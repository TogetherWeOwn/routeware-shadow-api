import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSession, TAKEOVER_WINDOW_MS } from "../src/authSession.do";
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

/**
 * Like `makeSession`, but exposes the raw storage map so at-rest eviction can
 * be asserted without any `/get` — a `/get` read evicts and tombstones itself,
 * which would mask a no-op `alarm()` or a missing constructor repair.
 */
async function makeInspectableSession(initial: Record<string, unknown> = {}) {
  const fake = authSessionTestState(initial);
  const session = new AuthSession(fake.state, {} as Env);
  await fake.ready();
  return { session, values: fake.values, storage: fake.storage };
}

function call(
  session: AuthSession,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<Response> {
  return session.fetch(
    new Request(`https://do.local${path}`, {
      method: body === undefined && headers === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers
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

/**
 * Acquire the refresh lock and return its ownership token.
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
      const lockToken = await acquireToken(session);

      // Act — the holder's write presents its token, releasing its own lock
      await call(session, "/set", { cookieHeader: ".WebRW=fresh", expiresAtMs: Date.now() + 60_000, lockToken });

      // Assert — refreshing reset, and the lock is immediately re-acquirable
      expect((await readState(session)).refreshing).toBe(false);
      expect((await call(session, "/lock")).status).toBe(200);
    });

    it("stores the session but keeps a live holder's lock on a tokenless write", async () => {
      // Arrange — a holder owns the lock; a non-holder publishes
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

    it("stores a stale holder's late publication after /takeover but preserves the winner's lock", async () => {
      // Arrange — A releases with no stored session; B wins the takeover.
      const { session, values } = await makeInspectableSession();
      const tokenA = await acquireToken(session);
      expect((await call(session, "/unlock", { lockToken: tokenA })).status).toBe(200);
      const takeover = await call(session, "/takeover", {});
      expect(takeover.status).toBe(200);
      const { lockToken: tokenB } = (await takeover.json()) as { lockToken: string };
      expect(tokenB).not.toBe(tokenA);
      const failedReleaseAtMs = values.get("failedReleaseAtMs");
      const takeoverAtMs = values.get("takeoverAtMs");
      expect(typeof failedReleaseAtMs).toBe("number");
      expect(typeof takeoverAtMs).toBe("number");

      // Act — A's late /set is accepted as a session write, but cannot release B.
      vi.setSystemTime(new Date(Date.now() + 1));
      const lateSet = await call(session, "/set", {
        cookieHeader: ".WebRW=late-stale-holder",
        expiresAtMs: Date.now() + 60_000,
        lockToken: tokenA
      });
      vi.setSystemTime(new Date(Date.now() + 1));
      const lateUnlock = await call(session, "/unlock", { lockToken: tokenA });

      // Assert — shipped behavior accepts /set independent of ownership; only
      // the matching token releases the lock. B can still publish and release.
      expect(lateSet.status).toBe(200);
      expect(lateUnlock.status).toBe(403);
      const state = (await (await call(session, "/get")).json()) as SessionSnapshot & {
        failedReleaseAtMs?: number;
        takeoverAtMs?: number;
      };
      expect(state.cookieHeader).toBe(".WebRW=late-stale-holder");
      expect(state.refreshing).toBe(true);
      expect(state.failedReleaseAtMs).toBe(failedReleaseAtMs);
      expect(state.takeoverAtMs).toBe(takeoverAtMs);
      expect(values.get("failedReleaseAtMs")).toBe(failedReleaseAtMs);
      expect(values.get("takeoverAtMs")).toBe(takeoverAtMs);
      expect((await call(session, "/lock")).status).toBe(423);
      expect((await call(session, "/set", {
        cookieHeader: ".WebRW=current-holder",
        expiresAtMs: Date.now() + 60_000,
        lockToken: tokenB
      })).status).toBe(200);
      expect((await readState(session)).cookieHeader).toBe(".WebRW=current-holder");
      expect((await readState(session)).refreshing).toBe(false);
      expect(values.has("failedReleaseAtMs")).toBe(false);
      expect(values.has("takeoverAtMs")).toBe(false);
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

    it("rejects an unparseable /set body with 400 instead of storing it", async () => {
      // Arrange
      const session = await makeSession();

      // Act — truncated JSON: req.json() rejects, so raw is null, never partial
      const response = await session.fetch(
        new Request("https://do.local/set", { method: "POST", body: "{invalid" })
      );

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

    describe("at-rest eviction (storage-direct, no /get)", () => {
      it("alarm() evicts an expired session at rest and persists the tombstone", async () => {
        // Arrange — a live session that expires with no request arriving.
        const { session, values, storage } = await makeInspectableSession();
        await call(session, "/set", {
          cookieHeader: ".WebRW=idle",
          expiresAtMs: Date.now() + 60_000
        });
        vi.setSystemTime(new Date(Date.now() + 61_000));

        // Act — the alarm fires; nothing reads through /get.
        await session.alarm();

        // Assert — storage holds no cookie material, the tombstone is set for
        // the next /get, and the spent alarm is cleared. A no-op alarm() fails
        // the first assertion; a missing tombstone write fails the second.
        expect(values.has("cookieHeader")).toBe(false);
        expect(values.has("expiresAtMs")).toBe(false);
        expect(values.get("expiredEvicted")).toBe(true);
        expect(await storage.getAlarm()).toBeNull();
      });

      it("constructor repair evicts a pre-alarm expired session before serving requests", async () => {
        // Arrange — storage written before alarms existed holds an
        // already-expired session and no alarm.
        const fake = authSessionTestState({
          cookieHeader: ".WebRW=legacy",
          expiresAtMs: Date.now() - 1
        });

        // Act — constructing the object runs the startup repair.
        const session = new AuthSession(fake.state, {} as Env);
        await fake.ready();

        // Assert — storage-direct: no request (and no /get eviction) involved.
        // Removing the constructor repair leaves the stale cookie in storage.
        expect(fake.values.has("cookieHeader")).toBe(false);
        expect(fake.values.get("expiredEvicted")).toBe(true);
        expect(await fake.storage.getAlarm()).toBeNull();

        // A later /get reports the expiry flag, not the stale cookie.
        const state = await readRaw(session);
        expect(state.cookieHeader).toBeNull();
        expect(state.expired).toBe(true);
      });

      it("alarm() re-arms a missing alarm for a live session without touching the cookie", async () => {
        // Arrange — a live session whose alarm was lost.
        const { session, values, storage } = await makeInspectableSession();
        const expiresAtMs = Date.now() + 60_000;
        await call(session, "/set", { cookieHeader: ".WebRW=live", expiresAtMs });
        await storage.deleteAlarm();

        // Act
        await session.alarm();

        // Assert — the alarm is restored to the recorded expiry and the live
        // material is untouched. Removing the re-arm leaves no alarm scheduled.
        expect(await storage.getAlarm()).toBe(expiresAtMs);
        expect(values.get("cookieHeader")).toBe(".WebRW=live");
      });
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
      const response = await session.fetch(
        new Request("https://do.local/takeover", { method: "POST" })
      );

      // Assert
      expect(response.status).toBe(423);
    });

    it("stays ineligible on a stale lock with no failed-release episode", async () => {
      // Arrange — the holder crashed without unlocking, and no failed release
      // was ever recorded. Stale-lock recovery goes through `/lock`; the
      // episode election needs an explicit failed release.
      const session = await makeSession();
      await acquireToken(session);

      // Act — past the TTL, with no episode anchor
      vi.setSystemTime(new Date(Date.now() + LOCK_TTL_MS + 1));
      const takeover = await session.fetch(
        new Request("https://do.local/takeover", { method: "POST" })
      );

      // Assert — 409, and nothing changed: no claim, no steal
      expect(takeover.status).toBe(409);
      expect((await readState(session)).refreshing).toBe(true);
    });

    it("stays ineligible on cold storage and writes nothing on 409", async () => {
      // Arrange — virgin DO: no lock, session, or episode keys were ever set,
      // so `refreshing` reads undefined rather than an explicit false.
      const { session, values } = await makeInspectableSession();
      const before = [...values.keys()];

      // Act
      const takeover = await call(session, "/takeover", {});

      // Assert — 409, and the route changed no state: no claim, no anchor.
      expect(takeover.status).toBe(409);
      expect([...values.keys()]).toEqual(before);
      expect((await readState(session)).refreshing).toBe(false);
    });

    it("keeps a takeover lock against a stale holder's late publish and release", async () => {
      // Arrange — A explicitly fails and releases; B wins the bounded takeover.
      const session = await makeSession();
      const staleToken = await acquireToken(session);
      expect((await call(session, "/unlock", { lockToken: staleToken })).status).toBe(200);
      const takeover = await call(session, "/takeover");
      expect(takeover.status).toBe(200);
      const currentToken = ((await takeover.json()) as { lockToken: string }).lockToken;
      expect(currentToken).not.toBe(staleToken);

      // Act — A's late publish is accepted by contract but cannot release B's
      // lock; A's late unlock is rejected and also leaves B's lock intact.
      const latePublish = await call(session, "/set", {
        cookieHeader: ".WebRW=stale-holder",
        expiresAtMs: Date.now() + 60_000,
        lockToken: staleToken
      });
      const lateUnlock = await call(session, "/unlock", { lockToken: staleToken });

      // Assert — only B's token can release the current lock or replace A's
      // stale publication. The `/get` response never reveals either token.
      expect(latePublish.status).toBe(200);
      expect(lateUnlock.status).toBe(403);
      expect((await readState(session)).cookieHeader).toBe(".WebRW=stale-holder");
      expect((await readState(session)).refreshing).toBe(true);
      expect((await call(session, "/lock")).status).toBe(423);
      expect((await call(session, "/set", {
        cookieHeader: ".WebRW=current-holder",
        expiresAtMs: Date.now() + 120_000,
        lockToken: currentToken
      })).status).toBe(200);
      expect((await readState(session)).cookieHeader).toBe(".WebRW=current-holder");
      expect((await readState(session)).refreshing).toBe(false);
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

    it("records no failed-release episode when a stale token is refused", async () => {
      // Arrange — holder A locks, outlives the TTL, holder B re-acquires.
      const session = await makeSession();
      await call(session, "/set", { cookieHeader: ".WebRW=keep-me", expiresAtMs: Date.now() + 300_000 });
      const stale = await acquireToken(session);
      vi.setSystemTime(new Date(Date.now() + LOCK_TTL_MS + 1));
      const live = await acquireToken(session);
      expect(live).not.toBe(stale);

      // Act — A's late unlock with its superseded token is refused; a
      // tokenless one is refused too.
      expect((await call(session, "/unlock", { lockToken: stale })).status).toBe(403);
      expect((await call(session, "/unlock")).status).toBe(403);

      // Assert — B's live lock survived both: still refreshing, cookie
      // intact, re-lock refused, and no failed-release episode recorded (a
      // bogus episode would admit a takeover login next to the live holder).
      expect((await readState(session)).refreshing).toBe(true);
      expect((await readState(session)).cookieHeader).toBe(".WebRW=keep-me");
      expect((await call(session, "/lock")).status).toBe(423);
      expect(
        (await session.fetch(new Request("https://do.local/takeover", { method: "POST" }))).status
      ).toBe(423);
    });

    it("keeps the original anchor when a second holder fails inside the window", async () => {
      // Arrange — A fails and anchors the episode; B takes a normal /lock
      // mid-episode (not a takeover) and fails 1s later, inside the window.
      const { session, values } = await makeInspectableSession();
      const tokenA = await acquireToken(session);
      expect((await call(session, "/unlock", { lockToken: tokenA })).status).toBe(200);
      const anchor = values.get("failedReleaseAtMs");
      expect(typeof anchor).toBe("number");
      vi.setSystemTime(new Date(Date.now() + 1000));
      const tokenB = await acquireToken(session);

      // Act — B's login fails too.
      const response = await call(session, "/unlock", { lockToken: tokenB });

      // Assert — no fresh episode: the anchor and the unspent budget survive,
      // so the window still closes on the original anchor and a waiter may
      // still take over once.
      expect(response.status).toBe(200);
      expect(values.get("failedReleaseAtMs")).toBe(anchor);
      expect(values.has("takeoverAtMs")).toBe(false);
      expect((await readState(session)).refreshing).toBe(false);
      expect((await call(session, "/takeover", {})).status).toBe(200);
    });

    it("opens a fresh episode when a holder fails after the window closed", async () => {
      // Arrange — A fails and anchors an episode nobody claims; the window passes.
      const { session, values } = await makeInspectableSession();
      const tokenA = await acquireToken(session);
      expect((await call(session, "/unlock", { lockToken: tokenA })).status).toBe(200);
      const staleAnchor = values.get("failedReleaseAtMs");
      expect(typeof staleAnchor).toBe("number");
      vi.setSystemTime(new Date(Date.now() + TAKEOVER_WINDOW_MS + 1));
      const tokenB = await acquireToken(session);

      // Act — B's login fails after the window closed.
      const response = await call(session, "/unlock", { lockToken: tokenB });

      // Assert — the stale anchor is replaced by B's failure time and the
      // budget is reset, so the new episode admits one takeover.
      expect(response.status).toBe(200);
      expect(values.get("failedReleaseAtMs")).toBe(Date.now());
      expect(values.get("failedReleaseAtMs")).not.toBe(staleAnchor);
      expect(values.has("takeoverAtMs")).toBe(false);
      expect((await readState(session)).refreshing).toBe(false);
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
