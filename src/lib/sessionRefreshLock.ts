import { LOCK_TTL_MS } from "../authSession.do";
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
 * closed to 502 (TOG-6527).
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
 * Thrown when a waiter gives up on an in-flight refresh (TOG-6526).
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
  env?: Env
): Response {
  return problemJsonResponse({
    type: problemType("bad-gateway", env),
    title: "Session refresh timed out",
    status: 502,
    detail:
      `Another request is refreshing the Routeware session and did not finish within ${timeoutMs}ms. ` +
      `Retry once; if it persists the upstream login is hung. See docs/PROBLEMS.md#bad-gateway.`,
    instance
  });
}

/** True when this caller now holds the refresh lock. False means someone else does. */
export async function acquireRefreshLock(stub: DurableObjectStub): Promise<boolean> {
  const response = await stub.fetch("https://auth/lock");
  return response.status === 200;
}

/**
 * Release the lock after a failed refresh. The DO's `/set` already clears it on
 * success, so this is only needed on the error path. Never throws — a failure to
 * unlock must not mask the original error, and the DO expires a stale lock anyway.
 * Do not inspect rejected values: they may contain credentials or throw on coercion.
 */
export async function releaseRefreshLock(stub: DurableObjectStub): Promise<void> {
  try {
    await stub.fetch("https://auth/unlock");
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
 * Throws if the DO rejects the write. That matters: the DO clears the refresh
 * lock as part of a successful `/set`, so a silently-ignored rejection would
 * leave the lock held until its TTL expires while no session was ever stored —
 * wedging authentication. Throwing routes the failure into `establishSession`'s
 * catch, which releases the lock.
 */
export async function storeSession(
  stub: DurableObjectStub,
  cookieHeader: string,
  expiresAtMs: number
): Promise<void> {
  const response = await stub.fetch("https://auth/set", {
    method: "POST",
    body: JSON.stringify({ cookieHeader, expiresAtMs })
  });
  if (!response.ok) {
    throw new Error(
      `AuthSession rejected the session write (status ${response.status}). ` +
        "Check that SESSION_TTL_SECONDS parses to a finite number."
    );
  }
}

/**
 * Wait for the refresh holder to publish a fresh session, instead of proceeding
 * with a stale/empty one. Returns once a non-refreshing session with a cookie is
 * visible. Throws `ConcurrentRefreshTimeoutError` on deadline (TOG-6526) — the
 * caller must fail closed to 502 rather than forwarding with the expired
 * cookie, which would surface upstream login HTML as a 200.
 */
export async function waitForConcurrentRefresh(
  stub: DurableObjectStub,
  timeoutMs: number = WAIT_TIMEOUT_MS,
  intervalMs: number = WAIT_INTERVAL_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readSessionState(stub);
    if (!state.refreshing && state.cookieHeader) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new ConcurrentRefreshTimeoutError(timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
