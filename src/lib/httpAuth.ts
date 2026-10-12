import { LoginPageUnavailableError } from "./loginPageError";
import { storeSession } from "./sessionRefreshLock";
import { sessionExpiryMs } from "./sessionState";
import { applyBrowserHeaders } from "./upstreamHeaders";
import { fetchWithUpstreamTimeout, readUpstreamTimeoutMs } from "./upstreamTimeout";
import {
  cookieHeaderForUrl,
  cookieHeaderFrom,
  mergeSetCookies,
  type CookieJar
} from "./cookieJar";

/**
 * Browser-free Routeware login. The WebRW login is a plain form POST (captured
 * via Browser Rendering): GET the login page for the anti-forgery cookie + token,
 * then `POST /Account/Login` with `returnUrl`, `__RequestVerificationToken`,
 * `UserName`, `Password`. The single response sets `.WebRW`, `RCCApi`,
 * `RCCApiRefresh` — no browser and no follow-up token exchange required.
 *
 * This runs from the Worker (direct to Routeware), so it is not affected by any
 * local dev proxy. `establishSessionWithBrowser` remains the fallback.
 */

export type { CookieJar } from "./cookieJar";
export { LoginPageUnavailableError } from "./loginPageError";

function jarCookies(jar: CookieJar): string[] {
  return jar.map((c) => c.name);
}

function jarHas(jar: CookieJar, name: string): boolean {
  return jar.some((c) => c.name === name);
}

/** Extract the anti-forgery token from the Ext.NET init script (or login HTML). */
export function extractAntiForgeryFromExtNet(text: string): string | null {
  const jsHit =
    /name:\s*"__RequestVerificationToken"\s*,\s*value:\s*"([^"]+)"/i.exec(text) ??
    /hiddenfield[^}]{0,160}?value:\s*"([^"]+)"/i.exec(text);
  if (jsHit) {
    return jsHit[1];
  }
  const htmlHit =
    /<input\b[^>]*\bname\s*=\s*["']__RequestVerificationToken["'][^>]*\bvalue\s*=\s*["']([^"']+)["']/i.exec(
      text
    );
  return htmlHit ? htmlHit[1] : null;
}

export type HttpLoginResult = {
  ok: boolean;
  loginStatus: number;
  cookieNames: string[];
  jar: CookieJar;
  note?: string;
};

/** Perform the HTTP login and return the resulting cookie jar (no DO writes). */
export async function httpLogin(env: Env): Promise<HttpLoginResult> {
  const username = env.LOGIN_USERNAME?.trim();
  const password = env.LOGIN_PASSWORD?.trim();
  if (!username || !password) {
    throw new Error("LOGIN_USERNAME / LOGIN_PASSWORD are not set.");
  }
  const origin = new URL(env.TARGET_ORIGIN).origin;
  const jar: CookieJar = [];
  // Bounded per-attempt budget (TOG-5835): a hung login host throws
  // `UpstreamTimeoutError` (a fixed PII-free string) instead of burning the
  // 300s CPU limit. No retry here — the caller (`forwardWithSessionRetry`)
  // already budgets a single retry for the login redirect.
  const timeoutMs = readUpstreamTimeoutMs(env);

  // 1) GET login page → anti-forgery cookie + reference to the init script.
  const h1 = new Headers();
  applyBrowserHeaders(h1, origin);
  const pageRes = await fetchWithUpstreamTimeout(
    env.LOGIN_URL,
    { headers: h1, redirect: "manual" },
    timeoutMs
  );
  // Fail fast on a WAF/maintenance block (TOG-6536): without this, a
  // non-200 page falls through to "token not found", which `establishSession`
  // misreads as a markup change and answers with expensive Browser Rendering
  // retries. The status (a fixed number) is safe for logs and 502s.
  if (!pageRes.ok) {
    throw new LoginPageUnavailableError(pageRes.status, "login page");
  }
  mergeSetCookies(jar, pageRes, env.LOGIN_URL);
  const html = await pageRes.text();

  // 2) GET the Ext.NET init script (same session) for the anti-forgery token.
  let token = extractAntiForgeryFromExtNet(html);
  const ax = /\/[\w/-]*extnet-init-js\/ext\.axd\?[a-f0-9]+/i.exec(html);
  if (!token && ax) {
    const axUrl = new URL(ax[0], origin).toString();
    const h2 = new Headers();
    applyBrowserHeaders(h2, origin);
    const axCookies = cookieHeaderForUrl(jar, axUrl);
    if (axCookies) h2.set("Cookie", axCookies);
    const axRes = await fetchWithUpstreamTimeout(
      axUrl,
      { headers: h2, redirect: "manual" },
      timeoutMs
    );
    if (!axRes.ok) {
      throw new LoginPageUnavailableError(axRes.status, "init script");
    }
    mergeSetCookies(jar, axRes, axUrl);
    token = extractAntiForgeryFromExtNet(await axRes.text());
  }
  if (!token) {
    throw new Error("Anti-forgery token not found on login page/init script.");
  }

  // 3) POST the four fields exactly as the browser does.
  const body = new URLSearchParams();
  body.set("returnUrl", "");
  body.set("__RequestVerificationToken", token);
  body.set("UserName", username);
  body.set("Password", password);
  const h3 = new Headers();
  applyBrowserHeaders(h3, origin);
  h3.set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
  h3.set("X-Requested-With", "XMLHttpRequest");
  h3.set("Referer", env.LOGIN_URL);
  const loginCookies = cookieHeaderForUrl(jar, env.LOGIN_URL);
  if (loginCookies) h3.set("Cookie", loginCookies);
  const loginRes = await fetchWithUpstreamTimeout(
    env.LOGIN_URL,
    {
      method: "POST",
      headers: h3,
      body: body.toString(),
      redirect: "manual"
    },
    timeoutMs
  );
  mergeSetCookies(jar, loginRes, env.LOGIN_URL);

  const ok = jarHas(jar, ".WebRW") && jarHas(jar, "RCCApi") && jarHas(jar, "RCCApiRefresh");
  return { ok, loginStatus: loginRes.status, cookieNames: [...new Set(jarCookies(jar))], jar };
}

/** Establish a session over HTTP and store it in the AuthSession Durable Object. */
export async function establishSessionViaHttp(
  env: Env,
  stub: DurableObjectStub
): Promise<void> {
  const result = await httpLogin(env);
  if (!result.ok) {
    throw new Error(
      `HTTP login failed (status ${result.loginStatus}); cookies: ${result.cookieNames.join(",")}`
    );
  }
  const cookieHeader = cookieHeaderFrom(result.jar);
  const expiresAtMs = sessionExpiryMs(env);
  await storeSession(stub, cookieHeader, expiresAtMs, result.jar);
}
