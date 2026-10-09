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
 * - Callers with no IP headers at all (no `CF-Connecting-IP`, no
 *   `X-Forwarded-For`, TOG-8896) get per-request treatment: failures are
 *   answered without touching storage, so one headerless client can neither
 *   throttle nor free-ride on any other caller. Identified-IP buckets are
 *   unaffected in both directions.
 * - Callers that send `X-Forwarded-For` where it is untrusted (production,
 *   flag off) still share the `"unknown"` bucket and its budget (TOG-8888
 *   fail-closed anti-evasion: rotating XFF cannot escape the throttle).
 *   Only the fully-headerless case — no signal to rotate — skips counting.
 * - Throttle storage errors fail OPEN (the 401/429 decision degrades to the
 *   pre-throttle 401 behavior) — auth itself is still enforced; only the
 *   counting is best-effort.
 */

import { logEvent } from "./logger";

export const AUTH_THROTTLE_MAX_FAILURES = 20;
export const AUTH_THROTTLE_WINDOW_MS = 60_000;
export const AUTH_THROTTLE_BLOCK_MS = 60_000;

/** Storage key inside the per-IP throttle DO instance. */
export const AUTH_THROTTLE_STATE_KEY = "throttle";

/**
 * Bucket key for callers with no usable IP headers (TOG-8896). No DO object
 * is ever addressed under this name: `recordAuthFailure`/`clearAuthFailures`
 * return per-request treatment before storage, so the shared object stays
 * untouched even if it holds stale counts from before the isolation.
 */
export const UNKNOWN_CLIENT_IP = "unknown";

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
 * (dev/test): in production XFF-only callers resolve to `"unknown"` and share
 * that bucket's budget, so rotating XFF cannot evade the throttle and no
 * victim bucket can be framed. Callers with neither header also resolve to
 * `"unknown"` but get per-request treatment instead (TOG-8896): they are
 * never counted and never blocked.
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
  return UNKNOWN_CLIENT_IP;
}

/**
 * Whether the request carries no IP headers at all (TOG-8896): no
 * `CF-Connecting-IP` and no `X-Forwarded-For` value. Independent of
 * `THROTTLE_TRUST_XFF` — an untrusted XFF value is still a client-supplied
 * signal and keeps the shared-unknown-bucket treatment (TOG-8888); only the
 * fully-headerless case skips counting, since there is nothing to scope a
 * counter to and nothing an attacker could rotate that counting would stop.
 */
export function hasNoIpHeaders(req: HeaderReader): boolean {
  const cfIp = req.header("CF-Connecting-IP")?.trim();
  if (cfIp) {
    return false;
  }
  const forwarded = req.header("X-Forwarded-For")?.split(",")[0]?.trim();
  return !forwarded;
}

/** DO instance name for an IP's throttle bucket. */
export function throttleObjectName(ip: string): string {
  return `auth-throttle:${ip}`;
}

function retryAfterSec(blockedUntilMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((blockedUntilMs - nowMs) / 1000));
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
  logEvent({
    level: "error",
    msg: "AUTH THROTTLE FAIL-OPEN",
    route: "authThrottle.failOpen",
    reason
  });
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
    return { blocked: true, retryAfterSec: retryAfterSec(state.blockedUntilMs, nowMs) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

/**
 * Record one failed outer-gate check for the request's IP and report whether
 * the IP is now throttled. Never throws: storage errors fail OPEN to the
 * pre-throttle 401 behavior (auth itself is still enforced by the caller).
 *
 * Fail-open is logged exactly once per `AUTH_THROTTLE_WINDOW_MS` (process-wide,
 * so a down throttle DO cannot spam the log): the event uses a fixed message
 * and reason category (plus status for non-OK) — never IP, token, or body.
 */
export async function recordAuthFailure(
  env: Env,
  req: HeaderReader,
  nowMs: number = Date.now()
): Promise<AuthThrottleVerdict> {
  const open: AuthThrottleVerdict = { blocked: false, retryAfterSec: 0 };
  // TOG-8896: isolate fully-headerless callers. With no IP headers there is
  // no narrow scope to count against, and a shared counter would let one
  // headerless client throttle (or free-ride on) every other caller.
  // Per-request treatment: answer open without touching storage. (XFF-only
  // callers in production still share the "unknown" bucket per TOG-8888.)
  if (hasNoIpHeaders(req)) {
    return open;
  }
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
    if (typeof verdict.blocked !== "boolean" || typeof verdict.retryAfterSec !== "number") {
      logFailOpenOnce("do_malformed", nowMs);
      return open;
    }
    return { blocked: verdict.blocked, retryAfterSec: verdict.retryAfterSec };
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
  // TOG-8896: nothing is ever counted for fully-headerless callers, so
  // there is nothing to clear. Skipping the DO fetch also keeps a headerless
  // success from resetting (free-riding on) any other caller's counter.
  if (hasNoIpHeaders(req)) {
    return;
  }
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
