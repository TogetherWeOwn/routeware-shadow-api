import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-6540 — the snapshot-door twin of the route-tier session retry (TOG-6515).
 *
 * Routeware answers an expired admin session with HTTP 200 carrying the login
 * form as often as with a 302, and both cron report doors
 * (`fetchReportCsvForPath` in `src/lib/snapshot/reportFetch.ts` and
 * `fetchReportCsvByQueryId` in `src/lib/routewareQueryReportCsv.ts`) only
 * retried on `status !== 200 || isLoginRedirect`. A 200 login page sailed
 * through as "CSV" and failed the cron spuriously (`streamSync` rejects it as
 * "not valid CSV", or parses zero rows). Both doors now take the same single
 * re-login + retry as `forwardWithSessionRetry` on a 200 login page, and throw
 * (status-only, never the upstream body — TOG-5821) when the retry still sees
 * one instead of returning HTML as CSV.
 *
 * Fixtures are structural only (form shape + FAKE stand-ins, no PII/secrets).
 */

const calls: {
  forwards: Array<{ url: string; cookie: string | null }>;
  established: number;
  sessionReads: number;
} = { forwards: [], established: 0, sessionReads: 0 };

const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => {
    calls.sessionReads += 1;
    return {
      cookieHeader: `ASP.NET_SessionId=s${calls.sessionReads}`,
      expiresAtMs: null,
      refreshing: false
    };
  }
}));

vi.mock("../src/lib/establishSession", () => ({
  establishSession: async () => {
    calls.established += 1;
  }
}));

vi.mock("../src/lib/upstreamForward", () => ({
  // A plain function, not vi.fn(): the spy wrapper records the settled result
  // of the double and turns a deliberate rejection into an unhandled one under
  // the workers pool (house pattern).
  forwardToUpstream: async (
    _incoming: Request,
    upstreamUrl: URL,
    session: { cookieHeader: string | null } | null,
    _bodyBuffer: ArrayBuffer | null
  ) => {
    calls.forwards.push({
      url: upstreamUrl.toString(),
      cookie: session?.cookieHeader ?? null
    });
    const next = behavior.responses.shift();
    return next ? next() : new Response("id,name\n", { status: 200 });
  }
}));

const { fetchReportCsvForPath } = await import("../src/lib/snapshot/reportFetch");
const { fetchReportCsvByQueryId } = await import("../src/lib/routewareQueryReportCsv");

const LOGIN_HTML =
  '<html><body><form action="/WebRW/Account/Login" method="post">' +
  '<input name="__RequestVerificationToken" type="hidden" value="FAKE-TOKEN" />' +
  '<input name="UserName" type="text" value="" />' +
  '<input name="Password" type="password" value="" />' +
  "</form></body></html>";

const loginPage = () =>
  new Response(LOGIN_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });

const csv = (text = "id,name\n1,Acme\n") =>
  new Response(text, { status: 200, headers: { "content-type": "text/csv" } });

const env = {
  TARGET_ORIGIN: "https://killeen.example.test",
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: "https://killeen.example.test/WebRW/Account/Login",
  AUTH_SESSION: {
    idFromName: () => ({}) as unknown as DurableObjectId,
    get: () => ({}) as unknown as DurableObjectStub
  }
} as unknown as Env;

const REPORT_PATH = "/WebRW/Reports/QueryReport?reportID=42&format=csv";

beforeEach(() => {
  calls.forwards = [];
  calls.established = 0;
  calls.sessionReads = 0;
  behavior.responses = [];
});

describe("fetchReportCsvForPath 200-login-page retry (TOG-6540)", () => {
  it("re-establishes and retries once on a 200 login page, returning the CSV", async () => {
    // Arrange — expired session served as HTTP 200 login HTML, then real CSV.
    behavior.responses = [loginPage, () => csv()];

    // Act
    const resp = await fetchReportCsvForPath(env, REPORT_PATH);

    // Assert — one re-login, one retry on a fresh cookie, CSV returned.
    expect(calls.established).toBe(1);
    expect(calls.forwards).toHaveLength(2);
    expect(calls.sessionReads).toBe(2);
    expect(calls.forwards[0].cookie).toBe("ASP.NET_SessionId=s1");
    expect(calls.forwards[1].cookie).toBe("ASP.NET_SessionId=s2");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("id,name\n1,Acme\n");
  });

  it("throws status-only when the retry still sees a login page", async () => {
    // Arrange — re-login did not take; the retry gets login HTML again.
    behavior.responses = [loginPage, loginPage];

    // Act
    const error = (await fetchReportCsvForPath(env, REPORT_PATH).catch(
      (e: unknown) => e
    )) as Error;

    // Assert — no retry loop (2 forwards, 1 login), and no byte of the
    // upstream body survives in the message (TOG-5821).
    expect(calls.established).toBe(1);
    expect(calls.forwards).toHaveLength(2);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^Report fetch failed: 200/);
    expect(error.message).not.toContain("FAKE-TOKEN");
  });
});

describe("fetchReportCsvByQueryId 200-login-page retry (TOG-6540)", () => {
  it("re-establishes and retries once on a 200 login page, returning the CSV", async () => {
    // Arrange
    behavior.responses = [loginPage, () => csv()];

    // Act
    const resp = await fetchReportCsvByQueryId(env, "23");

    // Assert
    expect(calls.established).toBe(1);
    expect(calls.forwards).toHaveLength(2);
    expect(calls.forwards[0].cookie).toBe("ASP.NET_SessionId=s1");
    expect(calls.forwards[1].cookie).toBe("ASP.NET_SessionId=s2");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/csv");
    expect(await resp.text()).toBe("id,name\n1,Acme\n");
  });

  it("throws status-only when the retry still sees a login page", async () => {
    // Arrange
    behavior.responses = [loginPage, loginPage];

    // Act
    const error = (await fetchReportCsvByQueryId(env, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(calls.established).toBe(1);
    expect(calls.forwards).toHaveLength(2);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("QueryExecuteDownload failed: HTTP 200");
    expect(error.message).not.toContain("FAKE-TOKEN");
  });

  it("does not re-authenticate when the first attempt is already CSV", async () => {
    // Arrange
    behavior.responses = [() => csv()];

    // Act
    const resp = await fetchReportCsvByQueryId(env, "23");

    // Assert
    expect(calls.established).toBe(0);
    expect(calls.forwards).toHaveLength(1);
    expect(await resp.text()).toBe("id,name\n1,Acme\n");
  });
});
