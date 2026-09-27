/**
 * Per-IP brute-force throttling for bearer-auth failures (TOG-5820).
 *
 * Every `/api/v1/*` route except `GET /api/v1/health` is bearer-gated with a
 * constant-time compare (`src/lib/auth.ts`), but nothing slowed brute force.
 * This module backs the gate with failure counting in the `AuthSession`
 * Durable Object (one DO instance per client IP, same binding — no new
 * migration), so counts survive across Worker isolates.
 *
 * Policy:
 * - Only *failed* outer-gate checks increment the counter. A valid token
 *   always passes and resets the IP's counter (legitimate traffic unaffected,
 *   even from an IP that previously failed).
 * - After `MAX_FAILURES` failures inside `WINDOW_MS`, further failed attempts
 *   from that IP get `429 rate-limited` (problem+json, `Retry-After`) for
 *   `BLOCK_MS`. The block is per-IP, not per-token, so rotating candidate
 *   tokens does not evade it.
 * - The public health probe and CORS preflight never touch the throttle.
 * - Throttle storage errors fail OPEN (the 401/429 decision degrades to the
 *   pre-throttle 401 behavior) — auth itself is still enforced; only the
 *   counting is best-effort.
 */

export const AUTH_THROTTLE_MAX_FAILURES = 20;
export const AUTH_THROTTLE_WINDOW_MS = 60_000;
export const AUTH_THROTTLE_BLOCK_MS = 60_000;

/** Storage key inside the per-IP throttle DO instance. */
export const AUTH_THROTTLE_STATE_KEY = "throttle";

export type AuthThrottleState = {
  failures: number;
  windowStartMs: number;
  blockedUntilMs: number | null;
};

export type AuthThrottleVerdict = {
  blocked: boolean;
  retryAfterSec: number;
};

type HeaderReader = { header: (name: string) => string | undefined };

/**
 * Best-effort client IP for throttle bucketing. `CF-Connecting-IP` is
 * authoritative (Cloudflare overwrites it, clients cannot spoof it);
 * `X-Forwarded-For` is a fallback for local dev/test only. Absent both, all
 * callers share the `"unknown"` bucket.
 */
export function clientIpFromRequest(req: HeaderReader): string {
  const cfIp = req.header("CF-Connecting-IP")?.trim();
  if (cfIp) {
    return cfIp;
  }
  const forwarded = req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  if (forwarded) {
    return forwarded;
  }
  return "unknown";
}

/** DO instance name for an IP's throttle bucket. */
export function throttleObjectName(ip: string): string {
  return `auth-throttle:${ip}`;
}

function retryAfterSec(blockedUntilMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((blockedUntilMs - nowMs) / 1000));
}

export function throttleCheckVerdict(
  state: AuthThrottleState | null,
  nowMs: number
): AuthThrottleVerdict {
  if (!state) {
    return { blocked: false, retryAfterSec: 0 };
  }
  if (state.blockedUntilMs !== null && nowMs < state.blockedUntilMs) {
    return { blocked: true, retryAfterSec: retryAfterSec(state.blockedUntilMs, nowMs) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

/**
 * Record one failed outer-gate check for the request's IP and report whether
 * the IP is now throttled. Never throws: storage errors fail OPEN to the
 * pre-throttle 401 behavior (auth itself is still enforced by the caller).
 */
export async function recordAuthFailure(
  env: Env,
  req: HeaderReader
): Promise<AuthThrottleVerdict> {
  const open: AuthThrottleVerdict = { blocked: false, retryAfterSec: 0 };
  try {
    const stub = env.AUTH_SESSION.get(
      env.AUTH_SESSION.idFromName(throttleObjectName(clientIpFromRequest(req)))
    );
    const res = await stub.fetch("https://throttle.local/throttle/failure", {
      method: "POST"
    });
    if (!res.ok) {
      return open;
    }
    const verdict = (await res.json()) as Partial<AuthThrottleVerdict>;
    if (typeof verdict.blocked !== "boolean" || typeof verdict.retryAfterSec !== "number") {
      return open;
    }
    return { blocked: verdict.blocked, retryAfterSec: verdict.retryAfterSec };
  } catch {
    return open;
  }
}

/**
 * Reset the request IP's failure counter after a successful check, so a
 * recovered client (or a legitimate user behind the same NAT IP) is never
 * stuck behind a stale count. Awaited by the caller for determinism; never
 * throws.
 */
export async function clearAuthFailures(env: Env, req: HeaderReader): Promise<void> {
  try {
    const stub = env.AUTH_SESSION.get(
      env.AUTH_SESSION.idFromName(throttleObjectName(clientIpFromRequest(req)))
    );
    await stub.fetch("https://throttle.local/throttle/clear", { method: "POST" });
  } catch {
    // Best-effort: a missed reset only leaves a stale counter that expires
    // with the window; it never blocks a valid token.
  }
}

export function throttleRecordFailure(
  state: AuthThrottleState | null,
  nowMs: number
): { next: AuthThrottleState; verdict: AuthThrottleVerdict } {
  const fresh =
    !state || nowMs - state.windowStartMs >= AUTH_THROTTLE_WINDOW_MS
      ? { failures: 0, windowStartMs: nowMs, blockedUntilMs: null }
      : state;
  const failures = fresh.failures + 1;
  const blockedUntilMs =
    failures >= AUTH_THROTTLE_MAX_FAILURES ? nowMs + AUTH_THROTTLE_BLOCK_MS : fresh.blockedUntilMs;
  const next: AuthThrottleState = { failures, windowStartMs: fresh.windowStartMs, blockedUntilMs };
  return { next, verdict: throttleCheckVerdict(next, nowMs) };
}
