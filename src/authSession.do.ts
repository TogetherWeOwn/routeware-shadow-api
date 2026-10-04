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
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/get") {
      const data: SessionState = {
        cookieHeader: (await this.state.storage.get("cookieHeader")) ?? null,
        expiresAtMs: (await this.state.storage.get("expiresAtMs")) ?? null,
        refreshing: (await this.state.storage.get("refreshing")) ?? false
      };
      return Response.json(data);
    }

    if (url.pathname === "/set") {
      const session = parseSetBody(await req.json().catch(() => null));
      if (!session) {
        // Storing a malformed session would silently corrupt every later expiry
        // check (a NaN expiry makes proactive refresh never fire again).
        return new Response("Bad Request", { status: 400 });
      }

      await this.state.storage.put("cookieHeader", session.cookieHeader);
      await this.state.storage.put("expiresAtMs", session.expiresAtMs);
      await this.state.storage.put("refreshing", false);
      await this.state.storage.delete("lockedAt");
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
