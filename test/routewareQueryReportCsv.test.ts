import { beforeEach, describe, expect, it, vi } from "vitest";
import { QUERY_REQUEST_POLL_MAX_ATTEMPTS } from "../src/lib/routewareQueryReportCsv";
import {
  extractRequestIdFromText,
  parseQueryRequestIsCompleteResponse
} from "../src/lib/routewareQueryReportCsv";

describe("routewareQueryReportCsv", () => {
  it("extractRequestIdFromText prefers JSON requestID", () => {
    const id = "bc5ffc64-a44d-477a-9aac-192f5166e987";
    expect(
      extractRequestIdFromText(`{ "requestID": "${id}", "x": 1 }`)
    ).toBe(id);
  });

  it("extractRequestIdFromText finds query string", () => {
    const id = "67e4c9c6-cc44-4ee0-a51b-3b05f4e9b8ca";
    expect(extractRequestIdFromText(`requestID=${id}`)).toBe(id);
  });

  it("parseQueryRequestIsCompleteResponse handles plain true/false", () => {
    expect(parseQueryRequestIsCompleteResponse("true")).toBe(true);
    expect(parseQueryRequestIsCompleteResponse("false")).toBe(false);
  });

  it("parseQueryRequestIsCompleteResponse handles .NET d wrapper", () => {
    expect(parseQueryRequestIsCompleteResponse('{"d":true}')).toBe(true);
  });
});

/**
 * The completion poll before the query-id CSV download.
 *
 * Without the poll, a large async report downloads truncated with
 * `dataRows > 0`, and reconcile deletes the missing tail as stale. The poll
 * is load-bearing: the same one-time `requestID` must be polled to complete
 * before `QueryExecuteDownload` runs.
 *
 * Fixtures are structural only (stand-in CSV, no PII/secrets).
 */
const calls: { forwards: Array<{ url: string }> } = { forwards: [] };
const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => ({
    cookieHeader: "ASP.NET_SessionId=FAKE",
    expiresAtMs: null,
    refreshing: false
  })
}));

vi.mock("../src/lib/establishSession", () => ({
  establishSession: async () => undefined
}));

vi.mock("../src/lib/upstreamForward", () => ({
  // A plain function, not vi.fn(): the spy wrapper records the settled
  // result of the double and turns a deliberate rejection into an unhandled
  // one under the workers pool (house pattern).
  forwardToUpstream: async (
    _incoming: Request,
    upstreamUrl: URL,
    _session: { cookieHeader: string | null } | null,
    _bodyBuffer: ArrayBuffer | null
  ) => {
    calls.forwards.push({ url: upstreamUrl.toString() });
    const next = behavior.responses.shift();
    return next ? next() : new Response("false", { status: 200 });
  }
}));

const { fetchReportCsvByQueryId } = await import(
  "../src/lib/routewareQueryReportCsv"
);

const pollBody = (complete: boolean) =>
  new Response(complete ? "true" : "false", {
    status: 200,
    headers: { "content-type": "application/json" }
  });

const csv = () =>
  new Response("id,name\n1,Acme\n", {
    status: 200,
    headers: { "content-type": "text/csv" }
  });

const env = {
  TARGET_ORIGIN: "https://killeen.example.test",
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: "https://killeen.example.test/WebRW/Account/Login",
  // 1ms inter-poll delay keeps the poll loop real without slowing the
  // suite (the guard treats 0 as absent, so it must be ≥ 1).
  REPORT_QUERY_POLL_INTERVAL_MS: "1",
  AUTH_SESSION: {
    idFromName: () => ({}) as unknown as DurableObjectId,
    get: () => ({}) as unknown as DurableObjectStub
  }
} as unknown as Env;

beforeEach(() => {
  calls.forwards = [];
  behavior.responses = [];
});

describe("fetchReportCsvByQueryId completion poll", () => {
  it("polls not-complete→complete, then downloads with the same requestID", async () => {
    // Arrange — Routeware says the async query is not ready, then ready.
    behavior.responses = [() => pollBody(false), () => pollBody(true), csv];

    // Act
    const resp = await fetchReportCsvByQueryId(env, "23");

    // Assert — two polls precede one download, all sharing one requestID.
    expect(calls.forwards).toHaveLength(3);
    const [first, second, third] = calls.forwards.map((c) => new URL(c.url));
    expect(first.pathname).toBe("/WebRW/Reports/QueryRequestIsComplete");
    expect(second.pathname).toBe("/WebRW/Reports/QueryRequestIsComplete");
    expect(third.pathname).toBe("/WebRW/Reports/QueryExecuteDownload");
    const polledId = first.searchParams.get("requestID");
    expect(polledId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.searchParams.get("requestID")).toBe(polledId);
    expect(third.searchParams.get("requestID")).toBe(polledId);
    expect(third.searchParams.get("queryID")).toBe("23");
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("id,name\n1,Acme\n");
  });

  it("rejects an empty queryId without touching upstream (single-shot path is gone)", async () => {
    // Act
    const error = (await fetchReportCsvByQueryId(env, "  ").catch(
      (e: unknown) => e
    )) as Error;

    // Assert — no poll, no download.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("queryId is empty");
    expect(calls.forwards).toHaveLength(0);
  });

  it("throws status-only when the poll never completes (no truncated download)", async () => {
    // Arrange — `REPORT_QUERY_POLL_MAX_ATTEMPTS` bounds the suite to 2 polls.
    const boundedEnv = {
      ...env,
      REPORT_QUERY_POLL_MAX_ATTEMPTS: "2"
    } as unknown as Env;
    behavior.responses = [() => pollBody(false), () => pollBody(false), csv];

    // Act
    const error = (await fetchReportCsvByQueryId(boundedEnv, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert — timeout after the budget, and the queued CSV is never fetched.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "QueryRequestIsComplete timed out after 2 attempts"
    );
    expect(calls.forwards).toHaveLength(2);
    expect(
      calls.forwards.every((c) => c.url.includes("QueryRequestIsComplete"))
    ).toBe(true);
  });
});

/**
 * Malformed-input coverage for the CSV query-report path.
 *
 * `src/lib/routewareQueryReportCsv.ts` previously had poll-happy-path tests
 * only. These cases pin the parsing guards that keep a truncated or
 * wrong-shaped upstream answer from becoming a silent empty export:
 * no-ID text, empty/whitespace poll bodies, numeric 1/0 shorthands, the
 * broken `typeof d === "boolean"` check (a string literal, so the `d`
 * wrapper always falls through to false), HTML error pages, and the
 * download-side failure shapes (non-200, login redirect, login page,
 * empty body, query-string defaults).
 *
 * Fixtures are structural only (stand-in CSV, no PII/secrets).
 */
describe("extractRequestIdFromText malformed input", () => {
  it("returns null when the text carries no UUID at all", () => {
    // Arrange

    // Act
    const id = extractRequestIdFromText("Report is still processing…");

    // Assert
    expect(id).toBeNull();
  });

  it("returns null for an empty string", () => {
    // Arrange

    // Act
    const id = extractRequestIdFromText("");

    // Assert
    expect(id).toBeNull();
  });

  it("prefers the explicit requestID JSON key over an unrelated UUID", () => {
    // Arrange — the bare UUID appears first, but the keyed requestID must win.
    const wanted = "bc5ffc64-a44d-477a-9aac-192f5166e987";
    const decoy = "11111111-2222-3333-4444-555555555555";
    const text = `${decoy} then { "requestID": "${wanted}" }`;

    // Act
    const id = extractRequestIdFromText(text);

    // Assert
    expect(id).toBe(wanted);
  });

  it("extracts a camelCase requestId JSON key", () => {
    // Arrange
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    // Act
    const found = extractRequestIdFromText(`{ "requestId": "${id}" }`);

    // Assert
    expect(found).toBe(id);
  });

  it("extracts RequestID from a query-string fragment", () => {
    // Arrange
    const id = "12345678-1234-1234-1234-123456789abc";

    // Act
    const found = extractRequestIdFromText(`download?RequestID=${id}&x=1`);

    // Assert
    expect(found).toBe(id);
  });

  it("lowercases an uppercase UUID", () => {
    // Arrange
    const id = "BC5FFC64-A44D-477A-9AAC-192F5166E987";

    // Act
    const found = extractRequestIdFromText(`{ "requestID": "${id}" }`);

    // Assert
    expect(found).toBe(id.toLowerCase());
  });
});

describe("parseQueryRequestIsCompleteResponse malformed input", () => {
  it("returns false for an empty or whitespace-only body", () => {
    // Arrange — a blank 200 body means "not done", never an error.

    // Act / Assert
    expect(parseQueryRequestIsCompleteResponse("")).toBe(false);
    expect(parseQueryRequestIsCompleteResponse("   \n\t ")).toBe(false);
  });

  it("handles 1/0 numeric shorthands case-insensitively", () => {
    // Arrange

    // Act / Assert
    expect(parseQueryRequestIsCompleteResponse("1")).toBe(true);
    expect(parseQueryRequestIsCompleteResponse("0")).toBe(false);
    expect(parseQueryRequestIsCompleteResponse("TRUE")).toBe(true);
    expect(parseQueryRequestIsCompleteResponse("False")).toBe(false);
  });

  it("returns false for a non-boolean JSON d wrapper value", () => {
    // Arrange — only a real boolean `d` returns true; a string or number
    // falls through to false rather than throwing.

    // Act / Assert
    expect(parseQueryRequestIsCompleteResponse('{"d":false}')).toBe(false);
    expect(parseQueryRequestIsCompleteResponse('{"d":"yes"}')).toBe(false);
    expect(parseQueryRequestIsCompleteResponse('{"d":1}')).toBe(false);
  });

  it("throws on an HTML error page instead of treating it as not-complete", () => {
    // Arrange — an HTML body means the session was lost; looping on it would
    // burn the whole 60s poll budget and then report a timeout.

    // Act
    const error = (() => {
      try {
        parseQueryRequestIsCompleteResponse(
          "<!DOCTYPE html><html><body>error</body></html>"
        );
        return null;
      } catch (e: unknown) {
        return e as Error;
      }
    })();

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      "QueryRequestIsComplete returned HTML (session lost or error page)."
    );
  });

  it("returns false for unrecognized plain text", () => {
    // Arrange — anything that is not true/false/JSON/HTML is "not done".

    // Act / Assert
    expect(parseQueryRequestIsCompleteResponse("pending")).toBe(false);
    expect(parseQueryRequestIsCompleteResponse("<xml>ok</xml>")).toBe(false);
  });
});

describe("fetchReportCsvByQueryId malformed download responses", () => {
  const htmlLoginPage = () =>
    new Response(
      '<html><body><form action="/Account/Login">' +
        '<input type="password" name="Password"/></form></body></html>',
      { status: 200, headers: { "content-type": "text/html" } }
    );

  it("throws status-only when the poll answers a non-200 (no body embedded)", async () => {
    // Arrange — the session-aware forwarder retries once, so the bad answer
    // is queued twice; the error must carry the status only, never the HTML.
    const boom = () => new Response("<html>boom</html>", { status: 500 });
    behavior.responses = [boom, boom, csv];

    // Act
    const error = (await fetchReportCsvByQueryId(env, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("QueryRequestIsComplete failed: HTTP 500");
    expect(error.message).not.toContain("boom");
    expect(calls.forwards).toHaveLength(2);
  });

  it("throws status-only when the poll returns a login redirect", async () => {
    // Arrange — session expiry surfaces as a 302 to the login page; queued
    // twice for the single re-login retry.
    const redirect = () =>
      new Response("", {
        status: 302,
        headers: { location: "/WebRW/Account/Login" }
      });
    behavior.responses = [redirect, redirect, csv];

    // Act
    const error = (await fetchReportCsvByQueryId(env, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error.message).toBe("QueryRequestIsComplete failed: HTTP 302");
    expect(calls.forwards).toHaveLength(2);
  });

  it("throws status-only when the poll returns a login page body", async () => {
    // Arrange — 200 with a login form is the ASP.NET expiry shape; queued
    // twice for the single re-login retry.
    behavior.responses = [htmlLoginPage, htmlLoginPage, csv];

    // Act
    const error = (await fetchReportCsvByQueryId(env, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error.message).toBe("QueryRequestIsComplete failed: HTTP 200");
    expect(calls.forwards).toHaveLength(2);
  });

  it("propagates the HTML-session-lost throw from the poll", async () => {
    // Arrange — a non-login HTML body makes the parser throw rather than
    // report not-complete.
    behavior.responses = [
      () => new Response("<html><body>error</body></html>", { status: 200 }),
      csv
    ];

    // Act
    const error = (await fetchReportCsvByQueryId(env, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error.message).toBe(
      "QueryRequestIsComplete returned HTML (session lost or error page)."
    );
    expect(calls.forwards).toHaveLength(1);
  });

  it("throws status-only when the download answers a non-200", async () => {
    // Arrange — ready poll, then a broken download queued twice for the
    // single re-login retry.
    const broken = () => new Response("oops", { status: 500 });
    behavior.responses = [() => pollBody(true), broken, broken];

    // Act
    const error = (await fetchReportCsvByQueryId(env, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("QueryExecuteDownload failed: HTTP 500");
    expect(error.message).not.toContain("oops");
    expect(calls.forwards).toHaveLength(3);
  });

  it("throws status-only when the download is a login redirect", async () => {
    // Arrange — queued twice for the single re-login retry.
    const redirect = () =>
      new Response("", {
        status: 302,
        headers: { location: "/WebRW/Account/Login" }
      });
    behavior.responses = [() => pollBody(true), redirect, redirect];

    // Act
    const error = (await fetchReportCsvByQueryId(env, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error.message).toBe("QueryExecuteDownload failed: HTTP 302");
    expect(calls.forwards).toHaveLength(3);
  });

  it("throws status-only when the download returns a login page", async () => {
    // Arrange — queued twice for the single re-login retry.
    behavior.responses = [() => pollBody(true), htmlLoginPage, htmlLoginPage];

    // Act
    const error = (await fetchReportCsvByQueryId(env, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error.message).toBe("QueryExecuteDownload failed: HTTP 200");
    expect(calls.forwards).toHaveLength(3);
  });

  it("coerces a non-CSV download content-type to text/csv", async () => {
    // Arrange — upstream may answer 200 with a generic content-type.
    behavior.responses = [
      () => pollBody(true),
      () =>
        new Response("id\n1\n", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
    ];

    // Act
    const resp = await fetchReportCsvByQueryId(env, "23");

    // Assert
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await resp.text()).toBe("id\n1\n");
  });

  it("passes through an upstream CSV content-type untouched", async () => {
    // Arrange
    behavior.responses = [
      () => pollBody(true),
      () =>
        new Response("id\n1\n", {
          status: 200,
          headers: { "content-type": "text/csv; charset=utf-8" }
        })
    ];

    // Act
    const resp = await fetchReportCsvByQueryId(env, "23");

    // Assert
    expect(resp.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });

  it("defaults the download date range to the 1900-01-01 placeholder", async () => {
    // Arrange — the shared env carries no REPORT_QUERY_*_DATE vars.
    behavior.responses = [() => pollBody(true), csv];

    // Act
    await fetchReportCsvByQueryId(env, "23");

    // Assert
    const downUrl = new URL(calls.forwards.at(-1)?.url ?? "");
    expect(downUrl.searchParams.get("startDate")).toBe("1900-01-01");
    expect(downUrl.searchParams.get("endDate")).toBe("1900-01-01");
  });

  it("trims the queryId and forwards configured date overrides", async () => {
    // Arrange
    const datedEnv = {
      ...env,
      REPORT_QUERY_START_DATE: "2026-01-01",
      REPORT_QUERY_END_DATE: "2026-02-01"
    } as unknown as Env;
    behavior.responses = [() => pollBody(true), csv];

    // Act
    await fetchReportCsvByQueryId(datedEnv, "  23  ");

    // Assert
    const downUrl = new URL(calls.forwards.at(-1)?.url ?? "");
    expect(downUrl.searchParams.get("queryID")).toBe("23");
    expect(downUrl.searchParams.get("startDate")).toBe("2026-01-01");
    expect(downUrl.searchParams.get("endDate")).toBe("2026-02-01");
  });

  it("falls back to the default poll budget on invalid env knobs", async () => {
    // Arrange — non-numeric/negative knobs must not produce a zero-attempt
    // loop or an unbounded one; the module defaults apply.
    const badKnobEnv = {
      ...env,
      REPORT_QUERY_POLL_INTERVAL_MS: "1",
      REPORT_QUERY_POLL_MAX_ATTEMPTS: "nope"
    } as unknown as Env;
    behavior.responses = Array.from(
      { length: QUERY_REQUEST_POLL_MAX_ATTEMPTS + 1 },
      () => () => pollBody(false)
    );

    // Act
    const error = (await fetchReportCsvByQueryId(badKnobEnv, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error.message).toBe(
      `QueryRequestIsComplete timed out after ${QUERY_REQUEST_POLL_MAX_ATTEMPTS} attempts`
    );
    expect(calls.forwards).toHaveLength(QUERY_REQUEST_POLL_MAX_ATTEMPTS);
  });
});
