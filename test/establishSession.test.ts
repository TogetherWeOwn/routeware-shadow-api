import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConcurrentRefreshTimeoutError } from "../src/lib/sessionRefreshLock";

const httpLoginCalls = { count: 0 };
const browserLoginCalls = { count: 0 };
const setCalls = { count: 0 };
let httpLoginShouldFail = false;

/** Must match LOCK_TTL_MS in src/authSession.do.ts. */
const LOCK_TTL_MS = 120_000;

// The login strategies are stubbed (no network/browser), but they publish the
// session through the REAL storeSession, so this file exercises the actual
// store-and-unlock wiring rather than a reimplementation of it.
vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    httpLoginCalls.count += 1;
    if (httpLoginShouldFail) {
      throw new Error("HTTP login failed (status 500)");
    }
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=http", Date.now() + 60_000, lockToken);
  })
}));

vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async (_env: Env, stub: DurableObjectStub, _bootstrapUrl: string, lockToken?: string | null) => {
    browserLoginCalls.count += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=browser", Date.now() + 60_000, lockToken);
  })
}));

const { establishSession } = await import("../src/lib/establishSession");
const { isConcurrentRefreshTimeout } = await import("../src/lib/sessionRefreshLock");

/**
 * `establishSession` must serialize logins through the AuthSession refresh lock
 * on EVERY auth mode. Before this was hoisted out of the browser-only path, the
 * default `AUTH_MODE=auto` (HTTP-first) bypassed the lock entirely, so N
 * concurrent requests on a cold start each drove a full upstream login.
 */

type LockState = {
  refreshing: boolean;
  lockedAt: number | null;
  lockToken: string | null;
  cookieHeader: string | null;
};

/**
 * Durable Object stub fake implementing the real /lock, /takeover, /unlock,
 * /set, /get semantics, including the LOCK_TTL_MS stale-lock expiry and the
 * TOG-18959 lock-token owner check: a lock older than the TTL is treated as
 * crashed and re-granted with a fresh token, and only the matching token
 * releases a held lock — matching `AuthSession`.
 */
function fakeStub(
  state: LockState,
  options: { rejectSet?: boolean; unlockFailure?: unknown } = {}
): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input)).pathname;

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
        if ("unlockFailure" in options) {
          throw options.unlockFailure;
        }
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
        setCalls.count += 1;
        if (options.rejectSet) {
          // Mirrors the DO's parseSetBody rejection: 400 and the lock stays held.
          return new Response("Bad Request", { status: 400 });
        }
        const body = JSON.parse(String(init?.body)) as { cookieHeader: string; lockToken?: unknown };
        state.cookieHeader = body.cookieHeader;
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
          expiresAtMs: state.cookieHeader ? Date.now() + 60_000 : null,
          refreshing: state.refreshing
        });
      }
      return new Response("Not Found", { status: 404 });
    }
  } as unknown as DurableObjectStub;
}

function freshState(): LockState {
  return { refreshing: false, lockedAt: null, lockToken: null, cookieHeader: null };
}

function envWith(mode: string): Env {
  return { AUTH_MODE: mode, LOGIN_URL: "https://upstream/Account/Login" } as unknown as Env;
}

describe("establishSession refresh-lock serialization", () => {
  beforeEach(() => {
    httpLoginCalls.count = 0;
    browserLoginCalls.count = 0;
    setCalls.count = 0;
    httpLoginShouldFail = false;
  });

  it("performs exactly one HTTP login for many concurrent cold-start requests", async () => {
    // Arrange — default auto mode, no session stored yet
    const state = freshState();
    const stub = fakeStub(state);
    const env = envWith("auto");

    // Act — 10 requests race to establish a session
    await Promise.all(
      Array.from({ length: 10 }, () => establishSession(env, stub, env.LOGIN_URL))
    );

    // Assert — the lock collapsed them into a single upstream login and a
    // single /set; the other 9 waited via waitForConcurrentRefresh. Both
    // counters matter: one login but N writes would still hammer the DO.
    expect(httpLoginCalls.count).toBe(1);
    expect(setCalls.count).toBe(1);
    expect(state.cookieHeader).toBe(".WebRW=http");
  });

  it("performs exactly one login for concurrent requests on an expired session", async () => {
    // Arrange — a stale cookie from a previous session, now expired
    const state: LockState = {
      refreshing: false,
      lockedAt: null,
      lockToken: null,
      cookieHeader: ".WebRW=stale"
    };
    const stub = fakeStub(state);
    const env = envWith("auto");

    // Act — 10 requests race on the expired session
    await Promise.all(
      Array.from({ length: 10 }, () => establishSession(env, stub, env.LOGIN_URL))
    );

    // Assert — one upstream login, one /set, and the stale cookie replaced
    expect(httpLoginCalls.count).toBe(1);
    expect(setCalls.count).toBe(1);
    expect(state.cookieHeader).toBe(".WebRW=http");
  });

  it("lets a waiter acquire a stale lock after the TTL expires", async () => {
    // Arrange — a lock whose holder crashed: held, but older than LOCK_TTL_MS.
    // Fake timers control Date.now() on both sides (fake /lock and real DO
    // both read wall-clock), so the TTL boundary is deterministic.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const state: LockState = {
        refreshing: true,
        lockedAt: Date.now(),
        lockToken: "synthetic-crashed-holder",
        cookieHeader: null
      };
      const stub = fakeStub(state);
      const env = envWith("http");

      // Act — advance past the TTL; the next caller must treat the lock as
      // stale and run its own login rather than waiting on a dead holder.
      vi.setSystemTime(new Date(Date.now() + LOCK_TTL_MS + 1));
      await establishSession(env, stub, env.LOGIN_URL);

      // Assert — the stale lock did not wedge authentication
      expect(httpLoginCalls.count).toBe(1);
      expect(setCalls.count).toBe(1);
      expect(state.cookieHeader).toBe(".WebRW=http");
      expect(state.refreshing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when a fresh lock is held by a stalled holder (TOG-6526)", async () => {
    // Arrange — a holder took the lock "now" and then stalled without
    // publishing a session (no /set, no /unlock). The lock stays fresh for
    // the whole wait, so the waiter must time out without logging in itself —
    // a duplicate login here is exactly the thundering-herd the lock exists
    // to prevent. Fake timers drive waitForConcurrentRefresh's poll loop
    // deterministically (90s default timeout, TOG-6527).
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const state: LockState = {
        refreshing: true,
        lockedAt: Date.now(),
        lockToken: "synthetic-crashed-holder",
        cookieHeader: null
      };
      const stub = fakeStub(state);

      // Act — waiter arrives, polls past its 90s timeout while the lock stays fresh
      const pending = establishSession(
        envWith("http"),
        stub,
        "https://upstream/Account/Login"
      );
      // Attach the settlement handler before advancing so the rejection is
      // never unhandled under the workerd pool.
      const settled = pending.then(
        () => null,
        (err: unknown) => err
      );
      await vi.advanceTimersByTimeAsync(95_000);
      const failure = await settled;

      // Assert — the waiter threw a PII-free timeout (never a silent return
      // that would forward with the expired cookie); no second login ran and
      // the unexpired lock was not taken over.
      expect(isConcurrentRefreshTimeout(failure)).toBe(true);
      expect((failure as ConcurrentRefreshTimeoutError).timeoutMs).toBe(90_000);
      expect((failure as Error).message).toBe(
        "Concurrent session refresh timed out after 90000ms"
      );
      expect(httpLoginCalls.count).toBe(0);
      expect(setCalls.count).toBe(0);
      expect(state.refreshing).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes the browser path too", async () => {
    // Arrange
    const state = freshState();
    const stub = fakeStub(state);
    const env = envWith("browser");

    // Act
    await Promise.all(
      Array.from({ length: 5 }, () => establishSession(env, stub, env.LOGIN_URL))
    );

    // Assert
    expect(browserLoginCalls.count).toBe(1);
    expect(httpLoginCalls.count).toBe(0);
  });

  it("releases the lock when the login fails so a later request can retry", async () => {
    // Arrange — http mode so the failure is not swallowed by the browser fallback
    const state = freshState();
    const stub = fakeStub(state);
    const env = envWith("http");
    httpLoginShouldFail = true;

    // Act
    await expect(establishSession(env, stub, env.LOGIN_URL)).rejects.toThrow("HTTP login failed");

    // Assert — lock released, so a retry is possible rather than wedged
    expect(state.refreshing).toBe(false);
    httpLoginShouldFail = false;
    await establishSession(env, stub, env.LOGIN_URL);
    expect(state.cookieHeader).toBe(".WebRW=http");
  });

  it("preserves the original auth failure when lock release rejects with a hostile object", async () => {
    const state = freshState();
    const inspect = vi.fn(() => {
      throw new Error(".WebRW=SYNTHETIC-UNLOCK-NOT-A-CREDENTIAL");
    });
    const stub = fakeStub(state, { unlockFailure: { toString: inspect } });
    const env = envWith("http");
    const authFailure = new Error("Original synthetic auth failure");
    const { establishSessionViaHttp } = await import("../src/lib/httpAuth");
    vi.mocked(establishSessionViaHttp).mockRejectedValueOnce(authFailure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(establishSession(env, stub, env.LOGIN_URL)).rejects.toBe(authFailure);

      expect(inspect).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith({
        level: "warn",
        msg: "Failed to release the auth refresh lock; it will expire via its TTL",
        route: "auth.refreshLock",
        ms: null
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SYNTHETIC-UNLOCK-NOT-A-CREDENTIAL");
      expect(state.refreshing).toBe(true);
      expect(state.cookieHeader).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to the browser under the same single lock when HTTP login fails in auto mode", async () => {
    // Arrange
    const state = freshState();
    const stub = fakeStub(state);
    const env = envWith("auto");
    httpLoginShouldFail = true;

    // Act
    await establishSession(env, stub, env.LOGIN_URL);

    // Assert — the fallback ran without deadlocking on a lock it already held
    expect(httpLoginCalls.count).toBe(1);
    expect(browserLoginCalls.count).toBe(1);
    expect(state.cookieHeader).toBe(".WebRW=browser");
    expect(state.refreshing).toBe(false);
  });

  it("releases the lock when the DO rejects the session write", async () => {
    // Arrange — the DO 400s the /set (e.g. a NaN expiry). The login "succeeds"
    // but nothing is stored, so the lock must not be left held.
    const state = freshState();
    const stub = fakeStub(state, { rejectSet: true });
    const env = envWith("http");

    // Act
    await expect(establishSession(env, stub, env.LOGIN_URL)).rejects.toThrow(
      /rejected the session write/
    );

    // Assert — lock released rather than wedged for the full TTL
    expect(state.refreshing).toBe(false);
    expect(state.cookieHeader).toBeNull();
  });

  it("accepts a live published session even when another caller re-locks before verification", async () => {
    // Arrange — our login publishes a live cookie, but another caller takes
    // the lock again before our post-login verification read lands. The guard
    // must judge only the cookie material, not lock ownership.
    const state = freshState();
    const inner = fakeStub(state);
    const innerFetch = inner.fetch.bind(inner);
    const stub = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const response = await innerFetch(input, init);
        const path = new URL(typeof input === "string" ? input : String(input)).pathname;
        if (path === "/set") {
          // Another caller immediately re-acquires the lock after our publish.
          state.refreshing = true;
          state.lockedAt = Date.now();
        }
        if (path === "/get") {
          const body = (await response.json()) as Record<string, unknown>;
          return Response.json({ ...body, refreshing: true });
        }
        return response;
      }
    } as unknown as DurableObjectStub;

    // Act — must not throw "without an available live session"
    await establishSession(envWith("http"), stub, envWith("http").LOGIN_URL);

    // Assert — our cookie is live and the other caller's lock is untouched
    expect(state.cookieHeader).toBe(".WebRW=http");
    expect(state.refreshing).toBe(true);
  });

  it("rejects when the published session already expired by verification time", async () => {
    // Arrange — login publishes, but the cookie is already past expiry when
    // verified (delayed write/read). Must fail rather than report success.
    const state = freshState();
    const inner = fakeStub(state);
    const innerFetch = inner.fetch.bind(inner);
    const stub = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const response = await innerFetch(input, init);
        const path = new URL(typeof input === "string" ? input : String(input)).pathname;
        if (path === "/get") {
          return Response.json({
            cookieHeader: ".WebRW=http",
            expiresAtMs: Date.now() - 1,
            refreshing: false
          });
        }
        return response;
      }
    } as unknown as DurableObjectStub;

    // Act / Assert
    await expect(
      establishSession(envWith("http"), stub, envWith("http").LOGIN_URL)
    ).rejects.toThrow(/without an available live session/);
  });

  it("waits for the in-flight refresh instead of logging in again", async () => {
    // Arrange — someone else already holds the lock and has published a session
    const state: LockState = {
      refreshing: true,
      lockedAt: Date.now(),
      lockToken: "synthetic-prior-holder",
      cookieHeader: ".WebRW=already-established"
    };
    const stub = fakeStub(state);

    // The holder finishes shortly after the waiter starts polling.
    setTimeout(() => {
      state.refreshing = false;
    }, 10);

    // Act
    await establishSession(envWith("auto"), stub, "https://upstream/Account/Login");

    // Assert — the waiter did not start its own login
    expect(httpLoginCalls.count).toBe(0);
    expect(browserLoginCalls.count).toBe(0);
  });
});
