import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession } from "../src/authSession.do";
import { sessionExpiryMs } from "../src/lib/sessionState";

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

type StoredValue = string | number | boolean;

/** Minimal in-memory stand-in for the subset of DurableObjectState the DO uses. */
function fakeState(): DurableObjectState {
  const store = new Map<string, StoredValue>();
  const storage = {
    get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
    put: async (key: string, value: StoredValue): Promise<void> => {
      store.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => store.delete(key),
    // Single-threaded tests need no real isolation: run the callback directly.
    transaction: async <T>(callback: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> =>
      callback(storage as unknown as DurableObjectTransaction)
  };
  return { storage } as unknown as DurableObjectState;
}

function makeSession(): AuthSession {
  return new AuthSession(fakeState(), {} as Env);
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

/**
 * Acquire the refresh lock and return its ownership token (TOG-18959).
 * `/unlock` and a holder's `/set` must present this token to release the lock.
 */
async function acquireToken(session: AuthSession): Promise<string> {
  const response = await call(session, "/lock");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { lockToken: unknown };
  expect(typeof body.lockToken).toBe("string");
  return body.lockToken as string;
}

describe("AuthSession Durable Object", () => {
  describe("/get", () => {
    it("returns an empty session before anything is stored", async () => {
      // Arrange
      const session = makeSession();

      // Act
      const state = await readState(session);

      // Assert
      expect(state).toEqual({ cookieHeader: null, expiresAtMs: null, refreshing: false });
    });
  });

  describe("/set", () => {
    it("stores the cookie header and expiry, and reports them back", async () => {
      // Arrange
      const session = makeSession();
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
      const lockToken = await acquireToken(session);

      // Act — the holder's write presents its token, releasing its own lock
      await call(session, "/set", { cookieHeader: ".WebRW=fresh", expiresAtMs: Date.now() + 60_000, lockToken });

      // Assert — refreshing reset, and the lock is immediately re-acquirable
      expect((await readState(session)).refreshing).toBe(false);
      expect((await call(session, "/lock")).status).toBe(200);
    });

    it("stores the session but keeps a live holder's lock on a tokenless write", async () => {
      // Arrange — a holder owns the lock; a non-holder publishes (TOG-18959)
      const session = await makeSession();
      await acquireToken(session);

      // Act — no lockToken presented
      const response = await call(session, "/set", {
        cookieHeader: ".WebRW=non-holder",
        expiresAtMs: Date.now() + 60_000
      });

      // Assert — the write lands (availability), but the holder's lock survives
      expect(response.status).toBe(200);
      expect((await readState(session)).cookieHeader).toBe(".WebRW=non-holder");
      expect((await readState(session)).refreshing).toBe(true);
      expect((await call(session, "/lock")).status).toBe(423);
    });

    it("stores the session but keeps a live holder's lock on a mismatched token", async () => {
      // Arrange
      const session = await makeSession();
      await acquireToken(session);

      // Act — a superseded holder's stale token
      const response = await call(session, "/set", {
        cookieHeader: ".WebRW=stale-holder",
        expiresAtMs: Date.now() + 60_000,
        lockToken: "stale-or-forged-token"
      });

      // Assert — stored, but the live lock is untouched
      expect(response.status).toBe(200);
      expect((await readState(session)).cookieHeader).toBe(".WebRW=stale-holder");
      expect((await readState(session)).refreshing).toBe(true);
      expect((await call(session, "/lock")).status).toBe(423);
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
      const session = makeSession();

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
      const session = makeSession();
      await call(session, "/set", { cookieHeader: ".WebRW=good", expiresAtMs: 1000 });

      // Act
      const response = await call(session, "/set", {
        cookieHeader: ".WebRW=bad",
        expiresAtMs: Number.NaN
      });

      // Assert
      expect(response.status).toBe(400);
      expect((await readState(session)).cookieHeader).toBe(".WebRW=good");
      expect((await readState(session)).expiresAtMs).toBe(1000);
    });

    it("overwrites a previously stored cookie", async () => {
      // Arrange
      const session = makeSession();
      await call(session, "/set", { cookieHeader: ".WebRW=old", expiresAtMs: 1 });

      // Act
      await call(session, "/set", { cookieHeader: ".WebRW=new", expiresAtMs: 2 });

      // Assert
      expect((await readState(session)).cookieHeader).toBe(".WebRW=new");
    });
  });

  describe("/lock", () => {
    it("grants the lock when free and marks the session as refreshing", async () => {
      // Arrange
      const session = makeSession();

      // Act
      const response = await call(session, "/lock");

      // Assert — a token is issued, and /get never exposes it
      expect(response.status).toBe(200);
      const body = (await response.json()) as { lockToken: unknown };
      expect(typeof body.lockToken).toBe("string");
      expect((body.lockToken as string).length).toBeGreaterThan(0);
      expect((await readState(session)).refreshing).toBe(true);
      expect(JSON.stringify(await readState(session))).not.toContain(body.lockToken);
    });

    it("issues a fresh token on every grant", async () => {
      // Arrange
      const session = await makeSession();

      // Act
      const first = await acquireToken(session);
      await call(session, "/unlock", { lockToken: first });
      const second = await acquireToken(session);

      // Assert — rotation, so a superseded holder's token never matches again
      expect(second).not.toBe(first);
    });

    it("returns 423 to a second caller while the lock is held and fresh", async () => {
      // Arrange
      const session = await makeSession();
      await acquireToken(session);

      // Act
      const second = await call(session, "/lock");

      // Assert
      expect(second.status).toBe(423);
    });
  });

  describe("/takeover", () => {
    it("refuses a takeover while the lock is held and fresh", async () => {
      // Arrange
      const session = await makeSession();
      await acquireToken(session);

      // Act
      const response = await call(session, "/takeover");

      // Assert
      expect(response.status).toBe(423);
    });

    it("recovers a stale lock with a fresh token the old holder cannot use", async () => {
      // Arrange — the holder crashed without unlocking
      const session = await makeSession();
      const staleToken = await acquireToken(session);

      // Act — past the TTL, an explicit takeover re-grants with a new token
      vi.setSystemTime(new Date(Date.now() + LOCK_TTL_MS + 1));
      const takeover = await call(session, "/takeover");
      expect(takeover.status).toBe(200);
      const freshToken = ((await takeover.json()) as { lockToken: string }).lockToken;
      expect(freshToken).not.toBe(staleToken);

      // Assert — the crashed holder's token no longer releases anything
      expect((await call(session, "/unlock", { lockToken: staleToken })).status).toBe(403);
      expect((await readState(session)).refreshing).toBe(true);
      expect((await call(session, "/unlock", { lockToken: freshToken })).status).toBe(200);
      expect((await readState(session)).refreshing).toBe(false);
    });
  });

  describe("/lock stale-lock recovery", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("still refuses a second caller just before the TTL expires", async () => {
      // Arrange
      const session = makeSession();
      await call(session, "/lock");

      // Act
      vi.setSystemTime(new Date(Date.now() + LOCK_TTL_MS - 1));
      const second = await call(session, "/lock");

      // Assert
      expect(second.status).toBe(423);
    });

    it("treats a lock older than the TTL as stale so a crashed refresh cannot wedge auth", async () => {
      // Arrange
      const session = makeSession();
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
      const lockToken = await acquireToken(session);

      // Act — the holder presents its token
      const response = await call(session, "/unlock", { lockToken });

      // Assert
      expect(response.status).toBe(200);
      expect((await readState(session)).refreshing).toBe(false);
      expect((await call(session, "/lock")).status).toBe(200);
    });

    it("preserves the stored cookie when releasing the lock", async () => {
      // Arrange
      const session = await makeSession();
      await call(session, "/set", { cookieHeader: ".WebRW=keep-me", expiresAtMs: Date.now() + 60_000 });
      const lockToken = await acquireToken(session);

      // Act
      await call(session, "/unlock", { lockToken });

      // Assert
      expect((await readState(session)).cookieHeader).toBe(".WebRW=keep-me");
    });

    it("is idempotent when no lock is held", async () => {
      // Arrange — never locked
      const session = await makeSession();

      // Act — tokenless, nothing to own
      const response = await call(session, "/unlock");

      // Assert
      expect(response.status).toBe(200);
      expect((await readState(session)).refreshing).toBe(false);
    });

    it.each([
      { label: "a missing token", body: {} },
      { label: "a mismatched token", body: { lockToken: "stale-or-forged-token" } },
      { label: "a non-JSON body", body: undefined }
    ])("refuses to release a live holder's lock with $label", async ({ body }) => {
      // Arrange — a live holder owns the lock
      const session = await makeSession();
      await acquireToken(session);

      // Act
      const response = await call(session, "/unlock", body);

      // Assert — 403 (or 200-OK idempotent only when free — never here):
      // the live lock survives the non-holder's release attempt
      expect(response.status).toBe(403);
      expect((await readState(session)).refreshing).toBe(true);
      expect((await call(session, "/lock")).status).toBe(423);
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
      const session = makeSession();

      // Act
      const response = await call(session, "/not-a-real-endpoint");

      // Assert
      expect(response.status).toBe(404);
    });
  });
});
