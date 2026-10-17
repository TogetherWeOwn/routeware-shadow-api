import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { forwardWithSessionRetry } from "../src/lib/forwardWithSessionRetry";
import { forwardToUpstream } from "../src/lib/upstreamForward";
import type { SessionState } from "../src/lib/sessionState";

const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";

const UPSTREAM = new URL("https://killeen.routeware.com/WebRW/Home/Index");
const LOGIN_URL = "https://killeen.routeware.com/WebRW/Account/Login";

/**
 * TOG-6284 — upstream `Set-Cookie` must never reach clients.
 *
 * CONVENTIONS.md § 4 contains the session in the `AuthSession` Durable Object:
 * every client-facing forward funnels through `forwardToUpstream` (directly or
 * via `forwardWithSessionRetry`), which strips `Set-Cookie` before returning.
 * This file pins that in three layers:
 *
 * 1. Unit: the strip holds for single, multiple (appended), and
 *    expired-session-rotation cookies, and on redirects (no follow).
 * 2. Retry: `forwardWithSessionRetry` strips on both the first forward and the
 *    post-login retry — rotation cookies arrive on exactly that path.
 * 3. Sweep: every `/api/v1/routeware/*` passthrough route is driven against an
 *    upstream that sets cookies, and the client response carries none. The
 *    route list is read off the live router (like `test/authGateSweep.test.ts`)
 *    so a new passthrough that bypasses the helper fails here; the count pin
 *    forces an explicit acknowledgement when the surface changes.
 * 4. Envelope: the `/api/v1/data/*` write tier answers with its own JSON
 *    envelope (never the upstream response object) — pinned cookie-free over
 *    the full real path (anti-forgery prep, forward, D1-sync attempt).
 */

function session(cookieHeader: string | null): SessionState {
  return { cookieHeader, expiresAtMs: Date.now() + 600_000, refreshing: false };
}

/** Upstream response carrying a session rotation plus an expired eviction. */
function cookieLadenUpstream(body: string, status = 200): Response {
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", ".WebRW=rotated-session; Path=/; HttpOnly");
  headers.append(
    "set-cookie",
    ".WebRW=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly"
  );
  headers.append("set-cookie", "RCCApi=upstream-secret; Path=/; Secure");
  return new Response(body, { status, headers });
}

function expectNoSetCookie(res: Response): void {
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.has("set-cookie")).toBe(false);
  const list =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  expect(list).toEqual([]);
}

describe("secureUpstreamResponse unit proof (TOG-6284)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("strips multiple appended Set-Cookie headers while keeping everything else", async () => {
    // Arrange — sanity: the stub really carries three cookies upstream.
    const upstream = cookieLadenUpstream('{"success":true}');
    expect(upstream.headers.getSetCookie()).toHaveLength(3);
    globalThis.fetch = vi.fn(async () => upstream) as unknown as typeof fetch;
    const incoming = new Request("http://test.local/api/v1/routeware/home/index");

    // Act
    const response = await forwardToUpstream(incoming, UPSTREAM, session(".WebRW=stored"), null);

    // Assert
    expectNoSetCookie(response);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"success":true}');
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("strips a lone expired-session rotation cookie", async () => {
    // Arrange — the eviction shape: empty value with a past expiry.
    globalThis.fetch = vi.fn(
      async () =>
        new Response("ok", {
          status: 200,
          headers: {
            "set-cookie": ".WebRW=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly"
          }
        })
    ) as unknown as typeof fetch;
    const incoming = new Request("http://test.local/api/v1/routeware/home/index");

    // Act
    const response = await forwardToUpstream(incoming, UPSTREAM, null, null);

    // Assert
    expectNoSetCookie(response);
    expect(await response.text()).toBe("ok");
  });

  it("strips Set-Cookie from a login redirect without following it", async () => {
    // Arrange — rotation cookies ride 302s on session expiry; the forwarder
    // must not follow the redirect and must not pass the cookie through.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: LOGIN_URL,
            "set-cookie": ".WebRW=stale-session; Path=/; HttpOnly"
          }
        })
    ) as unknown as typeof fetch;
    const incoming = new Request("http://test.local/api/v1/routeware/home/index");

    // Act
    const response = await forwardToUpstream(incoming, UPSTREAM, session(".WebRW=old"), null);

    // Assert — redirect shape preserved, cookie gone.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(LOGIN_URL);
    expectNoSetCookie(response);
  });
});

describe("forwardWithSessionRetry strips on both attempts (TOG-6284)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeStub(holder: { value: SessionState }): DurableObjectStub {
    return {
      fetch: async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/get")) {
          return new Response(JSON.stringify(holder.value), {
            headers: { "content-type": "application/json" }
          });
        }
        return new Response("OK");
      }
    } as unknown as DurableObjectStub;
  }

  it("strips rotation cookies on the first forward and on the post-login retry", async () => {
    // Arrange — expired session: first forward redirects with a rotation
    // cookie, the retry succeeds with another one.
    const holder = { value: session(".WebRW=stale") };
    const stub = makeStub(holder);
    const establish = vi.fn(async () => {
      holder.value = session(".WebRW=fresh");
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: LOGIN_URL,
            "set-cookie": ".WebRW=rotation-1; Path=/; HttpOnly"
          }
        })
      )
      .mockResolvedValueOnce(cookieLadenUpstream('{"success":true}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const env = { LOGIN_URL } as unknown as Env;

    // Act
    const res = await forwardWithSessionRetry(
      env,
      stub,
      new Request("http://test.local/api/v1/routeware/home/index"),
      UPSTREAM,
      null,
      establish
    );

    // Assert — one refresh, two forwards, and the client sees no cookie from either.
    expect(establish).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expectNoSetCookie(res);
    expect(await res.text()).toBe('{"success":true}');
  });
});

type SweepRoute = { method: string; path: string };

const SWEEP_PREFIX = "/api/v1/routeware/";

/**
 * Every client-facing upstream passthrough, read off the live router. The
 * DELETE customer route is excluded: it answers 405 without touching upstream.
 */
function sweepRoutes(): SweepRoute[] {
  const seen = new Set<string>();
  const routes: SweepRoute[] = [];
  for (const r of app.routes) {
    if (r.method === "ALL" || !r.path.startsWith(SWEEP_PREFIX)) {
      continue;
    }
    if (r.method === "DELETE") {
      continue;
    }
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    routes.push({ method: r.method, path: r.path });
  }
  routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
  return routes;
}

function sweepRequest(route: SweepRoute): { url: string; init: RequestInit } {
  const base = `http://test.local${route.path}`;
  if (route.path.endsWith("/load-long-modal")) {
    return { url: `${base}?customerID=99`, init: { method: route.method } };
  }
  if (route.path.endsWith("/query-request-is-complete")) {
    return { url: `${base}?requestID=abc-123&_=1`, init: { method: route.method } };
  }
  if (route.method === "POST" && route.path.includes("/save-")) {
    return {
      url: base,
      init: {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "CustomerID=5&CompanyName=Acme&__RequestVerificationToken=explicit-token"
      }
    };
  }
  if (route.method === "POST") {
    return {
      url: base,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }
    };
  }
  return { url: base, init: { method: route.method } };
}

describe("routeware passthrough Set-Cookie sweep (TOG-6284)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("killeen.routeware.com")) {
        throw new Error(`Unexpected upstream fetch in Set-Cookie sweep: ${url}`);
      }
      // Save routes: loud upstream failure passes the response through
      // unchanged (no D1 refresh), exercising the strip on the error path.
      if (
        url.includes("/SaveCustomerLongForm") ||
        url.includes("/SaveAddressForm") ||
        url.includes("/SaveContainerForm")
      ) {
        const headers = new Headers({ "content-type": "text/plain" });
        headers.append("set-cookie", ".WebRW=save-failure-session; Path=/; HttpOnly");
        return new Response("upstream down", { status: 500, headers });
      }
      // The poll answer is a bare boolean; HTML here would mean failure.
      if (url.includes("/QueryRequestIsComplete")) {
        const headers = new Headers({ "content-type": "text/plain" });
        headers.append("set-cookie", ".WebRW=poll-session; Path=/; HttpOnly");
        return new Response("true", { status: 200, headers });
      }
      // HTML-contract routes succeed with HTML; JSON reads succeed with JSON.
      const isHtmlRoute =
        url.includes("/Account/Login") ||
        url.includes("/Home/Index") ||
        url.includes("/AddNewLong") ||
        url.includes("/LoadLongCustomerModal");
      const body = isHtmlRoute ? "<html>routeware</html>" : '{"success":true}';
      const headers = new Headers({
        "content-type": isHtmlRoute ? "text/html; charset=utf-8" : "application/json"
      });
      headers.append("set-cookie", ".WebRW=rotated-session; Path=/; HttpOnly");
      headers.append(
        "set-cookie",
        ".WebRW=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly"
      );
      return new Response(body, { status: 200, headers });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sweeps every registered routeware passthrough route", () => {
    // Pinned count: adding/removing a routeware route must update this sweep explicitly.
    expect(sweepRoutes()).toHaveLength(12);
  });

  it.each(sweepRoutes())("no Set-Cookie reaches the client: $method $path", async (route) => {
    // Arrange
    const { url, init } = sweepRequest(route);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${API_TOKEN}`);

    // Act
    const response = await exports.default.fetch(url, { ...init, headers });

    // Assert — the expected upstream status proves the request actually passed
    // through (not a 401/404 that would vacuously carry no cookies), then the
    // containment: no Set-Cookie in any form.
    const expectedStatus = route.path.includes("/save-") ? 500 : 200;
    expect(response.status).toBe(expectedStatus);
    expectNoSetCookie(response);
    // Drain the body so a bypass cannot hide behind an unconsumed stream.
    await response.text();
  });
});

describe("data-entity envelope never carries Set-Cookie (TOG-6284)", () => {
  const originalFetch = globalThis.fetch;

  const DETAIL_FULL = {
    currentCustomer: { CustomerID: 5, CompanyName: "Acme", Enabled: true },
    data: []
  };

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/GetCustomerDetailFull")) {
        const headers = new Headers({ "content-type": "application/json" });
        headers.append("set-cookie", ".WebRW=detail-sync-session; Path=/; HttpOnly");
        return new Response(JSON.stringify(DETAIL_FULL), { status: 200, headers });
      }
      if (url.includes("/WebRW/")) {
        return cookieLadenUpstream('{"success":true}');
      }
      throw new Error(`Unexpected upstream fetch in envelope proof: ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function postEnvelope(path: string, form: string): Promise<Response> {
    return exports.default.fetch(`http://test.local${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SYNC_SECRET}`,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body: form
    });
  }

  it.each([
    {
      path: "/api/v1/data/customer",
      form: "CustomerID=5&CompanyName=Acme&__RequestVerificationToken=explicit-token"
    },
    {
      path: "/api/v1/data/address",
      form: "CustomerID=5&PickupAddressID=10&Address=1+Main+St&__RequestVerificationToken=explicit-token"
    },
    {
      path: "/api/v1/data/container",
      form: "CustomerID=5&ContainerID=100&PickupAddressID=10&__RequestVerificationToken=explicit-token"
    }
  ])("POST $path answers cookie-free while upstream sets cookies", async ({ path, form }) => {
    // Arrange / Act — full real path: anti-forgery prep, upstream forward
    // (cookie-laden), D1-sync attempt, JSON envelope.
    const response = await postEnvelope(path, form);

    // Assert — the save succeeded upstream (ok:true) and the Worker's own
    // envelope carries no trace of the upstream cookies.
    expect(response.status).toBe(200);
    expectNoSetCookie(response);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
