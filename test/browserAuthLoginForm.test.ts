import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-22032 — drives the login-form branch of `establishSessionWithBrowser`
 * (`src/lib/browserAuth.ts`) against a fake page.
 *
 * `test/browserAuth.test.ts` pins the selector contract against saved markup
 * but never runs the function, so a refactor that types the password into the
 * username field or drops the submit click would stay green. Here
 * `@cloudflare/puppeteer` is mocked (house pattern, no live browser), the
 * function and the real `storeSession` run for real, and the fake page records
 * what the login did. Fake timers keep the 2 s settle delay off the wall clock.
 */

const launch = vi.hoisted(() => vi.fn());

vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

import { BROWSER_LOGIN, establishSessionWithBrowser } from "../src/lib/browserAuth";

const USERNAME = "alice@routeware.example";
const PASSWORD = "p@ss-sentinel-7f3a";
const COOKIE_SENTINEL = "cookie-value-sentinel-91c2";
const SETTLE_DELAY_MS = 2000;
const NAVIGATION_PENDING_MS = 5000;
const SESSION_TTL_SECONDS = 3600;
const NOW_MS = Date.UTC(2026, 9, 11, 12, 0, 0);

const bootstrapUrl = "https://routeware.example/Home";
const loginUrl = `https://routeware.example${BROWSER_LOGIN.loginPathFragment}?ReturnUrl=%2FHome`;

// Padded the way a hand-pasted secret arrives; the function must trim it.
const env = {
  LOGIN_USERNAME: `  ${USERNAME}\n`,
  LOGIN_PASSWORD: `\t${PASSWORD}  `,
  SESSION_TTL_SECONDS: String(SESSION_TTL_SECONDS),
  BROWSER: {}
} as unknown as Env;

const sessionCookies = BROWSER_LOGIN.requiredCookies.map((name) => ({
  name,
  value: `${name}-${COOKIE_SENTINEL}`
}));
const sessionCookieHeader = sessionCookies.map((c) => `${c.name}=${c.value}`).join("; ");

type FakeCookie = { name: string; value: string };

function fakePage(opts: {
  url: string;
  cookies: FakeCookie[];
  waitForNavigation?: () => Promise<unknown>;
}) {
  return {
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => opts.url),
    waitForSelector: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    waitForNavigation: vi.fn(opts.waitForNavigation ?? (async () => undefined)),
    cookies: vi.fn(async () => opts.cookies)
  };
}

function launchWithPage(page: ReturnType<typeof fakePage>) {
  const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
  launch.mockResolvedValue(browser);
  return browser;
}

function fakeStub() {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
  return { stub: { fetch } as unknown as DurableObjectStub, fetch };
}

/** Starts the login and resolves to the error it threw, or undefined on success. */
function startLogin(stub: DurableObjectStub, lockToken?: string): Promise<unknown> {
  return establishSessionWithBrowser(env, stub, bootstrapUrl, lockToken).then(
    () => undefined,
    (error: unknown) => error
  );
}

function ranBefore(earlier: { mock: { invocationCallOrder: number[] } }, later: { mock: { invocationCallOrder: number[] } }) {
  return Math.max(...earlier.mock.invocationCallOrder) < Math.min(...later.mock.invocationCallOrder);
}

let logged: unknown[];

beforeEach(() => {
  launch.mockReset();
  logged = [];
  for (const method of ["debug", "log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((record: unknown) => {
      logged.push(record);
    });
  }
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  const output = JSON.stringify(logged);
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Every case: no credential or cookie value reaches any log output.
  expect(output).not.toContain(USERNAME);
  expect(output).not.toContain(PASSWORD);
  expect(output).not.toContain(COOKIE_SENTINEL);
});

describe("establishSessionWithBrowser login-form branch", () => {
  it("types the trimmed credentials into username then password, clicks submit, and stores the session", async () => {
    const page = fakePage({ url: loginUrl, cookies: sessionCookies });
    const browser = launchWithPage(page);
    const { stub, fetch } = fakeStub();

    const outcome = startLogin(stub, "lock-token-1");
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

    expect(await outcome).toBeUndefined();
    expect(launch).toHaveBeenCalledWith(env.BROWSER);
    expect(page.goto).toHaveBeenCalledWith(bootstrapUrl, expect.any(Object));

    expect(page.waitForSelector).toHaveBeenCalledTimes(2);
    expect(page.waitForSelector).toHaveBeenNthCalledWith(1, BROWSER_LOGIN.usernameSelector, expect.any(Object));
    expect(page.waitForSelector).toHaveBeenNthCalledWith(2, BROWSER_LOGIN.passwordSelector, expect.any(Object));

    expect(page.type).toHaveBeenCalledTimes(2);
    expect(page.type).toHaveBeenNthCalledWith(1, BROWSER_LOGIN.usernameSelector, USERNAME, expect.any(Object));
    expect(page.type).toHaveBeenNthCalledWith(2, BROWSER_LOGIN.passwordSelector, PASSWORD, expect.any(Object));

    expect(page.click).toHaveBeenCalledTimes(1);
    expect(page.click).toHaveBeenCalledWith(BROWSER_LOGIN.submitSelector);

    // Submit only after both fields are filled; cookies are read only after submit.
    expect(ranBefore(page.waitForSelector, page.type)).toBe(true);
    expect(ranBefore(page.type, page.click)).toBe(true);
    expect(ranBefore(page.click, page.cookies)).toBe(true);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://auth/set");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      cookieHeader: sessionCookieHeader,
      // Stamped at store time, i.e. after the settle delay.
      expiresAtMs: NOW_MS + SETTLE_DELAY_MS + SESSION_TTL_SECONDS * 1000,
      lockToken: "lock-token-1"
    });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("waits out the 2 s settle delay before reading cookies", async () => {
    const page = fakePage({ url: loginUrl, cookies: sessionCookies });
    launchWithPage(page);
    const { stub, fetch } = fakeStub();

    const outcome = startLogin(stub);
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS - 1);

    expect(page.click).toHaveBeenCalledTimes(1);
    expect(page.cookies).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeUndefined();
    expect(page.cookies).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("waits for the navigation to time out, then the settle delay, before reading cookies; the timeout is tolerated (ExtJS login need not navigate)", async () => {
    // The test, not the clock, decides when the navigation times out, so a call
    // that does not await it, or that sleeps before it, reads cookies too early.
    let rejectNavigation!: (error: Error) => void;
    const page = fakePage({
      url: loginUrl,
      cookies: sessionCookies,
      waitForNavigation: () =>
        new Promise((_resolve, reject) => {
          rejectNavigation = reject;
        })
    });
    const browser = launchWithPage(page);
    const { stub, fetch } = fakeStub();

    const outcome = startLogin(stub);
    await vi.advanceTimersByTimeAsync(NAVIGATION_PENDING_MS);

    // Submitted and far past the 2 s settle delay, but the navigation is still pending.
    expect(page.click).toHaveBeenCalledTimes(1);
    expect(page.waitForNavigation).toHaveBeenCalledTimes(1);
    expect(page.cookies).not.toHaveBeenCalled();

    // The navigation times out; the settle delay starts only now.
    rejectNavigation(Object.assign(new Error("Navigation timeout of 15000 ms exceeded"), { name: "TimeoutError" }));
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS - 1);
    expect(page.cookies).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeUndefined();
    expect(page.waitForNavigation).toHaveBeenCalledTimes(1);
    expect(page.cookies).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ cookieHeader: sessionCookieHeader });
    expect(browser.close).toHaveBeenCalledTimes(1);
    // The swallowed navigation timeout is not a login failure and is not logged as one.
    expect(logged).toEqual([]);
  });

  it("skips the login form entirely when the page is not the login path, and stores the cookies", async () => {
    const page = fakePage({ url: bootstrapUrl, cookies: sessionCookies });
    const browser = launchWithPage(page);
    const { stub, fetch } = fakeStub();

    // No timer is advanced: this path must not wait out the settle delay either.
    expect(await startLogin(stub)).toBeUndefined();

    expect(page.waitForSelector).not.toHaveBeenCalled();
    expect(page.type).not.toHaveBeenCalled();
    expect(page.click).not.toHaveBeenCalled();
    expect(page.waitForNavigation).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ cookieHeader: sessionCookieHeader });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("throws SessionCookiesMissing, stores nothing, and still closes the browser when login leaves no session cookies", async () => {
    const page = fakePage({
      url: loginUrl,
      cookies: [{ name: "ASP.NET_SessionId", value: COOKIE_SENTINEL }]
    });
    const browser = launchWithPage(page);
    const { stub, fetch } = fakeStub();

    const outcome = startLogin(stub);
    await vi.advanceTimersByTimeAsync(SETTLE_DELAY_MS);

    expect(await outcome).toMatchObject({ name: "SessionCookiesMissing" });
    expect(page.click).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
    // The failure record is emitted (so the afterEach secret scan is not vacuous) and names the class.
    expect(logged).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "Browser authentication failed",
        route: "auth.browser",
        kind: "SessionCookiesMissing"
      })
    ]);
  });
});
