import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_THROTTLE_MAX_FAILURES } from "../src/lib/authThrottle";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

// Fresh TEST-NET IPs (TOG-6287): never used by authThrottle.test.ts
// (203.0.113.7/.99/.200, 198.51.100.23, 192.0.2.44/.71), the TOG-6278 burst
// audit (203.0.113.211–217, 192.0.2.211), or the gate sweep, so per-IP DO
// buckets never leak state between suites.
const ATTACKER_IP = "203.0.113.231";
const VICTIM_IP = "203.0.113.232";
const SELF_CLEAR_IP = "198.51.100.231";
const OTHER_IP = "192.0.2.231";

const GATED = "/api/v1/routeware/home/index";
const PROBE = "/api/v1/shadow/health";

type CallOpts = {
  token?: string | null;
  ip?: string;
};

async function call(path: string, opts: CallOpts = {}): Promise<Response> {
  const headers = new Headers();
  if (opts.token !== null && opts.token !== undefined) {
    headers.set("authorization", `Bearer ${opts.token}`);
  }
  if (opts.ip) {
    headers.set("CF-Connecting-IP", opts.ip);
  }
  return exports.default.fetch(`http://test.local${path}`, { headers });
}

async function burnToBlocked(ip: string): Promise<void> {
  for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
    const res = await call(GATED, { token: `burn-${i}`, ip });
    expect(res.status).toBe(401);
  }
  const throttled = await call(GATED, { token: "burn-final", ip });
  expect(throttled.status).toBe(429);
}

describe("throttle reset-abuse isolation (TOG-6287)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No request below should reach upstream: 401s/429s stop at the gate,
    // and authorized probes use shadow/health (no proxy).
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in reset-isolation test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("a valid-token reset on one IP does not clear a blocked attacker's budget on another IP", async () => {
    // Arrange — attacker burns its own IP to a block; victim has 5 failures.
    await burnToBlocked(ATTACKER_IP);
    for (let i = 0; i < 5; i++) {
      expect((await call(GATED, { token: `victim-early-${i}`, ip: VICTIM_IP })).status).toBe(
        401
      );
    }

    // Act — a valid token from the victim IP passes (and resets only that IP).
    const legit = await call(PROBE, { token: API_TOKEN, ip: VICTIM_IP });
    expect(legit.status).toBe(200);

    // Assert — the attacker is still blocked: the victim's reset did not
    // clear another IP's budget. An attacker without the valid token has no
    // way to trigger a clear for anyone but its own IP, and a clear requires
    // a passing check, which the attacker cannot produce.
    expect((await call(GATED, { token: "attacker-again", ip: ATTACKER_IP })).status).toBe(
      429
    );

    // Assert — the victim's own budget is fresh (next bad attempt is a 401,
    // not a 429), proving the reset was scoped to the victim IP alone.
    expect((await call(GATED, { token: "victim-after-reset", ip: VICTIM_IP })).status).toBe(
      401
    );
  });

  it("only a same-IP valid token clears a block: failures and cross-IP resets never do", async () => {
    // Arrange — IP is actively blocked.
    await burnToBlocked(SELF_CLEAR_IP);

    // Act / Assert — further failures never clear: still 429.
    expect((await call(GATED, { token: "more-guesses", ip: SELF_CLEAR_IP })).status).toBe(
      429
    );

    // Act / Assert — a valid token from a DIFFERENT IP passes there but
    // leaves this IP's block intact (reset is keyed off the requester's own
    // IP, same DO key as the failure counter).
    expect((await call(PROBE, { token: API_TOKEN, ip: OTHER_IP })).status).toBe(200);
    expect((await call(GATED, { token: "after-cross-ip-reset", ip: SELF_CLEAR_IP })).status).toBe(
      429
    );

    // Act / Assert — a valid token from the SAME IP passes through the block
    // and resets: the next bad attempt is a plain 401.
    expect((await call(PROBE, { token: API_TOKEN, ip: SELF_CLEAR_IP })).status).toBe(200);
    expect((await call(GATED, { token: "bad-after-reset", ip: SELF_CLEAR_IP })).status).toBe(
      401
    );
  });
});
