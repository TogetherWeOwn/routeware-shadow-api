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

/** True when this caller now holds the refresh lock. False means someone else does. */
export async function acquireRefreshLock(stub: DurableObjectStub): Promise<boolean> {
  const response = await stub.fetch("https://auth/lock");
  return response.status === 200;
}

/**
 * Release the lock after a failed refresh. The DO's `/set` already clears it on
 * success, so this is only needed on the error path. Never throws — a failure to
 * unlock must not mask the original error, and the DO expires a stale lock anyway.
 */
export async function releaseRefreshLock(stub: DurableObjectStub): Promise<void> {
  try {
    await stub.fetch("https://auth/unlock");
  } catch (err) {
    console.warn(
      "Failed to release the auth refresh lock; it will expire via its TTL:",
      err instanceof Error ? err.message : String(err)
    );
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
 * visible, or after the timeout (the caller then reacts to any upstream login
 * redirect).
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
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
