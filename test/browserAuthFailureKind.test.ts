import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());

vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

import { establishSessionWithBrowser } from "../src/lib/browserAuth";

const stub = {} as unknown as DurableObjectStub;
const bootstrapUrl = "https://routeware.example/Home";
const loginEnv = { LOGIN_USERNAME: "user", LOGIN_PASSWORD: "pw", BROWSER: {} } as unknown as Env;

let errors: unknown[];

function launchWithPage(page: Record<string, unknown>) {
  const browser = { newPage: async () => page, close: vi.fn(async () => undefined) };
  launch.mockResolvedValue(browser);
  return browser;
}

beforeEach(() => {
  launch.mockReset();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((record: unknown) => {
    errors.push(record);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser auth failure records carry the error class as kind", () => {
  it("names MissingCredentials and never launches a browser when login secrets are unset", async () => {
    const env = { BROWSER: {} } as unknown as Env;

    await expect(establishSessionWithBrowser(env, stub, bootstrapUrl)).rejects.toMatchObject({
      name: "MissingCredentials"
    });
    expect(launch).not.toHaveBeenCalled();
    expect(errors).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "Browser authentication failed",
        route: "auth.browser",
        kind: "MissingCredentials"
      })
    ]);
  });

  it("names SessionCookiesMissing, points the error at this record, and logs no cookie value", async () => {
    const page = {
      goto: vi.fn(async () => undefined),
      url: () => bootstrapUrl,
      cookies: vi.fn(async () => [{ name: ".ASPXAUTH", value: "cookie-value-sentinel" }])
    };
    const browser = launchWithPage(page);

    await expect(establishSessionWithBrowser(loginEnv, stub, bootstrapUrl)).rejects.toThrow(
      /"Browser authentication failed" record \(kind SessionCookiesMissing\)/
    );
    expect(browser.close).toHaveBeenCalled();
    expect(errors).toEqual([
      expect.objectContaining({
        msg: "Browser authentication failed",
        kind: "SessionCookiesMissing"
      })
    ]);
    expect(JSON.stringify(errors)).not.toContain("cookie-value-sentinel");
  });

  it("carries the timeout error class when a login selector never appears", async () => {
    const timeout = Object.assign(new Error("Waiting for selector `#UserName-inputEl` failed"), {
      name: "TimeoutError"
    });
    launchWithPage({
      goto: vi.fn(async () => undefined),
      url: () => "https://routeware.example/Account/Login",
      waitForSelector: vi.fn(async () => {
        throw timeout;
      }),
      cookies: vi.fn(async () => [])
    });

    await expect(establishSessionWithBrowser(loginEnv, stub, bootstrapUrl)).rejects.toBe(timeout);
    expect(errors).toEqual([expect.objectContaining({ msg: "Browser authentication failed", kind: "TimeoutError" })]);
  });
});
