import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardWithSessionRetry } from "../src/lib/forwardWithSessionRetry";
import { isLoginRedirect } from "../src/lib/loginRedirect";
import type { SessionState } from "../src/lib/sessionState";

/**
 * TOG-5823: explicit status/body matrix for `forwardWithSessionRetry` +
 * `isLoginRedirect` — the codebase's core subtlety
 * (`docs/CONVENTIONS.md` fact 1, `docs/TEST-INVARIANTS.md`).
 *
 * The upstream signals failure silently: an expired admin session or a stale
 * anti-forgery token comes back as an **HTML page with HTTP 200** — never a
 * 401, never a 4xx. The retry layer therefore decides on *redirect shape*,
 * not on `resp.ok`, and the check order matters:
 *
 *   `if (response.status === 200 || !isLoginRedirect(response)) return response;`
 *
 * Truth table this file pins (fresh session, so no proactive refresh):
 *
 * | first upstream response              | retry? | why                                  |
 * |--------------------------------------|--------|--------------------------------------|
 * | 200 (any body, even HTML/login loc)  | no     | `status === 200` short-circuits      |
 * | 302 + `/Account/Login`/`Login.aspx`  | yes    | the only reactive-refresh trigger    |
 * | 302 elsewhere / no location          | no     | `isLoginRedirect` is false           |
 * | 301/307/303 + login location         | no     | `isLoginRedirect` requires 302       |
 * | 4xx/5xx                              | no     | never a login redirect               |
 *
 * House pattern (see docs/TEST-INVARIANTS.md § "No test may reach the
 * network"): `globalThis.fetch` is stubbed and restored in `afterEach`.
 */

const LOGIN_URL = "https://killeen.routeware.com/WebRW/Account/Login";
const OTHER_URL = "https://killeen.routeware.com/WebRW/Home/Index";
const UPSTREAM = new URL(OTHER_URL);
const env = { LOGIN_URL } as unknown as Env;

const HTML_ERROR_PAGE =
  "<!DOCTYPE html><html><body><h1>Object reference not set</h1></body></html>";

/** Fake AuthSession Durable Object stub backed by a mutable session holder. */
function makeStub(holder: { value: SessionState }): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/get")) {
        return new Response(JSON.stringify(holder.value), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("OK");
    }
  } as unknown as DurableObjectStub;
}

/** A session far from expiry, so only the reactive path can fire. */
function freshHolder(cookie = "old"): { value: SessionState } {
  return {
    value: {
      cookieHeader: cookie,
      expiresAtMs: Date.now() + 600_000,
      refreshing: false
    } as SessionState
  };
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe("isLoginRedirect status/location matrix", () => {
  const cases: Array<{
    name: string;
    status: number;
    location: string | null;
    expected: boolean;
  }> = [
    // The two true cells: 302 plus a login-shaped location.
    { name: "302 + /Account/Login", status: 302, location: LOGIN_URL, expected: true },
    {
      name: "302 + /Account/Login with query",
      status: 302,
      location: "/WebRW/Account/Login?returnUrl=%2FWebRW%2F",
      expected: true
    },
    {
      name: "302 + Login.aspx",
      status: 302,
      location: "/foo/Login.aspx?x=1",
      expected: true
    },
    // 302 without a login location is not a login redirect.
    { name: "302 + app location", status: 302, location: OTHER_URL, expected: false },
    { name: "302 + no location", status: 302, location: null, expected: false },
    { name: "302 + empty location", status: 302, location: "", expected: false },
    // Ordering: the status!==302 clause runs before the location check, so a
    // login location on any other status is still false — including on a 200,
    // which is the HTML-200 silent-failure shape.
    { name: "200 + login location", status: 200, location: LOGIN_URL, expected: false },
    { name: "200 + no location", status: 200, location: null, expected: false },
    { name: "301 + login location", status: 301, location: LOGIN_URL, expected: false },
    { name: "303 + login location", status: 303, location: LOGIN_URL, expected: false },
    { name: "307 + login location", status: 307, location: LOGIN_URL, expected: false },
    { name: "401 + login location", status: 401, location: LOGIN_URL, expected: false },
    { name: "500 + no location", status: 500, location: null, expected: false }
  ];

  it.each(cases)("$name → $expected", ({ status, location, expected }) => {
    const headers: HeadersInit | undefined =
      location === null ? undefined : { location };
    expect(isLoginRedirect(new Response(null, { status, headers }))).toBe(expected);
  });
});

describe("forwardWithSessionRetry status/body matrix", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const cases: Array<{
    name: string;
    /** First upstream response (built per-row inside the test). */
    build: () => Response;
    establishCalls: number;
    fetchCalls: number;
    expectStatus: number;
  }> = [
    {
      name: "200 JSON passes through with no refresh",
      build: () => new Response('{"ok":true}', { status: 200 }),
      establishCalls: 0,
      fetchCalls: 1,
      expectStatus: 200
    },
    {
      // CONVENTIONS.md fact 1: the HTML-200 silent failure is NOT rescued
      // here — status 200 short-circuits before the redirect check. The HTML
      // body guard lives downstream (routewareQueryReportCsv throws on
      // `<!DOCTYPE`/`<html`).
      name: "200 HTML error page passes through with no refresh",
      build: () => new Response(HTML_ERROR_PAGE, { status: 200 }),
      establishCalls: 0,
      fetchCalls: 1,
      expectStatus: 200
    },
    {
      // Ordering pin: a 200 carrying a login Location still short-circuits.
      name: "200 with login Location passes through with no refresh",
      build: () => new Response("ok", { status: 200, headers: { location: LOGIN_URL } }),
      establishCalls: 0,
      fetchCalls: 1,
      expectStatus: 200
    },
    {
      name: "302 /Account/Login re-establishes and retries once",
      build: () => redirectTo(LOGIN_URL),
      establishCalls: 1,
      fetchCalls: 2,
      expectStatus: 200
    },
    {
      name: "302 Login.aspx re-establishes and retries once",
      build: () => redirectTo("https://killeen.routeware.com/WebRW/Login.aspx"),
      establishCalls: 1,
      fetchCalls: 2,
      expectStatus: 200
    },
    {
      name: "302 to an app location passes through with no refresh",
      build: () => redirectTo(OTHER_URL),
      establishCalls: 0,
      fetchCalls: 1,
      expectStatus: 302
    },
    {
      name: "302 with no location passes through with no refresh",
      build: () => new Response(null, { status: 302 }),
      establishCalls: 0,
      fetchCalls: 1,
      expectStatus: 302
    },
    {
      name: "301 to login passes through with no refresh (302 required)",
      build: () => new Response(null, { status: 301, headers: { location: LOGIN_URL } }),
      establishCalls: 0,
      fetchCalls: 1,
      expectStatus: 301
    },
    {
      name: "500 passes through with no refresh",
      build: () => new Response("boom", { status: 500 }),
      establishCalls: 0,
      fetchCalls: 1,
      expectStatus: 500
    },
    {
      // Upstream signals expiry with a redirect or HTML, never a 401 — and
      // the retry layer treats a 401 as opaque passthrough.
      name: "401 passes through with no refresh",
      build: () => new Response("denied", { status: 401 }),
      establishCalls: 0,
      fetchCalls: 1,
      expectStatus: 401
    }
  ];

  it.each(cases)(
    "$name",
    async ({ build, establishCalls, fetchCalls, expectStatus }) => {
      // Arrange
      const holder = freshHolder();
      const establish = vi.fn(async () => {
        holder.value = {
          cookieHeader: "fresh",
          expiresAtMs: Date.now() + 600_000,
          refreshing: false
        };
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(build())
        .mockResolvedValue(new Response("recovered", { status: 200 }));
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

      // Assert
      expect(establish).toHaveBeenCalledTimes(establishCalls);
      expect(fetchMock).toHaveBeenCalledTimes(fetchCalls);
      expect(res.status).toBe(expectStatus);
    }
  );

  it("retries exactly once: a second login redirect is returned as-is", async () => {
    // Arrange
    const holder = freshHolder();
    const establish = vi.fn(async () => {
      holder.value = {
        cookieHeader: "fresh",
        expiresAtMs: Date.now() + 600_000,
        refreshing: false
      };
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo(LOGIN_URL))
      .mockResolvedValueOnce(redirectTo(LOGIN_URL));
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

    // Assert
    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(302);
    expect(isLoginRedirect(res)).toBe(true);
  });

  it("re-reads the session after re-establishing, so the retry uses the fresh cookie", async () => {
    // Arrange
    const holder = freshHolder("old");
    const establish = vi.fn(async () => {
      holder.value = {
        cookieHeader: "fresh",
        expiresAtMs: Date.now() + 600_000,
        refreshing: false
      };
    });
    const sentCookies: Array<string | null> = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sentCookies.push(new Headers(init?.headers).get("cookie"));
      return sentCookies.length === 1
        ? redirectTo(LOGIN_URL)
        : new Response("recovered", { status: 200 });
    }) as unknown as typeof fetch;

    // Act
    const res = await forwardWithSessionRetry(
      env,
      makeStub(holder),
      new Request("http://shadow/x"),
      UPSTREAM,
      null,
      establish
    );

    // Assert
    expect(res.status).toBe(200);
    expect(sentCookies).toEqual(["old", "fresh"]);
  });
});
