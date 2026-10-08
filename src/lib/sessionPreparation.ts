import { isLoginPageResponse, isLoginRedirect } from "./loginRedirect";

/** Keep typed login/configuration errors on the application's existing status path. */
export function isSessionConfigurationError(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("name" in err)) {
    return false;
  }
  return err.name === "InvalidAuthModeError" ||
    err.name === "MissingSetCookieCapabilityError" ||
    err.name === "LoginPageUnavailableError";
}

/** Signals session expiry during the modal hop without carrying upstream content. */
export class SessionRejectedDuringPreparation extends Error {
  constructor(status: number) {
    super(`Anti-forgery modal returned a login response: HTTP ${status}.`);
    this.name = "SessionRejectedDuringPreparation";
  }
}

/** Keeps preparation failures on their existing route-specific 502/400 path. */
export class SessionBodyPreparationError extends Error {
  constructor(readonly preparationCause: unknown) {
    super("Save body preparation failed.");
    this.name = "SessionBodyPreparationError";
  }
}

export async function requireAuthenticatedModal(response: Response): Promise<void> {
  if (isLoginRedirect(response) || await isLoginPageResponse(response)) {
    throw new SessionRejectedDuringPreparation(response.status);
  }
}
