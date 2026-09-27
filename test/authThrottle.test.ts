import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession } from "../src/authSession.do";
import {
  AUTH_THROTTLE_BLOCK_MS,
  AUTH_THROTTLE_MAX_FAILURES,
  AUTH_THROTTLE_WINDOW_MS,
  clearAuthFailures,
  clientIpFromRequest,
  recordAuthFailure,
  throttleCheckVerdict,
  throttleObjectName,
  throttleRecordFailure,
  type AuthThrottleState
} from "../src/lib/authThrottle";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

// Distinct TEST-NET IPs per test so the per-IP DO buckets never leak state
// between tests in this file (and never touch the "unknown" bucket the other
// suites share by sending no IP header).
const ATTACKER_IP = "203.0.113.7";
const RECOVERING_IP = "203.0.113.99";
const LEGIT_IP = "198.51.100.23";
const HEALTH_IP = "192.0.2.44";

const RATE_LIMITED_TYPE = `${PROBLEM_TYPE_BASE}rate-limited`;

function reqWith(headers: Record<string, string>): {
  header: (n: string) => string | undefined;
} {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { header: (n: string) => lower[n.toLowerCase()] };
}

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

describe("clientIpFromRequest", () => {
  it("prefers CF-Connecting-IP (authoritative, set by Cloudflare)", () => {
    expect(
      clientIpFromRequest(
        reqWith({ "CF-Connecting-IP": "203.0.113.1", "X-Forwarded-For": "198.51.100.1" })
      )
    ).toBe("203.0.113.1");
  });

  it("falls back to the first X-Forwarded-For entry", () => {
    expect(
      clientIpFromRequest(reqWith({ "X-Forwarded-For": "198.51.100.1, 70.41.3.18" }))
    ).toBe("198.51.100.1");
  });

  it("buckets headerless callers as unknown", () => {
    expect(clientIpFromRequest(reqWith({}))).toBe("unknown");
  });

  it("namespaces DO instances per IP", () => {
    expect(throttleObjectName("203.0.113.7")).toBe("auth-throttle:203.0.113.7");
    expect(throttleObjectName("203.0.113.7")).not.toBe(throttleObjectName("203.0.113.8"));
  });
});

describe("throttle window math", () => {
  it("counts failures inside the window without blocking", () => {
    // Arrange
    const now = 1_000_000;

    // Act — one below the threshold stays open.
    let state: AuthThrottleState | null = null;
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      const out = throttleRecordFailure(state, now + i);
      expect(out.verdict.blocked).toBe(false);
      state = out.next;
    }

    // Assert
    expect(state?.failures).toBe(AUTH_THROTTLE_MAX_FAILURES - 1);
  });

  it("blocks at the threshold with a Retry-After sized to the block", () => {
    // Arrange
    const now = 1_000_000;
    let state: AuthThrottleState | null = null;
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      state = throttleRecordFailure(state, now).next;
    }

    // Act
    const { next, verdict } = throttleRecordFailure(state, now);

    // Assert
    expect(verdict.blocked).toBe(true);
    expect(verdict.retryAfterSec).toBe(Math.ceil(AUTH_THROTTLE_BLOCK_MS / 1000));
    expect(next.blockedUntilMs).toBe(now + AUTH_THROTTLE_BLOCK_MS);
    expect(throttleCheckVerdict(next, now).blocked).toBe(true);
  });

  it("starts a fresh window after the old one expires", () => {
    // Arrange
    const first = throttleRecordFailure(null, 0).next;

    // Act — a failure past the window edge resets the count, not the block.
    const { next, verdict } = throttleRecordFailure(first, AUTH_THROTTLE_WINDOW_MS + 1);

    // Assert
    expect(verdict.blocked).toBe(false);
    expect(next.failures).toBe(1);
    expect(next.windowStartMs).toBe(AUTH_THROTTLE_WINDOW_MS + 1);
  });

  it("releases the block once the block expires", () => {
    // Arrange
    let state: AuthThrottleState | null = null;
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      state = throttleRecordFailure(state, 0).next;
    }

    // Act / Assert — still blocked just before expiry, open just after.
    expect(throttleCheckVerdict(state, AUTH_THROTTLE_BLOCK_MS - 1).blocked).toBe(true);
    expect(throttleCheckVerdict(state, AUTH_THROTTLE_BLOCK_MS + 1).blocked).toBe(false);
    expect(throttleCheckVerdict(null, 0)).toEqual({ blocked: false, retryAfterSec: 0 });
  });
});

describe("throttle DO endpoints", () => {
  function fakeState(initial?: Record<string, unknown>): DurableObjectState {
    const store = new Map<string, unknown>(Object.entries(initial ?? {}));
    return {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> =>
          store.get(key) as T | undefined,
        put: async (key: string, value: unknown): Promise<void> => {
          store.set(key, value);
        },
        delete: async (key: string): Promise<boolean> => store.delete(key)
      }
    } as unknown as DurableObjectState;
  }

  function sessionWith(initial?: Record<string, unknown>): AuthSession {
    return new AuthSession(fakeState(initial), {} as Env);
  }

  async function throttleCall(
    session: AuthSession,
    path: "/throttle/check" | "/throttle/failure" | "/throttle/clear"
  ): Promise<Response> {
    return session.fetch(new Request(`https://do.local${path}`, { method: "POST" }));
  }

  it("reports open on fresh state and counts one failure", async () => {
    // Arrange
    const session = sessionWith();

    // Act / Assert
    expect(await (await throttleCall(session, "/throttle/check")).json()).toEqual({
      blocked: false,
      retryAfterSec: 0
    });
    const verdict = await (await throttleCall(session, "/throttle/failure")).json();
    expect(verdict).toEqual({ blocked: false, retryAfterSec: 0 });
  });

  it("treats a corrupt stored value as empty instead of throwing", async () => {
    // Arrange — a foreign value under the throttle key (e.g. a past key bug).
    const session = sessionWith({ throttle: { failures: "many" } });

    // Act
    const res = await throttleCall(session, "/throttle/failure");

    // Assert — counted as the first failure, not a 500.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ blocked: false, retryAfterSec: 0 });
  });

  it("clears the counter so a recovered client starts fresh", async () => {
    // Arrange
    const session = sessionWith();
    await throttleCall(session, "/throttle/failure");

    // Act
    expect((await throttleCall(session, "/throttle/clear")).status).toBe(200);

    // Assert — the failure is gone (a later check is open, and the next
    // failure counts as #1 rather than continuing a stale streak).
    expect(await (await throttleCall(session, "/throttle/check")).json()).toEqual({
      blocked: false,
      retryAfterSec: 0
    });
  });
});

describe("throttle fail-open paths", () => {
  const req = reqWith({ "CF-Connecting-IP": "203.0.113.200" });

  function envWithStub(stub: unknown): Env {
    return {
      AUTH_SESSION: {
        idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
        get: () => stub as DurableObjectStub
      }
    } as unknown as Env;
  }

  it("records open when the DO fetch rejects (auth still enforced by the caller)", async () => {
    // Arrange
    const env = envWithStub({
      fetch: async () => {
        throw new Error("DO unreachable");
      }
    });

    // Act
    const verdict = await recordAuthFailure(env, req);

    // Assert
    expect(verdict).toEqual({ blocked: false, retryAfterSec: 0 });
  });

  it("records open when the DO answers non-OK or malformed", async () => {
    // Arrange
    const badStatus = envWithStub({ fetch: async () => new Response("x", { status: 500 }) });
    const malformed = envWithStub({
      fetch: async () => Response.json({ blocked: "yes-ish" })
    });

    // Act / Assert
    expect(await recordAuthFailure(badStatus, req)).toEqual({
      blocked: false,
      retryAfterSec: 0
    });
    expect(await recordAuthFailure(malformed, req)).toEqual({
      blocked: false,
      retryAfterSec: 0
    });
  });

  it("clear never throws when the DO is unreachable", async () => {
    // Arrange
    const env = envWithStub({
      fetch: async () => {
        throw new Error("DO unreachable");
      }
    });

    // Act / Assert — resolves, does not reject.
    await expect(clearAuthFailures(env, req)).resolves.toBeUndefined();
  });
});

describe("bearer brute-force throttle on /api/v1/* (TOG-5820)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No request below should reach upstream: 401s and 429s stop at the gate,
    // and the authorized probes use unknown paths (gate → routing → 404).
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in throttle test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("brute-forcing a bad token ends in 429 problem+json with Retry-After", async () => {
    // Arrange / Act — just under the threshold every attempt is a plain 401.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      const res = await call("/api/v1/routeware/home/index", {
        token: `guess-${i}`,
        ip: ATTACKER_IP
      });
      expect(res.status).toBe(401);
    }

    // The threshold attempt is throttled instead of another 401.
    const throttled = await call("/api/v1/routeware/home/index", {
      token: "guess-final",
      ip: ATTACKER_IP
    });

    // Assert
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("content-type")).toContain("problem+json");
    const retryAfter = throttled.headers.get("retry-after");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(Math.ceil(AUTH_THROTTLE_BLOCK_MS / 1000));
    const body = (await throttled.json()) as {
      type: string;
      title: string;
      status: number;
      detail?: string;
    };
    expect(body.type).toBe(RATE_LIMITED_TYPE);
    expect(body.title).toBe("Too Many Requests");
    expect(body.status).toBe(429);
    expect(body.detail).toContain("PROBLEMS.md#rate-limited");
    // Port note (TOG-5820 onto main without sibling TOG-5809): main has no
    // CORS layer yet, so no ACAO stamp is asserted here. The scope-branch
    // version asserts the stamp; TOG-5809's merge restores it.
  });

  it("a valid token from the throttled IP still passes and resets the counter", async () => {
    // Arrange — burn this IP up to the block first.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      await call("/api/v1/routeware/home/index", { token: "wrong", ip: RECOVERING_IP });
    }
    expect(
      (await call("/api/v1/routeware/home/index", { token: "wrong", ip: RECOVERING_IP }))
        .status
    ).toBe(429);

    // Act — the valid token passes the gate (unknown path → 404, not 429/401).
    const legit = await call("/api/v1/does-not-exist", {
      token: API_TOKEN,
      ip: RECOVERING_IP
    });

    // Assert — passed, and the counter reset: the next bad attempt is a 401.
    expect(legit.status).toBe(404);
    const after = await call("/api/v1/routeware/home/index", {
      token: "wrong-again",
      ip: RECOVERING_IP
    });
    expect(after.status).toBe(401);
  });

  it("legitimate traffic from another IP is unaffected by the block", async () => {
    // Arrange — ATTACKER_IP was blocked in the first test of this file.

    // Act — a different IP with the valid token reaches routing (404).
    const res = await call("/api/v1/does-not-exist", { token: API_TOKEN, ip: LEGIT_IP });

    // Assert
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("CORS preflight never consumes throttle budget", async () => {
    // Arrange — main has no TOG-5809 preflight early-return yet, so OPTIONS
    // reaches the gate as a 401; it must not burn budget doing so.
    const PREFLIGHT_IP = "192.0.2.71";
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      const res = await call("/api/v1/routeware/home/index", {
        token: "wrong",
        ip: PREFLIGHT_IP,
        method: "OPTIONS"
      });
      expect(res.status).toBe(401);
    }

    // Assert — the IP's first real gated failure is still a 401, not a 429.
    const gated = await call("/api/v1/routeware/home/index", {
      token: "wrong",
      ip: PREFLIGHT_IP
    });
    expect(gated.status).toBe(401);
  });

  it("the public health probe never consumes throttle budget", async () => {
    // Arrange / Act — bad-token health checks stay public, however many.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      const res = await call("/api/v1/health", { token: "wrong", ip: HEALTH_IP });
      expect(res.status).toBe(200);
    }

    // Assert — the IP's first gated failure is still a 401, not a 429.
    const gated = await call("/api/v1/routeware/home/index", {
      token: "wrong",
      ip: HEALTH_IP
    });
    expect(gated.status).toBe(401);
  });
});
