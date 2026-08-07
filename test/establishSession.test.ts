import { beforeEach, describe, expect, it, vi } from "vitest";

const httpLoginCalls = { count: 0 };
const browserLoginCalls = { count: 0 };
let httpLoginShouldFail = false;

// The login strategies are stubbed (no network/browser), but they publish the
// session through the REAL storeSession, so this file exercises the actual
// store-and-unlock wiring rather than a reimplementation of it.
vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub) => {
    httpLoginCalls.count += 1;
    if (httpLoginShouldFail) {
      throw new Error("HTTP login failed (status 500)");
    }
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=http", Date.now() + 60_000);
  })
}));

vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async (_env: Env, stub: DurableObjectStub) => {
    browserLoginCalls.count += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=browser", Date.now() + 60_000);
  })
}));

const { establishSession } = await import("../src/lib/establishSession");

/**
 * `establishSession` must serialize logins through the AuthSession refresh lock
 * on EVERY auth mode. Before this was hoisted out of the browser-only path, the
 * default `AUTH_MODE=auto` (HTTP-first) bypassed the lock entirely, so N
 * concurrent requests on a cold start each drove a full upstream login.
 */

type LockState = {
  refreshing: boolean;
  lockedAt: number | null;
  cookieHeader: string | null;
};

/** Durable Object stub fake implementing the real /lock, /unlock, /set, /get semantics. */
function fakeStub(
  state: LockState,
  options: { rejectSet?: boolean } = {}
): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input)).pathname;

      if (path === "/lock") {
        if (state.refreshing) {
          return new Response("LOCKED", { status: 423 });
        }
        state.refreshing = true;
        state.lockedAt = Date.now();
        return new Response("OK");
      }
      if (path === "/unlock") {
        state.refreshing = false;
        state.lockedAt = null;
        return new Response("OK");
      }
      if (path === "/set") {
        if (options.rejectSet) {
          // Mirrors the DO's parseSetBody rejection: 400 and the lock stays held.
          return new Response("Bad Request", { status: 400 });
        }
        const body = JSON.parse(String(init?.body)) as { cookieHeader: string };
        state.cookieHeader = body.cookieHeader;
        state.refreshing = false;
        state.lockedAt = null;
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
  return { refreshing: false, lockedAt: null, cookieHeader: null };
}

function envWith(mode: string): Env {
  return { AUTH_MODE: mode, LOGIN_URL: "https://upstream/Account/Login" } as unknown as Env;
}

describe("establishSession refresh-lock serialization", () => {
  beforeEach(() => {
    httpLoginCalls.count = 0;
    browserLoginCalls.count = 0;
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

    // Assert — the lock collapsed them into a single upstream login
    expect(httpLoginCalls.count).toBe(1);
    expect(state.cookieHeader).toBe(".WebRW=http");
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

  it("waits for the in-flight refresh instead of logging in again", async () => {
    // Arrange — someone else already holds the lock and has published a session
    const state: LockState = {
      refreshing: true,
      lockedAt: Date.now(),
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
