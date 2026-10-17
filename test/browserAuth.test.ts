import { describe, expect, it, vi } from "vitest";
import { LOGIN_PAGE_FIXTURE, LOGIN_PAGE_TOKEN } from "./browserLoginPageFixture";

/**
 * The Browser Rendering login (`src/lib/browserAuth.ts`) drives
 * the WebRW login page by element id, and the HTTP login
 * (`src/lib/httpAuth.ts`) extracts its anti-forgery token from the same
 * markup. Upstream drift fails syncs silently (HTML-200), so every
 * selector/extraction `BROWSER_LOGIN` depends on is asserted here against
 * saved markup (`test/browserLoginPageFixture.ts`).
 *
 * No live browser in CI: the contract is pinned hermetically. To verify the
 * tests catch drift, break a selector in the fixture (e.g. rename
 * `UserName-inputEl`) and watch this file go red — then restore it and
 * follow `docs/BROWSER-LOGIN-DRIFT.md` for a real refresh.
 *
 * House pattern: `@cloudflare/puppeteer` is mocked (no browser), the
 * selector contract, cookie check, and token extraction run for real.
 */

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: vi.fn() }
}));

const { BROWSER_LOGIN, hasRouteWareSessionCookies } = await import(
  "../src/lib/browserAuth"
);
const { extractAntiForgeryFromExtNet } = await import("../src/lib/httpAuth");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DRIFT_HINT = "upstream drift? See docs/BROWSER-LOGIN-DRIFT.md.";

/**
 * Resolve a `#id` selector against raw HTML and return the matched tag.
 * Throws unless exactly one element carries the id — a removed or duplicated
 * id fails loudly instead of failing a sync silently.
 */
function resolveIdSelector(html: string, selector: string): string {
  const id = /^#([\w-]+)$/.exec(selector)?.[1];
  if (!id) {
    throw new Error(
      `browserAuth selector contract covers #id selectors only; got ${JSON.stringify(selector)} — ` +
        `extend this helper when the login markup needs richer selectors (${DRIFT_HINT})`
    );
  }
  const pattern = `\\bid=["']${escapeRegExp(id)}["']`;
  const count = html.match(new RegExp(pattern, "gi"))?.length ?? 0;
  if (count === 0) {
    throw new Error(`selector ${selector} matched nothing in the saved login markup — ${DRIFT_HINT}`);
  }
  if (count !== 1) {
    throw new Error(`selector ${selector} matched ${count} elements; expected exactly 1 — ${DRIFT_HINT}`);
  }
  const tag = new RegExp(`<[^<>]*${pattern}[^<>]*>`, "i").exec(html)?.[0];
  if (!tag) {
    throw new Error(`selector ${selector} matched an id outside a tag — ${DRIFT_HINT}`);
  }
  return tag;
}

describe("browser login selector contract", () => {
  it("every BROWSER_LOGIN selector is an #id selector resolving in the fixture", () => {
    for (const selector of [
      BROWSER_LOGIN.usernameSelector,
      BROWSER_LOGIN.passwordSelector,
      BROWSER_LOGIN.submitSelector
    ]) {
      expect(() => resolveIdSelector(LOGIN_PAGE_FIXTURE, selector)).not.toThrow();
    }
  });

  it("username selector resolves to the empty text field named UserName", () => {
    const tag = resolveIdSelector(LOGIN_PAGE_FIXTURE, BROWSER_LOGIN.usernameSelector);
    expect(tag).toMatch(/^<input\b/i);
    expect(tag).toContain('name="UserName"');
    expect(tag).toContain('type="text"');
    expect(tag).toContain('value=""');
  });

  it("password selector resolves to the empty password field named Password", () => {
    const tag = resolveIdSelector(LOGIN_PAGE_FIXTURE, BROWSER_LOGIN.passwordSelector);
    expect(tag).toMatch(/^<input\b/i);
    expect(tag).toContain('name="Password"');
    expect(tag).toContain('type="password"');
    expect(tag).toContain('value=""');
  });

  it("submit selector resolves to the login control", () => {
    const tag = resolveIdSelector(LOGIN_PAGE_FIXTURE, BROWSER_LOGIN.submitSelector);
    expect(tag).toMatch(/^<(a|button|input)\b/i);
    expect(tag).toMatch(/role="button"|type="submit"/i);
  });

  it("login form posts to the login path fragment", () => {
    expect(BROWSER_LOGIN.loginPathFragment).toBe("/Account/Login");
    const action = /<form\b[^>]*\baction="([^"]*)"/i.exec(LOGIN_PAGE_FIXTURE)?.[1];
    expect(action).toBeDefined();
    expect(action).toContain(BROWSER_LOGIN.loginPathFragment);
  });

  it("anti-forgery token extracts from the saved markup", () => {
    expect(extractAntiForgeryFromExtNet(LOGIN_PAGE_FIXTURE)).toBe(LOGIN_PAGE_TOKEN);
  });

  it("login page references the Ext.NET init script the HTTP login follows", () => {
    expect(LOGIN_PAGE_FIXTURE).toMatch(/\/[\w/-]*extnet-init-js\/ext\.axd\?[a-f0-9]+/i);
  });

  it("required cookies pin the session contract", () => {
    expect([...BROWSER_LOGIN.requiredCookies]).toEqual([".WebRW", "RCCApi", "RCCApiRefresh"]);
  });

  it("hasRouteWareSessionCookies passes only on the full cookie trio", () => {
    expect(hasRouteWareSessionCookies([".WebRW", "RCCApi", "RCCApiRefresh"])).toBe(true);
    // Extra cookies are fine; each missing one fails.
    expect(hasRouteWareSessionCookies([".WebRW", "RCCApi", "RCCApiRefresh", "ASP.NET_SessionId"])).toBe(true);
    expect(hasRouteWareSessionCookies(["RCCApi", "RCCApiRefresh"])).toBe(false);
    expect(hasRouteWareSessionCookies([".WebRW", "RCCApiRefresh"])).toBe(false);
    expect(hasRouteWareSessionCookies([".WebRW", "RCCApi"])).toBe(false);
    expect(hasRouteWareSessionCookies([])).toBe(false);
  });

  it("a removed selector fails loudly (drift goes red, not silent)", () => {
    const drifted = LOGIN_PAGE_FIXTURE.replace('id="UserName-inputEl"', 'id="UserName-renamed"');
    expect(() => resolveIdSelector(drifted, BROWSER_LOGIN.usernameSelector)).toThrow(
      /matched nothing/
    );
  });

  it("a missing token extracts to null (drift goes red, not silent)", () => {
    const drifted = LOGIN_PAGE_FIXTURE.replace(LOGIN_PAGE_TOKEN, "");
    expect(extractAntiForgeryFromExtNet(drifted)).toBeNull();
  });

  it("fixture carries no real credentials", () => {
    // Obviously-fake token marker only, empty field values, no emails.
    expect(LOGIN_PAGE_TOKEN).toMatch(/^FIXTURE-/);
    expect(LOGIN_PAGE_FIXTURE).toContain(`value="${LOGIN_PAGE_TOKEN}"`);
    expect(LOGIN_PAGE_FIXTURE).not.toContain("@");
    const values = [...LOGIN_PAGE_FIXTURE.matchAll(/\bvalue="([^"]*)"/gi)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value === "" || value === LOGIN_PAGE_TOKEN).toBe(true);
    }
  });
});
