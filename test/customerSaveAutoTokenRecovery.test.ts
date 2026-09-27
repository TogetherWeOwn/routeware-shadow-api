import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-6025 — the save-long-form anti-forgery modal fetch had no session
 * recovery. `prepareSaveCustomerLongFormBody` called `forwardToUpstream`
 * directly, so a cold session (login HTML 200, no token) 502ed with
 * "layout may have changed" and a dead session (302 → login) 502ed with
 * "HTTP 302" — never attempting `establishSession`.
 *
 * These tests pin the recovery path in `resolveSaveCustomerLongFormToken`:
 * a login redirect or login-page HTML establishes once and refetches the
 * modal; the "layout may have changed" detail fires only for genuinely
 * token-less modal HTML under a live session.
 *
 * House pattern: `upstreamForward` and `sessionState` are mocked, the URL
 * builder / body merging / login-page detector run for real.
 */

const calls: { urls: string[]; cookies: Array<string | null>; established: number; reads: number } = {
  urls: [],
  cookies: [],
  established: 0,
  reads: 0
};

const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => {
    calls.reads += 1;
    return {
      cookieHeader: "ASP.NET_SessionId=fresh",
      expiresAtMs: null,
      refreshing: false
    };
  }
}));

vi.mock("../src/lib/upstreamForward", () => ({
  // Plain function, not vi.fn(): the spy wrapper records each call's settled
  // result, which turns deliberate rejections into unhandled rejections under
  // @cloudflare/vitest-pool-workers (see customerSaveAutoTokenCache.test.ts).
  forwardToUpstream: async (
    _incoming: Request,
    upstreamUrl: URL,
    session: { cookieHeader: string | null } | null
  ) => {
    calls.urls.push(upstreamUrl.toString());
    calls.cookies.push(session?.cookieHeader ?? null);
    const next = behavior.responses.shift();
    if (next) {
      return next();
    }
    return new Response(
      `<form><input name="__RequestVerificationToken" value="TOKEN-FALLBACK" /></form>`,
      { status: 200, headers: { "content-type": "text/html" } }
    );
  }
}));

const {
  clearAntiForgeryTokenCache,
  isRoutewareLoginPageHtml,
  prepareSaveCustomerLongFormBody,
  resolveSaveCustomerLongFormToken
} = await import("../src/lib/customerSaveAutoToken");

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";
const LOGIN_URL = `${ORIGIN}${BASE}/Account/Login`;
const URLENCODED = "application/x-www-form-urlencoded";

const LOGIN_HTML =
  `<html><body><form action="/Account/Login">` +
  `<input name="UserName" /><input name="Password" />` +
  `<input name="__RequestVerificationToken" value="LOGIN-TOKEN-WRONG" />` +
  `</form></body></html>`;

const MODAL_HTML = (token: string) =>
  `<form><input name="__RequestVerificationToken" value="${token}" /></form>`;

function makeEnv(): Env {
  return {
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: BASE,
    CUSTOMER_SAVE_AUTO_TOKEN: "true",
    LOGIN_URL
  } as unknown as Env;
}

function coldSession() {
  return { cookieHeader: null, expiresAtMs: null, refreshing: false };
}

function deadSession() {
  return { cookieHeader: "ASP.NET_SessionId=dead", expiresAtMs: null, refreshing: false };
}

function body(raw: string): ArrayBuffer {
  return new TextEncoder().encode(raw).buffer as ArrayBuffer;
}

function decode(buffer: ArrayBuffer | null): string {
  return buffer ? new TextDecoder().decode(buffer) : "";
}

function request(): Request {
  return new Request("http://internal/save", { method: "POST" });
}

function refreshFor(stub: DurableObjectStub) {
  return {
    sessionStub: stub,
    establishSession: async () => {
      calls.established += 1;
    }
  };
}

const sessionStub = {} as unknown as DurableObjectStub;

beforeEach(() => {
  calls.urls = [];
  calls.cookies = [];
  calls.established = 0;
  calls.reads = 0;
  behavior.responses = [];
  clearAntiForgeryTokenCache();
});

describe("TOG-6025 modal session recovery", () => {
  it("cold session + missing token: login HTML triggers exactly one establish then succeeds", async () => {
    // Arrange — no cookie stored, body carries no token, so the modal GET is
    // the first upstream contact. Upstream answers with the login form (HTML
    // 200, carrying its own wrong-form token) instead of the modal.
    const env = makeEnv();
    behavior.responses = [
      () => new Response(LOGIN_HTML, { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response(MODAL_HTML("TOKEN-RECOVERED"), { status: 200, headers: { "content-type": "text/html" } })
    ];

    // Act
    const out = await prepareSaveCustomerLongFormBody(
      env,
      coldSession(),
      request(),
      body("Enabled=true"),
      URLENCODED,
      {},
      refreshFor(sessionStub)
    );

    // Assert — one establish, one modal refetch, and the save carries the
    // modal token, never the login form's token.
    expect(calls.established).toBe(1);
    expect(calls.urls).toHaveLength(2);
    expect(calls.urls[0]).toContain("/Customer/AddNewLong");
    expect(calls.cookies[0]).toBeNull();
    expect(calls.cookies[1]).toBe("ASP.NET_SessionId=fresh");
    expect(decode(out)).toContain("__RequestVerificationToken=TOKEN-RECOVERED");
    expect(decode(out)).not.toContain("LOGIN-TOKEN-WRONG");
  });

  it("dead session: modal 302 triggers establish + modal refetch", async () => {
    // Arrange — cookie stored but server-side-dead: the modal GET 302s to login.
    const env = makeEnv();
    behavior.responses = [
      () => new Response(null, { status: 302, headers: { location: "/Account/Login?returnUrl=%2F" } }),
      () => new Response(MODAL_HTML("TOKEN-AFTER-302"), { status: 200, headers: { "content-type": "text/html" } })
    ];

    // Act
    const out = await prepareSaveCustomerLongFormBody(
      env,
      deadSession(),
      request(),
      body("CustomerID=5&Enabled=true"),
      URLENCODED,
      {},
      refreshFor(sessionStub)
    );

    // Assert
    expect(calls.established).toBe(1);
    expect(calls.urls).toHaveLength(2);
    expect(calls.urls[1]).toContain("LoadLongCustomerModal?customerID=5");
    expect(decode(out)).toContain("__RequestVerificationToken=TOKEN-AFTER-302");
  });

  it("'layout may have changed' fires only for genuinely token-less modal HTML with a live session", async () => {
    // Arrange — upstream answers 200 with real modal markup that simply has
    // no token (and none of the login markers), so recovery must NOT fire.
    const env = makeEnv();
    const modalUrl = new URL(`${ORIGIN}${BASE}/Customer/AddNewLong`);
    behavior.responses = [
      () => new Response(`<form><div>modal redesigned</div></form>`, { status: 200 })
    ];

    // Act
    const error = (await resolveSaveCustomerLongFormToken(
      env,
      { cookieHeader: "ASP.NET_SessionId=live", expiresAtMs: null, refreshing: false },
      request(),
      modalUrl,
      "/Customer/AddNewLong",
      {},
      refreshFor(sessionStub)
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("layout may have changed");
    expect(calls.established).toBe(0);
    expect(calls.urls).toHaveLength(1);
  });

  it("without a refresh path the 502 still names the session, never the layout", async () => {
    // Arrange — callers that cannot re-establish (none in production after
    // this fix; the parameter is optional) must still not blame markup for
    // a dead session.
    const env = makeEnv();
    const modalUrl = new URL(`${ORIGIN}${BASE}/Customer/AddNewLong`);

    behavior.responses = [
      () => new Response(LOGIN_HTML, { status: 200, headers: { "content-type": "text/html" } })
    ];
    const loginHtmlError = (await resolveSaveCustomerLongFormToken(
      env,
      coldSession(),
      request(),
      modalUrl,
      "/Customer/AddNewLong"
    ).catch((e: unknown) => e)) as Error;
    expect(loginHtmlError.message).toContain("session expired");
    expect(loginHtmlError.message).not.toContain("layout may have changed");

    clearAntiForgeryTokenCache();
    behavior.responses = [
      () => new Response(null, { status: 302, headers: { location: "/Account/Login" } })
    ];
    const redirectError = (await resolveSaveCustomerLongFormToken(
      env,
      deadSession(),
      request(),
      modalUrl,
      "/Customer/AddNewLong"
    ).catch((e: unknown) => e)) as Error;
    expect(redirectError.message).toContain("session expired");
    expect(redirectError.message).not.toContain("HTTP 302");

    // The detector itself never mistakes a real modal for the login page.
    expect(isRoutewareLoginPageHtml(LOGIN_HTML)).toBe(true);
    expect(isRoutewareLoginPageHtml(MODAL_HTML("TOKEN-X"))).toBe(false);
  });
});
