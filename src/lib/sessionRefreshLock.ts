import { problemJsonResponse, problemType } from "./problem";
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

const WAIT_TIMEOUT_MS = 20_000;
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
export function concurrentRefreshTimeoutProblem(timeoutMs: number, instance?: string): Response {
  return problemJsonResponse({
    type: problemType("bad-gateway"),
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
    console.warn("Failed to release the auth refresh lock; it will expire via its TTL.");
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
 * Wait for a non-refreshing session with a nonempty cookie and a finite,
 * future expiry. A failed holder may leave its old cookie in storage; unlock
 * alone cannot make expired or malformed session material usable.
 * This validates local expiry, not a new publication or upstream acceptance:
 * an upstream-rejected cookie whose recorded expiry is still future may pass.
 * Throws `ConcurrentRefreshTimeoutError` on deadline (TOG-6526) — the
 * caller must fail closed to 502 rather than forwarding with the expired cookie.
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
