import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession } from "../src/authSession.do";
import { authSessionTestState } from "./authSessionTestState";

const auth = vi.hoisted(() => ({ attempts: 0 }));
const COOKIE = ".WebRW=SYNTHETIC-INTEGRATION-NOT-A-CREDENTIAL";
const RENEWED_COOKIE = ".WebRW=SYNTHETIC-INTEGRATION-RENEWAL-NOT-A-CREDENTIAL";

// Real publication/lock helpers; only the credential-consuming login is synthetic.
vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: async (env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    auth.attempts += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    const { sessionExpiryMs } = await import("../src/lib/sessionState");
    await storeSession(stub, RENEWED_COOKIE, sessionExpiryMs(env), lockToken);
  }
}));
vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: async () => { throw new Error("Unexpected browser login"); }
}));

import { establishSession } from "../src/lib/establishSession";
import { releaseRefreshLock } from "../src/lib/sessionRefreshLock";
import { fetchGetCustomerDetailFull } from "../src/lib/detailFullSync";

/** Must match LOCK_TTL_MS in src/authSession.do.ts. */
const LOCK_TTL_MS = 120_000;

async function acquireToken(stub: DurableObjectStub, path = "/lock"): Promise<string> {
  const response = await stub.fetch(`https://auth${path}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { lockToken: unknown };
  expect(typeof body.lockToken).toBe("string");
  return body.lockToken as string;
}

const env = {
  AUTH_MODE: "http",
  SESSION_TTL_SECONDS: 60,
  TARGET_ORIGIN: "https://routeware.example.test",
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: "https://routeware.example.test/WebRW/Account/Login"
} as unknown as Env;

async function harness(delayPublicationMs = 0, expireRenewalOnRead = false) {
  const fake = authSessionTestState();
  const session = new AuthSession(fake.state, {} as Env);
  await fake.ready();
  let renewalReads = 0;
  const stub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/set" && delayPublicationMs) {
        vi.setSystemTime(Date.now() + delayPublicationMs);
      }
      if (path === "/get" && expireRenewalOnRead && fake.values.get("cookieHeader") === RENEWED_COOKIE) {
        renewalReads += 1;
        if (renewalReads === 2) vi.setSystemTime(Number(fake.values.get("expiresAtMs")));
      }
      return session.fetch(request);
    }
  } as unknown as DurableObjectStub;
  return { ...fake, session, stub };
}

describe("AuthSession expiry at publication and post-save detail refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    auth.attempts = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reauthenticates after local expiry instead of parsing anonymous HTTP-200 login HTML", async () => {
    const h = await harness();
    const expiresAtMs = Date.now() + 1000;
    await h.session.fetch(new Request("https://auth/set", {
      method: "POST", body: JSON.stringify({ cookieHeader: COOKIE, expiresAtMs })
    }));
    vi.setSystemTime(expiresAtMs);
    const cookies: Array<string | null> = [];
    const graph = { currentCustomer: { CustomerID: 5 }, data: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const cookie = request.headers.get("cookie");
      cookies.push(cookie);
      return cookie === RENEWED_COOKIE ? Response.json(graph) : new Response(
        '<html><form action="/Account/Login"><input name="Password"></form></html>',
        { headers: { "content-type": "text/html" } }
      );
    }));
    await expect(fetchGetCustomerDetailFull(env, h.stub, 5, true)).resolves.toEqual(graph);
    expect(auth.attempts).toBe(1);
    expect(cookies).toEqual([RENEWED_COOKIE]);
    expect(h.values.get("cookieHeader")).toBe(RENEWED_COOKIE);
  });

  it.each(["http", "auto"])("fails late authentication without unlocking a newer holder (%s)", async (mode) => {
    const h = await harness();
    const expiresAtMs = Date.now() + 1000;
    const transaction = h.storage.transaction.bind(h.storage);
    vi.spyOn(h.storage, "transaction").mockImplementationOnce(async (callback) => {
      const result = await transaction(callback);
      vi.setSystemTime(expiresAtMs);
      return result;
    });
    const stub = {
      fetch: async (input: string, init?: RequestInit) => {
        const response = await h.stub.fetch(input, init);
        if (new URL(input).pathname === "/set") {
          // Another holder acquires after publication, before its acknowledgement.
          expect((await h.session.fetch(new Request("https://auth/lock"))).status).toBe(200);
        }
        return response;
      }
    } as unknown as DurableObjectStub;
    const shortTtl = { ...env, AUTH_MODE: mode, SESSION_TTL_SECONDS: 1 } as unknown as Env;
    await expect(establishSession(shortTtl, stub, env.LOGIN_URL)).rejects.toThrow(
      "Session refresh completed without an available live session."
    );
    expect(auth.attempts).toBe(1);
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.get("refreshing")).toBe(true);
    expect(h.values.get("lockedAt")).toBe(expiresAtMs);
    expect((await h.session.fetch(new Request("https://auth/lock"))).status).toBe(423);
  });

  it("a superseded holder's late unlock cannot release the live holder's lock (TOG-18959)", async () => {
    const h = await harness();
    // Arrange — holder A acquires, then crashes without unlocking.
    const tokenA = await acquireToken(h.stub);
    expect(h.values.get("refreshing")).toBe(true);

    // Act — past the TTL, holder B takes over explicitly and gets its own token.
    vi.setSystemTime(Date.now() + LOCK_TTL_MS + 1);
    const tokenB = await acquireToken(h.stub, "/takeover");
    expect(tokenB).not.toBe(tokenA);
    // A's late failure path runs with its stale token (what
    // `establishSession`'s catch would send via `releaseRefreshLock`).
    await releaseRefreshLock(h.stub, tokenA);

    // Assert — the stale release fails closed: B's live lock survives and a
    // fresh acquisition is still refused, while B can still release its own.
    expect(h.values.get("refreshing")).toBe(true);
    expect((await h.session.fetch(new Request("https://auth/lock"))).status).toBe(423);
    await releaseRefreshLock(h.stub, tokenB);
    expect(h.values.get("refreshing")).toBe(false);
    expect((await h.session.fetch(new Request("https://auth/lock"))).status).toBe(200);
  });

  it("fails authentication when a supported short TTL expires before publication", async () => {
    const h = await harness(2000);
    const shortTtl = { ...env, SESSION_TTL_SECONDS: 1 } as unknown as Env;
    await expect(establishSession(shortTtl, h.stub, env.LOGIN_URL)).rejects.toThrow(
      "AuthSession rejected the session write (status 409)"
    );
    expect(auth.attempts).toBe(1);
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.has("expiresAtMs")).toBe(false);
    expect(h.values.get("refreshing")).toBe(false);
    expect(h.values.has("lockedAt")).toBe(false);
  });

  it.each([false, true])("withholds detail forwarding when the session expires after authentication (retry: %s)", async (retry) => {
    const h = await harness(0, true);
    if (retry) {
      await h.session.fetch(new Request("https://auth/set", {
        method: "POST", body: JSON.stringify({ cookieHeader: COOKIE, expiresAtMs: Date.now() + 60_000 })
      }));
    }
    const fetch = vi.fn(async () => new Response("synthetic unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchGetCustomerDetailFull(env, h.stub, 5, true)).rejects.toThrow(
      "GetCustomerDetailFull has no live session after authentication"
    );
    expect(auth.attempts).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(retry ? 1 : 0);
    expect(h.values.has("cookieHeader")).toBe(false);
  });

  it("does not forward a detail request after failed session publication", async () => {
    const h = await harness(2000);
    const shortTtl = { ...env, SESSION_TTL_SECONDS: 1 } as unknown as Env;
    const fetch = vi.fn(async () => new Response("unexpected upstream request"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchGetCustomerDetailFull(shortTtl, h.stub, 5, true)).rejects.toThrow(
      "AuthSession rejected the session write (status 409)"
    );
    expect(auth.attempts).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.values.has("cookieHeader")).toBe(false);
  });
});
