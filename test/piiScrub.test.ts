import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveCustomerLongFormBody } from "./customerFormExamples";

/**
 * PII scrub audit (TOG-5821). CONVENTIONS.md §4 forbids logging cookie headers,
 * passwords, or full upstream request/response bodies in production code paths;
 * nothing pinned it. This file pins the scrub at the sites where untrusted
 * upstream text used to enter a thrown `Error`, plus fixture hygiene.
 *
 * Audit table (full sweep 2026-09-27, head `38c7d2f`):
 *
 * | # | Site | What it emits | Verdict |
 * |---|---|---|---|
 * | 1 | `src/scheduled.ts` cron line | counts, outcome, mode, duration, `error.message` only | clean — never row data (`CronSyncLog.error` is message-only) |
 * | 2 | `src/lib/snapshot/orchestration.ts` skip logs | static config-state strings | clean — no values |
 * | 3 | `src/lib/r2SnapshotArchive.ts` | R2 object key (`snapshots/<date>/<table>.csv`) | clean — no row data |
 * | 4 | `src/lib/entityDataCache.ts` warn | cache `err.message` | clean — cache errors carry no PII |
 * | 5 | `src/lib/establishSession.ts` warn | HTTP-login `err.message` | clean after fix (names only, see 9) |
 * | 6 | `src/lib/sessionRefreshLock.ts` warn | `err.message` | clean — DO transport errors |
 * | 7 | `src/app.ts` `onError` | generic 500 to client; full `err` to server log only | clean — client never sees internals |
 * | 8 | `src/routes/*` + `dataEntityHandlers.ts` 502 `detail` | `err.message` from anti-forgery prep (fixed strings, status codes) | clean — pinned below |
 * | 9 | `src/lib/detailFullSync.ts` throw | **was** `…HTTP <status>: <upstream body slice>` → reached clients via `localSync.reason` | **FIXED — status only** |
 * | 10 | `src/lib/routewareQueryReportCsv.ts` throw | **was** `…<status> — <upstream body slice>` → reached cron logs via `[step]` wrap | **FIXED — status only** |
 * | 11 | `src/lib/snapshot/orchestration.ts` chained throw (1200-char slice) | body of an *internal* subrequest to our own sync routes (problem+json / counts) | clean — never upstream text |
 * | 12 | `src/lib/readiness.ts` D1 detail (200-char slice) | D1 driver error text | clean — no PII source; existing "no secrets" test |
 * | 13 | `src/lib/httpAuth.ts` login-failure throw | status + cookie *names* (`.WebRW`, …), never values | clean — names are fixed identifiers |
 * | 14 | `src/lib/upstreamForward.ts` `stripUpstreamSetCookie` | strips upstream `Set-Cookie` before responding | clean — pinned by `upstreamForward.test.ts` + `cors.test.ts` |
 * | 15 | `POST /api/v1/data/*` `posted` echo | client's own submitted form fields | by design (documented in OpenAPI); bearer-gated to the submitter |
 * | 16 | fixtures (`test/customerFormExamples.ts`, `tools/api-discovery/examples/*`) | `ExampleCo` / `Jane Doe` / empty phones / `REPLACE_WITH_TOKEN_FROM_PAGE` | clean — pinned below |
 *
 * No real secrets appear anywhere in this file: the PII stand-ins below are
 * `555-01xx` / `Example` values, and cookie stand-ins are `FAKE-…` literals.
 */

const PII_BODY =
  `<html><body>Error — customer "Jane Example" phone 555-0199 ` +
  `Set-Cookie: .WebRW=FAKE-SESSION-VALUE; Path=/</body></html>`;

/** Upstream answers PII-shaped HTML with a 503 unless the test queued otherwise. */
function piiResponse(): Response {
  return new Response(PII_BODY, { status: 503 });
}

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

/*
 * Plain function, not vi.fn(): the spy wrapper records each call's settled
 * result, which turns a deliberate rejection into an unhandled rejection under
 * @cloudflare/vitest-pool-workers (house pattern).
 */
vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async () => {
    const next = behavior.responses.shift();
    return next ? next() : piiResponse();
  }
}));

vi.mock("../src/lib/d1SnapshotSync", () => ({
  upsertCustomerSnapshotRows: async () => ({ upserted: 0 }),
  upsertAddressSnapshotRows: async () => ({ upserted: 0 }),
  upsertContainerSnapshotRows: async () => ({ upserted: 0 })
}));

const { fetchGetCustomerDetailFull } = await import("../src/lib/detailFullSync");
const { fetchReportCsvByQueryId } = await import("../src/lib/routewareQueryReportCsv");
const { prepareSaveAddressFormBody, prepareSaveContainerFormBody } = await import(
  "../src/lib/addressContainerSaveForm"
);

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";

const baseEnv = {
  TARGET_ORIGIN: ORIGIN,
  TARGET_BASE_PATH: BASE,
  LOGIN_URL: `${ORIGIN}${BASE}/Account/Login`,
  CUSTOMER_SAVE_AUTO_TOKEN: "true",
  CUSTOMER_DB: {} as unknown as D1Database,
  AUTH_SESSION: {
    idFromName: () => ({}),
    get: () => ({})
  }
} as unknown as Env;

const sessionStub = {} as unknown as DurableObjectStub;
const session = { cookieHeader: "ASP.NET_SessionId=FAKE", expiresAtMs: null, refreshing: false };

beforeEach(() => {
  behavior.responses = [];
});

/** Sites 9–10: an upstream body must never survive inside a thrown Error. */
function expectScrubbed(message: string, status: string): void {
  // The status is kept for diagnosis…
  expect(message).toContain(status);
  // …but no byte of the upstream body may survive.
  expect(message).not.toContain("Jane Example");
  expect(message).not.toContain("555-0199");
  expect(message).not.toContain("FAKE-SESSION-VALUE");
  expect(message).not.toContain("Set-Cookie");
}

describe("fetchGetCustomerDetailFull scrub (TOG-5821 site 9)", () => {
  it("reports the status without the upstream body", async () => {
    // Arrange — both attempts fail with a body carrying PII-shaped text. (The
    // shared mock answers PII/503 by default; queued explicitly for clarity.)

    // Act — the message used to reach API clients verbatim inside
    // `localSync.reason` (POST /api/v1/data/* keeps 200 and reports the sync
    // failure there).
    behavior.responses = [piiResponse, piiResponse];
    const error = (await fetchGetCustomerDetailFull(baseEnv, sessionStub, 5, true).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expectScrubbed(error.message, "503");
  });
});

describe("fetchReportCsvByQueryId scrub (TOG-5821 site 10)", () => {
  it("reports the status without the upstream body", async () => {
    // Arrange / Act — the message used to reach the cron log wrapped in
    // `[step]` context.
    behavior.responses = [piiResponse];
    const error = (await fetchReportCsvByQueryId(baseEnv, "23").catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expectScrubbed(error.message, "503");
  });
});

describe("anti-forgery modal-failure messages carry upstream status, never body text (site 8)", () => {
  const URLENCODED = "application/x-www-form-urlencoded";

  function body(raw: string): ArrayBuffer {
    return new TextEncoder().encode(raw).buffer as ArrayBuffer;
  }

  function request(): Request {
    return new Request("http://internal/save", { method: "POST" });
  }

  it("address modal failure names the modal and status, not the HTML", async () => {
    // Arrange — a new address (PickupAddressID 0) fetches CreateBlankAddress,
    // which answers non-200 with PII-shaped HTML. The throw must use the
    // status only: its message is echoed to clients as the 502 problem+json
    // `detail`.
    behavior.responses = [piiResponse];

    // Act
    const error = (await prepareSaveAddressFormBody(
      baseEnv,
      session,
      request(),
      body("CustomerID=5&PickupAddressID=0"),
      URLENCODED
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expectScrubbed(error.message, "503");
  });

  it("container modal failure names the modal and status, not the HTML", async () => {
    // Arrange
    behavior.responses = [piiResponse];

    // Act
    const error = (await prepareSaveContainerFormBody(
      baseEnv,
      session,
      request(),
      body("PickupAddressID=10&ContainerID=0"),
      URLENCODED
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expectScrubbed(error.message, "503");
  });
});

describe("committed fixtures carry no real-looking PII or secrets (site 16)", () => {
  it("save-long-form example uses placeholders and empty contact fields", () => {
    // Placeholder token marker, never a captured token…
    expect(saveCustomerLongFormBody).toContain("REPLACE_WITH_TOKEN_FROM_PAGE");
    // …example names only…
    expect(saveCustomerLongFormBody).toContain("ExampleCo");
    // …empty contact fields, never a dialable number…
    expect(saveCustomerLongFormBody).toMatch(/Phone1=&/);
    expect(saveCustomerLongFormBody).toMatch(/Phone2=&/);
    expect(saveCustomerLongFormBody).not.toMatch(/\d{3}-\d{3}-\d{4}/);
    // …and no cookies, emails, or passwords anywhere in the body.
    expect(saveCustomerLongFormBody).not.toMatch(/set-cookie/i);
    expect(saveCustomerLongFormBody).not.toContain("@");
    expect(saveCustomerLongFormBody).not.toMatch(/password/i);
  });
});
