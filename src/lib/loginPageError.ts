/**
 * Non-200 login-page signal (TOG-6536).
 *
 * A WAF block or maintenance page (403/500/…) carries no anti-forgery token,
 * so without a status check the login falls through to "token not found",
 * which `establishSession` (auto mode) misreads as a markup change and
 * answers with expensive Browser Rendering retries. Failing fast with the
 * status keeps the diagnosis ("upstream blocked") and skips the browser
 * entirely.
 *
 * Lives in its own module on purpose: five test files mock `../httpAuth`,
 * which would wipe a class defined there (see TOG-6531's
 * `InvalidAuthModeError` precedent in `establishSession.ts`). A name check
 * (not `instanceof`) keeps the predicate true across module doubles.
 *
 * `status` is a fixed number (never URL/body/PII) — safe for logs and 502s.
 */
export class LoginPageUnavailableError extends Error {
  readonly status: number;
  constructor(status: number, step: string) {
    super(`Routeware login page unavailable: HTTP ${status} (${step}).`);
    this.name = "LoginPageUnavailableError";
    this.status = status;
  }
}

/**
 * True for a fail-fast non-200 login-page failure — never a browser case.
 * A type guard: after it passes, `.status` is safe to read whether `err` is
 * a real instance or a foreign double carrying the same shape.
 */
export function isLoginPageUnavailableError(err: unknown): err is LoginPageUnavailableError {
  return (
    err instanceof LoginPageUnavailableError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "LoginPageUnavailableError" &&
      typeof (err as { status?: unknown }).status === "number")
  );
}
