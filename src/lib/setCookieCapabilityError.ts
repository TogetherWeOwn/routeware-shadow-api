/**
 * Missing `Headers.getSetCookie` capability signal.
 *
 * `mergeSetCookies` (`src/lib/httpAuth.ts`) used to fall back to `[]` when
 * the runtime had no `Headers.getSetCookie`, so every HTTP login silently
 * collected an empty jar: `http` mode hard-outaged and `auto` mode flipped
 * to expensive Browser Rendering logins with no diagnosis.
 *
 * Failing fast keeps the diagnosis ("runtime cannot merge Set-Cookie") and
 * — via `establishSession` — skips the browser entirely: there are no
 * cookies to fall back *from*, so a browser retry would burn Browser
 * Rendering budget on a platform gap, not a markup change.
 *
 * Lives in its own module on purpose: test files mock `../httpAuth`, which
 * would wipe a class defined there (see `InvalidAuthModeError`
 * precedent in `establishSession.ts` and `LoginPageUnavailableError`
 * in `loginPageError.ts`). A name check (not `instanceof`) keeps the predicate
 * true across module doubles.
 *
 * The message is a fixed string (never URL/body/cookie/PII) — safe for logs
 * and 503 details.
 */
export class MissingSetCookieCapabilityError extends Error {
  /** Fixed discriminant: the missing runtime capability (never PII). */
  readonly capability = "Headers.getSetCookie" as const;
  constructor() {
    super(
      "Routeware HTTP login requires Headers.getSetCookie (Set-Cookie merging unavailable in this runtime)."
    );
    this.name = "MissingSetCookieCapabilityError";
  }
}

/**
 * True for a missing-`getSetCookie` capability failure — never a browser
 * case. A type guard: after it passes, the error is safe to surface as a
 * fixed 503 detail whether `err` is a real instance or a foreign double
 * carrying the same shape.
 */
export function isMissingSetCookieCapabilityError(
  err: unknown
): err is MissingSetCookieCapabilityError {
  return (
    err instanceof MissingSetCookieCapabilityError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "MissingSetCookieCapabilityError")
  );
}
