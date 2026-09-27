import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";
const LOGIN_URL = "https://killeen.routeware.com/WebRW/Account/Login";

/**
 * TOG-6297 — the login-page probe fetches upstream without a session.
 *
 * `GET /api/v1/routeware/account/login-page` forwards to the fixed
 * `LOGIN_URL` with a `null` session (`src/routes/routeware.ts`): it must
 * never read or write the primary `AuthSession` Durable Object state (no
 * `/get`, `/set` or lock call), must send no `Cookie` upstream, and must
 * strip upstream `Set-Cookie` before responding — otherwise a supposedly
 * sessionless probe would leak or plant the shared Routeware session.
 *
 * The primary session is read through the real DO binding (`env.AUTH_SESSION`,
 * same as `test/snapshotSyncE2E.test.ts`), so this pins the acceptance
 * directly: call the route, confirm no DO session write occurs.
 */

type SessionSnapshot = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
};

async function readPrimarySession(): Promise<SessionSnapshot> {
  const authSession = (env as unknown as { AUTH_SESSION: DurableObjectNamespace })
    .AUTH_SESSION;
  const stub = authSession.get(authSession.idFromName("primary"));
  const res = await stub.fetch("https://auth/get");
  return (await res.json()) as SessionSnapshot;
}

async function callLoginPage(): Promise<Response> {
  return exports.default.fetch(
    "http://test.local/api/v1/routeware/account/login-page",
    { headers: { authorization: `Bearer ${API_TOKEN}` } }
  );
}

describe("login-page session isolation (TOG-6297)", () => {
  const originalFetch = globalThis.fetch;
  let upstreamUrls: string[];
  let upstreamCookies: Array<string | null>;

  beforeEach(() => {
    upstreamUrls = [];
    upstreamCookies = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        upstreamUrls.push(url);
        upstreamCookies.push(
          new Headers(init?.headers ?? {}).get("cookie")
        );
        if (url === LOGIN_URL) {
          return new Response("<html>login</html>", {
            status: 200,
            headers: {
              "content-type": "text/html",
              "set-cookie": ".WebRW=upstream-session; Path=/; HttpOnly"
            }
          });
        }
        // Fail loudly on any upstream URL the test did not anticipate instead
        // of silently hitting the network.
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the upstream login HTML without reading or writing the primary session", async () => {
    // Arrange — snapshot the DO state so the assertion holds whatever earlier
    // tests in the isolate left behind.
    const before = await readPrimarySession();

    // Act
    const response = await callLoginPage();

    // Assert — served, and the session is byte-identical afterwards: no /set,
    // no lock/unlock side effect, no session consumed.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("login");
    expect(await readPrimarySession()).toEqual(before);
  });

  it("fetches exactly the fixed login URL with no Cookie, and strips Set-Cookie", async () => {
    // Arrange / Act
    const response = await callLoginPage();

    // Assert — fixed URL (no client query string can reach upstream), no
    // session cookie leaves the Worker, and the upstream session cookie never
    // reaches the client (CONVENTIONS.md § 4 containment).
    expect(response.status).toBe(200);
    expect(upstreamUrls).toEqual([LOGIN_URL]);
    expect(upstreamCookies).toEqual([null]);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.has("set-cookie")).toBe(false);
  });
});
