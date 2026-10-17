import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { LOCK_TTL_MS } from "../src/authSession.do";
import { forwardWithSessionRetry } from "../src/lib/forwardWithSessionRetry";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import {
  ConcurrentRefreshTimeoutError,
  concurrentRefreshTimeoutProblem,
  isConcurrentRefreshTimeout,
  WAIT_TIMEOUT_MS,
  waitForConcurrentRefresh
} from "../src/lib/sessionRefreshLock";
import type { SessionState } from "../src/lib/sessionState";

/**
 * Fail-closed waiter on refresh-lock timeout.
 *
 * Bug: `waitForConcurrentRefresh` returned void on its 20s deadline and
 * `establishSession` returned with it — after a hung refresh the request
 * forwarded with the expired cookie, surfacing upstream login HTML as a 200
 * instead of a clean error.
 *
 * What this pins:
 * 1. The waiter throws `ConcurrentRefreshTimeoutError` on deadline (never a
 *    silent return), with a fixed PII-free message naming only the budget.
 * 2. `forwardWithSessionRetry` maps that throw to 502 `bad-gateway`
 *    problem+json on BOTH refresh legs (proactive + reactive), with zero
 *    upstream forwards — never an upstream-shaped 200 carrying login HTML.
 * 3. End-to-end: `GET /api/v1/routeware/home/index` through the REAL
 *    `establishSession` + waiter against a hung holder answers 502 without
 *    ever forwarding the stale cookie. (`app.onError` carries the same 502
 *    mapping as a backstop for direct `establishSession` callers such as the
 *    snapshot sync routes.)
 * 4. The waiter budget is derived from the lock TTL
 *    (`WAIT_TIMEOUT_MS = LOCK_TTL_MS - 30s`), covering a worst-case ~47s
 *    browser login — cold-start waiters previously timed out at 20s while
 *    the login was still running.
 *
 * Fixture hygiene: the only "cookies" are `.WebRW=FAKE-…` stand-ins and
 * structural login-form HTML — no credentials, no customer PII
 * (CONVENTIONS.md §§ 4-5).
 */

const LOGIN_URL = "https://killeen.routeware.com/WebRW/Account/Login";
const UPSTREAM = new URL("https://killeen.routeware.com/WebRW/Home/Index");

/** A `/get`-only DO stub whose session never resolves (the hung refresh). */
function hungStub(): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/get")) {
        return Response.json({
          cookieHeader: null,
          expiresAtMs: null,
          refreshing: true
        } satisfies SessionState);
      }
      return new Response("OK");
    }
  } as unknown as DurableObjectStub;
}

/**
 * Session fake for the forward-path unit tests below: `/get` serves the
 * holder; `/lock` reports held (unused there — those tests inject their own
 * `establish` fn — but kept so the fake also fits the real waiter leg).
 */
function forwardStub(holder: { value: SessionState }): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/lock")) {
        return new Response("LOCKED", { status: 423 });
      }
      if (url.endsWith("/get")) {
        return new Response(JSON.stringify(holder.value), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("OK");
    }
  } as unknown as DurableObjectStub;
}

const FORWARD_ENV = {
  LOGIN_URL,
  SHADOW_API_TOKEN: "test-api-token"
} as unknown as Env;

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

describe("waitForConcurrentRefresh deadline", () => {
  it("throws ConcurrentRefreshTimeoutError with a fixed PII-free message", async () => {
    // Arrange — a holder that never publishes: every poll still refreshing.
    const stub = hungStub();

    // Act — stubbed 200ms budget so the suite never waits the real 90s.
    const failure = await waitForConcurrentRefresh(stub, 200, 25).then(
      () => null,
      (err: unknown) => err
    );

    // Assert — the throw (never void), the closed type, and a message that
    // names only the budget: nothing a client or log sink could read PII from.
    expect(isConcurrentRefreshTimeout(failure)).toBe(true);
    expect(failure).toBeInstanceOf(ConcurrentRefreshTimeoutError);
    expect((failure as ConcurrentRefreshTimeoutError).timeoutMs).toBe(200);
    expect((failure as Error).message).toBe(
      "Concurrent session refresh timed out after 200ms"
    );
    // A non-timeout error is never misclassified (401/429 passthrough intact).
    expect(isConcurrentRefreshTimeout(new Error("nope"))).toBe(false);
  });

  it("resolves when the holder publishes before the deadline", async () => {
    // Arrange — holder finishes 10ms into a 5s budget.
    const holder = {
      value: { cookieHeader: null, expiresAtMs: null, refreshing: true } as SessionState
    };
    const stub = forwardStub(holder);
    setTimeout(() => {
      holder.value = {
        cookieHeader: ".WebRW=FAKE-PUBLISHED",
        expiresAtMs: Date.now() + 600_000,
        refreshing: false
      };
    }, 10);

    // Act / Assert — returns void (no throw) once a cookie is visible.
    await expect(waitForConcurrentRefresh(stub, 5_000, 10)).resolves.toBeUndefined();
  });
});

describe("waiter budget derivation", () => {
  it("WAIT_TIMEOUT_MS is derived from LOCK_TTL_MS with margin on both sides", () => {
    // The browser path costs ~47s (two 15s selector waits + 15s navigation +
    // 2s settle in `browserAuth.ts`); the old fixed 20s budget timed every
    // cold-start waiter out while the login was still running. The budget
    // must cover that path with margin while failing before the lock can go
    // stale and admit a duplicate login.
    expect(WAIT_TIMEOUT_MS).toBe(LOCK_TTL_MS - 30_000);
    expect(WAIT_TIMEOUT_MS).toBeGreaterThan(47_000);
    expect(WAIT_TIMEOUT_MS).toBeLessThan(LOCK_TTL_MS);
  });

  it("a waiter survives a 50s browser login (cold start)", async () => {
    // Arrange — the holder publishes 50s in: past the old 20s deadline (this
    // test rejects under the old budget), inside the new 90s budget. Fake
    // timers drive the poll loop deterministically.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const holder = {
        value: { cookieHeader: null, expiresAtMs: null, refreshing: true } as SessionState
      };
      const stub = forwardStub(holder);
      setTimeout(() => {
        holder.value = {
          cookieHeader: ".WebRW=FAKE-PUBLISHED",
          expiresAtMs: Date.now() + 600_000,
          refreshing: false
        };
      }, 50_000);

      // Act — the waiter is still polling at 50s and resolves on publish.
      const pending = waitForConcurrentRefresh(stub);
      const settled = pending.then(
        () => "resolved",
        (err: unknown) => err
      );
      await vi.advanceTimersByTimeAsync(60_000);
      const outcome = await settled;

      // Assert — resolved (never the fail-closed throw) on the default budget.
      expect(outcome).toBe("resolved");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("concurrentRefreshTimeoutProblem", () => {
  it("is 502 bad-gateway problem+json with no PII surface", async () => {
    const res = concurrentRefreshTimeoutProblem(200, "/api/v1/routeware/home/index");
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail: string;
      instance?: string;
    };
    expect(body.type).toBe(`${PROBLEM_TYPE_BASE}bad-gateway`);
    expect(body.title).toBe("Session refresh timed out");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("200ms");
    expect(body.instance).toBe("/api/v1/routeware/home/index");
  });
});

describe("forwardWithSessionRetry on refresh timeout", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("proactive leg: stubbed refresh timeout answers 502 with zero upstream forwards", async () => {
    // Arrange — an expiring session (takes the proactive leg) plus a refresh
    // that always times out; the upstream would serve login HTML if reached.
    const holder = {
      value: {
        cookieHeader: ".WebRW=FAKE-STALE",
        expiresAtMs: Date.now() - 1,
        refreshing: true
      } as SessionState
    };
    const establish = vi.fn(async () => {
      throw new ConcurrentRefreshTimeoutError(200);
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        '<html><body><form action="/WebRW/Account/Login" method="post">' +
          '<input name="UserName" type="text" value="" />' +
          '<input name="Password" type="password" value="" />' +
          "</form></body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Act
    const res = await forwardWithSessionRetry(
      FORWARD_ENV,
      forwardStub(holder),
      new Request("http://shadow/api/v1/routeware/home/index"),
      UPSTREAM,
      null,
      establish
    );

    // Assert — acceptance shape: 502 problem+json, never the upstream 200;
    // zero forwards (the expired cookie never left the Worker).
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toBe(`${PROBLEM_TYPE_BASE}bad-gateway`);
    expect(body.title).toBe("Session refresh timed out");
    expect(body.status).toBe(502);
    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reactive leg: stubbed refresh timeout answers 502 without retrying the stale cookie", async () => {
    // Arrange — fresh session (skips the proactive leg); the first forward
    // hits the silent-expiry 302, then the reactive re-login times out.
    const holder = {
      value: {
        cookieHeader: ".WebRW=FAKE-STALE",
        expiresAtMs: Date.now() + 600_000,
        refreshing: false
      } as SessionState
    };
    const establish = vi.fn(async () => {
      throw new ConcurrentRefreshTimeoutError(200);
    });
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: LOGIN_URL } })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Act
    const res = await forwardWithSessionRetry(
      FORWARD_ENV,
      forwardStub(holder),
      new Request("http://shadow/api/v1/routeware/home/index"),
      UPSTREAM,
      null,
      establish
    );

    // Assert — 502, exactly one forward (the doomed retry never ran), and the
    // stale cookie was never re-sent after the timeout.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toBe(`${PROBLEM_TYPE_BASE}bad-gateway`);
    expect(body.title).toBe("Session refresh timed out");
    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("non-timeout refresh failures still propagate (401/429 behavior intact)", async () => {
    // Arrange — the refresh fails with a plain login error, not a timeout.
    const holder = {
      value: {
        cookieHeader: ".WebRW=FAKE-STALE",
        expiresAtMs: Date.now() - 1,
        refreshing: true
      } as SessionState
    };
    const establish = vi.fn(async () => {
      throw new Error("HTTP login failed (status 500)");
    });
    globalThis.fetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;

    // Act
    const failure = await forwardWithSessionRetry(
      FORWARD_ENV,
      forwardStub(holder),
      new Request("http://shadow/api/v1/routeware/home/index"),
      UPSTREAM,
      null,
      establish
    ).then(
      () => null,
      (err: unknown) => err
    );

    // Assert — not swallowed into a 502: login failures keep their path to
    // the caller's catch / app.onError 500.
    expect((failure as Error).message).toContain("HTTP login failed");
  });
});

describe("app end-to-end on refresh timeout", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GET /api/v1/routeware/home/index answers 502 without forwarding the stale cookie", async () => {
    // Arrange — the REAL `establishSession` + waiter against a hung holder:
    // `/lock` stays held, `/get` shows a stale cookie that never refreshes.
    // Fake timers drive the 90s waiter deterministically (same shape as the
    // stalled-holder test in `establishSession.test.ts`).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const now = Date.now();
      const stub = {
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const path = new URL(
            typeof input === "string" ? input : String(input)
          ).pathname;
          if (path === "/throttle/clear" || path === "/throttle/failure") {
            return Response.json({ blocked: false, retryAfterSec: 0 });
          }
          if (path === "/lock") {
            return new Response("LOCKED", { status: 423 });
          }
          if (path === "/get") {
            return Response.json({
              cookieHeader: ".WebRW=FAKE-STALE",
              expiresAtMs: now - 1_000,
              refreshing: true
            } satisfies SessionState);
          }
          return new Response("OK");
        }
      };
      const env = {
        AUTH_MODE: "http",
        LOGIN_URL,
        TARGET_ORIGIN: "https://killeen.routeware.com",
        TARGET_BASE_PATH: "/WebRW",
        SESSION_TTL_SECONDS: 1800,
        SHADOW_API_TOKEN: "test-api-token",
        AUTH_SESSION: {
          idFromName: (name: string) => name,
          get: (_id: string) => stub
        }
      } as unknown as Env;
      // The upstream would serve the silent-expiry login page if the stale
      // cookie ever forwarded — count the calls to prove it never does.
      const fetchMock = vi.fn(
        async () =>
          new Response(
            '<html><body><form action="/WebRW/Account/Login" method="post">' +
              '<input name="UserName" type="text" value="" />' +
              '<input name="Password" type="password" value="" />' +
              "</form></body></html>",
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
          )
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      // Act — authorized request; the stale session takes the proactive leg,
      // the waiter polls past its 90s deadline while the lock stays held.
      const pending = app.fetch(
        new Request("http://test.local/api/v1/routeware/home/index", {
          headers: { authorization: "Bearer test-api-token" }
        }),
        env,
        ctx
      );
      await vi.advanceTimersByTimeAsync(95_000);
      const res = await pending;

      // Assert — acceptance shape: 502 problem+json (never the upstream 200
      // carrying login HTML), and the expired cookie never left the Worker.
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as {
        type: string;
        title: string;
        status: number;
      };
      expect(body.type).toBe(`${PROBLEM_TYPE_BASE}bad-gateway`);
      expect(body.title).toBe("Session refresh timed out");
      expect(body.status).toBe(502);
      // onError runs outside the /api/v1/* middleware chain, so the 502 must
      // carry its own CORS stamp (no Origin on this request → wildcard) —
      // otherwise a browser sees a CORS error instead of the real 502.
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
