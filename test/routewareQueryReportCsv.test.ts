import { beforeEach, describe, expect, it, vi } from "vitest";
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
 * TOG-6543 — the completion poll before the query-id CSV download.
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

describe("fetchReportCsvByQueryId completion poll (TOG-6543)", () => {
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
