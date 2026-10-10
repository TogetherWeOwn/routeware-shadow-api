import { LoginPageUnavailableError } from "./loginPageError";
import { MissingSetCookieCapabilityError } from "./setCookieCapabilityError";
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

/**
 * Upstream `Set-Cookie` attribute semantics for the tenant jar (TOG-9207).
 *
 * The Worker is a server-side HTTP client, so it plays the network-stack role
 * a browser's cookie store would play — with two simplifications that are safe
 * here and documented so they stay safe:
 *
 * - `Secure`: the cookie may only be replayed over HTTPS. Every sessioned
 *   forward targets `TARGET_ORIGIN`, which is `https://` in `wrangler.toml`
 *   (all envs). A `Secure` tenant cookie is therefore always eligible for
 *   replay, and must never be sent if an operator ever points a deploy at an
 *   `http://` origin. There is no per-cookie scheme tracking because there is
 *   a single upstream origin, not a browser profile visiting many sites.
 * - `HttpOnly`: the cookie is invisible to page JavaScript. That holds by
 *   construction — the jar lives in Worker memory and the `AuthSession` DO,
 *   and `stripUpstreamSetCookie` (`src/lib/upstreamForward.ts`) removes every
 *   upstream `Set-Cookie` before a client response is built, so no tenant
 *   cookie value ever reaches a browser, log line, or error message.
 * - `Domain`/`Path`/`SameSite` need no enforcement: the jar replays to exactly
 *   one origin (`TARGET_ORIGIN` + `TARGET_BASE_PATH`), never across origins,
 *   and server-to-server `fetch` has no address bar, no third-party context,
 *   and no CSRF surface — clients authenticate with a bearer token.
 * - `Expires`/`Max-Age` ARE enforced: a deletion/rotation cookie evicts the
 *   name from the jar (see `isExpiredSetCookie`). Without this, an upstream
 *   sign-out (`Name=; Expires=<past>`) would linger as an empty `Name=` pair
 *   replayed on every forward.
 */
/**
 * Fail fast when the runtime cannot merge `Set-Cookie` (TOG-6537).
 *
 * Without `Headers.getSetCookie` every HTTP login would silently collect an
 * empty jar: `http` mode hard-outages and `auto` mode flips to expensive
 * Browser Rendering logins with no diagnosis. Throwing here (and at
 * `httpLogin` start, before any fetch) keeps the diagnosis and lets
 * `establishSession` skip the browser — there are no cookies to fall back
 * from. The message is a fixed string (never URL/body/cookie/PII).
 */
export function assertGetSetCookieAvailable(): void {
  const probe = new Headers();
  if (
    typeof (probe as unknown as { getSetCookie?: unknown }).getSetCookie !==
    "function"
  ) {
    throw new MissingSetCookieCapabilityError();
  }
}

export function mergeSetCookies(jar: Jar, res: Response, nowMs: number = Date.now()): void {
  if (typeof res.headers.getSetCookie !== "function") {
    throw new MissingSetCookieCapabilityError();
  }
  const list = res.headers.getSetCookie();
  for (const sc of list) {
    const semi = sc.indexOf(";");
    const pair = semi === -1 ? sc : sc.slice(0, semi);
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    if (!name) {
      continue;
    }
    const value = pair.slice(eq + 1);
    const attrs = semi === -1 ? "" : sc.slice(semi + 1);
    if (isExpiredSetCookie(attrs, nowMs)) {
      // Upstream deleted/rotated this name away — evict it so the stale value
      // (or an empty `Name=` ghost) is never replayed.
      delete jar[name];
    } else {
      jar[name] = value;
    }
  }
}

/**
 * True when a `Set-Cookie` attribute string carries an already-fired expiry:
 * `Max-Age <= 0`, or an `Expires` date at/before `nowMs`. A bare empty value
 * with NO expiry signal is stored faithfully (not evicted) — only an explicit
 * expiry deletes, per RFC 6265 §5.3 step 12.
 */
function isExpiredSetCookie(attrs: string, nowMs: number): boolean {
  const maxAge = /(?:^|;)\s*max-age\s*=\s*"?(-?\d+)"?/i.exec(attrs);
  if (maxAge && Number(maxAge[1]) <= 0) {
    return true;
  }
  const expires = /(?:^|;)\s*expires\s*=\s*([^;]+)/i.exec(attrs);
  if (expires) {
    const t = Date.parse(expires[1].trim());
    if (Number.isFinite(t) && t <= nowMs) {
      return true;
    }
  }
  return false;
}

export function cookieHeaderFrom(jar: Jar): string {
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
  // Capability assert first (TOG-6537): before any upstream fetch, so a
  // runtime without `Headers.getSetCookie` fails with an explicit error
  // instead of collecting an empty jar and misdiagnosing as a markup change.
  assertGetSetCookieAvailable();
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
  // Fail fast on a WAF/maintenance block (TOG-6536): without this, a
  // non-200 page falls through to "token not found", which `establishSession`
  // misreads as a markup change and answers with expensive Browser Rendering
  // retries. The status (a fixed number) is safe for logs and 502s.
  if (!pageRes.ok) {
    throw new LoginPageUnavailableError(pageRes.status, "login page");
  }
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
    if (!axRes.ok) {
      throw new LoginPageUnavailableError(axRes.status, "init script");
    }
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

/**
 * Establish a session over HTTP and store it in the AuthSession Durable
 * Object. `lockToken` proves this caller holds the refresh lock so the DO
 * releases it as part of the write (TOG-18959).
 */
export async function establishSessionViaHttp(
  env: Env,
  stub: DurableObjectStub,
  lockToken?: string | null
): Promise<void> {
  const result = await httpLogin(env);
  if (!result.ok) {
    throw new Error(
      `HTTP login failed (status ${result.loginStatus}); cookies: ${result.cookieNames.join(",")}`
    );
  }
  const cookieHeader = cookieHeaderFrom(result.jar);
  const expiresAtMs = sessionExpiryMs(env);
  await storeSession(stub, cookieHeader, expiresAtMs, lockToken);
}
