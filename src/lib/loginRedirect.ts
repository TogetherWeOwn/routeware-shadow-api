import { readUpstreamText } from "./upstreamBody";
import { DEFAULT_UPSTREAM_TIMEOUT_MS, isUpstreamTimeout } from "./upstreamTimeout";

export function isLoginRedirect(response: Response): boolean {
  if (response.status !== 302) {
    return false;
  }
  const location = response.headers.get("location") ?? "";
  return (
    location.includes("/Account/Login") || location.includes("Login.aspx")
  );
}

/**
 * True when HTML text looks like the Routeware login form — the common
 * ASP.NET expiry shape (HTTP 200 with a login form instead of a 302).
 *
 * PII-free structural heuristic, not content matching: it keys on the
 * login-form structure (a password field plus a login path or the
 * UserName + anti-forgery pair), never on user data. Ordinary modal HTML
 * carries `__RequestVerificationToken` without a password field, and error
 * pages carry neither, so neither matches.
 */
export function looksLikeLoginPageHtml(text: string): boolean {
  const hasPassword =
    /type\s*=\s*["']password["']/i.test(text) ||
    text.includes("Password-inputEl") ||
    /name\s*=\s*["']Password["']/i.test(text);
  if (!hasPassword) {
    return false;
  }
  if (text.includes("/Account/Login") || text.includes("Login.aspx")) {
    return true;
  }
  return (
    text.includes("UserName") && text.includes("__RequestVerificationToken")
  );
}

/**
 * True when a 200 response carries a login-page body. Never logs the body
 * (PII). A timeout throws; other read failures mean "not a login page".
 * Report downloads explicitly pass null to preserve their existing sniff
 * without imposing a total deadline on CSV with a nonstandard content type.
 *
 * JSON/CSV/octet-stream 200s are real payloads — the body is not read at
 * all (which also avoids buffering large JSON graphs just to check).
 */
export async function isLoginPageResponse(
  response: Response,
  timeoutMs: number | null = DEFAULT_UPSTREAM_TIMEOUT_MS
): Promise<boolean> {
  if (response.status !== 200) {
    return false;
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (
    contentType.includes("application/json") ||
    contentType.includes("text/csv") ||
    contentType.includes("application/octet-stream")
  ) {
    return false;
  }
  try {
    const text = timeoutMs === null
      ? await response.clone().text()
      : await readUpstreamText(response, timeoutMs, true);
    return looksLikeLoginPageHtml(text);
  } catch (err) {
    if (isUpstreamTimeout(err)) {
      throw err;
    }
    return false;
  }
}
