import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-6462: token-less `save-long-form` looped 502 forever when the stored
 * session expired. `prepareSaveCustomerLongFormBody` fetched the anti-forgery
 * modal via bare `forwardToUpstream` and threw on the 302 → login answer, so
 * `establishSession` (only reachable through `forwardWithSessionRetry`) never
 * ran and every retry hit the identical 502.
 *
 * The modal fetch now runs through the REAL `forwardWithSessionRetry` (only
 * `upstreamForward` is mocked), so these tests prove a modal 302 triggers
 * exactly one re-establish + retry instead of a 502 loop.
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

vi.mock("../src/lib/upstreamForward", () => ({
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

const { prepareSaveCustomerLongFormBody } = await import(
  "../src/lib/customerSaveAutoToken"
);

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";
const LOGIN_URL = `${ORIGIN}${BASE}/Account/Login`;

const holder: {
  value: { cookieHeader: string | null; expiresAtMs: number | null; refreshing: boolean };
} = {
  value: { cookieHeader: "ASP.NET_SessionId=stale", expiresAtMs: null, refreshing: false }
};

const sessionStub = {
  fetch: async () =>
    new Response(JSON.stringify(holder.value), {
      headers: { "content-type": "application/json" }
    })
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
});

describe("prepareSaveCustomerLongFormBody expired-session retry (TOG-6462)", () => {
  it("re-establishes once and retries the create modal on a 302 → login", async () => {
    // Arrange — the exact issue repro: token-less create, modal answers 302.
    behavior.responses = [loginRedirect, () => tokenHtml("TOKEN-1")];
    const buffer = body("CustomerID=0&CompanyName=NewCo&Enabled=true");

    // Act
    const result = await prepareSaveCustomerLongFormBody(
      makeEnv(),
      sessionStub,
      request(),
      buffer,
      URLENCODED,
      establishSession
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

  it("re-establishes once and retries the edit modal on a 302 → login", async () => {
    // Arrange
    behavior.responses = [loginRedirect, () => tokenHtml("TOKEN-2")];
    const buffer = body("CustomerID=5&CompanyName=Acme&Enabled=true");

    // Act
    const result = await prepareSaveCustomerLongFormBody(
      makeEnv(),
      sessionStub,
      request(),
      buffer,
      URLENCODED,
      establishSession
    );

    // Assert
    expect(establishCalls).toHaveLength(1);
    expect(calls.modals).toHaveLength(2);
    expect(calls.modals[0].url).toBe(
      `${ORIGIN}${BASE}/Customer/LoadLongCustomerModal?customerID=5`
    );
    expect(decode(result)).toContain("__RequestVerificationToken=TOKEN-2");
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
      sessionStub,
      request(),
      buffer,
      URLENCODED,
      establishSession
    ).catch((e: unknown) => e)) as Error;

    // Assert — exactly 2 forwards, 1 refresh, no loop.
    expect(error.message).toContain("HTTP 302");
    expect(establishCalls).toHaveLength(1);
    expect(calls.modals).toHaveLength(2);
  });
});
