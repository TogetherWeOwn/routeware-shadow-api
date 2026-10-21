import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { httpLogin } from "../src/lib/httpAuth";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import { AuthSession } from "../src/authSession.do";
import { authSessionTestState } from "./authSessionTestState";

/**
 * Fail fast on a non-200 login page.
 *
 * Amplification bug: `httpLogin` read the login page body without a status
 * check, so a WAF/maintenance 403/500 fell through to "anti-forgery token
 * not found" — which `establishSession` (auto mode) misread as a markup
 * change and answered with expensive Browser Rendering retries.
 *
 * What this pins:
 * 1. `httpLogin` throws `LoginPageUnavailableError` (naming the status, never
 *    the body) on a non-200 login-page GET and on a non-200 init-script GET.
 * 2. `establishSession` in auto mode does NOT fall back to the browser for
 *    this class and releases the refresh lock.
 * 3. A genuine 200 page with no token still throws the markup-change error
 *    AND still falls back to the browser (no over-correction).
 * 4. App level: an authorized request whose re-login hits a 403 login page
 *    gets a fast 502 naming the status — never a browser launch, never a 500.
 *
 * Fixture hygiene: bodies are structural stand-ins (FAKE literals, Example
 * names); the PII-shaped 403 body below asserts the scrub, never leaks —
 * the message must name the status while containing no byte of the body
 * (CONVENTIONS.md §§ 4-5).
 */

const browserLoginCalls = { count: 0 };

vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async (env: Env, stub: DurableObjectStub, _bootstrapUrl: string, lockToken?: string | null) => {
    browserLoginCalls.count += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    const { sessionExpiryMs } = await import("../src/lib/sessionState");
    await storeSession(stub, ".WebRW=SYNTHETIC-BROWSER-FALLBACK-NOT-A-CREDENTIAL", sessionExpiryMs(env), lockToken);
  })
}));

const { establishSession } = await import("../src/lib/establishSession");
const { isLoginPageUnavailableError } = await import("../src/lib/loginPageError");

const ORIGIN = "https://killeen.routeware.com";
const LOGIN_URL = `${ORIGIN}/WebRW/Account/Login`;
const UPSTREAM = `${ORIGIN}/WebRW/Home/Index`;
const FOREIGN_ORIGIN = "https://app.example.com";

const PII_BODY =
  `<html><body>WAF block — customer "Jane Example" phone 555-0199 ` +
  `Set-Cookie: .WebRW=FAKE-SESSION-VALUE; Path=/</body></html>`;

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
 * Refresh-lock stub: /lock grants a token, /unlock and /set verify it,
 * /get is empty — mirroring the owner check in `AuthSession`.
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
        const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as { lockToken?: unknown };
        if (state.refreshing !== true || body.lockToken === state.lockToken) {
          state.refreshing = false;
          state.lockToken = null;
        }
        return new Response("OK");
      }
      return new Response("Not Found", { status: 404 });
    }
  } as unknown as DurableObjectStub;
}

const originalFetch = globalThis.fetch;

describe("httpLogin fail-fast on non-200", () => {
  beforeEach(() => {
    browserLoginCalls.count = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws naming the status on a 403 login page, never the body", async () => {
    // Arrange — WAF block with a PII-shaped body.
    globalThis.fetch = (async () =>
      new Response(PII_BODY, { status: 403 })) as unknown as typeof fetch;

    // Act
    const failure = await httpLogin(baseEnv()).then(
      () => null,
      (err: unknown) => err
    );

    // Assert — typed error, status named, zero body bytes survive.
    expect(isLoginPageUnavailableError(failure)).toBe(true);
    const err = failure as Error & { status: number };
    expect(err.status).toBe(403);
    expect(err.message).toContain("403");
    expect(err.message).toContain("login page");
    expect(err.message).not.toContain("Anti-forgery");
    expect(err.message).not.toContain("Jane Example");
    expect(err.message).not.toContain("555-0199");
    expect(err.message).not.toContain("FAKE-SESSION-VALUE");
    expect(err.message).not.toContain("Set-Cookie");
  });

  it("throws naming the status on a 500 init-script fetch", async () => {
    // Arrange — 200 login page pointing at the Ext.NET init script but
    // carrying no token, then the script fetch 500s.
    const loginHtml =
      '<html><body><script src="/extnet-init-js/ext.axd?abc123"></script></body></html>';
    globalThis.fetch = (async (url: unknown) =>
      String(url).includes("ext.axd")
        ? new Response("upstream error page", { status: 500 })
        : new Response(loginHtml, {
            status: 200,
            headers: { "content-type": "text/html" }
          })) as unknown as typeof fetch;

    // Act
    const failure = await httpLogin(baseEnv()).then(
      () => null,
      (err: unknown) => err
    );

    // Assert
    expect(isLoginPageUnavailableError(failure)).toBe(true);
    expect((failure as Error & { status: number }).status).toBe(500);
    expect((failure as Error).message).toContain("init script");
  });

  it("a genuine 200 page with no token still throws the markup-change error (not the fail-fast)", async () => {
    // Arrange — a real 200 login page whose markup genuinely changed.
    globalThis.fetch = (async () =>
      new Response("<html><body>redesigned login, no token</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })) as unknown as typeof fetch;

    // Act
    const failure = await httpLogin(baseEnv()).then(
      () => null,
      (err: unknown) => err
    );

    // Assert — the old error survives (it is the browser-fallback trigger),
    // and the fail-fast predicate does not over-match it.
    expect(isLoginPageUnavailableError(failure)).toBe(false);
    expect((failure as Error).message).toContain("Anti-forgery token not found");
  });
});

describe("establishSession never launches the browser for a blocked login page", () => {
  beforeEach(() => {
    browserLoginCalls.count = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("auto mode rethrows the 403 without a browser launch and releases the lock", async () => {
    // Arrange — free lock, upstream login page 403s.
    const state = { refreshing: false, lockToken: null as string | null };
    globalThis.fetch = (async () =>
      new Response(PII_BODY, { status: 403 })) as unknown as typeof fetch;

    // Act
    const failure = await establishSession(baseEnv(), lockStub(state), LOGIN_URL).then(
      () => null,
      (err: unknown) => err
    );

    // Assert — the 403 propagates (not a fallback), zero browser launches,
    // and the lock is released so a recovered upstream retries cleanly.
    expect(isLoginPageUnavailableError(failure)).toBe(true);
    expect((failure as Error & { status: number }).status).toBe(403);
    expect(browserLoginCalls.count).toBe(0);
    expect(state.refreshing).toBe(false);
  });

  it("auto mode still falls back to the browser on a genuine 200 markup change", async () => {
    // Arrange — 200 page, no token anywhere: the case the fallback exists for.
    // Real DO so the lock-token threading is exercised end to end:
    // the browser fallback publishes with the holder's token.
    const fake = authSessionTestState();
    const session = new AuthSession(fake.state, {} as Env);
    await fake.ready();
    const stub = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => session.fetch(new Request(input, init))
    } as unknown as DurableObjectStub;
    globalThis.fetch = (async () =>
      new Response("<html><body>redesigned login, no token</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      })) as unknown as typeof fetch;

    // Act
    await establishSession(baseEnv(), stub, LOGIN_URL);

    // Assert — the fallback ran exactly once and published a usable session.
    expect(browserLoginCalls.count).toBe(1);
    expect(fake.values.get("cookieHeader")).toBe(".WebRW=SYNTHETIC-BROWSER-FALLBACK-NOT-A-CREDENTIAL");
    expect(fake.values.get("expiresAtMs")).toBeGreaterThan(Date.now());
    expect(fake.values.get("refreshing")).toBe(false);
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
function blockedAppEnv(fetchImpl: typeof fetch): Env {
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

describe("app 502 on blocked login page", () => {
  beforeEach(() => {
    browserLoginCalls.count = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a fast 502 bad-gateway naming the 403, never launching the browser", async () => {
    // Arrange — the forward hits a login redirect (drives the reactive
    // re-login), then the login-page GET 403s. Anything else is an
    // unexpected upstream call — fail loudly, never reach the network.
    let calls = 0;
    const fetchImpl = (async (url: unknown) => {
      calls += 1;
      const s = String(url);
      if (s === LOGIN_URL) {
        return new Response(PII_BODY, { status: 403 });
      }
      if (s === UPSTREAM) {
        return new Response(null, { status: 302, headers: { location: LOGIN_URL } });
      }
      throw new Error(`unexpected upstream URL: ${s}`);
    }) as unknown as typeof fetch;
    const env = blockedAppEnv(fetchImpl);
    const req = new Request("http://test.local/api/v1/routeware/home/index", {
      headers: {
        authorization: "Bearer test-api-token",
        Origin: FOREIGN_ORIGIN
      }
    });

    // Act
    const res = await app.fetch(req, env, ctx);

    // Assert — fast 502 (not 500), detail names the 403 with no body bytes;
    // exactly 2 upstream calls (forward + login-page GET), zero browser.
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("problem+json");
    // onError branch (login-page unavailable, src/app.ts) must carry the API
    // posture via withCors — otherwise a browser sees a CORS error instead
    // of the real 502.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("access-control-allow-origin")).toBe(FOREIGN_ORIGIN);
    expect(res.headers.get("vary")).toMatch(/origin/i);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail?: string;
      stack?: unknown;
    };
    expect(body.type).toBe(`${PROBLEM_TYPE_BASE}bad-gateway`);
    expect(body.title).toBe("Upstream login unavailable");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("403");
    expect(body.detail).not.toContain("Jane Example");
    expect(body.detail).not.toContain("FAKE-SESSION-VALUE");
    expect("stack" in body).toBe(false);
    expect(calls).toBe(2);
    expect(browserLoginCalls.count).toBe(0);
  });
});
