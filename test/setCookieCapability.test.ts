import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { httpLogin, mergeSetCookies } from "../src/lib/httpAuth";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";

/**
 * Fail fast when the runtime has no `Headers.getSetCookie` (TOG-6537).
 *
 * Silent-mode-flip bug: `mergeSetCookies` fell back to `[]` when the runtime
 * lacked `getSetCookie`, so every HTTP login silently collected an empty jar —
 * `http` mode hard-outaged and `auto` mode flipped to expensive Browser
 * Rendering logins with no diagnosis.
 *
 * What this pins:
 * 1. `mergeSetCookies` throws `MissingSetCookieCapabilityError` (never an
 *    empty merge) when `getSetCookie` is absent.
 * 2. `httpLogin` throws the capability error before any upstream fetch.
 * 3. `establishSession` in auto mode does NOT fall back to the browser for
 *    this class and releases the refresh lock.
 * 4. App level: an authorized request whose re-login hits the missing
 *    capability gets a fast 503 naming it — never a browser launch, never
 *    a 500.
 *
 * Fixture hygiene: cookie values are `FAKE-` literals; the error message is
 * a fixed string carrying no URL, body, cookie, or PII (CONVENTIONS.md
 * §§ 4-5).
 */

const browserLoginCalls = { count: 0 };

vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async () => {
    browserLoginCalls.count += 1;
  })
}));

const { establishSession } = await import("../src/lib/establishSession");
const { isMissingSetCookieCapabilityError } = await import(
  "../src/lib/setCookieCapabilityError"
);

const ORIGIN = "https://killeen.routeware.com";
const LOGIN_URL = `${ORIGIN}/WebRW/Account/Login`;
const UPSTREAM = `${ORIGIN}/WebRW/Home/Index`;

function baseEnv(extra: Record<string, unknown> = {}): Env {
  return {
    AUTH_MODE: "auto",
    LOGIN_URL,
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: "/WebRW",
    SESSION_TTL_SECONDS: 1800,
    LOGIN_USERNAME: "operator",
    LOGIN_PASSWORD: "FAKE-PASSWORD-STAND-IN",
    SHADOW_API_TOKEN: "test-api-token",
    ...extra
  } as unknown as Env;
}

/**
 * Minimal refresh-lock stub: /lock grants a token, /unlock verifies it,
 * /get is empty — mirroring the TOG-18959 owner check in `AuthSession`.
 */
function lockStub(state: { refreshing: boolean; lockToken: string | null }): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input)).pathname;
      if (path === "/lock" || path === "/takeover") {
        state.refreshing = true;
        state.lockToken = "synthetic-lock-token";
        return Response.json({ lockToken: state.lockToken });
      }
      if (path === "/unlock") {
        if (state.refreshing === true) {
          const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as { lockToken?: unknown };
          if (body.lockToken !== state.lockToken) {
            return new Response("Forbidden", { status: 403 });
          }
        }
        state.refreshing = false;
        state.lockToken = null;
        return new Response("OK");
      }
      if (path === "/get") {
        return Response.json({ cookieHeader: null, expiresAtMs: null, refreshing: false });
      }
      if (path === "/set") {
        state.refreshing = false;
        return new Response("OK");
      }
      return new Response("Not Found", { status: 404 });
    }
  } as unknown as DurableObjectStub;
}

const getSetCookieDescriptor = Object.getOwnPropertyDescriptor(
  Headers.prototype,
  "getSetCookie"
);

/** Simulate a runtime without `Headers.getSetCookie` (the reviewer probe). */
function removeGetSetCookie(): void {
  delete (Headers.prototype as unknown as Record<string, unknown>).getSetCookie;
}

function restoreGetSetCookie(): void {
  if (getSetCookieDescriptor) {
    Object.defineProperty(Headers.prototype, "getSetCookie", getSetCookieDescriptor);
  }
}

const originalFetch = globalThis.fetch;

describe("mergeSetCookies fails fast without getSetCookie (TOG-6537)", () => {
  afterEach(() => {
    restoreGetSetCookie();
  });

  it("throws the capability error instead of merging nothing", () => {
    // Arrange — a response carrying a session cookie; sanity-check the
    // present runtime really merges before simulating the missing API.
    const res = new Response("ok", {
      headers: { "set-cookie": ".WebRW=FAKE-SESSION; Path=/" }
    });
    const sane: Record<string, string> = {};
    mergeSetCookies(sane, res);
    expect(sane[".WebRW"]).toBe("FAKE-SESSION");

    removeGetSetCookie();

    // Act
    const jar: Record<string, string> = {};
    const failure = (() => {
      try {
        mergeSetCookies(jar, res);
        return null;
      } catch (err) {
        return err;
      }
    })();

    // Assert — explicit capability error, never a silent empty merge; the
    // fixed message names the API and carries no cookie value.
    expect(isMissingSetCookieCapabilityError(failure)).toBe(true);
    expect(jar).toEqual({});
    expect((failure as Error).message).toContain("getSetCookie");
    expect((failure as Error).message).not.toContain("FAKE-SESSION");
  });
});

describe("httpLogin fails fast without getSetCookie (TOG-6537)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreGetSetCookie();
  });

  it("throws the capability error before any upstream fetch", async () => {
    // Arrange — capability missing; any fetch is a bug, fail loudly.
    removeGetSetCookie();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("unexpected upstream call");
    }) as unknown as typeof fetch;

    // Act
    const failure = await httpLogin(baseEnv()).then(
      () => null,
      (err: unknown) => err
    );

    // Assert — explicit error with zero upstream traffic (no empty jar
    // collected, nothing to misdiagnose as a markup change).
    expect(isMissingSetCookieCapabilityError(failure)).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("establishSession never launches the browser without getSetCookie (TOG-6537)", () => {
  beforeEach(() => {
    browserLoginCalls.count = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreGetSetCookie();
  });

  it("auto mode rethrows without a browser launch and releases the lock", async () => {
    // Arrange — free lock, capability missing.
    const state = { refreshing: false, lockToken: null as string | null };
    removeGetSetCookie();
    globalThis.fetch = (async () => {
      throw new Error("unexpected upstream fetch: capability assert must run first");
    }) as unknown as typeof fetch;

    // Act
    const failure = await establishSession(baseEnv(), lockStub(state), LOGIN_URL).then(
      () => null,
      (err: unknown) => err
    );

    // Assert — the capability error propagates (not a fallback), zero
    // browser launches, and the lock is released so a fixed runtime retries
    // cleanly.
    expect(isMissingSetCookieCapabilityError(failure)).toBe(true);
    expect(browserLoginCalls.count).toBe(0);
    expect(state.refreshing).toBe(false);
  });
});

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

/**
 * Synthetic env for direct `app.fetch` calls: drives the full route →
 * forward → reactive re-login → onError path with a stubbed upstream.
 */
function capabilityAppEnv(fetchImpl: typeof fetch): Env {
  const state = { refreshing: false, lockToken: null as string | null };
  const stub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input)).pathname;
      if (path === "/lock" || path === "/takeover") {
        state.refreshing = true;
        state.lockToken = "synthetic-lock-token";
        return Response.json({ lockToken: state.lockToken });
      }
      if (path === "/unlock") {
        if (state.refreshing === true) {
          const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as { lockToken?: unknown };
          if (body.lockToken !== state.lockToken) {
            return new Response("Forbidden", { status: 403 });
          }
        }
        state.refreshing = false;
        state.lockToken = null;
        return new Response("OK");
      }
      if (path === "/throttle/clear" || path === "/throttle/failure") {
        return Response.json({ blocked: false, retryAfterSec: 0 });
      }
      if (path === "/get") {
        return Response.json({ cookieHeader: null, expiresAtMs: null, refreshing: false });
      }
      return new Response("Not Found", { status: 404 });
    }
  };
  const AUTH_SESSION = {
    idFromName: (name: string) => name,
    get: (_id: string) => stub
  };
  const env = baseEnv({ AUTH_SESSION });
  globalThis.fetch = fetchImpl;
  return env;
}

describe("app 503 on missing getSetCookie capability (TOG-6537)", () => {
  beforeEach(() => {
    browserLoginCalls.count = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreGetSetCookie();
  });

  it("returns a fast 503 misconfigured naming the capability, never launching the browser", async () => {
    // Arrange — the forward hits a login redirect (drives the reactive
    // re-login), which fails fast on the missing capability before any login
    // fetch. Anything beyond the forward is an unexpected upstream call.
    removeGetSetCookie();
    let calls = 0;
    const fetchImpl = (async (url: unknown) => {
      calls += 1;
      const s = String(url);
      if (s === UPSTREAM) {
        return new Response(null, { status: 302, headers: { location: LOGIN_URL } });
      }
      throw new Error(`unexpected upstream URL: ${s}`);
    }) as unknown as typeof fetch;
    const env = capabilityAppEnv(fetchImpl);
    const req = new Request("http://test.local/api/v1/routeware/home/index", {
      headers: { authorization: "Bearer test-api-token" }
    });

    // Act
    const res = await app.fetch(req, env, ctx);

    // Assert — fast 503 (not 500), detail names the capability with no
    // cookie/PII bytes; exactly 1 upstream call (the forward), zero browser.
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail?: string;
      stack?: unknown;
    };
    expect(body.type).toBe(`${PROBLEM_TYPE_BASE}misconfigured`);
    expect(body.title).toBe("Service Unavailable");
    expect(body.status).toBe(503);
    expect(body.detail).toContain("getSetCookie");
    expect("stack" in body).toBe(false);
    expect(calls).toBe(1);
    expect(browserLoginCalls.count).toBe(0);
  });
});
