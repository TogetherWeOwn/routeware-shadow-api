/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const COOKIE = ".WebRW=SYNTHETIC-RUNTIME-NOT-A-CREDENTIAL";

function stub() {
  return env.AUTH_SESSION.get(env.AUTH_SESSION.newUniqueId());
}

async function store(session: DurableObjectStub, expiresAtMs: number) {
  const response = await session.fetch("https://auth/set", {
    method: "POST",
    body: JSON.stringify({ cookieHeader: COOKIE, expiresAtMs })
  });
  expect(response.status).toBe(200);
}

describe("AuthSession expiry in the local Durable Object runtime", () => {
  it("persists the session and alarm together, and rearms after an early alarm", async () => {
    const session = stub();
    const expiresAtMs = Date.now() + 60_000;
    await store(session, expiresAtMs);
    await runInDurableObject(session, async (_instance, state) => {
      expect(await state.storage.get("cookieHeader")).toBe(COOKIE);
      expect(await state.storage.getAlarm()).toBe(expiresAtMs);
    });
    expect(await runDurableObjectAlarm(session)).toBe(true);
    await runInDurableObject(session, async (_instance, state) => {
      expect(await state.storage.get("cookieHeader")).toBe(COOKIE);
      expect(await state.storage.getAlarm()).toBe(expiresAtMs);
    });
  });

  it("evicts idle expired material by the real alarm handler without releasing a refresh lock", async () => {
    const session = stub();
    await store(session, Date.now() + 60_000);
    await session.fetch("https://auth/lock");
    // Test-only legacy/late-delivery fixture in local storage, never production.
    await runInDurableObject(session, async (_instance, state) => {
      await state.storage.put("expiresAtMs", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(session)).toBe(true);
    await runInDurableObject(session, async (_instance, state) => {
      expect(await state.storage.get("cookieHeader")).toBeUndefined();
      expect(await state.storage.get("expiresAtMs")).toBeUndefined();
      expect(await state.storage.get("refreshing")).toBe(true);
      expect(await state.storage.get("lockedAt")).toBeTypeOf("number");
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await runDurableObjectAlarm(session)).toBe(false);
  });

  it("preserves renewal when a local alarm and /set run concurrently", async () => {
    const session = stub();
    await store(session, Date.now() + 60_000);
    await runInDurableObject(session, async (_instance, state) => {
      await state.storage.put("expiresAtMs", Date.now() - 1);
    });
    const expiresAtMs = Date.now() + 120_000;
    await Promise.all([runDurableObjectAlarm(session), store(session, expiresAtMs)]);
    await runInDurableObject(session, async (_instance, state) => {
      expect(await state.storage.get("cookieHeader")).toBe(COOKIE);
      expect(await state.storage.get("expiresAtMs")).toBe(expiresAtMs);
      expect(await state.storage.getAlarm()).toBe(expiresAtMs);
    });
  });

  it("evicts a legacy expired session on /get in real durable storage", async () => {
    const session = stub();
    await store(session, Date.now() + 60_000);
    await runInDurableObject(session, async (_instance, state) => {
      await state.storage.put("expiresAtMs", Date.now() - 1);
    });
    expect(await (await session.fetch("https://auth/get")).json()).toEqual({
      cookieHeader: null, expiresAtMs: null, refreshing: false
    });
    await runInDurableObject(session, async (_instance, state) => {
      expect(await state.storage.get("cookieHeader")).toBeUndefined();
      expect(await state.storage.get("expiresAtMs")).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
