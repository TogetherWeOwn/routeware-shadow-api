import { afterEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());

vi.mock("@cloudflare/puppeteer", () => ({ default: { launch } }));

import { establishSessionWithBrowser } from "../src/lib/browserAuth";
import { establishSessionViaHttp } from "../src/lib/httpAuth";
import { acquireRefreshLock } from "../src/lib/sessionRefreshLock";

/**
 * TOG-18959 — the lock-token ownership proof must reach `/set`.
 *
 * Gap: every suite mocked `establishSessionViaHttp` /
 * `establishSessionWithBrowser`, so deleting `lockToken` from the
 * `storeSession(...)` call in `httpAuth.ts` / `browserAuth.ts` still passed
 * the full suite. A successful login would then store the session while
 * leaving the refresh lock held until its TTL, and every waiter would fail
 * closed to a 90 s 502.
 *
 * What this pins (real functions, stubbed network + stubbed DO):
 * 1. `establishSessionViaHttp` carries the acquired lock token to `/set`,
 *    and the token-matching write releases the lock.
 * 2. `establishSessionWithBrowser` does the same.
 * 3. A `/set` without the token still stores the session but leaves a live
 *    holder's lock held (the non-holder semantics `storeSession` documents).
 *
 * Fixture hygiene: cookie values are `FAKE-` literals (house pattern, cf.
 * piiScrub); the lock tokens are synthetic (`TOG-18959` owner check).
 */

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";
const LOGIN_URL = `${ORIGIN}${BASE}/Account/Login`;

const LOGIN_HTML =
  '<html><body><form><input name="__RequestVerificationToken" ' +
  'type="hidden" value="FAKE-TOKEN" /></form></body></html>';

function env(): Env {
  return {
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: BASE,
    LOGIN_URL,
    LOGIN_USERNAME: "fake-user",
    LOGIN_PASSWORD: "fake-pass",
    SESSION_TTL_SECONDS: 1800,
    BROWSER: {}
  } as unknown as Env;
}

function jarResponse(body: string, status: number, setCookies: string[]): Response {
  const headers = new Headers({ "content-type": "text/html" });
  for (const sc of setCookies) {
    headers.append("set-cookie", sc);
  }
  return new Response(body, { status, headers });
}

/** Upstream stub: login-page GET, then the login POST with the session trio. */
function stubUpstreamLogin(): void {
  let calls = 0;
  globalThis.fetch = vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      return jarResponse(LOGIN_HTML, 200, [".AspNetCore.Antiforgery=FAKE-PRE; Path=/"]);
    }
    return jarResponse("", 200, [
      ".WebRW=FAKE-W; Path=/; HttpOnly",
      "RCCApi=FAKE-R; Path=/; Secure",
      "RCCApiRefresh=FAKE-RR; Path=/; Secure"
    ]);
  }) as unknown as typeof fetch;
}

type SetBody = { cookieHeader: string; expiresAtMs: number; lockToken?: unknown };

type DoState = {
  refreshing: boolean;
  lockToken: string | null;
  cookieHeader: string | null;
  setBodies: SetBody[];
};

/**
 * DO stub mirroring the real `AuthSession` owner check: `/lock` issues a
 * token, `/set` stores either way but clears a held lock only for the
 * matching token.
 */
function tokenCheckingStub(state: DoState): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input)).pathname;
      if (path === "/lock" || path === "/takeover") {
        state.refreshing = true;
        state.lockToken = "synthetic-lock-token";
        return Response.json({ lockToken: state.lockToken });
      }
      if (path === "/set") {
        const body = JSON.parse(String(init?.body)) as SetBody;
        state.setBodies.push(body);
        state.cookieHeader = body.cookieHeader;
        if (state.refreshing !== true || body.lockToken === state.lockToken) {
          state.refreshing = false;
          state.lockToken = null;
        }
        return new Response("OK");
      }
      if (path === "/unlock") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { lockToken?: unknown };
        if (state.refreshing === true && body.lockToken !== state.lockToken) {
          return new Response("Forbidden", { status: 403 });
        }
        state.refreshing = false;
        state.lockToken = null;
        return new Response("OK");
      }
      if (path === "/get") {
        return Response.json({
          cookieHeader: state.cookieHeader,
          expiresAtMs: state.cookieHeader ? Date.now() + 60_000 : null,
          refreshing: state.refreshing
        });
      }
      return new Response("Not Found", { status: 404 });
    }
  } as unknown as DurableObjectStub;
}

function freshState(): DoState {
  return { refreshing: false, lockToken: null, cookieHeader: null, setBodies: [] };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("lock-token ownership reaches /set (TOG-18959)", () => {
  it("establishSessionViaHttp carries the lock token and releases the lock", async () => {
    // Arrange — stubbed upstream login + token-checking DO, lock acquired
    // through the real acquireRefreshLock.
    stubUpstreamLogin();
    const state = freshState();
    const stub = tokenCheckingStub(state);
    const lockToken = await acquireRefreshLock(stub);
    expect(lockToken).toBe("synthetic-lock-token");

    // Act — the REAL success path.
    await establishSessionViaHttp(env(), stub, lockToken);

    // Assert — /set carried the token, the session stored, the lock released.
    // If the lockToken argument is dropped from storeSession, the body has no
    // token, the lock stays held, and this goes red.
    expect(state.setBodies).toHaveLength(1);
    expect(state.setBodies[0]?.lockToken).toBe("synthetic-lock-token");
    expect(state.setBodies[0]?.cookieHeader).toContain(".WebRW=FAKE-W");
    expect(state.cookieHeader).toContain(".WebRW=FAKE-W");
    expect(state.refreshing).toBe(false);
    expect(state.lockToken).toBeNull();
  });

  it("establishSessionWithBrowser carries the lock token and releases the lock", async () => {
    // Arrange — headless login lands somewhere other than the login form, so
    // the page cookies are read directly; no browser exists in CI.
    launch.mockReset();
    launch.mockResolvedValue({
      newPage: async () => ({
        goto: vi.fn(async () => undefined),
        url: () => `${ORIGIN}${BASE}/Home/Index`,
        cookies: vi.fn(async () => [
          { name: ".WebRW", value: "FAKE-W" },
          { name: "RCCApi", value: "FAKE-R" },
          { name: "RCCApiRefresh", value: "FAKE-RR" }
        ])
      }),
      close: vi.fn(async () => undefined)
    });
    const state = freshState();
    const stub = tokenCheckingStub(state);
    const lockToken = await acquireRefreshLock(stub);
    expect(lockToken).toBe("synthetic-lock-token");

    // Act — the REAL success path.
    await establishSessionWithBrowser(env(), stub, `${ORIGIN}${BASE}/`, lockToken);

    // Assert — same ownership proof as the HTTP path; dropping the lockToken
    // argument from storeSession in browserAuth.ts goes red here.
    expect(state.setBodies).toHaveLength(1);
    expect(state.setBodies[0]?.lockToken).toBe("synthetic-lock-token");
    expect(state.setBodies[0]?.cookieHeader).toContain(".WebRW=FAKE-W");
    expect(state.cookieHeader).toContain(".WebRW=FAKE-W");
    expect(state.refreshing).toBe(false);
    expect(state.lockToken).toBeNull();
  });

  it("a /set without the token stores the session but leaves a held lock", async () => {
    // Arrange — a live holder owns the lock; this caller writes as a
    // non-holder (no token).
    stubUpstreamLogin();
    const state = freshState();
    const stub = tokenCheckingStub(state);
    const holderToken = await acquireRefreshLock(stub);
    expect(holderToken).toBe("synthetic-lock-token");

    // Act
    await establishSessionViaHttp(env(), stub, undefined);

    // Assert — session stored, holder's lock untouched.
    expect(state.cookieHeader).toContain(".WebRW=FAKE-W");
    expect(state.refreshing).toBe(true);
    expect(state.lockToken).toBe("synthetic-lock-token");
  });
});
