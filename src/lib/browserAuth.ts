import puppeteer from "@cloudflare/puppeteer";
import { storeSession } from "./sessionRefreshLock";
import { sessionExpiryMs } from "./sessionState";

function credential(value: string | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function establishSessionWithBrowser(
  env: Env,
  stub: DurableObjectStub,
  bootstrapUrl: string
): Promise<void> {
  const username = credential(env.LOGIN_USERNAME);
  const password = credential(env.LOGIN_PASSWORD);
  if (!username || !password) {
    throw new Error(
      "LOGIN_USERNAME and LOGIN_PASSWORD are missing for browser auth. " +
        "For wrangler dev: add a .dev.vars file next to wrangler.toml (see .dev.vars.example). " +
        "Note: wrangler secret put only configures deployed Workers, not local dev. " +
        "Run: node scripts/check-devvars.mjs. " +
        "If you edited .dev.vars on Windows, save with LF line endings (dos2unix .dev.vars)."
    );
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    await page.goto(bootstrapUrl, { waitUntil: "networkidle0" });

    if (page.url().includes("/Account/Login")) {
      await page.waitForSelector("#UserName-inputEl", { timeout: 15000 });
      await page.waitForSelector("#Password-inputEl", { timeout: 15000 });

      await page.type("#UserName-inputEl", username, { delay: 30 });
      await page.type("#Password-inputEl", password, { delay: 30 });

      await page.click("#button-1012");

      try {
        await page.waitForNavigation({ timeout: 15000 });
      } catch {
        // ExtJS may not trigger a full navigation after login.
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const cookies = await page.cookies();
    const cookieNames = cookies.map((c) => c.name);
    const hasRouteWareAuth =
      cookieNames.includes(".WebRW") &&
      cookieNames.includes("RCCApi") &&
      cookieNames.includes("RCCApiRefresh");

    if (!hasRouteWareAuth) {
      throw new Error(
        "Authentication failed: RouteWare session cookies missing after headless login " +
          "(expected .WebRW, RCCApi, RCCApiRefresh in devtools Application → Cookies). " +
          "In production, set `LOGIN_USERNAME` and `LOGIN_PASSWORD` with `wrangler secret put` " +
          "(not only `.dev.vars`). " +
          "If secrets are set, the login may have failed: wrong password, " +
          "MFA/lockout, or a changed login form (selectors in browserAuth.ts). " +
          "Check Worker logs for BROWSER AUTH ERROR and try logging in manually to Routeware to verify the account."
      );
    }

    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const expiresAtMs = sessionExpiryMs(env);

    await storeSession(stub, cookieHeader, expiresAtMs);
  } catch (err) {
    // The refresh lock is released by `establishSession`, which owns it.
    console.error("BROWSER AUTH ERROR", err);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
