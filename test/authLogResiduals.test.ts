import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R9-24 residual pins for the two post-#226 structured-log call sites on the
// Routeware login path that TOG-6278 (2026-09-27) predates:
//   - `auth.login`  — src/lib/establishSession.ts:157 (HTTP→browser fallback)
//   - `auth.browser` — src/lib/browserAuth.ts:117 (browser login failure)
// Everything else on the throttle/auth surface (fail-open alarm, refresh
// lock, the HTTP burst itself) is pinned in test/throttleSecretResiduals.test.ts.
//
// TOG-6278 pattern: distinct probe strings ride every input channel that
// reaches these call sites (login credentials, session cookie, HTTP error
// message, lock token); assertions then demand the emitted log records equal
// the fixed events exactly and contain zero probe occurrences. The one
// borderline field is `auth.browser`'s `kind`, which is `errorKind(err)` —
// the error's class NAME, never its message (docs/LOGGING.md:10).

const PROBE_USERNAME = "probe-user-r9-2c7f@example.invalid";
const PROBE_PASSWORD = "probe-password-r9-8b31d6";
const PROBE_COOKIE_VALUE = "probe-cookievalue-r9-4a90e2";
const PROBE_HTTP_ERROR = "probe-httperr-r9-71c5f0";
const PROBE_LOCK_TOKEN = "probe-locktoken-r9-55d1a8";
const PROBE_BEARER = "probe-bearer-r9-09e6c3";
const PROBE_IP = "203.0.113.218";

const launch = vi.hoisted(() => vi.fn());
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async () => {
    throw new Error(`HTTP login blew up: ${PROBE_HTTP_ERROR} ${PROBE_PASSWORD} ${PROBE_COOKIE_VALUE}`);
  })
}));

import { establishSessionWithBrowser } from "../src/lib/browserAuth";
import { establishSession } from "../src/lib/establishSession";

type LogLine = { level: string; record: unknown };

// Direct console assignment, not vi.spyOn: under
// `@cloudflare/vitest-pool-workers` the console methods are bound accessors
// (same pattern as test/authThrottleFailOpenAlarm.test.ts).
const realConsole = {
  info: console.info,
  warn: console.warn,
  error: console.error
};
const logLines: LogLine[] = [];

function expectLogsClean(probes: readonly string[]): void {
  const blob = JSON.stringify(logLines);
  for (const probe of probes) {
    expect(blob, `structured logs must not contain probe ${JSON.stringify(probe)}`).not.toContain(
      probe
    );
  }
}

/**
 * Minimal AuthSession DO fake: grants the refresh lock with a distinct
 * probe token, accepts the holder's `/set`, and reports a live session on
 * `/get`. Cookie headers carry a probe value end-to-end.
 */
function sessionStub(): DurableObjectStub {
  let cookieHeader: string | null = null;
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input)).pathname;
      if (path === "/lock" || path === "/takeover") {
        return Response.json({ lockToken: PROBE_LOCK_TOKEN });
      }
      if (path === "/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { cookieHeader?: string };
        cookieHeader = body.cookieHeader ?? null;
        return new Response("OK");
      }
      if (path === "/unlock") {
        return new Response("OK");
      }
      if (path === "/get") {
        return Response.json({
          cookieHeader,
          expiresAtMs: cookieHeader ? Date.now() + 60_000 : null,
          refreshing: false
        });
      }
      return new Response("Not Found", { status: 404 });
    }
  } as unknown as DurableObjectStub;
}

/**
 * Login page whose browser flow completes the form but yields a session
 * cookie with a probe value and not the full required set — so browserAuth
 * throws SessionCookiesMissing after handling real credential material.
 */
function launchLoginPage(): void {
  const page = {
    goto: vi.fn(async () => undefined),
    url: () => "https://routeware.example/Account/Login",
    waitForSelector: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    waitForNavigation: vi.fn(async () => undefined),
    cookies: vi.fn(async () => [{ name: ".WebRW", value: PROBE_COOKIE_VALUE }])
  };
  launch.mockResolvedValue({
    newPage: async () => page,
    close: vi.fn(async () => undefined)
  });
}

const BOOTSTRAP_URL = "https://routeware.example/Home";

function loginEnv(): Env {
  return {
    AUTH_MODE: "auto",
    LOGIN_USERNAME: PROBE_USERNAME,
    LOGIN_PASSWORD: PROBE_PASSWORD,
    BROWSER: {},
    SESSION_TTL_SECONDS: 1800
  } as unknown as Env;
}

const ALL_PROBES = [
  PROBE_USERNAME,
  PROBE_PASSWORD,
  PROBE_COOKIE_VALUE,
  PROBE_HTTP_ERROR,
  PROBE_LOCK_TOKEN,
  PROBE_BEARER,
  PROBE_IP
];

describe("auth login log call-site residuals (R9-24)", () => {
  beforeEach(() => {
    launch.mockReset();
    logLines.length = 0;
    for (const level of ["info", "warn", "error"] as const) {
      console[level] = (...args: unknown[]) => {
        logLines.push({ level, record: args[0] });
      };
    }
  });

  afterEach(() => {
    console.info = realConsole.info;
    console.warn = realConsole.warn;
    console.error = realConsole.error;
  });

  it(
    "pass-and-pin: HTTP→browser fallback emits only the fixed auth.login and " +
      "auth.browser events, credential- and cookie-free",
    async () => {
      launchLoginPage();

      await expect(establishSession(loginEnv(), sessionStub(), BOOTSTRAP_URL)).rejects.toMatchObject({
        name: "SessionCookiesMissing"
      });

      expect(logLines).toEqual([
        {
          level: "warn",
          record: {
            level: "warn",
            msg: "HTTP authentication failed; falling back to Browser Rendering",
            route: "auth.login",
            ms: null,
            fallback: "browser"
          }
        },
        {
          level: "error",
          record: {
            level: "error",
            msg: "Browser authentication failed",
            route: "auth.browser",
            ms: null,
            kind: "SessionCookiesMissing"
          }
        }
      ]);
      expectLogsClean(ALL_PROBES);
    }
  );

  it(
    "pass-and-pin: auth.browser kind is the error class name only, never " +
      "the probe-laden message or the typed credentials",
    async () => {
      const launchFailure = Object.assign(
        new Error(`launch died: ${PROBE_PASSWORD} ${PROBE_COOKIE_VALUE} ${PROBE_BEARER}`),
        { name: "ProbeLaunchError" }
      );
      launch.mockRejectedValue(launchFailure);

      await expect(
        establishSessionWithBrowser(loginEnv(), sessionStub(), BOOTSTRAP_URL, PROBE_LOCK_TOKEN)
      ).rejects.toBe(launchFailure);

      expect(logLines).toEqual([
        {
          level: "error",
          record: {
            level: "error",
            msg: "Browser authentication failed",
            route: "auth.browser",
            ms: null,
            kind: "ProbeLaunchError"
          }
        }
      ]);
      expectLogsClean(ALL_PROBES);
    }
  );
});
