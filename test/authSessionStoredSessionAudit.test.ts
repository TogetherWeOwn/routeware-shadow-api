import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession } from "../src/authSession.do";
import {
  isConcurrentRefreshTimeout,
  releaseRefreshLock,
  storeSession,
  waitForConcurrentRefresh
} from "../src/lib/sessionRefreshLock";
import { readSessionState, sessionExpiryMs } from "../src/lib/sessionState";
import { authSessionTestState } from "./authSessionTestState";

// Synthetic fixture only. Expiry cases now assert eviction and fail-closed reads;
// the scoped release-warning regressions do not guarantee all auth-log redaction.
const COOKIE = ".WebRW=SYNTHETIC-AUDIT-NOT-A-CREDENTIAL";
const LOCK_TTL_MS = 120_000;

function harness() {
  const fake = authSessionTestState();
  let session = new AuthSession(fake.state, {} as Env);
  const stub = {
    fetch: async (input: string, init?: RequestInit) => {
      await fake.ready();
      return session.fetch(new Request(input, init));
    }
  } as unknown as DurableObjectStub;
  return {
    ...fake,
    stub,
    recreate: async () => {
      session = new AuthSession(fake.state, {} as Env);
      await fake.ready();
    }
  };
}

/**
 * Acquire the refresh lock through the real DO and return its ownership token.
 * The DO mints a token per grant (TOG-18119, reviewer finding 2); the holder
 * must present it on `/unlock`, so simulated holders thread it through
 * `releaseRefreshLock` instead of releasing bare.
 */
async function lockWithToken(stub: DurableObjectStub): Promise<string> {
  const response = await stub.fetch("https://auth/lock");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { lockToken: unknown };
  expect(typeof body.lockToken).toBe("string");
  return body.lockToken as string;
}

function captureConsole() {
  return ["log", "info", "warn", "error", "debug"].map((method) =>
    vi.spyOn(console, method as "log").mockImplementation(() => {})
  );
}

describe("AuthSession stored-session audit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns a stored session just before its TTL boundary", async () => {
    const { stub } = harness();
    const expiresAtMs = sessionExpiryMs({ SESSION_TTL_SECONDS: 1 } as unknown as Env);
    await storeSession(stub, COOKIE, expiresAtMs);
    vi.setSystemTime(expiresAtMs - 1);

    expect(await readSessionState(stub)).toEqual({
      cookieHeader: COOKIE,
      expiresAtMs,
      refreshing: false
    });
  });

  it.each([0, 1, 86_400_000])(
    "evicts expired cookie at expiry + %i ms, including after recreation",
    async (offsetMs) => {
      const { stub, values, storage, recreate } = harness();
      const expiresAtMs = sessionExpiryMs({ SESSION_TTL_SECONDS: 1 } as unknown as Env);
      await storeSession(stub, COOKIE, expiresAtMs);
      storage.delete.mockClear();
      vi.setSystemTime(expiresAtMs + offsetMs);
      await recreate();

      expect(await readSessionState(stub)).toEqual({
        cookieHeader: null,
        expiresAtMs: null,
        refreshing: false,
        expired: true
      });
      expect(values.has("cookieHeader")).toBe(false);
      expect(values.has("expiresAtMs")).toBe(false);
      expect(values.get("expiredEvicted")).toBe(true);
      expect(storage.delete).toHaveBeenCalledWith(["cookieHeader", "expiresAtMs"]);
      expect(await storage.getAlarm()).toBeNull();
    }
  );

  it("recovers the refresh lock exactly at 120 seconds, not the session cookie TTL", async () => {
    const { stub, values } = harness();
    const startedAt = Date.now();
    await storeSession(stub, COOKIE, startedAt + 1000);
    expect((await stub.fetch("https://auth/lock")).status).toBe(200);
    vi.setSystemTime(startedAt + LOCK_TTL_MS - 1);
    expect((await stub.fetch("https://auth/lock")).status).toBe(423);
    vi.setSystemTime(startedAt + LOCK_TTL_MS);

    expect((await stub.fetch("https://auth/lock")).status).toBe(200);
    expect(values.get("lockedAt")).toBe(Date.now());
    expect((await readSessionState(stub)).cookieHeader).toBeNull();
    expect(values.has("cookieHeader")).toBe(false);
  });

  it("emits no console output on normal session, lock, and rejected-payload paths", async () => {
    const logs = captureConsole();
    const { stub } = harness();
    await storeSession(stub, COOKIE, sessionExpiryMs({ SESSION_TTL_SECONDS: 60 } as unknown as Env));
    await readSessionState(stub);
    const token = await lockWithToken(stub);
    await stub.fetch("https://auth/lock");
    await releaseRefreshLock(stub, token);
    await waitForConcurrentRefresh(stub);
    expect((await stub.fetch("https://auth/set", {
      method: "POST",
      body: JSON.stringify({ cookieHeader: COOKIE, expiresAtMs: null })
    })).status).toBe(400);

    for (const log of logs) {
      expect(log).not.toHaveBeenCalled();
    }
  });

  it("does not echo cookie bytes or a rejected write response body in its error", async () => {
    const stub = {
      fetch: async () => new Response(COOKIE, { status: 400 })
    } as unknown as DurableObjectStub;
    const failure = await storeSession(stub, COOKIE, Date.now() + 60_000).then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "AuthSession rejected the session write (status 400). " +
      "Check that SESSION_TTL_SECONDS parses to a finite number."
    );
    expect((failure as Error).message).not.toContain(COOKIE);
  });

  it.each(["expired", "missing-expiry"])(
    "does not expose a %s cookie to a waiter after a failed holder unlocks",
    async (kind) => {
      const { stub, values } = harness();
      const expiresAtMs = Date.now() + 1000;
      await storeSession(stub, COOKIE, expiresAtMs);
      if (kind === "missing-expiry") values.delete("expiresAtMs");
      else vi.setSystemTime(expiresAtMs);
      const token = await lockWithToken(stub);
      const settled = waitForConcurrentRefresh(stub, 2000, 500).then(
        () => null,
        (err: unknown) => err
      );
      await vi.advanceTimersByTimeAsync(0);

      await releaseRefreshLock(stub, token);
      await vi.advanceTimersByTimeAsync(2000);
      expect(isConcurrentRefreshTimeout(await settled)).toBe(true);
      expect((await readSessionState(stub)).cookieHeader).toBeNull();
      expect(values.has("cookieHeader")).toBe(false);
      expect(values.has("expiresAtMs")).toBe(false);
    }
  );

  it("fails closed with a fixed-shape error when a holder remains refreshing", async () => {
    const logs = captureConsole();
    const { stub } = harness();
    const expiresAtMs = Date.now() + 1000;
    await storeSession(stub, COOKIE, expiresAtMs);
    vi.setSystemTime(expiresAtMs);
    await stub.fetch("https://auth/lock");
    const settled = waitForConcurrentRefresh(stub, 2000, 500).then(
      () => null,
      (err: unknown) => err
    );
    await vi.advanceTimersByTimeAsync(2000);
    const failure = await settled;

    expect(isConcurrentRefreshTimeout(failure)).toBe(true);
    expect((failure as Error).message).toBe("Concurrent session refresh timed out after 2000ms");
    expect((failure as Error).message).not.toContain(COOKIE);
    for (const log of logs) {
      expect(log).not.toHaveBeenCalled();
    }
  });

  it.each([
    { label: "Error.message", thrown: new Error(COOKIE) },
    { label: "string", thrown: COOKIE },
    { label: "object stringification", thrown: { toString: (): string => COOKIE } }
  ])("emits only a fixed warning when unlock rejects with untrusted $label", async ({ thrown }) => {
    const logs = captureConsole();
    const fetch = vi.fn().mockRejectedValue(thrown);
    const stub = { fetch } as unknown as DurableObjectStub;

    await expect(releaseRefreshLock(stub)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://auth/unlock", {
      method: "POST",
      body: "{}"
    });
    expect(logs[2]).toHaveBeenCalledExactlyOnceWith({
      level: "warn",
      msg: "Failed to release the auth refresh lock; it will expire via its TTL",
      route: "auth.refreshLock",
      ms: null
    });
    for (const log of logs) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(COOKIE);
    }
  });

  it.each(["toString", "message getter"])(
    "does not inspect a rejected object's throwing %s",
    async (kind) => {
      const logs = captureConsole();
      const inspect = vi.fn(() => { throw new Error(COOKIE); });
      const thrown = kind === "toString"
        ? { toString: inspect }
        : Object.defineProperty(new Error(""), "message", { get: inspect });
      const stub = { fetch: vi.fn().mockRejectedValue(thrown) } as unknown as DurableObjectStub;

      await expect(releaseRefreshLock(stub)).resolves.toBeUndefined();

      expect(inspect).not.toHaveBeenCalled();
      expect(logs[2]).toHaveBeenCalledExactlyOnceWith({
        level: "warn",
        msg: "Failed to release the auth refresh lock; it will expire via its TTL",
        route: "auth.refreshLock",
        ms: null
      });
    }
  );
});
