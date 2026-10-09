import {
  AUTH_THROTTLE_STATE_KEY,
  throttleCheckVerdict,
  throttleRecordFailure,
  type AuthThrottleState
} from "./lib/authThrottle";

type SessionState = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
  /**
   * Set on `/get` when storage held cookie material past its recorded expiry
   * (evicted on this read, or earlier by `alarm()` via the `expiredEvicted`
   * tombstone). Mirrors `expired?` in `lib/sessionState.ts` so the
   * proactive refresh can tell "expired while idle" from a cold start.
   */
  expired?: boolean;
  /**
   * Failed-refresh episode anchor (TOG-18119, CISO option B): epoch ms of the
   * first `/unlock` that released a held lock without a `/set`, i.e. an
   * explicit failed release. Lets one queued waiter take over with a bounded
   * fresh login. Absent (never `null`) otherwise — like `expired`, so
   * existing exact-shape reads are unaffected.
   */
  failedReleaseAtMs?: number;
  /**
   * Epoch ms of the single takeover login claimed inside the current episode.
   * Present only after a `/takeover` win; cleared by the next successful
   * `/set`. Absent (never `null`) otherwise.
   */
  takeoverAtMs?: number;
};

/**
 * Auto-expire a held lock after this long so a refresh that crashed without
 * unlocking cannot wedge authentication forever. Must exceed a worst-case
 * browser login (~47s: two 15s selector waits + 15s navigation + 2s settle
 * in `browserAuth.ts`).
 *
 * Exported as the single source of truth for the timeout chain (TOG-6527):
 * `WAIT_TIMEOUT_MS` in `sessionRefreshLock.ts` is derived from it, so the
 * waiter budget can never drift past the lock TTL again.
 */
export const LOCK_TTL_MS = 120_000;

/**
 * How long a failed-refresh episode admits at most one waiter-takeover login
 * (TOG-18119, CISO option B: ≥60s named-constant cap on the DO-storage failure
 * window, bounding the episode at two logins however many requests queue).
 *
 * Anchored at the first explicit failed release (an `/unlock` that released a
 * held lock — the success path clears the lock via `/set`, never `/unlock`).
 * A successful `/set` clears the episode. The 60s floor fits a worst-case
 * browser login (~47s) inside one window. Only counters and timestamps are
 * stored — never cookie, URL, credential, or upstream body.
 */
export const TAKEOVER_WINDOW_MS = 60_000;

const LOCK_TOKEN_HEADER = "x-lock-token";

/**
 * Mint an ownership token for a freshly granted refresh lock (TOG-18119,
 * reviewer finding 2): `/lock` and `/takeover` return it in the 200 body, and
 * `/unlock` only releases a token-held lock when the caller presents the same
 * token. A superseded holder whose lock outlived `LOCK_TTL_MS` can otherwise
 * send a late `/unlock` that releases the NEXT holder's live lock and records
 * a bogus failed release — admitting a takeover login while a holder is still
 * refreshing. Only timestamp/flag bytes are stored; the token itself is an
 * opaque random nonce, never a credential or cookie.
 */
function newLockToken(): string {
  try {
    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return cryptoObj.randomUUID();
    }
  } catch {
    // Fall through to the Math.random fallback below.
  }
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 53).toString(36)}`;
}

/** Read the ownership token a caller presents on `/unlock`, if any. */
async function readUnlockToken(req: Request, url: URL): Promise<string | null> {
  const header = req.headers.get(LOCK_TOKEN_HEADER);
  if (header && header.length > 0) {
    return header;
  }
  const query = url.searchParams.get("token");
  if (query && query.length > 0) {
    return query;
  }
  return null;
}

type StoredSession = { cookieHeader: string; expiresAtMs: number };

/**
 * Validate a `/set` payload before it reaches storage. `req.json()` is `unknown`,
 * and an unchecked cast would let a caller bug (a missing field, or a `NaN`
 * expiry from an unparseable `SESSION_TTL_SECONDS`) be written straight into the
 * Durable Object, where it silently breaks every later refresh decision.
 */
function parseSetBody(body: unknown): StoredSession | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { cookieHeader, expiresAtMs } = body as Record<string, unknown>;
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) {
    return null;
  }
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) {
    return null;
  }
  return { cookieHeader, expiresAtMs };
}

/**
 * Narrow an unknown stored value to throttle state. Stale or foreign values
 * (e.g. a session field written under a colliding key by a bug) reset to
 * empty rather than throwing inside the DO.
 */
function isThrottleState(value: unknown): value is AuthThrottleState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { failures, windowStartMs, blockedUntilMs } = value as Record<string, unknown>;
  return (
    typeof failures === "number" &&
    Number.isInteger(failures) &&
    failures >= 0 &&
    typeof windowStartMs === "number" &&
    Number.isFinite(windowStartMs) &&
    (blockedUntilMs === null || (typeof blockedUntilMs === "number" && Number.isFinite(blockedUntilMs)))
  );
}

export class AuthSession {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env
  ) {
    // Repair sessions written before alarms existed when the object next wakes.
    this.state.blockConcurrencyWhile(() =>
      this.state.storage.transaction((txn) => this.readLiveSession(txn))
    );
  }

  private async clearSession(txn: DurableObjectTransaction): Promise<void> {
    await txn.delete(["cookieHeader", "expiresAtMs"]);
    await txn.deleteAlarm();
  }

  private async readLiveSession(txn: DurableObjectTransaction): Promise<StoredSession | null> {
    const cookieHeader = await txn.get<unknown>("cookieHeader");
    const expiresAtMs = await txn.get<unknown>("expiresAtMs");
    const session = parseSetBody({ cookieHeader, expiresAtMs });
    if (!session || session.expiresAtMs <= Date.now()) {
      // Session eviction must not release another caller's lock or throttle.
      const hadCookie = typeof cookieHeader === "string" && cookieHeader.length > 0;
      await this.clearSession(txn);
      if (hadCookie) {
        // Persist an expiry tombstone so a later `/get` still reports
        // `expired: true` when `alarm()` already evicted the cookie material.
        // Cleared on the next successful `/set`; a cold start that never stored
        // a session sets no marker. Keeps proactive refresh (no wasted
        // cookieless forward) for alarm-first expiry.
        await txn.put("expiredEvicted", true);
      }
      return null;
    }
    if (await txn.getAlarm() !== session.expiresAtMs) {
      await txn.setAlarm(session.expiresAtMs);
    }
    // Alarm storage I/O can cross the boundary even while the transaction holds.
    if (session.expiresAtMs <= Date.now()) {
      await this.clearSession(txn);
      // Cookie was present (session parsed), so expiry crossed during I/O.
      await txn.put("expiredEvicted", true);
      return null;
    }
    return session;
  }

  async alarm(): Promise<void> {
    // At-least-once/old alarms must inspect the current expiry, not the one
    // that originally scheduled them. A renewal and its alarm are atomic.
    await this.state.storage.transaction((txn) => this.readLiveSession(txn));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/get") {
      const data = await this.state.storage.transaction(async (txn): Promise<SessionState> => {
        const refreshing = (await txn.get<boolean>("refreshing")) ?? false;
        const rawCookie = await txn.get<unknown>("cookieHeader");
        const session = await this.readLiveSession(txn);
        // Flag an eviction that discarded real material: storage held a cookie
        // whose recorded expiry had passed (or was malformed), so this read
        // cleared it — or an earlier `alarm()` eviction already persisted the
        // `expiredEvicted` tombstone. A cold start with no stored cookie and no
        // tombstone reports no flag, which keeps the reactive first-forward
        // path for cookieless upstreams.
        const expiredMarker = await txn.get<boolean>("expiredEvicted");
        const evictedExpired =
          session === null &&
          ((typeof rawCookie === "string" && rawCookie.length > 0) || expiredMarker === true);
        // Failed-release episode markers (TOG-18119, CISO option B): surfaced
        // so waiters can elect one takeover login, then fail fast once the
        // budget is spent. Absent when no episode is recorded — like `expired`,
        // never `false`/`null` — so existing exact-shape reads are unaffected.
        const failedReleaseAtMs = await txn.get<unknown>("failedReleaseAtMs");
        const takeoverAtMs = await txn.get<unknown>("takeoverAtMs");
        return {
          cookieHeader: session?.cookieHeader ?? null,
          expiresAtMs: session?.expiresAtMs ?? null,
          refreshing,
          ...(evictedExpired ? { expired: true as const } : {}),
          ...(typeof failedReleaseAtMs === "number" && Number.isFinite(failedReleaseAtMs)
            ? { failedReleaseAtMs }
            : {}),
          ...(typeof takeoverAtMs === "number" && Number.isFinite(takeoverAtMs)
            ? { takeoverAtMs }
            : {})
        };
      });
      // Committing the transaction can cross expiry after its callback returned.
      if (data.expiresAtMs !== null && data.expiresAtMs <= Date.now()) {
        await this.state.storage.transaction((txn) => this.readLiveSession(txn));
        data.cookieHeader = null;
        data.expiresAtMs = null;
        data.expired = true;
      }
      return Response.json(data);
    }

    if (url.pathname === "/set") {
      const session = parseSetBody(await req.json().catch(() => null));
      if (!session) {
        // Storing a malformed session would silently corrupt every later expiry
        // check (a NaN expiry makes proactive refresh never fire again).
        return new Response("Bad Request", { status: 400 });
      }

      const published = await this.state.storage.transaction(async (txn) => {
        if (session.expiresAtMs <= Date.now()) {
          await this.readLiveSession(txn);
          return false;
        }
        await txn.put(session);
        await txn.setAlarm(session.expiresAtMs);
        await txn.put("refreshing", false);
        await txn.delete("lockedAt");
        await txn.delete("lockToken");
        await txn.delete("expiredEvicted");
        // A successful publication ends any failed-release episode (TOG-18119,
        // CISO option B): the fresh cookie is live, so no takeover is owed.
        await txn.delete("failedReleaseAtMs");
        await txn.delete("takeoverAtMs");
        return true;
      });
      if (!published) {
        return new Response("Session expired", { status: 409 });
      }
      // This acknowledges the committed write and lock release, not authentication.
      return new Response("OK");
    }

    if (url.pathname === "/lock") {
      const refreshing = await this.state.storage.get<boolean>("refreshing");
      const lockedAt = await this.state.storage.get<number>("lockedAt");
      const now = Date.now();
      // Treat a lock older than LOCK_TTL_MS as stale (holder likely crashed).
      const heldAndFresh =
        refreshing === true &&
        typeof lockedAt === "number" &&
        now - lockedAt < LOCK_TTL_MS;
      if (heldAndFresh) {
        return new Response("LOCKED", { status: 423 });
      }
      // Granting the lock mints an ownership token (TOG-18119, reviewer
      // finding 2): the winner presents it on `/unlock`, so a superseded
      // holder's late unlock can no longer release this lock. A stale lock
      // re-granted here replaces the previous token with the new winner's.
      const token = newLockToken();
      await this.state.storage.put("refreshing", true);
      await this.state.storage.put("lockedAt", now);
      await this.state.storage.put("lockToken", token);
      return new Response(token);
    }

    if (url.pathname === "/unlock") {
      // An explicit failed release: the success path clears the lock via
      // `/set`, never `/unlock`, so releasing a HELD lock here means the
      // holder's login failed (TOG-18119, CISO option B). Record the episode
      // anchor so one queued waiter may take over with a bounded fresh login.
      // A second unlock inside the window (failed takeover) keeps the anchor
      // and budget instead of admitting another takeover — capping the
      // episode at two logins. Unlocking an unheld lock records nothing.
      // Transactional with the release so the anchor can never describe a
      // lock that is still held.
      //
      // Ownership (TOG-18119, reviewer finding 2): when the stored lock carries
      // a token, only the matching token releases it. A superseded holder's
      // late `/unlock` (stale or missing token) changes nothing — neither the
      // live holder's lock nor the episode bookkeeping. Locks granted before
      // tokens existed carry no token and still release (deploy transition).
      //
      // Takeover budget (TOG-18119, reviewer finding 1): the takeover winner's
      // own failed `/unlock` (its `lockedAt` equals its `takeoverAtMs`) keeps
      // the anchor and the spent budget even past the window, instead of
      // starting a fresh episode that would admit a third login.
      const now = Date.now();
      const presented = await readUnlockToken(req, url);
      await this.state.storage.transaction(async (txn) => {
        const refreshing = (await txn.get<boolean>("refreshing")) ?? false;
        if (refreshing !== true) {
          await txn.put("refreshing", false);
          await txn.delete("lockedAt");
          await txn.delete("lockToken");
          return;
        }
        const storedToken = await txn.get<unknown>("lockToken");
        if (
          typeof storedToken === "string" &&
          storedToken.length > 0 &&
          presented !== storedToken
        ) {
          return;
        }
        const lockedAt = await txn.get<unknown>("lockedAt");
        const takeoverAt = await txn.get<unknown>("takeoverAtMs");
        await txn.put("refreshing", false);
        await txn.delete("lockedAt");
        await txn.delete("lockToken");
        if (
          typeof lockedAt === "number" &&
          typeof takeoverAt === "number" &&
          lockedAt === takeoverAt
        ) {
          return;
        }
        const prev = await txn.get<unknown>("failedReleaseAtMs");
        const active =
          typeof prev === "number" &&
          Number.isFinite(prev) &&
          now - prev < TAKEOVER_WINDOW_MS;
        if (!active) {
          await txn.put("failedReleaseAtMs", now);
          await txn.delete("takeoverAtMs");
        }
      });
      return new Response("OK");
    }

    if (url.pathname === "/takeover") {
      // Bounded fresh acquisition (TOG-18119, CISO option B): one queued waiter
      // takes over after an explicit failed release. Eligibility, lock
      // acquisition, and budget claim run in a single transaction so exactly
      // one waiter wins; losers see a held lock and wait on the new holder.
      // 200 = winner (now holds the lock; the body is its ownership token
      // for `/unlock`); 423 = a holder is live, keep waiting; 409 = no
      // failed-release episode, budget already spent, or the stored cookie is
      // live — keep waiting on a live cookie, or (spent budget) fail fast;
      // this route never changes state on 409.
      // A missing expiry counts as expired. No credential or cookie bytes are
      // read or written here — only lock flags, timestamps, and the liveness
      // check.
      const outcome = await this.state.storage.transaction(async (txn) => {
        const now = Date.now();
        const refreshing = (await txn.get<boolean>("refreshing")) ?? false;
        const lockedAt = await txn.get<number>("lockedAt");
        const heldAndFresh =
          refreshing === true &&
          typeof lockedAt === "number" &&
          now - lockedAt < LOCK_TTL_MS;
        if (heldAndFresh) {
          return "locked" as const;
        }
        const failedAt = await txn.get<unknown>("failedReleaseAtMs");
        const episodeActive =
          typeof failedAt === "number" &&
          Number.isFinite(failedAt) &&
          now - failedAt < TAKEOVER_WINDOW_MS;
        if (!episodeActive) {
          return "ineligible" as const;
        }
        const claimedAt = await txn.get<unknown>("takeoverAtMs");
        const budgetSpent =
          typeof claimedAt === "number" &&
          Number.isFinite(claimedAt) &&
          now - claimedAt < TAKEOVER_WINDOW_MS;
        if (budgetSpent) {
          return "ineligible" as const;
        }
        // Read raw: no eviction here — the winner's login publishes fresh
        // material, and a missing expiry counts as expired.
        const cookieHeader = await txn.get<unknown>("cookieHeader");
        const expiresAtMs = await txn.get<unknown>("expiresAtMs");
        const cookieLive =
          typeof cookieHeader === "string" &&
          cookieHeader.length > 0 &&
          typeof expiresAtMs === "number" &&
          Number.isFinite(expiresAtMs) &&
          expiresAtMs > now;
        if (cookieLive) {
          return "ineligible" as const;
        }
        const token = newLockToken();
        await txn.put("refreshing", true);
        await txn.put("lockedAt", now);
        await txn.put("lockToken", token);
        await txn.put("takeoverAtMs", now);
        return { status: "ok", token } as const;
      });
      if (outcome === "locked") {
        return new Response("LOCKED", { status: 423 });
      }
      if (typeof outcome === "object") {
        return new Response(outcome.token);
      }
      return new Response("NOT ELIGIBLE", { status: 409 });
    }

    // Per-IP bearer-failure throttle (TOG-5820). Each client IP gets its own
    // DO instance (`auth-throttle:<ip>`), so this storage key is namespaced by
    // construction. Malformed/absent state is treated as empty, never fatal.
    if (url.pathname === "/throttle/check") {
      const raw = await this.state.storage.get<unknown>(AUTH_THROTTLE_STATE_KEY);
      const state = isThrottleState(raw) ? raw : null;
      return Response.json(throttleCheckVerdict(state, Date.now()));
    }

    if (url.pathname === "/throttle/failure") {
      const raw = await this.state.storage.get<unknown>(AUTH_THROTTLE_STATE_KEY);
      const state = isThrottleState(raw) ? raw : null;
      const { next, verdict } = throttleRecordFailure(state, Date.now());
      await this.state.storage.put(AUTH_THROTTLE_STATE_KEY, next);
      return Response.json(verdict);
    }

    if (url.pathname === "/throttle/clear") {
      await this.state.storage.delete(AUTH_THROTTLE_STATE_KEY);
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
}
