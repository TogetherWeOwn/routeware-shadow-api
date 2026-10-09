import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import {
  AUTH_THROTTLE_MAX_FAILURES,
  clearAuthFailures,
  clientIpFromRequest,
  hasNoIpHeaders,
  recordAuthFailure,
  throttleRecordFailure,
  UNKNOWN_CLIENT_IP,
  type AuthThrottleState
} from "../src/lib/authThrottle";

// TOG-8896 (R3-20): isolate the unknown-IP throttle bucket.
//
// Callers with no usable IP headers (no CF-Connecting-IP, and XFF untrusted)
// resolve to the shared `"unknown"` bucket. A shared counter would let one
// headerless client throttle — or free-ride on — every other headerless
// caller, so unknown callers get per-request treatment: failures are answered
// without touching storage (never counted, never blocked), and successes
// clear nothing. Identified-IP buckets are unaffected in both directions.

// Fresh TEST-NET IPs never used by authThrottle.test.ts (.7/.99/.200,
// 198.51.100.23, 192.0.2.44/.71), the TOG-6278 burst audit (.211-.217,
// 192.0.2.211), or the TOG-6287 reset audit (.231/.232, 198.51.100.231,
// 192.0.2.231), so per-IP DO buckets never leak state between suites.
const IDENTIFIED_A = "203.0.113.241";
const IDENTIFIED_B = "203.0.113.242";

const GATED = "/api/v1/routeware/home/index";

function reqWith(headers: Record<string, string>): {
  header: (n: string) => string | undefined;
} {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { header: (n: string) => lower[n.toLowerCase()] };
}

// No CF-Connecting-IP and no XFF: headerless, even with THROTTLE_TRUST_XFF.
async function callHeaderless(path: string, token: string): Promise<Response> {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  return exports.default.fetch(`http://test.local${path}`, { headers });
}

async function callWithIp(path: string, token: string, ip: string): Promise<Response> {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  headers.set("CF-Connecting-IP", ip);
  return exports.default.fetch(`http://test.local${path}`, { headers });
}

describe("unknown-IP throttle isolation (TOG-8896)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No request below should reach upstream: 401s/429s stop at the gate.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in unknown-isolation test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("headerless callers resolve to the unknown bucket with no IP headers", () => {
    expect(clientIpFromRequest(reqWith({}))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIpFromRequest(reqWith({}))).toBe("unknown");
    expect(hasNoIpHeaders(reqWith({}))).toBe(true);
    // An untrusted XFF value is still a signal: not headerless, so the
    // shared-unknown-bucket treatment (TOG-8888) applies to it.
    expect(hasNoIpHeaders(reqWith({ "X-Forwarded-For": "198.51.100.9" }))).toBe(false);
    expect(hasNoIpHeaders(reqWith({ "CF-Connecting-IP": "203.0.113.9" }))).toBe(false);
  });

  it("a headerless burst never throttles: every failure stays a 401", async () => {
    // Arrange / Act — twice the block threshold of headerless failures.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES * 2; i++) {
      const res = await callHeaderless(GATED, `headerless-${i}`);
      expect(res.status).toBe(401);
    }

    // Assert — still a plain 401, never a 429: no shared unknown counter.
    const last = await callHeaderless(GATED, "headerless-final");
    expect(last.status).toBe(401);
  });

  it("a headerless burst does not consume an identified IP's budget", async () => {
    // Arrange — hammer the headerless path past the block threshold.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      expect((await callHeaderless(GATED, `pre-${i}`)).status).toBe(401);
    }

    // Act — the identified IP burns its OWN full budget from scratch.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      expect(
        (await callWithIp(GATED, `identified-${i}`, IDENTIFIED_A)).status
      ).toBe(401);
    }

    // Assert — the 20th failure on the identified IP 429s on its own budget,
    // independent of the headerless burst.
    expect((await callWithIp(GATED, "identified-final", IDENTIFIED_A)).status).toBe(
      429
    );
  });

  it("blocking an identified IP does not throttle headerless callers", async () => {
    // Arrange — burn the identified IP to a block.
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      await callWithIp(GATED, `burn-${i}`, IDENTIFIED_B);
    }
    expect((await callWithIp(GATED, "burn-again", IDENTIFIED_B)).status).toBe(429);

    // Act / Assert — headerless callers still get plain 401s.
    for (let i = 0; i < 3; i++) {
      expect((await callHeaderless(GATED, `after-block-${i}`)).status).toBe(401);
    }
  });

  it("prod XFF-only callers still share the unknown bucket (TOG-8888 preserved)", async () => {
    // Arrange — prod-like env (flag off) with a stateful in-memory throttle
    // stub (the test/authThrottleXffProbe.test.ts seam): XFF is ignored, so
    // XFF-only failures land in the shared "unknown" bucket and still trip.
    // Fully-headerless callers bypass before storage (TOG-8896) and never
    // consume that budget.
    const GATE_CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    function prodEnv(): Env {
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
      return { SHADOW_API_TOKEN: "test-api-token", THROTTLE_TRUST_XFF: "false", AUTH_SESSION } as unknown as Env;
    }
    async function gateCall(env: Env, xff?: string): Promise<Response> {
      const headers = new Headers();
      headers.set("authorization", "Bearer wrong-token");
      if (xff !== undefined) {
        headers.set("X-Forwarded-For", xff);
      }
      return app.fetch(new Request(`http://test.local${GATED}`, { headers }), env, GATE_CTX);
    }

    // Act / Assert — fixed XFF-only identity trips at exactly 20.
    const fixedEnv = prodEnv();
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      expect((await gateCall(fixedEnv, "198.51.100.251")).status).toBe(401);
    }
    expect((await gateCall(fixedEnv, "198.51.100.251")).status).toBe(429);

    // Act / Assert — rotating XFF still cannot evade: shared bucket trips.
    const rotEnv = prodEnv();
    let last: Response | null = null;
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      last = await gateCall(rotEnv, `198.51.100.${101 + i}`);
      if (i < AUTH_THROTTLE_MAX_FAILURES - 1) {
        expect(last.status).toBe(401);
      }
    }
    expect(last?.status).toBe(429);
  });

  it("record/clear for unknown never touches DO storage", async () => {
    // Arrange — a stub that records any storage access.
    const fetchSpy = vi.fn(async () => new Response("unreachable", { status: 500 }));
    const env = {
      AUTH_SESSION: {
        idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
        get: () => ({ fetch: fetchSpy }) as unknown as DurableObjectStub
      }
    } as unknown as Env;
    const unknownReq = reqWith({});

    // Act
    const verdict = await recordAuthFailure(env, unknownReq);
    await clearAuthFailures(env, unknownReq);

    // Assert — per-request treatment: open verdict, zero DO fetches (no
    // shared-counter read, write, or clear for the unknown bucket).
    expect(verdict).toEqual({ blocked: false, retryAfterSec: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
