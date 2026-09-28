import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_THROTTLE_MAX_FAILURES } from "../src/lib/authThrottle";

// TOG-8886 (R3-10): adversarial QA probe — X-Forwarded-For throttle evasion.
//
// `clientIpFromRequest` (src/lib/authThrottle.ts) trusts `X-Forwarded-For`
// whenever `CF-Connecting-IP` is absent. The comment claims the fallback is
// "for local dev/test only", but nothing enforces that: in any environment
// without the CF header the throttle bucket key is fully attacker-controlled,
// and rotating it evades the brute-force throttle entirely (B1). Worse, an
// attacker can pile failures into ANY bucket name, burning a victim's budget
// remotely (B2).
//
// ## Red-then-green recipe for the reviewer
// 1. `npx vitest run test/authThrottleXffProbe.test.ts` → green, with the two
//    adversarial probes reported as expected failures (`it.fails`). The
//    expected-failure markers ARE the pinned bugs: each proves a bypass.
// 2. Temporarily change `it.fails` to `it` on the two probes → they go RED
//    (bypass demonstrated live), the two controls stay green.
// 3. Land the fix, keep step-2 state → all four go GREEN. The fix card then
//    owns these probes (re-bucket if XFF stops keying, fold into
//    test/authThrottle.test.ts if desired).
//
// Post-fix maintenance note: if the fix stops keying XFF-only callers by
// their XFF value (e.g. a shared bucket), the B1/B2 requests will share one
// bucket and trip it early. The fix card re-partitions these probes then.
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
