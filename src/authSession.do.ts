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
        return {
          cookieHeader: session?.cookieHeader ?? null,
          expiresAtMs: session?.expiresAtMs ?? null,
          refreshing,
          ...(evictedExpired ? { expired: true as const } : {})
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
        await txn.delete("expiredEvicted");
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
      await this.state.storage.put("refreshing", true);
      await this.state.storage.put("lockedAt", now);
      return new Response("OK");
    }

    if (url.pathname === "/unlock") {
      await this.state.storage.put("refreshing", false);
      await this.state.storage.delete("lockedAt");
      return new Response("OK");
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
