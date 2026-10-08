import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession } from "../src/authSession.do";
import { AUTH_THROTTLE_STATE_KEY } from "../src/lib/authThrottle";
import { authSessionTestState } from "./authSessionTestState";

const COOKIE = ".WebRW=SYNTHETIC-EXPIRY-NOT-A-CREDENTIAL";
const RENEWED_COOKIE = ".WebRW=SYNTHETIC-RENEWAL-NOT-A-CREDENTIAL";

function harness(initial: Record<string, unknown> = {}) {
  const fake = authSessionTestState(initial);
  let session = new AuthSession(fake.state, {} as Env);
  const call = async (path: string, body?: unknown) => {
    await fake.ready();
    return session.fetch(new Request(`https://auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body)
    }));
  };
  return {
    ...fake,
    call,
    set: (expiresAtMs: number, cookieHeader = COOKIE) => call("/set", { cookieHeader, expiresAtMs }),
    read: async () => (await call("/get")).json(),
    alarm: async () => {
      await fake.ready();
      // A delivered alarm is consumed before its handler starts, as in workerd.
      await fake.storage.deleteAlarm();
      await session.alarm();
    },
    recreate: async () => {
      session = new AuthSession(fake.state, {} as Env);
      await fake.ready();
    }
  };
}

describe("AuthSession expiry cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("schedules the exact expiry and keeps a session alive until that boundary", async () => {
    const h = harness();
    const expiresAtMs = Date.now() + 1000;
    await h.set(expiresAtMs);
    expect(await h.storage.getAlarm()).toBe(expiresAtMs);
    vi.setSystemTime(expiresAtMs - 1);
    expect(await h.read()).toEqual({ cookieHeader: COOKIE, expiresAtMs, refreshing: false });
  });

  it("does not return a session that expires during alarm storage I/O", async () => {
    const h = harness();
    const expiresAtMs = Date.now() + 1000;
    await h.set(expiresAtMs);
    vi.spyOn(h.storage, "getAlarm").mockImplementationOnce(async () => {
      vi.setSystemTime(expiresAtMs);
      return expiresAtMs;
    });
    expect(await h.read()).toEqual({ cookieHeader: null, expiresAtMs: null, refreshing: false });
    expect(h.values.has("cookieHeader")).toBe(false);
  });

  it("evicts instead of returning a session that expires while the read transaction completes", async () => {
    const h = harness();
    const expiresAtMs = Date.now() + 1000;
    await h.set(expiresAtMs);
    const transaction = h.storage.transaction.bind(h.storage);
    vi.spyOn(h.storage, "transaction").mockImplementationOnce(async (callback) => {
      const result = await transaction(callback);
      vi.setSystemTime(expiresAtMs);
      return result;
    });
    expect(await h.read()).toEqual({ cookieHeader: null, expiresAtMs: null, refreshing: false });
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.has("expiresAtMs")).toBe(false);
    expect(await h.storage.getAlarm()).toBeNull();
  });

  it("acknowledges a committed write but evicts it on the next read if commit crosses expiry", async () => {
    const h = harness();
    await h.ready();
    const expiresAtMs = Date.now() + 1000;
    const transaction = h.storage.transaction.bind(h.storage);
    vi.spyOn(h.storage, "transaction").mockImplementationOnce(async (callback) => {
      const result = await transaction(callback);
      vi.setSystemTime(expiresAtMs);
      return result;
    });
    expect((await h.set(expiresAtMs)).status).toBe(200);
    expect(await h.read()).toEqual({ cookieHeader: null, expiresAtMs: null, refreshing: false });
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.has("expiresAtMs")).toBe(false);
    expect(await h.storage.getAlarm()).toBeNull();
  });

  it("does not release a refresh lock when rejecting an expired publication", async () => {
    const h = harness();
    await h.call("/lock");
    const lockedAt = h.values.get("lockedAt");
    expect((await h.set(Date.now())).status).toBe(409);
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.get("refreshing")).toBe(true);
    expect(h.values.get("lockedAt")).toBe(lockedAt);
  });

  it("preserves a concurrent renewal while withholding the read's expired snapshot", async () => {
    const h = harness();
    const oldExpiry = Date.now() + 1000;
    const newExpiry = oldExpiry + 60_000;
    await h.set(oldExpiry);
    const transaction = h.storage.transaction.bind(h.storage);
    vi.spyOn(h.storage, "transaction").mockImplementationOnce(async (callback) => {
      const result = await transaction(callback);
      vi.setSystemTime(oldExpiry);
      await h.set(newExpiry, RENEWED_COOKIE);
      return result;
    });
    expect(await h.read()).toEqual({ cookieHeader: null, expiresAtMs: null, refreshing: false });
    expect(h.values.get("cookieHeader")).toBe(RENEWED_COOKIE);
    expect(h.values.get("expiresAtMs")).toBe(newExpiry);
    expect(await h.storage.getAlarm()).toBe(newExpiry);
  });

  it("does not clobber a valid renewal or its lock with an already-expired write", async () => {
    const h = harness();
    const expiresAtMs = Date.now() + 60_000;
    await h.set(expiresAtMs, RENEWED_COOKIE);
    await h.call("/lock");
    const lockedAt = h.values.get("lockedAt");
    expect((await h.set(Date.now(), COOKIE)).status).toBe(409);
    expect(h.values.get("cookieHeader")).toBe(RENEWED_COOKIE);
    expect(h.values.get("expiresAtMs")).toBe(expiresAtMs);
    expect(h.values.get("refreshing")).toBe(true);
    expect(h.values.get("lockedAt")).toBe(lockedAt);
    expect(await h.storage.getAlarm()).toBe(expiresAtMs);
  });

  it.each([0, 1, 86_400_000])("evicts on an active read at expiry + %i ms", async (offsetMs) => {
    const h = harness();
    const expiresAtMs = Date.now() + 1000;
    await h.set(expiresAtMs);
    vi.setSystemTime(expiresAtMs + offsetMs);
    expect(await h.read()).toEqual({ cookieHeader: null, expiresAtMs: null, refreshing: false });
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.has("expiresAtMs")).toBe(false);
    expect(await h.storage.getAlarm()).toBeNull();
  });

  it.each([0, 1, 86_400_000])("cleans an idle session by alarm at expiry + %i ms after recreation", async (offsetMs) => {
    const h = harness();
    const expiresAtMs = Date.now() + 1000;
    await h.set(expiresAtMs);
    await h.recreate();
    vi.setSystemTime(expiresAtMs + offsetMs);
    // No /get request: the alarm alone must delete the stored material.
    await h.alarm();
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.has("expiresAtMs")).toBe(false);
    expect(await h.storage.getAlarm()).toBeNull();
    await h.alarm(); // At-least-once redelivery is harmless.
    expect(h.values.has("cookieHeader")).toBe(false);
  });

  it.each([0, -1])("does not retain an already-expired /set at now + %i ms", async (offsetMs) => {
    const h = harness();
    const expiresAtMs = Date.now() + 1000;
    await h.set(expiresAtMs);
    vi.setSystemTime(expiresAtMs);
    expect((await h.set(Date.now() + offsetMs)).status).toBe(409);
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.has("expiresAtMs")).toBe(false);
    expect(await h.storage.getAlarm()).toBeNull();
  });

  it.each(["read", "alarm", "recreation"])("preserves refresh and throttle state during %s cleanup", async (path) => {
    const h = harness();
    const expiresAtMs = Date.now() + 1000;
    await h.set(expiresAtMs);
    await h.call("/lock");
    await h.call("/throttle/failure");
    const lockedAt = h.values.get("lockedAt");
    const throttle = h.values.get(AUTH_THROTTLE_STATE_KEY);
    vi.setSystemTime(expiresAtMs);
    if (path === "read") await h.read();
    else if (path === "alarm") await h.alarm();
    else await h.recreate();
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.get("refreshing")).toBe(true);
    expect(h.values.get("lockedAt")).toBe(lockedAt);
    expect(h.values.get(AUTH_THROTTLE_STATE_KEY)).toEqual(throttle);
    expect((await h.call("/lock")).status).toBe(423);
    expect(await h.read()).toEqual({ cookieHeader: null, expiresAtMs: null, refreshing: true });
  });

  it("rearms a renewed session when an old alarm is delivered", async () => {
    const h = harness();
    const oldExpiry = Date.now() + 1000;
    const newExpiry = oldExpiry + 60_000;
    await h.set(oldExpiry);
    await h.set(newExpiry, RENEWED_COOKIE);
    vi.setSystemTime(oldExpiry);
    await h.alarm();
    expect(h.values.get("cookieHeader")).toBe(RENEWED_COOKIE);
    expect(h.values.get("expiresAtMs")).toBe(newExpiry);
    expect(await h.storage.getAlarm()).toBe(newExpiry);
    vi.setSystemTime(newExpiry);
    await h.alarm();
    expect(h.values.has("cookieHeader")).toBe(false);
  });

  it.each(["cleanup-first", "renewal-first"])("serializes concurrent cleanup and renewal (%s)", async (order) => {
    const h = harness();
    const oldExpiry = Date.now() + 1000;
    const newExpiry = oldExpiry + 60_000;
    await h.set(oldExpiry);
    vi.setSystemTime(oldExpiry);
    // Both requests enter in the same turn; storage transactions serialize them.
    if (order === "cleanup-first") await Promise.all([h.read(), h.set(newExpiry, RENEWED_COOKIE)]);
    else await Promise.all([h.set(newExpiry, RENEWED_COOKIE), h.alarm()]);
    expect(await h.read()).toEqual({ cookieHeader: RENEWED_COOKIE, expiresAtMs: newExpiry, refreshing: false });
    expect(await h.storage.getAlarm()).toBe(newExpiry);
  });

  it("arms a legacy unexpired session on activation without a migration", async () => {
    const expiresAtMs = Date.now() + 60_000;
    const h = harness({ cookieHeader: COOKIE, expiresAtMs });
    await h.ready();
    expect(await h.storage.getAlarm()).toBe(expiresAtMs);
    await h.recreate();
    expect(h.storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(h.values.get("cookieHeader")).toBe(COOKIE);
  });

  it.each([undefined, null, "soon", Number.NaN, Number.POSITIVE_INFINITY, "expired"])(
    "discards a legacy cookie with invalid or expired expiry %s on activation",
    async (value) => {
      const expiresAtMs = value === "expired" ? Date.now() - 1 : value;
      const h = harness({ cookieHeader: COOKIE, expiresAtMs, refreshing: true, lockedAt: Date.now() });
      await h.ready();
      expect(h.values.has("cookieHeader")).toBe(false);
      expect(h.values.has("expiresAtMs")).toBe(false);
      expect(h.values.get("refreshing")).toBe(true);
      expect(h.values.has("lockedAt")).toBe(true);
    }
  );

  it("deletes an orphaned expiry without creating a periodic alarm", async () => {
    const h = harness({ expiresAtMs: Date.now() + 60_000 });
    await h.ready();
    expect(h.values.has("expiresAtMs")).toBe(false);
    expect(h.storage.setAlarm).not.toHaveBeenCalled();
    expect(await h.storage.getAlarm()).toBeNull();
  });

  it("fails a read closed on cleanup failure and evicts on the next successful cleanup", async () => {
    const h = harness();
    const expiresAtMs = Date.now() + 1000;
    await h.set(expiresAtMs);
    vi.setSystemTime(expiresAtMs);
    h.storage.deleteAlarm.mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    await expect(h.read()).rejects.toThrow("synthetic cleanup failure");
    expect(h.values.get("cookieHeader")).toBe(COOKIE); // Failed transaction rolled back.
    await h.alarm();
    expect(h.values.has("cookieHeader")).toBe(false);
    expect(h.values.has("expiresAtMs")).toBe(false);
  });

  it.each([undefined, null, "soon", Number.NaN, Number.POSITIVE_INFINITY])(
    "evicts a corrupted expiry %s on an active read",
    async (expiresAtMs) => {
      const h = harness();
      await h.set(Date.now() + 60_000);
      h.values.set("expiresAtMs", expiresAtMs);
      expect(await h.read()).toEqual({ cookieHeader: null, expiresAtMs: null, refreshing: false });
      expect(h.values.has("cookieHeader")).toBe(false);
      expect(h.values.has("expiresAtMs")).toBe(false);
    }
  );

  it("does not publish a renewal or release its lock if alarm scheduling fails", async () => {
    const h = harness();
    const oldExpiry = Date.now() + 1000;
    await h.set(oldExpiry);
    await h.call("/lock");
    h.storage.setAlarm.mockRejectedValueOnce(new Error("synthetic storage failure"));
    await expect(h.set(oldExpiry + 60_000, RENEWED_COOKIE)).rejects.toThrow("synthetic storage failure");
    expect(h.values.get("cookieHeader")).toBe(COOKIE);
    expect(h.values.get("expiresAtMs")).toBe(oldExpiry);
    expect(h.values.get("refreshing")).toBe(true);
    expect(await h.storage.getAlarm()).toBe(oldExpiry);
  });
});
