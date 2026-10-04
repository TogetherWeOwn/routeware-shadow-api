import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import {
  AUTH_THROTTLE_MAX_FAILURES,
  throttleRecordFailure,
  type AuthThrottleState
} from "../src/lib/authThrottle";

// TOG-8886 (R3-10): adversarial QA probe — X-Forwarded-For throttle evasion.
// TOG-8888 (R3-12): the fallback is now gated behind `THROTTLE_TRUST_XFF`.
//
// `clientIpFromRequest` (src/lib/authThrottle.ts) honors `X-Forwarded-For`
// only when `THROTTLE_TRUST_XFF === "true"` (dev/test). Production (flag
// absent or `"false"`) buckets XFF-only callers as `"unknown"`, so rotating
// XFF cannot evade the throttle and no victim bucket can be framed.
//
// The self-fetch suites below run under `[env.test.vars]`, which opts in
// (`THROTTLE_TRUST_XFF="true"` — dev-like). B1/B2 therefore still demonstrate
// the bypass as expected-failures (`it.fails`): with the flag ON, trusting
// XFF is the documented dev-only tradeoff, not a prod bug. The prod-like
// behavior (flag off: XFF ignored, throttle still triggers) is pinned by
// "XFF gate pins (TOG-8888)" at the bottom of this file via direct
// `app.fetch` with synthetic envs and a stateful in-memory throttle stub —
// hermetic, no DO buckets involved.
//
// ## Reviewer recipe
// 1. `npx vitest run test/authThrottleXffProbe.test.ts` → green: B1/B2 report
//    as expected failures (bypass demonstrable with the dev-only flag on),
//    both controls and all six gate pins pass.
// 2. Temporarily change `it.fails` to `it` on B1/B2 → they go RED (bypass
//    demonstrated live under the opted-in test env).
//
// TEST-NET allocation (fresh — never used by authThrottle, throttleBurst,
// authGateSweep, throttleResetIsolation, dualSecretMatrix or problemAnchors
// suites, so per-IP DO buckets never leak state between files):
// - B1 rotates 198.51.100.101–140 (40 distinct identities, 2× budget).
// - Same-XFF control: 198.51.100.243. B2 victim XFF: 198.51.100.241.
// - CF control: CF-Connecting-IP 203.0.113.250 (proves prod bucketing intact).
// No probe sends `CF-Connecting-IP` alongside XFF: the CF header takes
// precedence and would mask the fallback under test.

const GATED = "/api/v1/routeware/home/index";

type ProbeOpts = {
  token?: string;
  /** Sent WITHOUT CF-Connecting-IP, so the throttle falls back to XFF. */
  xff?: string;
  /** Authoritative bucket (control only) — never combined with `xff`. */
  cfIp?: string;
};

async function probe(opts: ProbeOpts): Promise<Response> {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${opts.token ?? "wrong-token"}`);
  if (opts.xff !== undefined) {
    headers.set("X-Forwarded-For", opts.xff);
  }
  if (opts.cfIp !== undefined) {
    headers.set("CF-Connecting-IP", opts.cfIp);
  }
  return exports.default.fetch(`http://test.local${GATED}`, { headers });
}

describe("XFF throttle-evasion probes (TOG-8886)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No probe below should reach upstream: 401s/429s stop at the gate.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in XFF probe");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.fails("B1: rotating XFF across 40 identities never trips the throttle", async () => {
    // Arrange — 40 failures (2× budget), each under a fresh XFF identity.
    // Secure expectation: the throttle keys on something the client cannot
    // rotate, so the 20th failure 429s. Pre-fix: every request lands in its
    // own DO bucket, all 40 return 401 — unbounded guessing, no slowdown.
    let seen429 = false;
    for (let i = 0; i < 2 * AUTH_THROTTLE_MAX_FAILURES; i++) {
      const res = await probe({ token: `rotate-guess-${i}`, xff: `198.51.100.${101 + i}` });
      if (res.status === 429) {
        seen429 = true;
        break;
      }
      expect(res.status).toBe(401);
    }

    // Assert
    expect(seen429).toBe(true);
  });

  it.fails("B2: attacker failures attributed to a victim XFF burn its budget", async () => {
    // Arrange — attacker piles 19 failures into the victim's XFF bucket.
    const VICTIM_XFF = "198.51.100.241";
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      const res = await probe({ token: `frame-${i}`, xff: VICTIM_XFF });
      expect(res.status).toBe(401);
    }

    // Act — the victim's FIRST failure under its own identity.
    const victimFirst = await probe({ token: "victim-legit-typo", xff: VICTIM_XFF });

    // Assert — secure expectation: 401 (attacker's failures are not the
    // victim's). Pre-fix: 429 — the attacker remotely burned the victim's
    // whole budget, a throttle-budget poisoning / targeted-DoS primitive.
    expect(victimFirst.status).toBe(401);
  });

  it("control: one fixed XFF identity still trips at exactly 20 (rotation is the variable)", async () => {
    // Same fallback path as B1, but WITHOUT rotation: 19× 401, 20th 429s.
    // Proves the fallback buckets consistently — only rotation evades it.
    const FIXED_XFF = "198.51.100.243";
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      expect((await probe({ token: `fixed-${i}`, xff: FIXED_XFF })).status).toBe(401);
    }
    expect((await probe({ token: "fixed-final", xff: FIXED_XFF })).status).toBe(429);
  });

  it("control: CF-Connecting-IP bucketing trips at exactly 20 (prod path intact)", async () => {
    // The authoritative header keeps exact budget semantics; the fix for
    // B1/B2 must not regress this path.
    const CF_IP = "203.0.113.250";
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      expect((await probe({ token: `cf-${i}`, cfIp: CF_IP })).status).toBe(401);
    }
    expect((await probe({ token: "cf-final", cfIp: CF_IP })).status).toBe(429);
  });
});

// TOG-8888 (R3-12) gate pins: prod-like env (flag off) ignores XFF, dev env
// still honors it. Driven via direct `app.fetch` with synthetic envs (the
// `test/authModeValidation.test.ts` seam — the self-fetch suite above always
// runs under `[env.test.vars]`, which opts the flag IN) and a stateful
// in-memory throttle stub, so these pins are hermetic and never touch the
// real DO buckets (fresh "unknown" keys per test, never leaked between
// tests or files).

const GATE_CTX = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

const GATE_TOKEN = "test-api-token";

function gateProbeEnv(trustXff: unknown): Env {
  // One stateful bucket per "auth-throttle:<ip>" name: the prod "unknown"
  // bucket (and each dev XFF bucket) persists across calls inside one test
  // so the 20-failure budget trips. `idFromName` receives the throttle
  // object name; the stub routes on its ip suffix.
  const buckets = new Map<string, AuthThrottleState | null>();
  const AUTH_SESSION = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      const ip = String(name).replace(/^auth-throttle:/, "");
      return {
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const url = new URL(typeof input === "string" ? input : String(input));
          if (url.pathname === "/throttle/clear") {
            buckets.delete(ip);
            return new Response("OK");
          }
          const out = throttleRecordFailure(buckets.get(ip) ?? null, Date.now());
          buckets.set(ip, out.next);
          return Response.json(out.verdict);
        }
      };
    }
  };
  return {
    // Bearer secret for the gate pins: the valid-token probe must pass the
    // outer gate (then 404 on an unknown path), proving a blocked shared
    // bucket never locks out legitimate traffic.
    SHADOW_API_TOKEN: GATE_TOKEN,
    THROTTLE_TRUST_XFF: trustXff,
    AUTH_SESSION
  } as unknown as Env;
}

async function gateCall(
  env: Env,
  opts: { token?: string; xff?: string; path?: string }
): Promise<Response> {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${opts.token ?? "wrong-token"}`);
  if (opts.xff !== undefined) {
    headers.set("X-Forwarded-For", opts.xff);
  }
  // No CF-Connecting-IP: forces the XFF-or-unknown path under test.
  // Valid-token probes use an unknown path (→ 404 past the gate); the real
  // route would reach for upstream, which is mocked to throw here.
  return app.fetch(
    new Request(`http://test.local${opts.path ?? "/api/v1/routeware/home/index"}`, {
      headers
    }),
    env,
    GATE_CTX
  );
}

describe("XFF gate pins (TOG-8888)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Gated requests never reach upstream: 401s/429s stop at the gate.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in XFF gate-pin test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("prod-like env (flag absent): 20 XFF-rotated failures share one bucket and trip 429", async () => {
    // Arrange — no THROTTLE_TRUST_XFF key at all (missing binding behaves as off).
    const env = gateProbeEnv(undefined);
    delete (env as unknown as Record<string, unknown>).THROTTLE_TRUST_XFF;

    // Act — rotating XFF across 20 identities must NOT evade the throttle:
    // every request lands in the shared "unknown" bucket.
    let last: Response | null = null;
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      last = await gateCall(env, { token: `gate-rot-${i}`, xff: `198.51.100.${101 + i}` });
      if (i < AUTH_THROTTLE_MAX_FAILURES - 1) {
        expect(last.status).toBe(401);
      }
    }

    // Assert — the 20th rotated failure trips the shared bucket.
    expect(last?.status).toBe(429);
  });

  it('prod-like env (flag "false"): XFF is ignored, one fixed XFF identity trips at exactly 20', async () => {
    // Arrange
    const env = gateProbeEnv("false");
    const XFF = "198.51.100.244";

    // Act / Assert — 19× 401, 20th 429: the throttle still triggers even
    // though the (ignored) XFF value is constant.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      expect((await gateCall(env, { token: `gate-fixed-${i}`, xff: XFF })).status).toBe(401);
    }
    expect((await gateCall(env, { token: "gate-fixed-final", xff: XFF })).status).toBe(429);
  });

  it('prod-like env: attacker failures into a victim XFF cannot burn the victim (shared "unknown" bucket)', async () => {
    // Arrange — fresh env so this test owns its "unknown" bucket alone.
    const env = gateProbeEnv("false");
    const VICTIM_XFF = "198.51.100.245";

    // Act — attacker piles failures under the victim's XFF value; XFF is
    // ignored, so they land in "unknown". One more failure with a DIFFERENT
    // XFF would share that same bucket — the victim is indistinguishable
    // from any other XFF-only caller there, which is the documented tradeoff
    // (fail-closed: no framable per-value bucket), not a per-victim burn.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      expect((await gateCall(env, { token: `gate-frame-${i}`, xff: VICTIM_XFF })).status).toBe(401);
    }

    // Assert — the 20th failure on the shared bucket trips, whatever XFF it carries.
    expect((await gateCall(env, { token: "gate-frame-final", xff: "198.51.100.246" })).status).toBe(
      429
    );
  });

  it('dev env (flag "true"): XFF is honored — one fixed identity trips at exactly 20, rotation evades', async () => {
    // Arrange — dev-like env honors XFF (documented dev-only tradeoff).
    const devEnv = gateProbeEnv("true");
    const FIXED_XFF = "198.51.100.247";

    // Act / Assert — fixed dev XFF buckets consistently.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      expect((await gateCall(devEnv, { token: `dev-fixed-${i}`, xff: FIXED_XFF })).status).toBe(
        401
      );
    }
    expect((await gateCall(devEnv, { token: "dev-fixed-final", xff: FIXED_XFF })).status).toBe(429);
  });

  it('non-"true" flag values ("0", "yes", "") behave as off', async () => {
    // Arrange — only the exact literal "true" opts in.
    for (const flag of ["0", "yes", ""]) {
      const env = gateProbeEnv(flag);
      const XFF = "198.51.100.248";

      // Act / Assert — first failure is a 401 in the shared bucket; a second
      // XFF value on a FRESH env shares it too (each loop iteration owns its
      // env/bucket, so two failures never trip — the pins below prove
      // bucketing, not the budget).
      expect((await gateCall(env, { token: "pin-a", xff: XFF })).status).toBe(401);
      expect((await gateCall(env, { token: "pin-b", xff: "198.51.100.249" })).status).toBe(401);
    }
  });

  it("a valid token on the shared bucket passes (fail-closed never locks out legit traffic)", async () => {
    // Arrange — burn the shared "unknown" bucket to the block with XFF-only failures.
    const env = gateProbeEnv("false");
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      await gateCall(env, { token: `burn-${i}`, xff: `198.51.100.${150 + i}` });
    }
    expect((await gateCall(env, { token: "burn-final", xff: "198.51.100.199" })).status).toBe(429);

    // Act — the valid token passes the gate (unknown path → 404, not 429/401)
    // even from the blocked shared bucket, and resets it.
    const legit = await gateCall(env, {
      token: GATE_TOKEN,
      xff: "198.51.100.150",
      path: "/api/v1/does-not-exist"
    });

    // Assert
    expect(legit.status).toBe(404);
  });
});
