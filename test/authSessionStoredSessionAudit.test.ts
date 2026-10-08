import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession } from "../src/authSession.do";
import {
  isConcurrentRefreshTimeout,
  releaseRefreshLock,
  storeSession,
  waitForConcurrentRefresh
} from "../src/lib/sessionRefreshLock";
import { readSessionState, sessionExpiryMs } from "../src/lib/sessionState";

// Synthetic fixture only. F1/F2 evidence tests still characterize unfixed defects;
// the scoped release-warning regressions do not guarantee expiry or all auth-log redaction.
const COOKIE = ".WebRW=SYNTHETIC-AUDIT-NOT-A-CREDENTIAL";
const LOCK_TTL_MS = 120_000;

function harness() {
  const values = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
    },
    delete: vi.fn(async (key: string): Promise<boolean> => values.delete(key)),
    setAlarm: vi.fn(async (): Promise<void> => {})
  };
  const state = { storage } as unknown as DurableObjectState;
  let session = new AuthSession(state, {} as Env);
  const stub = {
    fetch: (input: string, init?: RequestInit) => session.fetch(new Request(input, init))
  } as unknown as DurableObjectStub;
  return {
    values,
    storage,
    stub,
    recreate: () => {
      session = new AuthSession(state, {} as Env);
    }
  };
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
    "F1 evidence: expired cookie remains stored/readable at expiry + %i ms, including after recreation",
    async (offsetMs) => {
      const { stub, values, storage, recreate } = harness();
      const expiresAtMs = sessionExpiryMs({ SESSION_TTL_SECONDS: 1 } as unknown as Env);
      await storeSession(stub, COOKIE, expiresAtMs);
      storage.delete.mockClear();
      vi.setSystemTime(expiresAtMs + offsetMs);
      recreate();

      expect(await readSessionState(stub)).toEqual({
        cookieHeader: COOKIE,
        expiresAtMs,
        refreshing: false
      });
      expect(values.get("cookieHeader")).toBe(COOKIE);
      expect(values.get("expiresAtMs")).toBe(expiresAtMs);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(storage.setAlarm).not.toHaveBeenCalled();
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
    expect(values.get("cookieHeader")).toBe(COOKIE);
  });

  it("emits no console output on normal session, lock, and rejected-payload paths", async () => {
    const logs = captureConsole();
    const { stub } = harness();
    await storeSession(stub, COOKIE, sessionExpiryMs({ SESSION_TTL_SECONDS: 60 } as unknown as Env));
    await readSessionState(stub);
    await stub.fetch("https://auth/lock");
    await stub.fetch("https://auth/lock");
    await releaseRefreshLock(stub);
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
    "F2 evidence: a waiter accepts the retained %s cookie after a failed holder unlocks",
    async (kind) => {
      const { stub, values } = harness();
      await storeSession(stub, COOKIE, Date.now() - 1);
      if (kind === "missing-expiry") {
        values.delete("expiresAtMs");
      }
      await stub.fetch("https://auth/lock");
      let completed = false;
      const pending = waitForConcurrentRefresh(stub, 2000, 500).then(() => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBe(false);

      // The failed holder's /unlock leaves its previous session in storage.
      await releaseRefreshLock(stub);
      await vi.advanceTimersByTimeAsync(500);
      await pending;

      expect(completed).toBe(true);
      expect((await readSessionState(stub)).cookieHeader).toBe(COOKIE);
      expect(values.get("expiresAtMs") ?? null).toBe(
        kind === "expired" ? Date.now() - 501 : null
      );
    }
  );

  it("fails closed with a fixed-shape error when a holder remains refreshing", async () => {
    const logs = captureConsole();
    const { stub } = harness();
    await storeSession(stub, COOKIE, Date.now() - 1);
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

    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://auth/unlock");
    expect(logs[2]).toHaveBeenCalledExactlyOnceWith(
      "Failed to release the auth refresh lock; it will expire via its TTL."
    );
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
      expect(logs[2]).toHaveBeenCalledExactlyOnceWith(
        "Failed to release the auth refresh lock; it will expire via its TTL."
      );
    }
  );
});
