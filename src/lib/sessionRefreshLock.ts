import { LOCK_TTL_MS, TAKEOVER_WINDOW_MS } from "../authSession.do";
import { problemJsonResponse, problemType } from "./problem";
import { logEvent } from "./logger";
import { readSessionState } from "./sessionState";

/**
 * Refresh-lock helpers for the `AuthSession` Durable Object.
 *
 * Only one login should run at a time per DO instance: N concurrent requests
 * arriving on a cold start (or right after the session expires) would otherwise
 * each drive a full login against Routeware, which at best wastes upstream calls
 * and at worst trips rate limiting or an account lockout.
 *
 * These live here, rather than inside one auth strategy, so every path in
 * `establishSession` is serialized by the same lock.
 */

/**
 * How long a waiter polls for the holder's fresh session before failing
 * closed to 502.
 *
 * Derived from the lock TTL so the relationship can never drift: the budget
 * must cover a worst-case browser login (~47s — two 15s selector waits + 15s
 * navigation + 2s settle in `browserAuth.ts`) with margin, while staying 30s
 * inside `LOCK_TTL_MS` so every waiter fails before the lock can go stale
 * and admit a duplicate login. Cold-start waiters previously timed out at
 * 20s, so any normal browser login outlasted them all.
 */
export const WAIT_TIMEOUT_MS = LOCK_TTL_MS - 30_000;
const WAIT_INTERVAL_MS = 500;

/**
 * Thrown when a waiter gives up on an in-flight refresh.
 *
 * The message carries only the timeout budget (a fixed PII-free string):
 * it reaches API clients inside a 502 `bad-gateway` problem+json and the
 * cron log, so it must never carry a cookie, URL, or body.
 */
export class ConcurrentRefreshTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Concurrent session refresh timed out after ${timeoutMs}ms`);
    this.name = "ConcurrentRefreshTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isConcurrentRefreshTimeout(err: unknown): err is ConcurrentRefreshTimeoutError {
  return err instanceof ConcurrentRefreshTimeoutError;
}

/** 502 problem+json for a waiter that gave up on a hung refresh. No cookie, URL, body, or PII. */
export function concurrentRefreshTimeoutProblem(
  timeoutMs: number,
  instance?: string,
  env?: Env,
  requestId?: string
): Response {
  return problemJsonResponse({
    type: problemType("bad-gateway", env),
    title: "Session refresh timed out",
    status: 502,
    detail:
      `Another request is refreshing the Routeware session and did not finish within ${timeoutMs}ms. ` +
      `Retry once; if it persists the upstream login is hung. See docs/PROBLEMS.md#bad-gateway.`,
    instance,
    ...(requestId === undefined ? {} : { requestId })
  });
}

/**
 * Narrow an unknown `/lock` (or `/takeover`) response body to an ownership
 * token. A missing or malformed token means the grant cannot be proven — the
 * caller must not act as the holder.
 */
function parseLockTokenGrant(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { lockToken } = body as Record<string, unknown>;
  return typeof lockToken === "string" && lockToken.length > 0 ? lockToken : null;
}

/**
 * Ask the DO for the refresh lock. Returns the ownership token when this
 * caller now holds the lock, or `null` when someone else does (423) or the
 * request fails. The token is opaque and PII-free; it only proves lock
 * ownership to `/unlock` and `/set`. `/takeover` is not a stale-lock alias —
 * it is the failed-release episode election (see `acquireTakeoverLock`).
 */
async function requestLockToken(
  stub: DurableObjectStub,
  path: "/lock" | "/takeover",
  init?: RequestInit
): Promise<string | null> {
  let response: Response;
  try {
    response = await stub.fetch(`https://auth${path}`, init);
  } catch {
    return null;
  }
  if (response.status !== 200) {
    return null;
  }
  return parseLockTokenGrant(await response.json().catch(() => null));
}

/** Ownership token when this caller now holds the refresh lock; null otherwise. */
export async function acquireRefreshLock(
  stub: DurableObjectStub
): Promise<string | null> {
  return requestLockToken(stub, "/lock");
}

/**
 * Release the lock after a failed refresh. The holder's `/set` already clears
 * it on success, so this is only needed on the error path. Only the matching
 * token releases a held lock — a superseded holder's stale token fails closed
 * with 403 and the live holder keeps its lock. Never throws — a failure to
 * unlock must not mask the original error, and the DO expires a stale lock anyway.
 * Do not inspect rejected values: they may contain credentials or throw on coercion.
 * The token is sent so the DO can verify ownership; a release without it (or with
 * a stale one) leaves a live holder's lock untouched.
 */
export async function releaseRefreshLock(
  stub: DurableObjectStub,
  lockToken?: string | null
): Promise<void> {
  try {
    await stub.fetch("https://auth/unlock", {
      method: "POST",
      body: JSON.stringify(lockToken ? { lockToken } : {})
    });
  } catch {
    logEvent({
      level: "warn",
      msg: "Failed to release the auth refresh lock; it will expire via its TTL",
      route: "auth.refreshLock"
    });
  }
}

/**
 * Publish a freshly-established session to the Durable Object.
 *
 * `lockToken` proves this caller holds the refresh lock: the DO stores the
 * session either way, but clears the lock only for the matching token. A
 * non-holder's write therefore never releases a live holder's lock.
 *
 * Throws if the DO rejects the write. That matters: the holder's `/set` clears
 * its own lock on success, so a silently-ignored rejection would leave the
 * lock held until its TTL expires while no session was ever stored — wedging
 * authentication. Throwing routes the failure into `establishSession`'s
 * catch, which releases the lock.
 */
export async function storeSession(
  stub: DurableObjectStub,
  cookieHeader: string,
  expiresAtMs: number,
  lockToken?: string | null
): Promise<void> {
  const response = await stub.fetch("https://auth/set", {
    method: "POST",
    body: JSON.stringify(lockToken ? { cookieHeader, expiresAtMs, lockToken } : { cookieHeader, expiresAtMs })
  });
  if (!response.ok) {
    throw new Error(
      `AuthSession rejected the session write (status ${response.status}). ` +
        "Check that SESSION_TTL_SECONDS parses to a finite number."
    );
  }
}

/**
 * Wait for a non-refreshing session with a nonempty cookie and a finite,
 * future expiry. A failed holder may leave its old cookie in storage; unlock
 * alone cannot make expired or malformed session material usable.
 * This validates local expiry, not a new publication or upstream acceptance:
 * an upstream-rejected cookie whose recorded expiry is still future may pass.
 * Throws `ConcurrentRefreshTimeoutError` on deadline — the
 * caller must fail closed to 502 rather than forwarding with the expired cookie.
 * Callers that should take over after an explicit failed release use
 * `waitForPublicationOrTakeover` instead.
 */
export async function waitForConcurrentRefresh(
  stub: DurableObjectStub,
  timeoutMs: number = WAIT_TIMEOUT_MS,
  intervalMs: number = WAIT_INTERVAL_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readSessionState(stub);
    if (
      state.refreshing === false &&
      typeof state.cookieHeader === "string" && state.cookieHeader.length > 0 &&
      typeof state.expiresAtMs === "number" && Number.isFinite(state.expiresAtMs) &&
      state.expiresAtMs > Date.now()
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new ConcurrentRefreshTimeoutError(timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Attempt a bounded fresh acquisition after an explicit failed release
 * (CISO option B). Resolves to the ownership token when this caller
 * won the atomic `/takeover` and now holds the refresh lock — it must run the
 * holder login path next and release with this token. `null` on 423 (a holder
 * is live — keep waiting on it) or 409 (no episode, spent budget, or a live
 * cookie — re-read and decide). A rejected fetch propagates: like `/lock`, a
 * failing `/takeover` call is a real error, not a lost race.
 */
export async function acquireTakeoverLock(stub: DurableObjectStub): Promise<string | null> {
  return requestLockToken(stub, "/takeover", { method: "POST" });
}

/** Outcome of `waitForPublicationOrTakeover`: the holder published, or this caller won the takeover. */
export type WaiterOutcome = "published" | "takeover";

/**
 * Settled waiter result: what happened, plus the ownership token the caller
 * holds when it won the takeover (for its eventual `/unlock`). `null` on
 * "published" — no lock is held.
 */
export type WaiterSettlement =
  | { outcome: "published"; token: null }
  | { outcome: "takeover"; token: string };

/**
 * Wait for the holder's fresh session exactly like
 * `waitForConcurrentRefresh`, but with bounded fresh acquisition (
 * CISO option B): after the holder's explicit failed release (`/unlock` that
 * released a held lock), one waiter takes over with a single fresh login
 * instead of every waiter stalling to 502.
 *
 * The DO decides the winner atomically in `/takeover`; the pre-check here
 * only avoids the call when the state cannot be eligible. Races resolve by
 * re-reading: losing the race means a new holder is live (keep waiting on
 * it); a shifted state means re-evaluating. Once a failed takeover spent the
 * window budget, remaining waiters fail at once with the existing timeout
 * shape instead of waiting out the window. A missing expiry counts as expired.
 * Throws `ConcurrentRefreshTimeoutError` on deadline — the caller must fail
 * closed to 502 rather than forwarding with the expired cookie.
 */
export async function waitForPublicationOrTakeover(
  stub: DurableObjectStub,
  timeoutMs: number = WAIT_TIMEOUT_MS,
  intervalMs: number = WAIT_INTERVAL_MS
): Promise<WaiterSettlement> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readSessionState(stub);
    const now = Date.now();
    if (
      state.refreshing === false &&
      typeof state.cookieHeader === "string" && state.cookieHeader.length > 0 &&
      typeof state.expiresAtMs === "number" && Number.isFinite(state.expiresAtMs) &&
      state.expiresAtMs > now
    ) {
      return { outcome: "published", token: null };
    }
    if (now >= deadline) {
      throw new ConcurrentRefreshTimeoutError(timeoutMs);
    }
    // Mirror of the DO's atomic `/takeover` eligibility: a recorded
    // failed-release episode inside the window, no live cookie, and no live
    // holder. The DO re-checks under its transaction, so a stale read here
    // only costs one 409.
    const episodeActive =
      typeof state.failedReleaseAtMs === "number" &&
      Number.isFinite(state.failedReleaseAtMs) &&
      now - state.failedReleaseAtMs < TAKEOVER_WINDOW_MS;
    const cookieLive =
      typeof state.cookieHeader === "string" && state.cookieHeader.length > 0 &&
      typeof state.expiresAtMs === "number" && Number.isFinite(state.expiresAtMs) &&
      state.expiresAtMs > now;
    if (episodeActive && !cookieLive && state.refreshing === false) {
      const budgetSpent =
        typeof state.takeoverAtMs === "number" &&
        Number.isFinite(state.takeoverAtMs) &&
        now - state.takeoverAtMs < TAKEOVER_WINDOW_MS;
      if (budgetSpent) {
        // The takeover already failed inside the window: fail at once with the
        // existing timeout shape instead of waiting out the budget.
        throw new ConcurrentRefreshTimeoutError(timeoutMs);
      }
      const takeoverToken = await acquireTakeoverLock(stub);
      if (takeoverToken) {
        return { outcome: "takeover", token: takeoverToken };
      }
      // Lost the race or the state shifted: loop re-reads. A new holder means
      // plain waiting; a spent budget means fast failure above. Re-check the
      // deadline before sleeping so a slow race cannot overrun the budget.
      if (Date.now() >= deadline) {
        throw new ConcurrentRefreshTimeoutError(timeoutMs);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
