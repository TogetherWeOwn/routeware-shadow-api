import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession } from "../src/authSession.do";
import { sessionExpiryMs } from "../src/lib/sessionState";
import { authSessionTestState } from "./authSessionTestState";

/**
 * Unit tests for the `AuthSession` Durable Object — the sole holder of the
 * upstream Routeware session cookie (`docs/CONVENTIONS.md` § 4).
 *
 * Driven through a Map-backed `DurableObjectState` fake so the stale-lock TTL
 * branch can be exercised deterministically with fake timers, rather than
 * depending on wall-clock timing.
 */

/** Must match LOCK_TTL_MS in src/authSession.do.ts. */
const LOCK_TTL_MS = 120_000;

async function makeSession(): Promise<AuthSession> {
  const fake = authSessionTestState();
  const session = new AuthSession(fake.state, {} as Env);
  await fake.ready();
  return session;
}

function call(session: AuthSession, path: string, body?: unknown): Promise<Response> {
  return session.fetch(
    new Request(`https://do.local${path}`, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  );
}

type SessionSnapshot = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
};

async function readState(session: AuthSession): Promise<SessionSnapshot> {
  const response = await call(session, "/get");
  return (await response.json()) as SessionSnapshot;
}

async function readRaw(
  session: AuthSession
): Promise<SessionSnapshot & { expired?: boolean }> {
  const response = await call(session, "/get");
  return (await response.json()) as SessionSnapshot & { expired?: boolean };
}

describe("AuthSession Durable Object", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("/get", () => {
    it("returns an empty session before anything is stored", async () => {
      // Arrange
      const session = await makeSession();

      // Act
      const state = await readState(session);

      // Assert
      expect(state).toEqual({ cookieHeader: null, expiresAtMs: null, refreshing: false });
    });
  });

  describe("/set", () => {
    it("stores the cookie header and expiry, and reports them back", async () => {
      // Arrange
      const session = await makeSession();
      const expiresAtMs = 1_900_000_000_000;

      // Act
      const response = await call(session, "/set", {
        cookieHeader: ".WebRW=cookie-a",
        expiresAtMs
      });

      // Assert
      expect(response.status).toBe(200);
      expect(await readState(session)).toEqual({
        cookieHeader: ".WebRW=cookie-a",
        expiresAtMs,
        refreshing: false
      });
    });

    it("clears a held lock so a completed refresh cannot wedge authentication", async () => {
      // Arrange
      const session = await makeSession();
      await call(session, "/lock");

      // Act
      await call(session, "/set", { cookieHeader: ".WebRW=fresh", expiresAtMs: Date.now() + 60_000 });

      // Assert — refreshing reset, and the lock is immediately re-acquirable
      expect((await readState(session)).refreshing).toBe(false);
      expect((await call(session, "/lock")).status).toBe(200);
    });

    it.each([
      { label: "a missing cookieHeader", body: { expiresAtMs: 1 } },
      { label: "an empty cookieHeader", body: { cookieHeader: "", expiresAtMs: 1 } },
      { label: "a missing expiresAtMs", body: { cookieHeader: ".WebRW=x" } },
      { label: "a NaN expiresAtMs", body: { cookieHeader: ".WebRW=x", expiresAtMs: Number.NaN } },
      {
        label: "a non-numeric expiresAtMs",
        body: { cookieHeader: ".WebRW=x", expiresAtMs: "soon" }
      },
      { label: "a non-object body", body: "nope" }
    ])("rejects $label with 400 instead of storing it", async ({ body }) => {
      // Arrange
      const session = await makeSession();

      // Act
      const response = await call(session, "/set", body);

      // Assert — rejected, and nothing was persisted
      expect(response.status).toBe(400);
      expect(await readState(session)).toEqual({
        cookieHeader: null,
        expiresAtMs: null,
        refreshing: false
      });
    });

    it("does not clobber a good session when a later malformed /set arrives", async () => {
      // Arrange
      const session = await makeSession();
      const expiresAtMs = Date.now() + 60_000;
      await call(session, "/set", { cookieHeader: ".WebRW=good", expiresAtMs });

      // Act
      const response = await call(session, "/set", {
        cookieHeader: ".WebRW=bad",
        expiresAtMs: Number.NaN
      });

      // Assert
      expect(response.status).toBe(400);
      expect((await readState(session)).cookieHeader).toBe(".WebRW=good");
      expect((await readState(session)).expiresAtMs).toBe(expiresAtMs);
    });

    it("overwrites a previously stored cookie", async () => {
      // Arrange
      const session = await makeSession();
      await call(session, "/set", { cookieHeader: ".WebRW=old", expiresAtMs: Date.now() + 1000 });

      // Act
      await call(session, "/set", { cookieHeader: ".WebRW=new", expiresAtMs: Date.now() + 2000 });

      // Assert
      expect((await readState(session)).cookieHeader).toBe(".WebRW=new");
    });
  });

  describe("expiry eviction", () => {
    it("flags an idle-expired session on /get and clears the stale cookie", async () => {
      // Arrange — a live session that expires while idle.
      const session = await makeSession();
      await call(session, "/set", {
        cookieHeader: ".WebRW=idle",
        expiresAtMs: Date.now() + 60_000
      });
      vi.setSystemTime(new Date(Date.now() + 61_000));

      // Act
      const state = await readRaw(session);

      // Assert — stale material is gone, and the eviction is flagged so the
      // proactive refresh fires instead of a wasted cookieless forward.
      expect(state.cookieHeader).toBeNull();
      expect(state.expiresAtMs).toBeNull();
      expect(state.expired).toBe(true);
    });

    it("reports no expired flag on a cold start that never stored a session", async () => {
      // Arrange
      const session = await makeSession();

      // Act
      const state = await readRaw(session);

      // Assert — stays on the reactive first-forward path for cookieless upstreams.
      expect(state.expired).toBeUndefined();
    });

    it("alarm() evicts an expired session and keeps a live one", async () => {
      // Arrange
      const expired = await makeSession();
      await call(expired, "/set", {
        cookieHeader: ".WebRW=old",
        expiresAtMs: Date.now() + 1_000
      });
      const live = await makeSession();
      await call(live, "/set", {
        cookieHeader: ".WebRW=fresh",
        expiresAtMs: Date.now() + 60_000
      });
      vi.setSystemTime(new Date(Date.now() + 2_000));

      // Act
      await expired.alarm();
      await live.alarm();

      // Assert
      const expiredState = await readRaw(expired);
      expect(expiredState.cookieHeader).toBeNull();
      expect(expiredState.expired).toBe(true);
      const liveState = await readRaw(live);
      expect(liveState.cookieHeader).toBe(".WebRW=fresh");
      expect(liveState.expired).toBeUndefined();
    });

    it("reports expired on /get after alarm() evicted first (no wasted cold-start forward)", async () => {
      // Arrange — a live session that expires while idle, alarm runs first.
      const session = await makeSession();
      await call(session, "/set", {
        cookieHeader: ".WebRW=idle",
        expiresAtMs: Date.now() + 60_000
      });
      vi.setSystemTime(new Date(Date.now() + 61_000));
      await session.alarm();

      // Act — the next request reads after the alarm already cleared material.
      const state = await readRaw(session);

      // Assert — tombstone survives the alarm so proactive refresh fires
      // instead of a wasted cookieless forward.
      expect(state.cookieHeader).toBeNull();
      expect(state.expiresAtMs).toBeNull();
      expect(state.expired).toBe(true);
    });

    it("clears the expiry tombstone on the next successful /set", async () => {
      // Arrange — expire while idle and let alarm() persist the marker.
      const session = await makeSession();
      await call(session, "/set", {
        cookieHeader: ".WebRW=old",
        expiresAtMs: Date.now() + 60_000
      });
      vi.setSystemTime(new Date(Date.now() + 61_000));
      await session.alarm();
      expect((await readRaw(session)).expired).toBe(true);

      // Act — publish a fresh session.
      const response = await call(session, "/set", {
        cookieHeader: ".WebRW=fresh",
        expiresAtMs: Date.now() + 60_000
      });

      // Assert — marker cleared, live session reports no expired flag.
      expect(response.status).toBe(200);
      const state = await readRaw(session);
      expect(state.cookieHeader).toBe(".WebRW=fresh");
      expect(state.expired).toBeUndefined();
    });

    it("rejects a /set whose expiry already passed with 409 and keeps the live session", async () => {
      // Arrange
      const session = await makeSession();
      const expiresAtMs = Date.now() + 60_000;
      await call(session, "/set", { cookieHeader: ".WebRW=good", expiresAtMs });

      // Act
      const response = await call(session, "/set", {
        cookieHeader: ".WebRW=stale",
        expiresAtMs: Date.now() - 1
      });

      // Assert
      expect(response.status).toBe(409);
      const state = await readRaw(session);
      expect(state.cookieHeader).toBe(".WebRW=good");
      expect(state.expiresAtMs).toBe(expiresAtMs);
    });
  });

  describe("/lock", () => {
    it("grants the lock when free and marks the session as refreshing", async () => {
      // Arrange
      const session = await makeSession();

      // Act
      const response = await call(session, "/lock");

      // Assert
      expect(response.status).toBe(200);
      expect((await readState(session)).refreshing).toBe(true);
    });

    it("returns 423 to a second caller while the lock is held and fresh", async () => {
      // Arrange
      const session = await makeSession();
      await call(session, "/lock");

      // Act
      const second = await call(session, "/lock");

      // Assert
      expect(second.status).toBe(423);
    });
  });

  describe("/lock stale-lock recovery", () => {
    it("still refuses a second caller just before the TTL expires", async () => {
      // Arrange
      const session = await makeSession();
      await call(session, "/lock");

      // Act
      vi.setSystemTime(new Date(Date.now() + LOCK_TTL_MS - 1));
      const second = await call(session, "/lock");

      // Assert
      expect(second.status).toBe(423);
    });

    it("treats a lock older than the TTL as stale so a crashed refresh cannot wedge auth", async () => {
      // Arrange
      const session = await makeSession();
      await call(session, "/lock");

      // Act — the holder never unlocked (simulating a crash)
      vi.setSystemTime(new Date(Date.now() + LOCK_TTL_MS + 1));
      const second = await call(session, "/lock");

      // Assert
      expect(second.status).toBe(200);
      expect((await readState(session)).refreshing).toBe(true);
    });
  });

  describe("/unlock", () => {
    it("releases the lock so the next caller can acquire it", async () => {
      // Arrange
      const session = await makeSession();
      await call(session, "/lock");

      // Act
      const response = await call(session, "/unlock");

      // Assert
      expect(response.status).toBe(200);
      expect((await readState(session)).refreshing).toBe(false);
      expect((await call(session, "/lock")).status).toBe(200);
    });

    it("preserves the stored cookie when releasing the lock", async () => {
      // Arrange
      const session = await makeSession();
      await call(session, "/set", { cookieHeader: ".WebRW=keep-me", expiresAtMs: Date.now() + 60_000 });
      await call(session, "/lock");

      // Act
      await call(session, "/unlock");

      // Assert
      expect((await readState(session)).cookieHeader).toBe(".WebRW=keep-me");
    });
  });

  describe("sessionExpiryMs", () => {
    it("computes expiry from a valid TTL", () => {
      // Arrange
      const env = { SESSION_TTL_SECONDS: 1800 } as unknown as Env;

      // Act
      const expiry = sessionExpiryMs(env, 1_000_000);

      // Assert
      expect(expiry).toBe(1_000_000 + 1800 * 1000);
    });

    it("accepts a numeric string, as bindings may deliver", () => {
      // Arrange
      const env = { SESSION_TTL_SECONDS: "600" } as unknown as Env;

      // Act / Assert
      expect(sessionExpiryMs(env, 0)).toBe(600_000);
    });

    it.each([
      { label: "undefined", value: undefined },
      { label: "an empty string", value: "" },
      { label: "a non-numeric string", value: "thirty minutes" },
      { label: "zero", value: 0 },
      { label: "a negative number", value: -60 }
    ])("throws rather than producing a NaN/past expiry for $label", ({ value }) => {
      // Arrange
      const env = { SESSION_TTL_SECONDS: value } as unknown as Env;

      // Act / Assert — a NaN expiry would silently disable proactive refresh
      expect(() => sessionExpiryMs(env, 0)).toThrow(/SESSION_TTL_SECONDS/);
    });
  });

  describe("unknown paths", () => {
    it("returns 404 rather than falling through to a default behavior", async () => {
      // Arrange
      const session = await makeSession();

      // Act
      const response = await call(session, "/not-a-real-endpoint");

      // Assert
      expect(response.status).toBe(404);
    });
  });
});
