import { establishSessionWithBrowser } from "./browserAuth";
import { establishSessionViaHttp } from "./httpAuth";
import {
  acquireRefreshLock,
  releaseRefreshLock,
  waitForConcurrentRefresh
} from "./sessionRefreshLock";

/** The closed set of valid `AUTH_MODE` values (lowercase, post-trim). */
export const AUTH_MODES = ["auto", "http", "browser"] as const;

/** One of the closed `AUTH_MODE` values. */
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * Thrown when `AUTH_MODE` is set to something outside the closed set.
 *
 * A typo must fail fast here — never fall into the HTTP-then-browser
 * fallback, which would silently trigger expensive Browser Rendering logins
 * on what the operator intended as an `http`-only deploy (TOG-6531).
 * `received` echoes the operator's own config value (never a credential or
 * customer data), so it is safe to surface in a 503 detail.
 */
export class InvalidAuthModeError extends Error {
  readonly received: string;
  constructor(received: string) {
    super(
      `Invalid AUTH_MODE ${JSON.stringify(received)}: must be one of ${AUTH_MODES.join(", ")}.`
    );
    this.name = "InvalidAuthModeError";
    this.received = received;
  }
}

export function isInvalidAuthModeError(err: unknown): err is InvalidAuthModeError {
  return err instanceof InvalidAuthModeError;
}

/**
 * Resolve `AUTH_MODE` to the closed set. Case-insensitive with surrounding
 * whitespace trimmed (matching the previous normalization); absent defaults
 * to `"auto"` (the `wrangler.toml` default). Anything else throws
 * `InvalidAuthModeError` — callers must let it propagate to `app.onError`,
 * which maps it to a 503 `misconfigured` problem+json.
 */
export function resolveAuthMode(env: Env): AuthMode {
  const raw = String(env.AUTH_MODE ?? "auto").trim().toLowerCase();
  if ((AUTH_MODES as readonly string[]).includes(raw)) {
    return raw as AuthMode;
  }
  throw new InvalidAuthModeError(String(env.AUTH_MODE));
}

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
  // Closed validation (TOG-6531): unknown values throw before any login
  // attempt, so a typo never falls into the HTTP-then-browser fallback.
  const mode = resolveAuthMode(env);

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
