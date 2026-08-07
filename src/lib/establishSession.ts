import { establishSessionWithBrowser } from "./browserAuth";
import { establishSessionViaHttp } from "./httpAuth";
import {
  acquireRefreshLock,
  releaseRefreshLock,
  waitForConcurrentRefresh
} from "./sessionRefreshLock";

/**
 * Establish a Routeware session, choosing the method by `AUTH_MODE`:
 *   - "http"    → HTTP form login only (no browser).
 *   - "browser" → Browser Rendering login only.
 *   - "auto"    → (default) HTTP login, falling back to the browser on failure.
 *
 * The HTTP path is far cheaper/faster than Browser Rendering; the browser stays
 * as a resilient fallback in case the login markup or anti-forgery flow changes.
 *
 * Every mode runs under the `AuthSession` refresh lock so concurrent requests
 * that all see an expired session drive a single login rather than one each.
 */
export async function establishSession(
  env: Env,
  stub: DurableObjectStub,
  bootstrapUrl: string
): Promise<void> {
  const holdsLock = await acquireRefreshLock(stub);
  if (!holdsLock) {
    // Another request is already refreshing. Wait for it rather than logging in
    // again (the lock auto-expires if that refresh dies).
    await waitForConcurrentRefresh(stub);
    return;
  }

  try {
    await login(env, stub, bootstrapUrl);
  } catch (err) {
    // The DO clears the lock on a successful /set, so release only on failure.
    await releaseRefreshLock(stub);
    throw err;
  }
}

/** Run the configured login strategy. Assumes the refresh lock is already held. */
async function login(
  env: Env,
  stub: DurableObjectStub,
  bootstrapUrl: string
): Promise<void> {
  const mode = (env.AUTH_MODE ?? "auto").trim().toLowerCase();

  if (mode === "browser") {
    return establishSessionWithBrowser(env, stub, bootstrapUrl);
  }

  try {
    await establishSessionViaHttp(env, stub);
    return;
  } catch (err) {
    if (mode === "http") {
      throw err;
    }
    console.warn(
      "HTTP auth failed; falling back to Browser Rendering:",
      err instanceof Error ? err.message : String(err)
    );
    return establishSessionWithBrowser(env, stub, bootstrapUrl);
  }
}
