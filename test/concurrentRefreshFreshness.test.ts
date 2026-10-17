import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession } from "../src/authSession.do";
import {
  isConcurrentRefreshTimeout,
  releaseRefreshLock,
  storeSession,
  waitForConcurrentRefresh
} from "../src/lib/sessionRefreshLock";

const COOKIE = ".WebRW=SYNTHETIC-EXPIRED";
const FRESH_COOKIE = ".WebRW=SYNTHETIC-PUBLISHED";
const env = { AUTH_MODE: "http", LOGIN_URL: "https://upstream.invalid/WebRW/Account/Login" } as unknown as Env;

// Takeover and reactive-holder logins publish fresh material through the REAL
// storeSession (no network, no credentials): the forwarding legs below assert
// no forward ever carried a cookie that was expired at send time, so a failed
// holder's expiry must resolve to a fresh publication, not a stall. Tests that
// never log in assert the counter stayed at zero. The factories run when the
// dynamic imports below execute — after these bindings initialize — which is
// why the modules under test are imported dynamically, not statically.
const httpLoginCalls = { count: 0 };
vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    httpLoginCalls.count += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, FRESH_COOKIE, Date.now() + 120_000, lockToken);
  })
}));
vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async () => { throw new Error("Unexpected browser login"); })
}));

const { establishSession } = await import("../src/lib/establishSession");
const { forwardWithSessionRetry } = await import("../src/lib/forwardWithSessionRetry");

function harness() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  let queue = Promise.resolve();
  let ready = Promise.resolve();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") values.set(key, value);
      else for (const [name, entry] of Object.entries(key)) values.set(name, entry);
    },
    delete: async (key: string | string[]) => {
      if (typeof key === "string") return values.delete(key);
      return key.filter((name) => values.delete(name)).length;
    },
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => { alarm = time; },
    deleteAlarm: async () => { alarm = null; },
    transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>) => {
      const result = queue.then(() => callback(storage as unknown as DurableObjectTransaction));
      queue = result.then(() => {}, () => {});
      return result;
    }
  };
  const state = {
    storage,
    blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
      ready = callback().then(() => {});
      return ready;
    }
  } as unknown as DurableObjectState;
  const session = new AuthSession(state, {} as Env);
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    await ready;
    return session.fetch(new Request(input, init));
  });
  return { values, fetch, stub: { fetch } as unknown as DurableObjectStub };
}

async function storeThenExpire(stub: DurableObjectStub) {
  await storeSession(stub, COOKIE, Date.now() + 1);
  await vi.advanceTimersByTimeAsync(1);
}

const invalidExpiries = [
  { label: "expired", expiry: () => Date.now() - 1 },
  { label: "exact expiry boundary", expiry: () => Date.now() },
  { label: "missing expiry", expiry: () => undefined },
  { label: "null expiry", expiry: () => null },
  { label: "numeric-string expiry", expiry: () => String(Date.now() + 60_000) },
  { label: "NaN expiry", expiry: () => NaN },
  { label: "infinite expiry", expiry: () => Infinity }
];

/**
 * Acquire the refresh lock through the real DO and return its ownership token
 * (reviewer finding 2): simulated holders present it on `/unlock`.
 */
async function lockWithToken(stub: DurableObjectStub): Promise<string> {
  const response = await stub.fetch("https://auth/lock");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { lockToken: unknown };
  expect(typeof body.lockToken).toBe("string");
  return body.lockToken as string;
}

async function settleWait(stub: DurableObjectStub) {
  const settled = waitForConcurrentRefresh(stub, 2000, 500).then(
    () => null,
    (err: unknown) => err
  );
  await vi.advanceTimersByTimeAsync(2000);
  return settled;
}

describe("concurrent refresh requires a validated unexpired session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    httpLoginCalls.count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected upstream fetch"); }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(invalidExpiries)("fails closed after unlock with $label", async ({ expiry }) => {
    const { stub, values, fetch } = harness();
    await storeThenExpire(stub);
    values.set("expiresAtMs", expiry());
    const token = await lockWithToken(stub);
    let completed = false;
    const settled = waitForConcurrentRefresh(stub, 2000, 500).then(
      () => { completed = true; return null; },
      (err: unknown) => { completed = true; return err; }
    );
    await vi.advanceTimersByTimeAsync(0);
    await releaseRefreshLock(stub, token);
    await vi.advanceTimersByTimeAsync(500);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1499);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const failure = await settled;
    expect(isConcurrentRefreshTimeout(failure)).toBe(true);
    expect((failure as Error).message).toBe("Concurrent session refresh timed out after 2000ms");
    expect((failure as Error).message).not.toContain(COOKIE);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/lock"))).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([null, "", 123, { cookie: "synthetic" }])(
    "rejects absent or malformed cookie %j despite future expiry",
    async (cookie) => {
      const { stub, values } = harness();
      values.set("cookieHeader", cookie);
      values.set("expiresAtMs", Date.now() + 60_000);
      expect(isConcurrentRefreshTimeout(await settleWait(stub))).toBe(true);
    }
  );

  it("rejects an overflowing JSON expiry instead of treating Infinity as fresh", async () => {
    const stub = {
      fetch: async () => new Response(
        '{"cookieHeader":"synthetic","expiresAtMs":1e400,"refreshing":false}'
      )
    } as unknown as DurableObjectStub;
    expect(isConcurrentRefreshTimeout(await settleWait(stub))).toBe(true);
  });

  it("accepts a valid session one millisecond before expiry", async () => {
    const { stub } = harness();
    await storeSession(stub, FRESH_COOKIE, Date.now() + 1);
    await expect(waitForConcurrentRefresh(stub, 2000, 500)).resolves.toBeUndefined();
  });

  it("keeps waiting while refreshing even with a valid session", async () => {
    const { stub } = harness();
    await storeSession(stub, FRESH_COOKIE, Date.now() + 60_000);
    await stub.fetch("https://auth/lock");
    expect(isConcurrentRefreshTimeout(await settleWait(stub))).toBe(true);
  });

  it("accepts a later valid publication without extending the original deadline", async () => {
    const { stub } = harness();
    await storeThenExpire(stub);
    const token = await lockWithToken(stub);
    let completed = false;
    const pending = waitForConcurrentRefresh(stub, 2000, 500).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    await releaseRefreshLock(stub, token);
    await vi.advanceTimersByTimeAsync(1500);
    expect(completed).toBe(false);
    await storeSession(stub, FRESH_COOKIE, Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(completed).toBe(true);
  });

  it("all real establishSession waiters reuse one publication without logging in", async () => {
    const { stub, fetch } = harness();
    await storeThenExpire(stub);
    // The holder's token threads through its own publication: a
    // tokenless `/set` stores but no longer releases a live holder's lock, so
    // publishing without it would leave the waiters queued until their budget.
    const lockResponse = await stub.fetch("https://auth/lock");
    expect(lockResponse.status).toBe(200);
    const holderToken = ((await lockResponse.json()) as { lockToken: string }).lockToken;
    const pending = Promise.all(Array.from({ length: 3 }, () => establishSession(env, stub, env.LOGIN_URL)));
    await vi.advanceTimersByTimeAsync(0);
    await storeSession(stub, FRESH_COOKIE, Date.now() + 60_000, holderToken);
    await vi.advanceTimersByTimeAsync(500);
    await pending;

    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/lock"))).toHaveLength(4);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/set"))).toHaveLength(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["proactive", "reactive"])(
    "%s forwarding takes over after the failed holder unlocks and never forwards an expired cookie",
    async (leg) => {
      const { stub, fetch } = harness();
      // The reactive cookie starts outside the 60s skew and is rejected upstream
      // while locally live. Both cookies expire before the failed holder unlocks.
      // Under bounded takeover (CISO option B), the holder's failed
      // release lets this single caller win `/takeover` and publish fresh
      // material — the request then succeeds instead of stalling to a 502.
      const remainingMs = leg === "proactive" ? 1000 : 61_000;
      const expiresAtMs = Date.now() + remainingMs;
      await storeSession(stub, COOKIE, expiresAtMs);
      const holderToken = await lockWithToken(stub);
      const seenCookies: string[] = [];
      const forwardTimes: number[] = [];
      const upstream = vi.fn(async (_input: unknown, init?: RequestInit) => {
        seenCookies.push(new Headers(init?.headers).get("cookie") ?? "");
        forwardTimes.push(Date.now());
        // Only the post-takeover fresh cookie is accepted upstream: a stale
        // retry would answer the login page again.
        if (seenCookies.at(-1) === FRESH_COOKIE) {
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(
          '<form action="/WebRW/Account/Login" method="post">' +
            '<input name="UserName" /><input name="Password" type="password" /></form>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      });
      vi.stubGlobal("fetch", upstream);
      const pending = forwardWithSessionRetry(
        env, stub, new Request("https://shadow.invalid/api/test"),
        new URL("https://upstream.invalid/data"), null, establishSession
      );
      const settled = pending.then((response) => response, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(seenCookies).toEqual(leg === "reactive" ? [COOKIE] : []);
      await vi.advanceTimersByTimeAsync(remainingMs);
      expect(Date.now()).toBe(expiresAtMs);
      await releaseRefreshLock(stub, holderToken);
      // The takeover login and the retried forward resolve within the poll
      // interval; no 90s waiter budget is consumed.
      await vi.advanceTimersByTimeAsync(2000);
      const result = await settled;
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;

      expect(response.status).toBe(200);
      expect(httpLoginCalls.count).toBe(1);
      expect(seenCookies).toEqual(
        leg === "reactive" ? [COOKIE, FRESH_COOKIE] : [FRESH_COOKIE]
      );
      // The expired cookie was never forwarded at or after its expiry; the
      // only post-expiry forward carried the fresh takeover publication.
      for (const [index, cookie] of seenCookies.entries()) {
        if (cookie === COOKIE) {
          expect(forwardTimes[index]).toBeLessThan(expiresAtMs);
        } else {
          expect(cookie).toBe(FRESH_COOKIE);
        }
      }
      expect(fetch.mock.calls.filter(([url]) => url.endsWith("/takeover"))).toHaveLength(1);
    }
  );
});
