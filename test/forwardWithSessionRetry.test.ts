import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forwardWithSessionRetry,
  sessionNeedsRefresh
} from "../src/lib/forwardWithSessionRetry";
import type { SessionState } from "../src/lib/sessionState";

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
