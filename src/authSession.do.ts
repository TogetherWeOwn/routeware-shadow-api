import {
  AUTH_THROTTLE_STATE_KEY,
  throttleCheckVerdict,
  throttleRecordFailure,
  type AuthThrottleState
} from "./lib/authThrottle";

type StoredJarCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  expiresAtMs: number | null;
  secure: boolean;
};

type SessionState = {
  cookieHeader: string | null;
  expiresAtMs: number | null;
  refreshing: boolean;
  jar?: StoredJarCookie[] | null;
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

type StoredSession = {
  cookieHeader: string;
  expiresAtMs: number;
  jar?: StoredJarCookie[];
};

/**
 * Narrow an unknown stored value to a scoped jar entry. Anything malformed
 * is dropped (not fatal) — the forward path falls back to the unscoped
 * `cookieHeader` when no usable jar entry survives.
 */
function isJarCookie(value: unknown): value is StoredJarCookie {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const c = value as Record<string, unknown>;
  return (
    typeof c.name === "string" &&
    c.name.length > 0 &&
    typeof c.value === "string" &&
    typeof c.domain === "string" &&
    c.domain.length > 0 &&
    typeof c.hostOnly === "boolean" &&
    typeof c.path === "string" &&
    c.path.startsWith("/") &&
    (c.expiresAtMs === null ||
      (typeof c.expiresAtMs === "number" && Number.isFinite(c.expiresAtMs))) &&
    typeof c.secure === "boolean"
  );
}

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
  const { cookieHeader, expiresAtMs, jar } = body as Record<string, unknown>;
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) {
    return null;
  }
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) {
    return null;
  }
  if (jar !== undefined && jar !== null) {
    if (!Array.isArray(jar) || !jar.every(isJarCookie)) {
      return null;
    }
    return { cookieHeader, expiresAtMs, jar };
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
        refreshing: (await this.state.storage.get("refreshing")) ?? false,
        jar: (await this.state.storage.get("jar")) ?? null
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
      if (session.jar) {
        await this.state.storage.put("jar", session.jar);
      } else {
        await this.state.storage.delete("jar");
      }
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
