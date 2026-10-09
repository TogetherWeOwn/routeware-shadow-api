import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession } from "../src/authSession.do";
import { establishSession } from "../src/lib/establishSession";
import { forwardWithSessionRetry } from "../src/lib/forwardWithSessionRetry";
import {
  isConcurrentRefreshTimeout,
  releaseRefreshLock,
  storeSession,
  waitForConcurrentRefresh
} from "../src/lib/sessionRefreshLock";

// No network or credentials: login must never run for a waiting caller.
vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async () => { throw new Error("Unexpected HTTP login"); })
}));
vi.mock("../src/lib/browserAuth", () => ({
  establishSessionWithBrowser: vi.fn(async () => { throw new Error("Unexpected browser login"); })
}));

const COOKIE = ".WebRW=SYNTHETIC-EXPIRED";
const FRESH_COOKIE = ".WebRW=SYNTHETIC-PUBLISHED";
const env = { AUTH_MODE: "http", LOGIN_URL: "https://upstream.invalid/WebRW/Account/Login" } as unknown as Env;

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

/**
 * Acquire the refresh lock through the stub and return its ownership token
 * (TOG-18959). Holder-only releases (`releaseRefreshLock`, the holder's
 * `storeSession`) must present this token.
 */
async function acquire(stub: DurableObjectStub): Promise<string> {
  const response = await stub.fetch("https://auth/lock");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { lockToken: unknown };
  expect(typeof body.lockToken).toBe("string");
  return body.lockToken as string;
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
    const lockToken = await acquire(stub);
    let completed = false;
    const settled = waitForConcurrentRefresh(stub, 2000, 500).then(
      () => { completed = true; return null; },
      (err: unknown) => { completed = true; return err; }
    );
    await vi.advanceTimersByTimeAsync(0);
    await releaseRefreshLock(stub, lockToken);
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
    const lockToken = await acquire(stub);
    let completed = false;
    const pending = waitForConcurrentRefresh(stub, 2000, 500).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    await releaseRefreshLock(stub, lockToken);
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
    const lockToken = await acquire(stub);
    const pending = Promise.all(Array.from({ length: 3 }, () => establishSession(env, stub, env.LOGIN_URL)));
    await vi.advanceTimersByTimeAsync(0);
    // The test acts as the holder publishing: its token releases its own lock.
    await storeSession(stub, FRESH_COOKIE, Date.now() + 60_000, lockToken);
    await vi.advanceTimersByTimeAsync(500);
    await pending;

    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/lock"))).toHaveLength(4);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/set"))).toHaveLength(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["proactive", "reactive"])(
    "%s forwarding never retries a cookie that expires while the failed holder is locked",
    async (leg) => {
      const { stub, fetch } = harness();
      // The reactive cookie starts outside the 60s skew and is rejected upstream
      // while locally live. Both cookies expire before the failed holder unlocks.
      const remainingMs = leg === "proactive" ? 1000 : 61_000;
      const expiresAtMs = Date.now() + remainingMs;
      await storeSession(stub, COOKIE, expiresAtMs);
      const lockToken = await acquire(stub);
      const seenCookies: string[] = [];
      const forwardTimes: number[] = [];
      const upstream = vi.fn(async (_input: unknown, init?: RequestInit) => {
        seenCookies.push(new Headers(init?.headers).get("cookie") ?? "");
        forwardTimes.push(Date.now());
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
      await releaseRefreshLock(stub, lockToken);
      // Covers both the inherited 20s budget and current main's unchanged 90s budget.
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await settled;
      expect(result).toBeInstanceOf(Response);
      const response = result as Response;

      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("problem+json");
      expect(await response.text()).not.toContain(COOKIE);
      expect(seenCookies).toEqual(leg === "reactive" ? [COOKIE] : []);
      expect(forwardTimes.every((time) => time < expiresAtMs)).toBe(true);
      expect(fetch.mock.calls.filter(([url]) => url.endsWith("/lock"))).toHaveLength(2);
      expect(fetch.mock.calls.filter(([url]) => url.endsWith("/set"))).toHaveLength(1);
    }
  );
});
