import { establishSessionWithBrowser } from "./browserAuth";
import { establishSessionViaHttp } from "./httpAuth";
import { isLoginPageUnavailableError } from "./loginPageError";
import { logEvent } from "./logger";
import { isMissingSetCookieCapabilityError } from "./setCookieCapabilityError";
import { readSessionState } from "./sessionState";
import {
  acquireRefreshLock,
  releaseRefreshLock,
  waitForPublicationOrTakeover
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
  // The ownership token for the lock this caller holds, if any: granted by
  // `/lock` directly, or by `/takeover` after waiting. It is presented on the
  // failure-path `/unlock` so a late release can never clear another holder's
  // live lock (TOG-18119, reviewer finding 2).
  let lockToken = await acquireRefreshLock(stub);
  if (!lockToken) {
    // Another request is already refreshing. Wait for its publication — or,
    // after its explicit failed release, take over with one bounded fresh
    // login (TOG-18119, CISO option B: the atomic `/takeover` elects a single
    // winner inside the failed-release window; losers wait on the new
    // holder). On deadline, or once a failed takeover spent the window
    // budget, the wait throws `ConcurrentRefreshTimeoutError` (TOG-6526) — it
    // propagates so the caller fails closed to 502 instead of forwarding with
    // the expired cookie.
    const settlement = await waitForPublicationOrTakeover(stub);
    if (settlement.outcome === "published") {
      return;
    }
    // "takeover": this caller won the atomic `/takeover` and now holds the
    // lock — fall through to the holder login path below.
    lockToken = settlement.token;
  }

  try {
    await login(env, stub, bootstrapUrl);
  } catch (err) {
    // The DO clears the lock on a successful /set, so release only on failure.
    await releaseRefreshLock(stub, lockToken);
    throw err;
  }

  // A successful publication released our lock. Validate the published material
  // outside the catch: a delayed write/read can expire. Lock ownership is NOT
  // checked here — another caller may legitimately hold the lock for the next
  // refresh by the time this read lands, while our just-published cookie is
  // still live. Only the cookie and its expiry determine success.
  const session = await readSessionState(stub);
  if (
    typeof session.cookieHeader !== "string" || session.cookieHeader.length === 0 ||
    typeof session.expiresAtMs !== "number" || !Number.isFinite(session.expiresAtMs) ||
    session.expiresAtMs <= Date.now()
  ) {
    throw new Error("Session refresh completed without an available live session.");
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
    // A blocked login page (TOG-6536) is never a browser case: the token is
    // missing because upstream answered 403/500, not because the markup
    // changed. Re-run the browser there would burn Browser Rendering budget
    // on a page that has no form at all. A missing getSetCookie capability
    // (TOG-6537) is likewise never a browser case: there are no cookies to
    // fall back from, so a browser retry would burn budget on a platform
    // gap, not a markup change.
    if (
      mode === "http" ||
      isLoginPageUnavailableError(err) ||
      isMissingSetCookieCapabilityError(err)
    ) {
      throw err;
    }
    logEvent({
      level: "warn",
      msg: "HTTP authentication failed; falling back to Browser Rendering",
      route: "auth.login",
      fallback: "browser"
    });
    return establishSessionWithBrowser(env, stub, bootstrapUrl);
  }
}
