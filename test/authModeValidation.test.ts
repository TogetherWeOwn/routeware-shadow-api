import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";

/**
 * Closed `AUTH_MODE` validation.
 *
 * Cost bug: `mode` was lowercased but never validated, so a typo (e.g.
 * `AUTH_MODE=browserr`) fell into the HTTP-then-browser fallback and silently
 * triggered expensive Browser Rendering logins on what the operator intended
 * as an `http`-only deploy. Validation now fails fast in `login()` — before
 * any login attempt — and `app.onError` maps it to a 503 `misconfigured`
 * problem+json naming the valid values.
 *
 * What this pins:
 * 1. `resolveAuthMode` accepts the closed set (case-insensitive, trimmed),
 *    defaults an absent var to `"auto"`, and throws `InvalidAuthModeError`
 *    (naming the received value) for anything else.
 * 2. `establishSession` with a typo rejects WITHOUT attempting either login
 *    strategy and releases the refresh lock (no wedge, no browser launch).
 * 3. App level: an authorized request under `AUTH_MODE=browserr` gets a fast
 *    503 naming the valid values — never a browser launch, never a 500.
 *
 * Fixture hygiene: the only "values" here are mode typos and placeholder
 * URLs/cookies — no credentials, no customer PII (CONVENTIONS.md §§ 4-5).
 */

const httpLoginCalls = { count: 0 };
const browserLoginCalls = { count: 0 };

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async () => {
    httpLoginCalls.count += 1;
  })
}));

vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async () => {
    browserLoginCalls.count += 1;
  })
}));

const {
  AUTH_MODES,
  InvalidAuthModeError,
  establishSession,
  isInvalidAuthModeError,
  resolveAuthMode
} = await import("../src/lib/establishSession");

const LOGIN_URL = "https://killeen.routeware.com/WebRW/Account/Login";

function envWith(mode: unknown): Env {
  return {
    AUTH_MODE: mode,
    LOGIN_URL,
    TARGET_ORIGIN: "https://killeen.routeware.com",
    TARGET_BASE_PATH: "/WebRW",
    SESSION_TTL_SECONDS: 1800,
    SHADOW_API_TOKEN: "test-api-token"
  } as unknown as Env;
}

/**
 * Minimal refresh-lock stub: /lock grants a token, /unlock verifies it,
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
      return new Response("Not Found", { status: 404 });
    }
  } as unknown as DurableObjectStub;
}

describe("resolveAuthMode", () => {
  it("accepts the closed set case-insensitively with surrounding whitespace", () => {
    expect(resolveAuthMode(envWith("auto"))).toBe("auto");
    expect(resolveAuthMode(envWith("http"))).toBe("http");
    expect(resolveAuthMode(envWith("browser"))).toBe("browser");
    expect(resolveAuthMode(envWith("AUTO"))).toBe("auto");
    expect(resolveAuthMode(envWith(" Http "))).toBe("http");
  });

  it("defaults an absent AUTH_MODE to auto (the wrangler.toml default)", () => {
    const env = envWith("auto");
    delete (env as unknown as Record<string, unknown>).AUTH_MODE;
    expect(resolveAuthMode(env)).toBe("auto");
  });

  it("throws InvalidAuthModeError naming the received value and the valid set", () => {
    for (const typo of ["browserr", "magic", "", "htt p"]) {
      let caught: unknown;
      try {
        resolveAuthMode(envWith(typo));
      } catch (err) {
        caught = err;
      }
      expect(isInvalidAuthModeError(caught)).toBe(true);
      const err = caught as InstanceType<typeof InvalidAuthModeError>;
      expect(err).toBeInstanceOf(InvalidAuthModeError);
      expect(err.message).toContain("AUTH_MODE");
      expect(err.message).toContain(JSON.stringify(typo));
      for (const mode of AUTH_MODES) {
        expect(err.message).toContain(mode);
      }
    }
  });
});

describe("establishSession with a typo'd AUTH_MODE", () => {
  beforeEach(() => {
    httpLoginCalls.count = 0;
    browserLoginCalls.count = 0;
  });

  it("rejects without attempting either login strategy and releases the lock", async () => {
    // Arrange — typo'd mode, free lock
    const state = { refreshing: false, lockToken: null as string | null };
    const stub = lockStub(state);

    // Act
    const failure = await establishSession(envWith("browserr"), stub, LOGIN_URL).then(
      () => null,
      (err: unknown) => err
    );

    // Assert — the typo, not a login failure; zero upstream attempts on
    // either path (in particular, no Browser Rendering launch); the lock is
    // released so a corrected config retries instead of wedging on the TTL.
    expect(isInvalidAuthModeError(failure)).toBe(true);
    expect((failure as Error).message).toContain("browserr");
    expect(httpLoginCalls.count).toBe(0);
    expect(browserLoginCalls.count).toBe(0);
    expect(state.refreshing).toBe(false);
  });
});

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

const originalFetch = globalThis.fetch;

/**
 * Synthetic env for direct `app.fetch` calls: the `cloudflare:workers`
 * self-fetch path always runs under `[env.test.vars]` (AUTH_MODE="auto") and
 * cannot exercise the typo branch, so the app is driven directly like
 * `test/openapiDocsGate.test.ts` does.
 */
function typoAppEnv(): Env {
  const state = { refreshing: false, lockToken: null as string | null };
  const stub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input)).pathname;
      if (path === "/lock" || path === "/takeover") {
        state.refreshing = true;
        state.lockToken = "synthetic-lock-token";
        return Response.json({ lockToken: state.lockToken });
      }
      if (path === "/unlock" || path === "/throttle/clear" || path === "/throttle/failure") {
        if (path === "/unlock" && state.refreshing === true) {
          const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as { lockToken?: unknown };
          if (body.lockToken !== state.lockToken) {
            return new Response("Forbidden", { status: 403 });
          }
          state.refreshing = false;
          state.lockToken = null;
        }
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
  return {
    AUTH_MODE: "browserr",
    LOGIN_URL,
    TARGET_ORIGIN: "https://killeen.routeware.com",
    TARGET_BASE_PATH: "/WebRW",
    SESSION_TTL_SECONDS: 1800,
    SHADOW_API_TOKEN: "test-api-token",
    AUTH_SESSION
  } as unknown as Env;
}

describe("app 503 on typo'd AUTH_MODE", () => {
  beforeEach(() => {
    httpLoginCalls.count = 0;
    browserLoginCalls.count = 0;
    // Upstream rejects the (absent) session with a login redirect, which is
    // what drives the reactive re-login that must fail fast on the typo.
    // Anything else would be an unexpected upstream call — fail loudly, and
    // never reach the network (CONVENTIONS.md §3).
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: LOGIN_URL }
      })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a fast 503 misconfigured naming the valid values, never launching the browser", async () => {
    // Arrange — authorized request under a typo'd AUTH_MODE
    const req = new Request("http://test.local/api/v1/routeware/home/index", {
      headers: { authorization: "Bearer test-api-token" }
    });

    // Act
    const res = await app.fetch(req, typoAppEnv(), ctx);

    // Assert — typed 503 (not 500, not a stack trace); the detail names the
    // received typo and every valid value; neither login strategy ran.
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
    expect(body.detail).toContain("browserr");
    for (const mode of AUTH_MODES) {
      expect(body.detail).toContain(mode);
    }
    expect("stack" in body).toBe(false);
    expect(httpLoginCalls.count).toBe(0);
    expect(browserLoginCalls.count).toBe(0);
  });
});
