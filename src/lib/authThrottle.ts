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
 * - The `MAX_FAILURES`-th failed attempt inside `WINDOW_MS` gets
 *   `429 rate-limited` (problem+json, `Retry-After`, and `X-RateLimit-*`
 *   headers) and starts a `BLOCK_MS` block; failed attempts during the block
 *   get 429 too. The block is per-IP, not per-token, so rotating candidate
 *   tokens does not evade it.
 * - The public health probe and CORS preflight never touch the throttle.
 * - Throttle storage errors fail OPEN (the 401/429 decision degrades to the
 *   pre-throttle 401 behavior) — auth itself is still enforced; only the
 *   counting is best-effort.
 */

export const AUTH_THROTTLE_MAX_FAILURES = 20;
/** Failed checks answered 401 per window; the next one is the first 429. */
export const AUTH_THROTTLE_ALLOWED_FAILURES = AUTH_THROTTLE_MAX_FAILURES - 1;
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
  resetAtSec?: number;
};

type HeaderReader = { header: (name: string) => string | undefined };

/**
 * Whether the throttle may trust `X-Forwarded-For` for bucketing. Explicit
 * opt-in only (`THROTTLE_TRUST_XFF === "true"`, set in `[env.test.vars]` and
 * local `.dev.vars`): production leaves it absent/`"false"`, so an
 * attacker-controlled XFF value can neither evade the throttle by rotation
 * nor burn a victim's budget (TOG-8888; probes in
 * test/authThrottleXffProbe.test.ts).
 */
function throttleTrustsXff(env: { THROTTLE_TRUST_XFF?: unknown } | undefined): boolean {
  return env?.THROTTLE_TRUST_XFF === "true";
}

/**
 * Best-effort client IP for throttle bucketing. `CF-Connecting-IP` is
 * authoritative (Cloudflare overwrites it, clients cannot spoof it).
 * `X-Forwarded-For` is honored only when `THROTTLE_TRUST_XFF="true"`
 * (dev/test): in production XFF-only callers share the `"unknown"` bucket,
 * so rotating XFF cannot evade the throttle and no victim bucket can be
 * framed. Absent both (or XFF without the flag), all callers share
 * `"unknown"`.
 */
export function clientIpFromRequest(
  req: HeaderReader,
  env?: { THROTTLE_TRUST_XFF?: unknown }
): string {
  const cfIp = req.header("CF-Connecting-IP")?.trim();
  if (cfIp) {
    return cfIp;
  }
  if (throttleTrustsXff(env)) {
    const forwarded = req.header("X-Forwarded-For")?.split(",")[0]?.trim();
    if (forwarded) {
      return forwarded;
    }
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

function rateLimitResetAtSec(blockedUntilMs: number): number {
  return Math.ceil(blockedUntilMs / 1000);
}

/**
 * Process-wide timestamp of the last fail-open log line. A down throttle DO
 * would otherwise emit one line per failed request (up to brute-force volume);
 * dedup to one line per `AUTH_THROTTLE_WINDOW_MS` keeps the alarm without
 * spamming the log.
 */
let lastFailOpenLogMs: number | null = null;

/**
 * Log a throttle fail-open exactly once per window. `reason` is one of the
 * fixed categories (`do_error`, `do_non_ok status=N`, `do_malformed`) — never
 * an IP, token, header, or body (CONVENTIONS.md §1 fact 2, §4).
 */
function logFailOpenOnce(reason: string, nowMs: number): void {
  if (lastFailOpenLogMs !== null && nowMs - lastFailOpenLogMs < AUTH_THROTTLE_WINDOW_MS) {
    return;
  }
  lastFailOpenLogMs = nowMs;
  console.error(`AUTH THROTTLE FAIL-OPEN ${reason}`);
}

/** Test-only: reset the per-window fail-open log dedup. */
export function resetAuthThrottleFailOpenLogForTests(): void {
  lastFailOpenLogMs = null;
}

export function throttleCheckVerdict(
  state: AuthThrottleState | null,
  nowMs: number
): AuthThrottleVerdict {
  if (!state) {
    return { blocked: false, retryAfterSec: 0 };
  }
  if (state.blockedUntilMs !== null && nowMs < state.blockedUntilMs) {
    return {
      blocked: true,
      retryAfterSec: retryAfterSec(state.blockedUntilMs, nowMs),
      resetAtSec: rateLimitResetAtSec(state.blockedUntilMs)
    };
  }
  return { blocked: false, retryAfterSec: 0 };
}

/**
 * Record one failed outer-gate check for the request's IP and report whether
 * the IP is now throttled. Never throws: storage errors fail OPEN to the
 * pre-throttle 401 behavior (auth itself is still enforced by the caller).
 *
 * Fail-open is logged exactly once per `AUTH_THROTTLE_WINDOW_MS` (process-wide,
 * so a down throttle DO cannot spam the log): the line is a fixed string with
 * a reason category (and status code for non-OK) — never IP, token, or body.
 */
export async function recordAuthFailure(
  env: Env,
  req: HeaderReader,
  nowMs: number = Date.now()
): Promise<AuthThrottleVerdict> {
  const open: AuthThrottleVerdict = { blocked: false, retryAfterSec: 0 };
  try {
    const stub = env.AUTH_SESSION.get(
      env.AUTH_SESSION.idFromName(throttleObjectName(clientIpFromRequest(req, env)))
    );
    const res = await stub.fetch("https://throttle.local/throttle/failure", {
      method: "POST"
    });
    if (!res.ok) {
      logFailOpenOnce(`do_non_ok status=${res.status}`, nowMs);
      return open;
    }
    const verdict = (await res.json()) as Partial<AuthThrottleVerdict>;
    if (
      typeof verdict.blocked !== "boolean" ||
      typeof verdict.retryAfterSec !== "number" ||
      !Number.isFinite(verdict.retryAfterSec)
    ) {
      logFailOpenOnce("do_malformed", nowMs);
      return open;
    }
    if (!verdict.blocked) {
      return { blocked: false, retryAfterSec: verdict.retryAfterSec };
    }
    // Older DO code may omit the absolute reset field during a rolling deploy.
    // Keep the throttle response usable while deriving a conservative fallback.
    const resetAtSec =
      typeof verdict.resetAtSec === "number" && Number.isFinite(verdict.resetAtSec)
        ? verdict.resetAtSec
        : Math.ceil((Date.now() + verdict.retryAfterSec * 1000) / 1000);
    return { blocked: true, retryAfterSec: verdict.retryAfterSec, resetAtSec };
  } catch {
    logFailOpenOnce("do_error", nowMs);
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
      env.AUTH_SESSION.idFromName(throttleObjectName(clientIpFromRequest(req, env)))
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
  const activeBlock =
    state !== null && state.blockedUntilMs !== null && nowMs < state.blockedUntilMs;
  const fresh =
    !state ||
    (nowMs - state.windowStartMs >= AUTH_THROTTLE_WINDOW_MS && !activeBlock)
      ? { failures: 0, windowStartMs: nowMs, blockedUntilMs: null }
      : state;
  const failures = fresh.failures + 1;
  const blockedUntilMs =
    failures >= AUTH_THROTTLE_MAX_FAILURES ? nowMs + AUTH_THROTTLE_BLOCK_MS : fresh.blockedUntilMs;
  const next: AuthThrottleState = { failures, windowStartMs: fresh.windowStartMs, blockedUntilMs };
  return { next, verdict: throttleCheckVerdict(next, nowMs) };
}
