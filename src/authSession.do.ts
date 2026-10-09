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
};

/**
 * Auto-expire a held lock after this long so a refresh that crashed without
 * unlocking cannot wedge authentication forever. Must exceed a worst-case
 * browser login.
 */
const LOCK_TTL_MS = 120_000;

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
 * Extract an optional refresh-lock ownership token from a `/set` or `/unlock`
 * body. The token is opaque here (issued by `/lock`/`/takeover`); absent or
 * malformed means "no proof of ownership", never a throw inside the DO.
 */
function parseLockToken(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { lockToken } = body as Record<string, unknown>;
  return typeof lockToken === "string" && lockToken.length > 0 ? lockToken : null;
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
      await this.clearSession(txn);
      return null;
    }
    if (await txn.getAlarm() !== session.expiresAtMs) {
      await txn.setAlarm(session.expiresAtMs);
    }
    // Alarm storage I/O can cross the boundary even while the transaction holds.
    if (session.expiresAtMs <= Date.now()) {
      await this.clearSession(txn);
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
        const session = await this.readLiveSession(txn);
        return {
          cookieHeader: session?.cookieHeader ?? null,
          expiresAtMs: session?.expiresAtMs ?? null,
          refreshing
        };
      });
      // Committing the transaction can cross expiry after its callback returned.
      if (data.expiresAtMs !== null && data.expiresAtMs <= Date.now()) {
        await this.state.storage.transaction((txn) => this.readLiveSession(txn));
        data.cookieHeader = null;
        data.expiresAtMs = null;
      }
      return Response.json(data);
    }

    if (url.pathname === "/set") {
      const raw = await req.json().catch(() => null);
      const session = parseSetBody(raw);
      if (!session) {
        // Storing a malformed session would silently corrupt every later expiry
        // check (a NaN expiry makes proactive refresh never fire again).
        return new Response("Bad Request", { status: 400 });
      }
      // Only the lock holder releases the refresh lock (TOG-18959). A live
      // session write without a matching token is still stored, but a live
      // holder's lock survives it — so a superseded holder or a waiter that
      // never acquired the lock cannot release another holder's live lock.
      const presentedToken = parseLockToken(raw);

      const published = await this.state.storage.transaction(async (txn) => {
        if (session.expiresAtMs <= Date.now()) {
          await this.readLiveSession(txn);
          return false;
        }
        await txn.put(session);
        await txn.setAlarm(session.expiresAtMs);
        const refreshing = await txn.get<boolean>("refreshing");
        if (refreshing !== true) {
          await txn.delete("lockedAt");
          await txn.delete("lockToken");
          return true;
        }
        const heldToken = await txn.get<string>("lockToken");
        if (
          typeof heldToken === "string" && heldToken.length > 0 &&
          presentedToken === heldToken
        ) {
          await txn.put("refreshing", false);
          await txn.delete("lockedAt");
          await txn.delete("lockToken");
        }
        return true;
      });
      if (!published) {
        return new Response("Session expired", { status: 409 });
      }
      // This acknowledges the committed write, not authentication (and, for a
      // non-holder write, not a lock release).
      return new Response("OK");
    }

    // `/lock` grants a fresh lock; `/takeover` is the explicit stale-recovery
    // alias (same guard: a fresh held lock is never taken). Both issue an
    // ownership token the holder must present to `/unlock` and `/set`
    // (TOG-18959). The token is never exposed via `/get`.
    if (url.pathname === "/lock" || url.pathname === "/takeover") {
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
      const lockToken = crypto.randomUUID();
      await this.state.storage.put("refreshing", true);
      await this.state.storage.put("lockedAt", now);
      await this.state.storage.put("lockToken", lockToken);
      return Response.json({ lockToken });
    }

    if (url.pathname === "/unlock") {
      const refreshing = await this.state.storage.get<boolean>("refreshing");
      if (refreshing !== true) {
        // Idempotent when nothing is held; also sweeps orphaned lock keys.
        await this.state.storage.put("refreshing", false);
        await this.state.storage.delete("lockedAt");
        await this.state.storage.delete("lockToken");
        return new Response("OK");
      }
      // A held lock is released only by its holder (TOG-18959). A missing or
      // mismatched token — a superseded holder, a waiter that never acquired
      // the lock, or a legacy caller — fails closed; the TTL still bounds a
      // lock whose token was lost.
      const presentedToken = parseLockToken(await req.json().catch(() => null));
      const heldToken = await this.state.storage.get<string>("lockToken");
      if (
        typeof heldToken !== "string" || heldToken.length === 0 ||
        presentedToken !== heldToken
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      await this.state.storage.put("refreshing", false);
      await this.state.storage.delete("lockedAt");
      await this.state.storage.delete("lockToken");
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
