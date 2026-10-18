import puppeteer from "@cloudflare/puppeteer";
import { errorKind, logEvent } from "./logger";
import { storeSession } from "./sessionRefreshLock";
import { sessionExpiryMs } from "./sessionState";

function credential(value: string | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Single source of truth for the WebRW login-page contract the Browser
 * Rendering login depends on. Every entry is asserted against saved login
 * markup in `test/browserAuth.test.ts` (fixture:
 * `test/browserLoginPageFixture.ts`), so upstream markup drift fails CI
 * instead of failing syncs silently (HTML-200). Refresh the selectors and
 * the fixture together — see `docs/BROWSER-LOGIN-DRIFT.md`.
 */
export const BROWSER_LOGIN = {
  /** URL fragment gating the login-form branch (the ExtJS app serves it here). */
  loginPathFragment: "/Account/Login",
  /** ExtJS login field ids (typed into) and submit control id (clicked). */
  usernameSelector: "#UserName-inputEl",
  passwordSelector: "#Password-inputEl",
  submitSelector: "#button-1012",
  /** Session cookies proving the headless login succeeded. */
  requiredCookies: [".WebRW", "RCCApi", "RCCApiRefresh"]
} as const;

/** True when the cookie names from the headless page prove a live session. */
export function hasRouteWareSessionCookies(cookieNames: readonly string[]): boolean {
  return BROWSER_LOGIN.requiredCookies.every((name) => cookieNames.includes(name));
}

function browserAuthError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * Browser Rendering login. `lockToken` proves this caller holds the refresh
 * lock so the DO releases it as part of the write.
 */
export async function establishSessionWithBrowser(
  env: Env,
  stub: DurableObjectStub,
  bootstrapUrl: string,
  lockToken?: string | null
): Promise<void> {
  const username = credential(env.LOGIN_USERNAME);
  const password = credential(env.LOGIN_PASSWORD);

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

  try {
    if (!username || !password) {
      throw browserAuthError(
        "MissingCredentials",
        "LOGIN_USERNAME and LOGIN_PASSWORD are missing for browser auth. " +
          "For wrangler dev: add a .dev.vars file next to wrangler.toml (see .dev.vars.example). " +
          "Note: wrangler secret put only configures deployed Workers, not local dev. " +
          "Run: node scripts/check-devvars.mjs. " +
          "If you edited .dev.vars on Windows, save with LF line endings (dos2unix .dev.vars)."
      );
    }
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    await page.goto(bootstrapUrl, { waitUntil: "networkidle0" });

    if (page.url().includes(BROWSER_LOGIN.loginPathFragment)) {
      await page.waitForSelector(BROWSER_LOGIN.usernameSelector, { timeout: 15000 });
      await page.waitForSelector(BROWSER_LOGIN.passwordSelector, { timeout: 15000 });

      await page.type(BROWSER_LOGIN.usernameSelector, username, { delay: 30 });
      await page.type(BROWSER_LOGIN.passwordSelector, password, { delay: 30 });

      await page.click(BROWSER_LOGIN.submitSelector);

      try {
        await page.waitForNavigation({ timeout: 15000 });
      } catch {
        // ExtJS may not trigger a full navigation after login.
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const cookies = await page.cookies();
    const cookieNames = cookies.map((c) => c.name);
    const hasRouteWareAuth = hasRouteWareSessionCookies(cookieNames);

    if (!hasRouteWareAuth) {
      throw browserAuthError(
        "SessionCookiesMissing",
        "Authentication failed: RouteWare session cookies missing after headless login " +
          "(expected .WebRW, RCCApi, RCCApiRefresh in devtools Application → Cookies). " +
          "In production, set `LOGIN_USERNAME` and `LOGIN_PASSWORD` with `wrangler secret put` " +
          "(not only `.dev.vars`). " +
          "If secrets are set, the login may have failed: wrong password, " +
          "MFA/lockout, or a changed login form (selectors in browserAuth.ts). " +
          "Check Worker logs for the \"Browser authentication failed\" record (kind SessionCookiesMissing) " +
          "and try logging in manually to Routeware to verify the account."
      );
    }

    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const expiresAtMs = sessionExpiryMs(env);

    await storeSession(stub, cookieHeader, expiresAtMs, lockToken);
  } catch (err) {
    // The refresh lock is released by `establishSession`, which owns it.
    logEvent({
      level: "error",
      msg: "Browser authentication failed",
      route: "auth.browser",
      kind: errorKind(err)
    });
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
