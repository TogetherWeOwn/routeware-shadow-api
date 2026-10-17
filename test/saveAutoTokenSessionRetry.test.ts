import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * On current main, token-less save-long-form / save-address-form /
 * save-container-form got a 502 loop when the stored session expired — the
 * anti-forgery modal fetch ran via bare `forwardToUpstream` and threw on the
 * 302 → login answer, so `establishSession` (reachable only through
 * `forwardWithSessionRetry`) never ran and every retry hit the identical 502.
 *
 * With retry context the modal GET runs through the REAL
 * `forwardWithSessionRetry` (only `upstreamForward` is mocked), so these tests
 * prove the documented repro heals: one re-establish + retry, token injected,
 * no 502. They also pin the interactions with current-main behaviour:
 * HTTP-200 login-page detection, the per-attempt timeout budget
 * (never retried), the internal anti-forgery marker, and the
 * session + modal-URL token-cache keying surviving a heal.
 */

type ModalCall = {
  method: string;
  url: string;
  cookie: string | null;
  internalMarker: string | undefined;
};

const calls: { modals: ModalCall[] } = { modals: [] };
const behavior: { responses: Array<() => Response> } = { responses: [] };

function tokenHtml(token: string): Response {
  return new Response(
    `<form><input name="__RequestVerificationToken" value="${token}" /></form>`,
    { status: 200, headers: { "content-type": "text/html" } }
  );
}

function loginPageHtml(): Response {
  // Login-page shape: HTTP 200 carrying the Routeware login form (password
  // field + login path), not a 302.
  return new Response(
    '<html><body><form action="/WebRW/Account/Login" method="post">' +
      '<input name="__RequestVerificationToken" type="hidden" value="FAKE-TOKEN" />' +
      '<input name="UserName" type="text" value="" />' +
      '<input name="Password" type="password" value="" />' +
      "</form></body></html>",
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

vi.mock("../src/lib/upstreamForward", () => ({
  // A plain function, not vi.fn(): the spy wrapper records each call's settled
  // result, which turns any deliberate rejection into an unhandled rejection
  // under @cloudflare/vitest-pool-workers.
  forwardToUpstream: async (
    incoming: Request,
    upstreamUrl: URL,
    session: { cookieHeader: string | null } | null,
    _body: ArrayBuffer | null,
    options: { internalMarker?: string } = {}
  ) => {
    calls.modals.push({
      method: incoming.method,
      url: upstreamUrl.toString(),
      cookie: session?.cookieHeader ?? null,
      internalMarker: options.internalMarker
    });
    const next = behavior.responses.shift();
    return next ? next() : tokenHtml("FRESH-TOKEN");
  }
}));

const { clearAntiForgeryTokenCache, prepareSaveCustomerLongFormBody } = await import(
  "../src/lib/customerSaveAutoToken"
);
const { UpstreamTimeoutError } = await import("../src/lib/upstreamTimeout");
const {
  prepareSaveAddressFormBody,
  prepareSaveContainerFormBody
} = await import("../src/lib/addressContainerSaveForm");

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";
const LOGIN_URL = `${ORIGIN}${BASE}/Account/Login`;

/**
 * AuthSession DO stub backed by a mutable holder. The read path answers
 * `/get` like `readSessionState` expects; `/lock` grants immediately and
 * `/set` persists, so the stub establish below heals the holder the way the
 * real lock + store would for a single caller.
 */
const holder: {
  value: { cookieHeader: string | null; expiresAtMs: number | null; refreshing: boolean };
} = {
  value: { cookieHeader: "ASP.NET_SessionId=stale", expiresAtMs: null, refreshing: false }
};

const sessionStub = {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.endsWith("/set") && init?.body) {
      const body = JSON.parse(String(init.body)) as {
        cookieHeader: string;
        expiresAtMs: number;
      };
      holder.value = {
        cookieHeader: body.cookieHeader,
        expiresAtMs: body.expiresAtMs,
        refreshing: false
      };
      return new Response("OK");
    }
    if (url.endsWith("/lock") || url.endsWith("/unlock")) {
      return new Response("OK");
    }
    return new Response(JSON.stringify(holder.value), {
      headers: { "content-type": "application/json" }
    });
  }
} as unknown as DurableObjectStub;

const establishCalls: string[] = [];
async function establishSession(
  _env: Env,
  _stub: DurableObjectStub,
  bootstrapUrl: string
): Promise<void> {
  establishCalls.push(bootstrapUrl);
  holder.value = {
    cookieHeader: "ASP.NET_SessionId=fresh",
    expiresAtMs: Date.now() + 600_000,
    refreshing: false
  };
}

function makeEnv(): Env {
  return {
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: BASE,
    LOGIN_URL
  } as unknown as Env;
}

const URLENCODED = "application/x-www-form-urlencoded";

function body(raw: string): ArrayBuffer {
  return new TextEncoder().encode(raw).buffer as ArrayBuffer;
}

function decode(buffer: ArrayBuffer | null): string {
  return buffer ? new TextDecoder().decode(buffer) : "";
}

function request(): Request {
  return new Request("http://internal/save", { method: "POST" });
}

function retryCtx() {
  return { sessionStub, establishSession };
}

const loginRedirect = () =>
  new Response(null, { status: 302, headers: { location: LOGIN_URL } });

beforeEach(() => {
  calls.modals = [];
  behavior.responses = [];
  establishCalls.length = 0;
  holder.value = {
    cookieHeader: "ASP.NET_SessionId=stale",
    expiresAtMs: null,
    refreshing: false
  };
  // The token cache is a module-level Map that outlives a single test.
  clearAntiForgeryTokenCache();
});

describe("expired-session retry", () => {
  it("customer create: re-establishes once and retries the modal on a 302 → login", async () => {
    // Arrange — the exact issue repro: token-less create, modal answers 302.
    behavior.responses = [loginRedirect, () => tokenHtml("TOKEN-1")];
    const buffer = body("CustomerID=0&CompanyName=NewCo&Enabled=true");

    // Act
    const result = await prepareSaveCustomerLongFormBody(
      makeEnv(),
      { cookieHeader: holder.value.cookieHeader, expiresAtMs: null, refreshing: false },
      request(),
      buffer,
      URLENCODED,
      retryCtx()
    );

    // Assert — one login, one retry, token injected; no 502.
    expect(establishCalls).toEqual([LOGIN_URL]);
    expect(calls.modals).toHaveLength(2);
    expect(calls.modals[0].url).toBe(`${ORIGIN}${BASE}/Customer/AddNewLong`);
    expect(calls.modals[0].cookie).toBe("ASP.NET_SessionId=stale");
    expect(calls.modals[1].cookie).toBe("ASP.NET_SessionId=fresh");
    expect(calls.modals[1].internalMarker).toBe("anti-forgery-modal");
    expect(decode(result)).toContain("__RequestVerificationToken=TOKEN-1");
  });

  it("customer edit: re-establishes once and retries the modal on a 302 → login", async () => {
    // Arrange
    behavior.responses = [loginRedirect, () => tokenHtml("TOKEN-2")];
    const buffer = body("CustomerID=5&CompanyName=Acme&Enabled=true");

    // Act
    const result = await prepareSaveCustomerLongFormBody(
      makeEnv(),
      { cookieHeader: holder.value.cookieHeader, expiresAtMs: null, refreshing: false },
      request(),
      buffer,
      URLENCODED,
      retryCtx()
    );

    // Assert
    expect(establishCalls).toHaveLength(1);
    expect(calls.modals).toHaveLength(2);
    expect(calls.modals[0].url).toBe(
      `${ORIGIN}${BASE}/Customer/LoadLongCustomerModal?customerID=5`
    );
    expect(decode(result)).toContain("__RequestVerificationToken=TOKEN-2");
  });

  it("address: re-establishes once and retries the modal on a 302 → login", async () => {
    // Arrange
    behavior.responses = [loginRedirect, () => tokenHtml("ADDR-RETRY")];
    const buffer = body("PickupAddressID=10&CustomerID=5&Address=1+Main+St");

    // Act
    const result = await prepareSaveAddressFormBody(
      makeEnv(),
      { cookieHeader: holder.value.cookieHeader, expiresAtMs: null, refreshing: false },
      request(),
      buffer,
      URLENCODED,
      retryCtx()
    );

    // Assert
    expect(establishCalls).toEqual([LOGIN_URL]);
    expect(calls.modals).toHaveLength(2);
    expect(calls.modals[0].cookie).toBe("ASP.NET_SessionId=stale");
    expect(calls.modals[1].cookie).toBe("ASP.NET_SessionId=fresh");
    expect(calls.modals[1].internalMarker).toBe("anti-forgery-modal");
    expect(decode(result)).toContain("__RequestVerificationToken=ADDR-RETRY");
  });

  it("container: re-establishes once and retries the modal on a 302 → login", async () => {
    // Arrange
    behavior.responses = [loginRedirect, () => tokenHtml("CONT-RETRY")];
    const buffer = body("ContainerID=100&PickupAddressID=10&Size=96");

    // Act
    const result = await prepareSaveContainerFormBody(
      makeEnv(),
      { cookieHeader: holder.value.cookieHeader, expiresAtMs: null, refreshing: false },
      request(),
      buffer,
      URLENCODED,
      retryCtx()
    );

    // Assert
    expect(establishCalls).toEqual([LOGIN_URL]);
    expect(calls.modals).toHaveLength(2);
    expect(calls.modals[0].cookie).toBe("ASP.NET_SessionId=stale");
    expect(calls.modals[1].cookie).toBe("ASP.NET_SessionId=fresh");
    expect(calls.modals[1].internalMarker).toBe("anti-forgery-modal");
    expect(decode(result)).toContain("__RequestVerificationToken=CONT-RETRY");
  });

  it("customer: heals through the HTTP-200 login-page shape", async () => {
    // Arrange — main's newer expiry shape: 200 + login form, not a 302.
    behavior.responses = [loginPageHtml, () => tokenHtml("TOKEN-200")];
    const buffer = body("CustomerID=0&CompanyName=NewCo&Enabled=true");

    // Act
    const result = await prepareSaveCustomerLongFormBody(
      makeEnv(),
      {
        cookieHeader: holder.value.cookieHeader,
        expiresAtMs: Date.now() + 600_000,
        refreshing: false
      },
      request(),
      buffer,
      URLENCODED,
      retryCtx()
    );

    // Assert — the login page triggers the same single heal as a 302.
    expect(establishCalls).toHaveLength(1);
    expect(calls.modals).toHaveLength(2);
    expect(decode(result)).toContain("__RequestVerificationToken=TOKEN-200");
  });

  it("customer: caches the healed token under the fresh session (cache × retry)", async () => {
    // Arrange — heal once, then save again: the second save must reuse the
    // token cached under the FRESH session without a third modal GET.
    behavior.responses = [loginRedirect, () => tokenHtml("TOKEN-HEALED")];
    const buffer = body("CustomerID=5&CompanyName=Acme&Enabled=true");
    const session = {
      cookieHeader: holder.value.cookieHeader,
      expiresAtMs: null as number | null,
      refreshing: false
    };

    // Act — the second save is a subsequent request: its handler read the
    // session AFTER the heal, so it carries the fresh cookie like production.
    const first = await prepareSaveCustomerLongFormBody(
      makeEnv(),
      session,
      request(),
      buffer,
      URLENCODED,
      retryCtx()
    );
    const second = await prepareSaveCustomerLongFormBody(
      makeEnv(),
      {
        cookieHeader: "ASP.NET_SessionId=fresh",
        expiresAtMs: Date.now() + 600_000,
        refreshing: false
      },
      request(),
      buffer,
      URLENCODED,
      retryCtx()
    );

    // Assert
    expect(decode(first)).toContain("__RequestVerificationToken=TOKEN-HEALED");
    expect(decode(second)).toContain("__RequestVerificationToken=TOKEN-HEALED");
    expect(calls.modals).toHaveLength(2);
    expect(establishCalls).toHaveLength(1);
  });

  it("returns the retried 302 instead of looping when refresh cannot heal upstream", async () => {
    // Arrange — upstream still redirects after the refresh (e.g. revoked
    // credentials): the retry's 302 is surfaced once, not looped, and the
    // session WAS refreshed so the next save can heal.
    behavior.responses = [loginRedirect, loginRedirect];
    const buffer = body("CustomerID=0&CompanyName=NewCo&Enabled=true");

    // Act
    const error = (await prepareSaveCustomerLongFormBody(
      makeEnv(),
      { cookieHeader: holder.value.cookieHeader, expiresAtMs: null, refreshing: false },
      request(),
      buffer,
      URLENCODED,
      retryCtx()
    ).catch((e: unknown) => e)) as Error;

    // Assert — exactly 2 forwards, 1 refresh, no loop.
    expect(error.message).toContain("HTTP 302");
    expect(establishCalls).toHaveLength(1);
    expect(calls.modals).toHaveLength(2);
  });

  it("does not spend the retry budget on a hung upstream", async () => {
    // Arrange — the modal GET throws the same `UpstreamTimeoutError` the real
    // `forwardToUpstream` raises when the per-attempt budget fires. The single
    // retry is reserved for the login redirect; a timeout must fail fast
    // without a re-login, never double-hit upstream.
    behavior.responses = [
      () => {
        throw new UpstreamTimeoutError(30);
      }
    ];
    const buffer = body("CustomerID=0&CompanyName=NewCo&Enabled=true");

    // Act
    const error = (await prepareSaveCustomerLongFormBody(
      makeEnv(),
      { cookieHeader: holder.value.cookieHeader, expiresAtMs: null, refreshing: false },
      request(),
      buffer,
      URLENCODED,
      retryCtx()
    ).catch((e: unknown) => e)) as Error;

    // Assert — exactly 1 forward, 0 logins; the timeout surfaces as the
    // modal-load error, never a retry or a loop.
    expect(error.message).toContain(
      "Could not load anti-forgery modal (/Customer/AddNewLong): HTTP 502"
    );
    expect(calls.modals).toHaveLength(1);
    expect(establishCalls).toHaveLength(0);
  });

  it("leaves supplied-token and disabled paths untouched (no session re-read)", async () => {
    // Arrange — a client-supplied real token and a disabled flag each return
    // before any fetch or session touch.
    const realToken = body(
      "__RequestVerificationToken=client-token&CustomerID=5&Enabled=true"
    );

    // Act
    const supplied = await prepareSaveCustomerLongFormBody(
      makeEnv(),
      { cookieHeader: "x", expiresAtMs: null, refreshing: false },
      request(),
      realToken,
      URLENCODED,
      retryCtx()
    );
    const rawDisabled = body("CustomerID=5&Enabled=true");
    const disabled = await prepareSaveCustomerLongFormBody(
      { ...makeEnv(), CUSTOMER_SAVE_AUTO_TOKEN: "false" } as unknown as Env,
      { cookieHeader: "x", expiresAtMs: null, refreshing: false },
      request(),
      rawDisabled,
      URLENCODED,
      retryCtx()
    );

    // Assert — same objects back, zero modal traffic, zero logins.
    expect(supplied).toBe(realToken);
    expect(disabled).toBe(rawDisabled);
    expect(calls.modals).toEqual([]);
    expect(establishCalls).toEqual([]);
  });
});
