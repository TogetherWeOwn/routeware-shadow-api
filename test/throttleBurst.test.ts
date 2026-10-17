import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_THROTTLE_BLOCK_MS,
  AUTH_THROTTLE_MAX_FAILURES
} from "../src/lib/authThrottle";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

const RATE_LIMITED_TYPE = `${PROBLEM_TYPE_BASE}rate-limited`;
const UNAUTHORIZED_TYPE = `${PROBLEM_TYPE_BASE}unauthorized`;

// Burst verification for the 20-failures/60s throttle.
//
// Gaps this file covers beyond test/authThrottle.test.ts and
// test/authGateSweep.test.ts:
// - per-IP isolation proven with independent budgets (victim burns its OWN
//   full 20-failure budget while the attacker is blocked — not just one 401),
// - valid token bypasses an ACTIVE block (passes while blocked, then resets),
// - partial-count reset (5 failures + valid token + 19 failures → only the
//   20th post-reset failure 429s; shared-NAT case),
// - failures on different routes share one per-IP bucket,
// - OPTIONS interleaved with failures never consumes budget,
// - 401/429 bodies never echo the submitted bearer (secret-residual guard).
//
// Window expiry / block release timing is covered by unit math in
// test/authThrottle.test.ts ("throttle window math") with injected clocks;
// the DO uses Date.now(), so HTTP-level time travel is not possible here.
//
// Every test gets fresh TEST-NET IP(s) never used by authThrottle.test.ts
// (203.0.113.7/.99/.200, 198.51.100.23, 192.0.2.44/.71) or
// authGateSweep.test.ts (198.51.100.64+, 203.0.113.140, 192.0.2.140/.141,
// 198.51.100.200 + 192.0.2 mirrors), so per-IP DO buckets never leak state
// between tests or files.
const ISOLATION_ATTACKER_IP = "203.0.113.211";
const ISOLATION_VICTIM_IP = "203.0.113.212";
const BYPASS_IP = "203.0.113.213";
const PARTIAL_IP = "203.0.113.214";
const CROSS_ROUTE_IP = "203.0.113.215";
const OPTIONS_IP = "203.0.113.216";
const ECHO_IP = "203.0.113.217";
const HEALTH_BURST_IP = "192.0.2.211";

const HOME_INDEX = "/api/v1/routeware/home/index";
const UNKNOWN_PATH = "/api/v1/does-not-exist";
const SHADOW_HEALTH = "/api/v1/shadow/health";

type CallOpts = {
  token?: string | null;
  ip?: string;
  method?: string;
};

async function call(path: string, opts: CallOpts = {}): Promise<Response> {
  const headers = new Headers();
  if (opts.token !== null && opts.token !== undefined) {
    headers.set("authorization", `Bearer ${opts.token}`);
  }
  if (opts.ip) {
    headers.set("CF-Connecting-IP", opts.ip);
  }
  return exports.default.fetch(`http://test.local${path}`, {
    method: opts.method ?? "GET",
    headers
  });
}

async function expectFailure401(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toContain("problem+json");
  const body = (await res.json()) as { type: string; status: number };
  expect(body.type).toBe(UNAUTHORIZED_TYPE);
  expect(body.status).toBe(401);
}

async function burnToBlocked(ip: string, path: string = HOME_INDEX): Promise<void> {
  for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
    const res = await call(path, { token: `burn-${i}`, ip });
    expect(res.status).toBe(401);
  }
  const throttled = await call(path, { token: "burn-final", ip });
  expect(throttled.status).toBe(429);
}

describe("throttle burst verification", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No request below should reach upstream: 401s/429s stop at the gate,
    // and authorized probes use shadow/health or unknown paths (no proxy).
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in throttle burst test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("isolates per IP: victim keeps its own full budget while attacker is blocked", async () => {
    // Arrange — attacker burns to a block.
    await burnToBlocked(ISOLATION_ATTACKER_IP);
    expect(
      (await call(HOME_INDEX, { token: "again", ip: ISOLATION_ATTACKER_IP })).status
    ).toBe(429);

    // Act — victim burns its OWN full budget from scratch.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      const res = await call(HOME_INDEX, { token: `victim-${i}`, ip: ISOLATION_VICTIM_IP });
      expect(res.status).toBe(401);
    }

    // Assert — victim's 20th failure 429s on its own budget, independent of
    // the attacker's block.
    const victimFinal = await call(HOME_INDEX, {
      token: "victim-final",
      ip: ISOLATION_VICTIM_IP
    });
    expect(victimFinal.status).toBe(429);
  });

  it("valid token bypasses an active block and resets the counter", async () => {
    // Arrange — IP is actively blocked.
    await burnToBlocked(BYPASS_IP);
    expect(
      (await call(HOME_INDEX, { token: "still-bad", ip: BYPASS_IP })).status
    ).toBe(429);

    // Act — the valid token passes WHILE blocked (shadow health needs no
    // upstream, so this proves gate passage without stubbing the network).
    const legit = await call(SHADOW_HEALTH, { token: API_TOKEN, ip: BYPASS_IP });

    // Assert — passed, and the counter reset: next bad attempt is a 401.
    expect(legit.status).toBe(200);
    const after = await call(HOME_INDEX, { token: "bad-after-reset", ip: BYPASS_IP });
    expect(after.status).toBe(401);
  });

  it("valid token resets a partial count (shared-NAT case)", async () => {
    // Arrange — 5 failures, then a legitimate pass.
    for (let i = 0; i < 5; i++) {
      await expectFailure401(await call(HOME_INDEX, { token: `early-${i}`, ip: PARTIAL_IP }));
    }
    expect(
      (await call(SHADOW_HEALTH, { token: API_TOKEN, ip: PARTIAL_IP })).status
    ).toBe(200);

    // Act / Assert — a full fresh budget of 19 × 401 remains. Without the
    // reset the 20th post-reset failure would have 429'd far earlier (5+19).
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      await expectFailure401(
        await call(HOME_INDEX, { token: `late-${i}`, ip: PARTIAL_IP })
      );
    }
    const final = await call(HOME_INDEX, { token: "late-final", ip: PARTIAL_IP });
    expect(final.status).toBe(429);
  });

  it("counts failures across routes in one per-IP bucket", async () => {
    // Arrange / Act — alternate two paths; the bucket is per-IP, not per-route.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      const path = i % 2 === 0 ? HOME_INDEX : UNKNOWN_PATH;
      await expectFailure401(await call(path, { token: `xroute-${i}`, ip: CROSS_ROUTE_IP }));
    }

    // Assert — the 20th failure 429s even though no single path saw 20.
    const final = await call(UNKNOWN_PATH, { token: "xroute-final", ip: CROSS_ROUTE_IP });
    expect(final.status).toBe(429);
  });

  it("OPTIONS interleaved with failures never consumes budget", async () => {
    // Arrange — 10 failures, a 20-deep OPTIONS burst, then 9 more failures.
    // OPTIONS is answered with a 204 preflight before the bearer gate.
    for (let i = 0; i < 10; i++) {
      await expectFailure401(await call(HOME_INDEX, { token: `pre-${i}`, ip: OPTIONS_IP }));
    }
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      const res = await call(HOME_INDEX, {
        token: "wrong",
        ip: OPTIONS_IP,
        method: "OPTIONS"
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    }
    for (let i = 0; i < 9; i++) {
      await expectFailure401(await call(HOME_INDEX, { token: `post-${i}`, ip: OPTIONS_IP }));
    }

    // Assert — 19 real failures counted, so the 20th 429s. If any OPTIONS
    // had consumed budget, the block would have fired earlier.
    const final = await call(HOME_INDEX, { token: "opt-final", ip: OPTIONS_IP });
    expect(final.status).toBe(429);
  });

  it("never echoes the submitted bearer in 401/429 bodies", async () => {
    // Arrange — distinctive tokens that would be unmistakable in a body.
    const bad401 = "burst-probe-401-8f3a2c";
    const bad429 = "burst-probe-429-7d1e9b";

    // Act / Assert — 401 body carries no trace of the submitted token.
    const first = await call(HOME_INDEX, { token: bad401, ip: ECHO_IP });
    expect(first.status).toBe(401);
    const text401 = await first.text();
    expect(text401).not.toContain(bad401);

    // Burn the rest of the budget, then check the 429 the same way.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 2; i++) {
      expect((await call(HOME_INDEX, { token: `echo-burn-${i}`, ip: ECHO_IP })).status).toBe(
        401
      );
    }
    const throttled = await call(HOME_INDEX, { token: bad429, ip: ECHO_IP });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("content-type")).toContain("problem+json");
    const retryAfter = throttled.headers.get("retry-after");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(Math.ceil(AUTH_THROTTLE_BLOCK_MS / 1000));
    const text429 = await throttled.text();
    expect(text429).not.toContain(bad429);
    const body = JSON.parse(text429) as { type: string; title: string; status: number };
    expect(body.type).toBe(RATE_LIMITED_TYPE);
    expect(body.title).toBe("Too Many Requests");
    expect(body.status).toBe(429);
  });

  it("health probe burst never consumes throttle budget", async () => {
    // Arrange / Act — bad-token health checks stay public, however many.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      const res = await call("/api/v1/health", { token: "wrong", ip: HEALTH_BURST_IP });
      expect(res.status).toBe(200);
    }

    // Assert — the IP's first gated failure is still a 401, not a 429.
    await expectFailure401(
      await call(HOME_INDEX, { token: "wrong", ip: HEALTH_BURST_IP })
    );
  });
});
