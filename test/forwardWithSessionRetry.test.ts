import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forwardWithSessionRetry,
  sessionNeedsRefresh
} from "../src/lib/forwardWithSessionRetry";
import { establishSession } from "../src/lib/establishSession";
import type { SessionState } from "../src/lib/sessionState";

const stormCounters = vi.hoisted(() => ({ httpLogins: 0 }));

// The expiry-storm test below drives the REAL establishSession (refresh lock +
// waitForConcurrentRefresh) with a stubbed HTTP login that publishes through
// the REAL storeSession, so the single-login assertion exercises the actual
// lock wiring rather than a reimplementation of it.
vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    stormCounters.httpLogins += 1;
    // Hold the login briefly so all N first-wave forwards land (and observe
    // the redirect) before the fresh session is published.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=fresh", Date.now() + 600_000, lockToken);
  })
}));

vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async () => {
    throw new Error("browser login must not run during the http-mode expiry storm");
  })
}));

const LOGIN_URL = "https://killeen.routeware.com/WebRW/Account/Login";
const UPSTREAM = new URL("https://killeen.routeware.com/WebRW/Home/Index");
const env = { LOGIN_URL } as unknown as Env;

/** Fake AuthSession Durable Object stub backed by a mutable session holder. */
function makeStub(holder: { value: SessionState }): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/get")) {
        return new Response(JSON.stringify(holder.value), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("OK");
    }
  } as unknown as DurableObjectStub;
}

const loginRedirect = () =>
  new Response(null, { status: 302, headers: { location: LOGIN_URL } });

/** Must match LOCK_TTL_MS in src/authSession.do.ts. */
const LOCK_TTL_MS = 120_000;

type LockState = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
  lockedAt: number | null;
  lockToken: string | null;
};

/**
 * AuthSession stub fake implementing the real /lock, /takeover, /unlock,
 * /set, /get semantics — including the TOG-18959 lock-token owner check —
 * so the expiry-storm test drives the actual refresh-lock wiring.
 */
function makeLockStub(
  state: LockState,
  counters: { sets: number }
): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      const path = new URL(url).pathname;
      if (path === "/lock" || path === "/takeover") {
        const now = Date.now();
        const heldAndFresh =
          state.refreshing === true &&
          typeof state.lockedAt === "number" &&
          now - state.lockedAt < LOCK_TTL_MS;
        if (heldAndFresh) {
          return new Response("LOCKED", { status: 423 });
        }
        state.refreshing = true;
        state.lockedAt = now;
        state.lockToken = `synthetic-lock-token-${now}`;
        return Response.json({ lockToken: state.lockToken });
      }
      if (path === "/unlock") {
        if (state.refreshing === true) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { lockToken?: unknown };
          if (typeof state.lockToken !== "string" || body.lockToken !== state.lockToken) {
            return new Response("Forbidden", { status: 403 });
          }
        }
        state.refreshing = false;
        state.lockedAt = null;
        state.lockToken = null;
        return new Response("OK");
      }
      if (path === "/set") {
        counters.sets += 1;
        const body = JSON.parse(String(init?.body)) as {
          cookieHeader: string;
          expiresAtMs: number;
          lockToken?: unknown;
        };
        state.cookieHeader = body.cookieHeader;
        state.expiresAtMs = body.expiresAtMs;
        if (state.refreshing !== true || body.lockToken === state.lockToken) {
          state.refreshing = false;
          state.lockedAt = null;
          state.lockToken = null;
        }
        return new Response("OK");
      }
      if (path === "/get") {
        return Response.json({
          cookieHeader: state.cookieHeader,
          expiresAtMs: state.expiresAtMs,
          refreshing: state.refreshing
        });
      }
      return new Response("Not Found", { status: 404 });
    }
  } as unknown as DurableObjectStub;
}

describe("sessionNeedsRefresh", () => {
  const now = 1_000_000;
  it("does not proactively refresh a missing session (handled reactively)", () => {
    expect(sessionNeedsRefresh({ cookieHeader: null, expiresAtMs: null, refreshing: false }, now)).toBe(false);
  });
  it("does not refresh a fresh cookie with no/future expiry", () => {
    expect(sessionNeedsRefresh({ cookieHeader: "c=1", expiresAtMs: null, refreshing: false }, now)).toBe(false);
    expect(sessionNeedsRefresh({ cookieHeader: "c=1", expiresAtMs: now + 600_000, refreshing: false }, now)).toBe(false);
  });
  it("refreshes when within the skew of expiry", () => {
    expect(sessionNeedsRefresh({ cookieHeader: "c=1", expiresAtMs: now + 1000, refreshing: false }, now)).toBe(true);
    expect(sessionNeedsRefresh({ cookieHeader: "c=1", expiresAtMs: now - 1, refreshing: false }, now)).toBe(true);
  });
  it("refreshes when the stored expiry outlives the current TTL (TOG-6528)", () => {
    // Arrange — logged in under a 30-minute TTL, then the operator lowers the
    // TTL to 5 minutes to contain a suspected leaked session. The stored
    // absolute expiry never moves, so without this check the far-future expiry
    // would keep the possibly-dead cookie in use.
    const session = { cookieHeader: "c=1", expiresAtMs: now + 30 * 60_000, refreshing: false };
    const lowered = { SESSION_TTL_SECONDS: 300 } as unknown as Env;

    // Act / Assert
    expect(sessionNeedsRefresh(session, now, lowered)).toBe(true);
  });
  it("does not refresh when the stored expiry fits within the current TTL", () => {
    // Arrange — remaining lifetime (10 min) under the current TTL (30 min):
    // the TTL was not lowered since login.
    const session = { cookieHeader: "c=1", expiresAtMs: now + 10 * 60_000, refreshing: false };
    const current = { SESSION_TTL_SECONDS: 1800 } as unknown as Env;

    // Act / Assert
    expect(sessionNeedsRefresh(session, now, current)).toBe(false);
  });
  it("falls back to the stored expiry alone when the TTL is unparseable", () => {
    // Arrange — a bad TTL must never hard-fail traffic on the read path; the
    // next login still fails loudly via sessionExpiryMs.
    const bad = { SESSION_TTL_SECONDS: "soon" } as unknown as Env;

    // Act / Assert
    expect(
      sessionNeedsRefresh({ cookieHeader: "c=1", expiresAtMs: now + 600_000, refreshing: false }, now, bad)
    ).toBe(false);
    expect(
      sessionNeedsRefresh({ cookieHeader: "c=1", expiresAtMs: now - 1, refreshing: false }, now, bad)
    ).toBe(true);
  });
  it("keeps the legacy two-arg behavior when no env is passed", () => {
    // Arrange — callers that do not know the TTL get the stored-expiry check only.
    expect(
      sessionNeedsRefresh({ cookieHeader: "c=1", expiresAtMs: now + 30 * 60_000, refreshing: false }, now)
    ).toBe(false);
  });
});

describe("forwardWithSessionRetry", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("proactively refreshes an expiring session, then forwards once", async () => {
    const holder = {
      value: { cookieHeader: "old", expiresAtMs: Date.now() - 1, refreshing: false } as SessionState
    };
    const stub = makeStub(holder);
    const establish = vi.fn(async () => {
      holder.value = { cookieHeader: "fresh", expiresAtMs: Date.now() + 600_000, refreshing: false };
    });
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await forwardWithSessionRetry(
      env,
      stub,
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("proactively refreshes when the TTL was lowered below the stored expiry (TOG-6528)", async () => {
    // Arrange — acceptance: logged in under a long TTL, then the reviewer
    // lowers the TTL. The stored far-future expiry must trigger a proactive
    // refresh instead of reusing the possibly-dead cookie.
    const holder = {
      value: { cookieHeader: "old", expiresAtMs: Date.now() + 30 * 60_000, refreshing: false } as SessionState
    };
    const stub = makeStub(holder);
    const loweredEnv = { ...env, SESSION_TTL_SECONDS: 300 } as unknown as Env;
    const establish = vi.fn(async () => {
      holder.value = { cookieHeader: "fresh", expiresAtMs: Date.now() + 300_000, refreshing: false };
    });
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Act
    const res = await forwardWithSessionRetry(
      loweredEnv,
      stub,
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    // Assert — one proactive refresh, one forward with the fresh cookie.
    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("does not refresh a missing session proactively (reactive path handles it)", async () => {
    const holder = { value: { cookieHeader: null, expiresAtMs: null, refreshing: false } as SessionState };
    const establish = vi.fn(async () => {});
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    expect(establish).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("does not proactively refresh a fresh session", async () => {
    const holder = {
      value: { cookieHeader: "c=1", expiresAtMs: Date.now() + 600_000, refreshing: false } as SessionState
    };
    const establish = vi.fn(async () => {});
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    expect(establish).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("does not retry-loop when the retry also sees a login redirect", async () => {
    const holder = {
      value: { cookieHeader: "c=1", expiresAtMs: Date.now() + 600_000, refreshing: false } as SessionState
    };
    const establish = vi.fn(async () => {
      holder.value = { cookieHeader: "fresh", expiresAtMs: Date.now() + 600_000, refreshing: false };
    });
    const fetchMock = vi.fn(async () => loginRedirect());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    // The retry's redirect is returned as-is: exactly 2 forwards, 1 refresh, no loop.
    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(302);
  });

  it("expiry storm: N concurrent redirects collapse to one login, one retry each", async () => {
    // Arrange — an expired session every request will see rejected upstream, and
    // the REAL establishSession (refresh lock + waitForConcurrentRefresh) with a
    // stubbed HTTP login publishing through the REAL storeSession.
    const N = 8;
    stormCounters.httpLogins = 0;
    const setCounter = { sets: 0 };
    const state: LockState = {
      cookieHeader: ".WebRW=stale",
      expiresAtMs: Date.now() + 600_000,
      refreshing: false,
      lockedAt: null,
      lockToken: null
    };
    const stub = makeLockStub(state, setCounter);
    const stormEnv = { ...env, AUTH_MODE: "http" } as unknown as Env;

    // Upstream rejects the stale cookie with a login redirect and serves the
    // fresh one: first wave redirects, retries succeed.
    const seenCookies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const cookie = new Headers(init?.headers).get("cookie") ?? "";
      seenCookies.push(cookie);
      if (cookie.includes(".WebRW=fresh")) {
        return new Response("ok", { status: 200 });
      }
      return loginRedirect();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Act — N requests race; all see the redirect before the fresh session lands
    // (the stubbed login holds 25ms so the whole first wave observes it).
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        forwardWithSessionRetry(
          stormEnv,
          stub,
          new Request("http://shadow/x"),
          UPSTREAM,
          null,
          establishSession
        )
      )
    );

    // Assert — one upstream login and one /set for the whole storm; every
    // request retried exactly once (N stale forwards + N fresh forwards) and
    // all N landed 200 with no retry loops (2N total, not more).
    expect(stormCounters.httpLogins).toBe(1);
    expect(setCounter.sets).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2 * N);
    expect(seenCookies.filter((c) => c.includes(".WebRW=stale"))).toHaveLength(N);
    expect(seenCookies.filter((c) => c.includes(".WebRW=fresh"))).toHaveLength(N);
    expect(results.map((r) => r.status)).toEqual(Array(N).fill(200));
    expect(state.cookieHeader).toBe(".WebRW=fresh");
  });

  it("reactively re-establishes and retries once on a 200 login page (TOG-6515)", async () => {
    // Arrange — the common ASP.NET expiry shape: HTTP 200 with a login form,
    // not a 302. Fixture is structural only (no credentials/PII).
    const holder = {
      value: { cookieHeader: "old", expiresAtMs: Date.now() + 600_000, refreshing: false } as SessionState
    };
    const establish = vi.fn(async () => {
      holder.value = { cookieHeader: "fresh", expiresAtMs: Date.now() + 600_000, refreshing: false };
    });
    const loginPage = () =>
      new Response(
        '<html><body><form action="/WebRW/Account/Login" method="post">' +
          '<input name="__RequestVerificationToken" type="hidden" value="FAKE-TOKEN" />' +
          '<input name="UserName" type="text" value="" />' +
          '<input name="Password" type="password" value="" />' +
          "</form></body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginPage())
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Act
    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    // Assert — one re-login, one retry, and the retried body is returned.
    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("does not retry-loop when the retry also sees a 200 login page (TOG-6515)", async () => {
    const holder = {
      value: { cookieHeader: "c=1", expiresAtMs: Date.now() + 600_000, refreshing: false } as SessionState
    };
    const establish = vi.fn(async () => {
      holder.value = { cookieHeader: "fresh", expiresAtMs: Date.now() + 600_000, refreshing: false };
    });
    const loginPage = () =>
      new Response(
        '<html><body><form action="/WebRW/Account/Login" method="post">' +
          '<input name="UserName" type="text" value="" />' +
          '<input name="Password" type="password" value="" />' +
          "</form></body></html>",
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    const fetchMock = vi.fn(async () => loginPage());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    // The retry's login page is returned as-is: exactly 2 forwards, 1 refresh, no loop.
    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("passes through a 200 JSON body mentioning login words without retrying (TOG-6515)", async () => {
    // Guards against false positives: JSON payloads are never body-sniffed.
    const holder = {
      value: { cookieHeader: "c=1", expiresAtMs: Date.now() + 600_000, refreshing: false } as SessionState
    };
    const establish = vi.fn(async () => {});
    const fetchMock = vi.fn(async () =>
      new Response('{"note":"Password reset for UserName"}', {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    expect(establish).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("reactively re-establishes and retries once on a login redirect", async () => {
    const holder = {
      value: { cookieHeader: "old", expiresAtMs: Date.now() + 600_000, refreshing: false } as SessionState
    };
    const establish = vi.fn(async () => {
      holder.value = { cookieHeader: "fresh", expiresAtMs: Date.now() + 600_000, refreshing: false };
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(loginRedirect())
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });
});
