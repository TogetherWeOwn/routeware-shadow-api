import { storeSession } from "./sessionRefreshLock";
import { sessionExpiryMs } from "./sessionState";
import { readUpstreamText } from "./upstreamBody";
import { applyBrowserHeaders } from "./upstreamHeaders";
import { fetchWithUpstreamTimeout, readUpstreamTimeoutMs } from "./upstreamTimeout";

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

type Jar = Record<string, string>;

function mergeSetCookies(jar: Jar, res: Response): void {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const sc of list) {
    const m = /^([^=;]+)=([^;]*)/.exec(sc);
    if (m) {
      jar[m[1].trim()] = m[2];
    }
  }
}

function cookieHeaderFrom(jar: Jar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
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
  jar: Jar;
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
  const jar: Jar = {};
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
  mergeSetCookies(jar, pageRes);
  const html = await readUpstreamText(pageRes, timeoutMs);

  // 2) GET the Ext.NET init script (same session) for the anti-forgery token.
  let token = extractAntiForgeryFromExtNet(html);
  const ax = /\/[\w/-]*extnet-init-js\/ext\.axd\?[a-f0-9]+/i.exec(html);
  if (!token && ax) {
    const h2 = new Headers();
    applyBrowserHeaders(h2, origin);
    if (Object.keys(jar).length) h2.set("Cookie", cookieHeaderFrom(jar));
    const axRes = await fetchWithUpstreamTimeout(
      new URL(ax[0], origin).toString(),
      { headers: h2, redirect: "manual" },
      timeoutMs
    );
    mergeSetCookies(jar, axRes);
    token = extractAntiForgeryFromExtNet(await readUpstreamText(axRes, timeoutMs));
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
  if (Object.keys(jar).length) h3.set("Cookie", cookieHeaderFrom(jar));
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
  mergeSetCookies(jar, loginRes);

  const ok = Boolean(jar[".WebRW"] && jar["RCCApi"] && jar["RCCApiRefresh"]);
  return { ok, loginStatus: loginRes.status, cookieNames: Object.keys(jar), jar };
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
  await storeSession(stub, cookieHeader, expiresAtMs);
}
