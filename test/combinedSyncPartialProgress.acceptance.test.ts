import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import {
  PartialDataSnapshotSyncError,
  runDataSnapshotSyncChainedHttp
} from "../src/lib/snapshot/orchestration";
import { scheduled } from "../src/scheduled";

const tables = ["customer", "address", "container"] as const;
type Table = typeof tables[number];
const base = "http://test.local";
const counts = { upserted: 3, rowCount: 4 };
const marker = "SYNTHETIC-PARTIAL-PROGRESS-MARKER";
const credential = "partial-probe-pass-7d2e1a";
const secret = "synthetic-sync-secret";
const syncSecret = "test-sync-secret";
const requestId = "combined-sync-acceptance-01";
const config = {
  CUSTOMER_REPORT_QUERY_ID: "23",
  ADDRESS_REPORT_QUERY_ID: "24",
  CONTAINER_REPORT_QUERY_ID: "25",
  CUSTOMER_SNAPSHOT_SYNC_SECRET: secret
} as unknown as Env;

/**
 * Opt-in sanitized partial progress on combined-sync failure (R15-01).
 *
 * Combined `POST /api/v1/data-snapshot/sync` chains three per-table
 * subrequests (customer → address → container). Today a step failure answers
 * the generic 500 `internal` problem+json with no hint of which tables
 * completed. This suite pins the new explicit opt-in contract:
 *
 * - `?partialProgress=true` (only the exact string opts in) answers a step
 *   failure with HTTP 500 `application/json`:
 *   `{customer, address, container, failure}`, where each table is the
 *   allowlisted `{upserted, rowCount}` (completed) or `null`
 *   (failed/unattempted/skipped — never `deleted`, `r2`, or row data) and
 *   `failure` is `{table, code}` plus `status` only for `ChainedHttpError`.
 *   `code` is one of the six existing chained classifications (§4.1), never a
 *   new kind and never raw upstream/driver text.
 * - Anything else for the flag (`yes`, `TRUE`, `1`, empty, …) is rejected
 *   with the anchored 400 `bad-request` problem+json before any table runs —
 *   the `dryRun` enum precedent, never submitted values in `detail`.
 * - Default (absent or `?partialProgress=false`) keeps the generic 500 and
 *   the 200 success shape byte-for-byte; success with the opt-in is
 *   byte-identical to default success (no `failure` key on success).
 * - Cron records keep `kind` + `next_action` per runbook §4.1 for all six
 *   refusal kinds; the Builder's refactor must not move them.
 *
 * Out of scope (must NOT change): retry behavior, redirect replay, R13-02
 * bounds (180s per-table deadline, 64 KiB ceiling), new refusal kinds,
 * pre-work failures (401/503 stay exactly as default), and the per-table
 * routes (the flag is consumed by the combined route only, never forwarded).
 *
 * Status at authoring: the opt-in failure-shape, invalid-flag, interplay and
 * strip tests below are RED (the flag is unknown, so every opt-in request
 * behaves as default). The default byte-for-byte, auth, library message/cause
 * and cron tests are GREEN characterization locks the Builder must keep
 * green. Builder: build on this branch, never edit this file; regenerate the
 * OpenAPI snapshot (`vitest run test/openapiContract.test.ts -u`) for the new
 * query param and update CUSTOMER_SNAPSHOT.md, PROBLEMS.md and the §4.1
 * focused check.
 *
 * Focused check:
 * npx vitest run test/combinedSyncPartialProgress.acceptance.test.ts \
 *   test/chainedSyncResponseBoundary.acceptance.test.ts test/snapshotOrchestration.test.ts
 */

const byteCeiling = 65_536;
const timeoutConfig = { ...config, CHAINED_SYNC_TIMEOUT_MS: "50" } as unknown as Env;
const nextAction = "inspect_table_sync_before_resubmitting";
const chainedCodes = [
  "ChainedHttpError",
  "ChainedNetworkError",
  "ChainedResponseReadError",
  "ChainedResponseTooLargeError",
  "ChainedInvalidJsonError",
  "ChainedTimeoutError"
] as const;

let responses: Map<Table, () => Response | Promise<Response>>;
let attempted: Table[];
let requests: { table: Table; url: URL; headers: Headers; signal: AbortSignal; redirect: RequestRedirect }[];
let unexpected: string[];
let records: Record<string, unknown>[];
let cleanups: (() => void)[];

const testCtx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

beforeEach(() => {
  responses = new Map();
  attempted = [];
  requests = [];
  unexpected = [];
  records = [];
  cleanups = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((record: unknown) => {
      records.push(record as Record<string, unknown>);
    });
  }
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const table = tables.find((t) => url.pathname === `/api/v1/${t}-snapshot/sync`);
    if (url.origin !== base || !table || request.method !== "POST") {
      unexpected.push(request.url);
      throw new Error("Unexpected network request in partial-progress acceptance suite");
    }
    attempted.push(table);
    requests.push({ table, url, headers: request.headers, signal: request.signal, redirect: request.redirect });
    return responses.get(table)?.() ?? Response.json(counts);
  });
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

function reply(table: Table, body: unknown): void {
  responses.set(table, () => Response.json(body));
}

async function postCombined(
  query: string,
  headers?: Record<string, string>
): Promise<{ status: number; raw: string; contentType: string }> {
  const resp = await exports.default.fetch(`${base}/api/v1/data-snapshot/sync${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${syncSecret}`, "X-Request-Id": requestId, ...headers }
  });
  expect(resp.headers.get("X-Request-Id")).toBe(requestId);
  return {
    status: resp.status,
    raw: await resp.text(),
    contentType: resp.headers.get("content-type") ?? ""
  };
}

function controlledBody(prefix = "", status = 200) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (prefix) c.enqueue(new TextEncoder().encode(prefix));
    }
  });
  cleanups.push(() => {
    try { controller.close(); } catch { /* Already cancelled or errored. */ }
  });
  return {
    response: new Response(body, { status }),
    fail: () => controller.error(new Error(marker))
  };
}

function paddedJson(bytes: number): string {
  const prefix = '{"upserted":3,"rowCount":4,"ignored":"';
  const suffix = '"}';
  const available = bytes - new TextEncoder().encode(prefix + suffix).byteLength;
  return prefix + "x".repeat(available) + suffix;
}

function chunked(text: string, chunkBytes: number): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset === bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(offset, offset + chunkBytes));
      offset = Math.min(bytes.length, offset + chunkBytes);
    }
  }));
}

async function runCron(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await scheduled({
    cron: "0 7 * * *",
    scheduledTime: Date.parse("2026-10-21T07:00:00.000Z")
  } as ScheduledController, {
    ...env,
    ...config,
    SHADOW_API_PUBLIC_BASE: base
  } as unknown as Env, {
    waitUntil(p: Promise<unknown>) { pending.push(p); },
    passThroughOnException() {}
  } as ExecutionContext);
  await Promise.all(pending);
}

function cronRecord(outcome: "success" | "failed"): Record<string, unknown> {
  const lines = records.filter((r) => r.event === "data-snapshot-sync" && r.outcome === outcome);
  expect(lines).toHaveLength(1);
  return lines[0];
}

/** Asserts the opt-in failure envelope shared by every failure mode. */
function expectPartialBody(
  raw: string,
  expected: {
    customer: unknown;
    address: unknown;
    container: unknown;
    failure: Record<string, unknown>;
  }
): Record<string, unknown> {
  expect(raw).not.toContain(marker);
  expect(raw).not.toContain(credential);
  const body = JSON.parse(raw) as Record<string, unknown>;
  expect(body).toEqual(expected);
  expect(Object.keys(body).sort()).toEqual(["address", "container", "customer", "failure"]);
  const failure = body.failure as Record<string, unknown>;
  expect(Object.keys(failure).sort()).toEqual(
    "status" in expected.failure ? ["code", "status", "table"] : ["code", "table"]
  );
  expect(chainedCodes).toContain(failure.code);
  return body;
}

describe("opt-in partial progress on step failure", () => {
  it("http 500: fixed table, code and status with exact completed counts", async () => {
    responses.set("address", () => new Response(
      `<html><body>Upstream explosion ${marker}</body></html>`,
      { status: 500, headers: { "content-type": "text/html" } }
    ));
    const res = await postCombined("?partialProgress=true");
    expect(res.status).toBe(500);
    expect(res.contentType).toContain("application/json");
    expect(res.contentType).not.toContain("problem+json");
    expectPartialBody(res.raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "address", code: "ChainedHttpError", status: 500 }
    });
    expect(attempted).toEqual(["customer", "address"]);
    expect(JSON.stringify(records)).not.toContain(marker);
  });

  it.each([401, 429, 503])("http %i: preserves upstream status inside the outer 500 envelope", async (status) => {
    responses.set("address", () => new Response(
      `<html><body>Upstream refusal ${marker} ${credential}</body></html>`,
      { status, headers: { "content-type": "text/html" } }
    ));
    const res = await postCombined("?partialProgress=true");
    expect(res.status).toBe(500);
    expect(res.contentType).toContain("application/json");
    expect(res.contentType).not.toContain("problem+json");
    expectPartialBody(res.raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "address", code: "ChainedHttpError", status }
    });
    expect(attempted).toEqual(["customer", "address"]);
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(JSON.stringify(records)).not.toContain(credential);
  });

  it("fetch reject: classified network code, no status, no credential leak", async () => {
    responses.set("address", () => {
      throw new TypeError(`fetch failed for https://sync-user:${credential}@routeware.invalid/sync?token=${marker}`);
    });
    const res = await postCombined("?partialProgress=true");
    expect(res.status).toBe(500);
    expectPartialBody(res.raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "address", code: "ChainedNetworkError" }
    });
    expect(attempted).toEqual(["customer", "address"]);
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(JSON.stringify(records)).not.toContain(credential);
  });

  it("stream error: classified read code with exact completed counts", async () => {
    const stream = controlledBody();
    responses.set("address", () => stream.response);
    const pending = postCombined("?partialProgress=true");
    stream.fail();
    const res = await pending;
    expect(res.status).toBe(500);
    expectPartialBody(res.raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "address", code: "ChainedResponseReadError" }
    });
    expect(attempted).toEqual(["customer", "address"]);
    expect(JSON.stringify(records)).not.toContain(marker);
  });

  it("timeout: classified timeout code without waiting on the hung table", async () => {
    // Direct app.fetch with a synthetic 50ms chained budget: the canonical
    // test env pins the 180s default with no per-test override, and fake
    // timers under exports.default.fetch trip workerd's request hang
    // detector instead of reaching the orchestration deadline.
    responses.set("address", () => new Promise<Response>(() => {}));
    const res = await app.fetch(
      new Request(`${base}/api/v1/data-snapshot/sync?partialProgress=true`, {
        method: "POST",
        headers: { authorization: `Bearer ${syncSecret}` }
      }),
      { ...env, CHAINED_SYNC_TIMEOUT_MS: "50" } as Env,
      testCtx
    );
    const raw = await res.text();
    expect(res.status).toBe(500);
    expectPartialBody(raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "address", code: "ChainedTimeoutError" }
    });
    expect(attempted).toEqual(["customer", "address"]);
  });

  it("oversize: classified too-large code with exact completed counts", async () => {
    responses.set("address", () => chunked(paddedJson(byteCeiling + 1), 1023));
    const res = await postCombined("?partialProgress=true");
    expect(res.status).toBe(500);
    expectPartialBody(res.raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "address", code: "ChainedResponseTooLargeError" }
    });
    expect(attempted).toEqual(["customer", "address"]);
  });

  it.each([
    ["malformed json", `{"upserted":3,"rowCount":4,"private":"${marker}"`],
    ["non-integer counts", `{"upserted":3,"rowCount":4,"deleted":"${marker}"}`]
  ])("invalid json (%s): classified invalid-json code, marker never echoed", async (_label, body) => {
    responses.set("address", () => new Response(body));
    const res = await postCombined("?partialProgress=true");
    expect(res.status).toBe(500);
    expectPartialBody(res.raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "address", code: "ChainedInvalidJsonError" }
    });
    expect(attempted).toEqual(["customer", "address"]);
    expect(JSON.stringify(records)).not.toContain(marker);
  });
});

describe("opt-in failure position and allowlist", () => {
  it("first-table failure leaves every table null with the fixed identity", async () => {
    responses.set("customer", () => new Response(
      `<html><body>${marker}</body></html>`,
      { status: 500, headers: { "content-type": "text/html" } }
    ));
    const res = await postCombined("?partialProgress=true");
    expect(res.status).toBe(500);
    expectPartialBody(res.raw, {
      customer: null,
      address: null,
      container: null,
      failure: { table: "customer", code: "ChainedHttpError", status: 500 }
    });
    expect(attempted).toEqual(["customer"]);
    expect(JSON.stringify(records)).not.toContain(marker);
  });

  it("last-table failure keeps both completed tables, skipped stays null", async () => {
    reply("address", { skipped: true });
    responses.set("container", () => {
      throw new TypeError(`fetch failed ${marker}`);
    });
    const res = await postCombined("?partialProgress=true");
    expect(res.status).toBe(500);
    expectPartialBody(res.raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "container", code: "ChainedNetworkError" }
    });
    expect(attempted).toEqual(tables);
    expect(JSON.stringify(records)).not.toContain(marker);
  });

  it("container failure preserves distinct completed customer and address counts without metadata", async () => {
    reply("customer", { upserted: 7, rowCount: 11, deleted: 2, r2: { status: "stored" } });
    reply("address", { upserted: 13, rowCount: 17, deleted: 5, r2: { status: "failed", reason: marker } });
    responses.set("container", () => {
      throw new TypeError(`fetch failed ${marker}`);
    });
    const res = await postCombined("?partialProgress=true");
    expect(res.status).toBe(500);
    expect(res.contentType).toContain("application/json");
    expect(res.contentType).not.toContain("problem+json");
    const body = expectPartialBody(res.raw, {
      customer: { upserted: 7, rowCount: 11 },
      address: { upserted: 13, rowCount: 17 },
      container: null,
      failure: { table: "container", code: "ChainedNetworkError" }
    });
    for (const table of ["customer", "address"] as const) {
      expect(Object.keys(body[table] as Record<string, unknown>).sort()).toEqual(["rowCount", "upserted"]);
    }
    expect(attempted).toEqual(tables);
    expect(JSON.stringify(records)).not.toContain(marker);
  });

  it("strips deleted and r2 from completed tables in the failure body", async () => {
    reply("customer", { ...counts, deleted: 2, r2: { status: "stored" } });
    responses.set("address", () => new Response(marker, { status: 500 }));
    const res = await postCombined("?partialProgress=true");
    expect(res.status).toBe(500);
    const body = expectPartialBody(res.raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "address", code: "ChainedHttpError", status: 500 }
    });
    expect(Object.keys(body.customer as Record<string, unknown>).sort()).toEqual(["rowCount", "upserted"]);
  });
});

describe("invalid opt-in values are rejected before work", () => {
  it.each(["yes", "TRUE", "1", "", "true "])("?partialProgress=%j answers 400 without attempting a table", async (value) => {
    responses.set("address", () => new Response(marker, { status: 500 }));
    const res = await postCombined(`?partialProgress=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(res.contentType).toContain("application/problem+json");
    const body = JSON.parse(res.raw) as Record<string, unknown>;
    expect(body).toMatchObject({ title: "Bad Request", status: 400 });
    expect(body.type).toBe(
      "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request"
    );
    expect(body.detail).toContain("partialProgress");
    if (value) expect(res.raw).not.toContain(value);
    expect(attempted).toEqual([]);
  });

  it("existing dryRun validation still rejects before work with the new flag present", async () => {
    responses.set("address", () => new Response(marker, { status: 500 }));
    const res = await postCombined("?dryRun=maybe&partialProgress=true");
    expect(res.status).toBe(400);
    const body = JSON.parse(res.raw) as Record<string, unknown>;
    expect(body).toMatchObject({ title: "Bad Request", status: 400 });
    expect(body.detail).toContain("dryRun");
    expect(attempted).toEqual([]);
  });
});

describe("default shape is byte-for-byte unchanged", () => {
  const genericFailure =
    '{"type":"https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#internal"' +
    ',"title":"Internal Server Error","status":500' +
    ',"detail":"An unexpected error occurred. See Worker logs for details. See docs/PROBLEMS.md#internal."' +
    `,"requestId":"${requestId}"}`;
  const fullSuccess =
    '{"customer":{"upserted":3,"rowCount":4}' +
    ',"address":{"upserted":3,"rowCount":4}' +
    ',"container":{"upserted":3,"rowCount":4}}';

  it("default failure keeps the exact generic 500 body", async () => {
    responses.set("address", () => new Response(
      `<html><body>${marker}</body></html>`,
      { status: 500, headers: { "content-type": "text/html" } }
    ));
    const res = await postCombined("");
    expect(res.status).toBe(500);
    expect(res.contentType).toContain("application/problem+json");
    expect(res.raw).toBe(genericFailure);
  });

  it("?partialProgress=false fails exactly as default", async () => {
    responses.set("address", () => new Response(
      `<html><body>${marker}</body></html>`,
      { status: 500, headers: { "content-type": "text/html" } }
    ));
    const explicit = await postCombined("?partialProgress=false");
    attempted.length = 0;
    const implicit = await postCombined("");
    expect(explicit.status).toBe(500);
    expect(explicit.raw).toBe(genericFailure);
    expect(explicit.raw).toBe(implicit.raw);
  });

  it("default success keeps the exact 200 body", async () => {
    const res = await postCombined("");
    expect(res.status).toBe(200);
    expect(res.raw).toBe(fullSuccess);
  });

  it("opt-in success is byte-identical to default success", async () => {
    const opted = await postCombined("?partialProgress=true");
    const implicit = await postCombined("");
    expect(opted.status).toBe(200);
    expect(opted.raw).toBe(fullSuccess);
    expect(opted.raw).toBe(implicit.raw);
    expect(JSON.parse(opted.raw)).not.toHaveProperty("failure");
  });
});

describe("opt-in composes with dryRun without forwarding the flag", () => {
  it("forwards dryRun to every subrequest and keeps partialProgress local", async () => {
    responses.set("address", () => new Response(marker, { status: 500 }));
    const res = await postCombined("?dryRun=true&partialProgress=true");
    expect(res.status).toBe(500);
    expectPartialBody(res.raw, {
      customer: counts,
      address: null,
      container: null,
      failure: { table: "address", code: "ChainedHttpError", status: 500 }
    });
    expect(attempted).toEqual(["customer", "address"]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url.searchParams.get("dryRun")).toBe("true");
      expect(request.url.search).not.toContain("partialProgress");
      expect(request.redirect).toBe("manual");
    }
  });
});

describe("auth and pre-work failures ignore the flag", () => {
  it("missing auth answers the same 401 with and without the opt-in", async () => {
    const opted = await exports.default.fetch(`${base}/api/v1/data-snapshot/sync?partialProgress=true`, {
      method: "POST",
      headers: { "X-Request-Id": requestId }
    });
    const implicit = await exports.default.fetch(`${base}/api/v1/data-snapshot/sync`, {
      method: "POST",
      headers: { "X-Request-Id": requestId }
    });
    const unauthorized =
      '{"type":"https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized"' +
      ',"title":"Unauthorized","status":401' +
      ',"detail":"Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized."' +
      ',"instance":"/api/v1/data-snapshot/sync"' +
      `,"requestId":"${requestId}"}`;
    expect(opted.status).toBe(401);
    expect(implicit.status).toBe(401);
    for (const res of [opted, implicit]) {
      expect(res.headers.get("X-Request-Id")).toBe(requestId);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
    }
    const optedRaw = await opted.text();
    expect(optedRaw).toBe(unauthorized);
    expect(optedRaw).toBe(await implicit.text());
    expect(attempted).toEqual([]);
  });

  it("an invalid flag behind missing auth still answers 401 (outer gate first)", async () => {
    const resp = await exports.default.fetch(`${base}/api/v1/data-snapshot/sync?partialProgress=yes`, {
      method: "POST"
    });
    expect(resp.status).toBe(401);
    expect(attempted).toEqual([]);
  });
});

describe("thrown step errors keep message and cause sanitized", () => {
  function expectLibFailure(error: unknown, table: Table, code: string): void {
    expect(error).toBeInstanceOf(PartialDataSnapshotSyncError);
    const result = error as PartialDataSnapshotSyncError;
    expect(result.failedTable).toBe(table);
    expect(result.cause).toBeInstanceOf(Error);
    expect(chainedCodes).toContain((result.cause as Error).name);
    expect((result.cause as Error).name).toBe(code);
    expect(result.message).toMatch(new RegExp(`^\\[chained ${table}\\]`));
    expect(result.message).not.toContain(marker);
    expect((result.cause as Error).message).not.toContain(marker);
    expect((result.cause as Error).cause).toBeUndefined();
    expect(JSON.stringify([result, ...records])).not.toContain(marker);
  }

  it("http 500 carries the fixed identity, code and partial counts", async () => {
    responses.set("address", () => new Response(marker, { status: 500 }));
    const error = await runDataSnapshotSyncChainedHttp(base, config).catch((e: unknown) => e);
    expectLibFailure(error, "address", "ChainedHttpError");
    expect((error as PartialDataSnapshotSyncError).partial).toEqual({
      customer: counts,
      address: null,
      container: null
    });
    expect(attempted).toEqual(["customer", "address"]);
  });

  it("fetch reject carries the fixed identity, code and partial counts", async () => {
    responses.set("address", () => {
      throw new TypeError(`fetch failed for https://sync-user:${credential}@routeware.invalid ${marker}`);
    });
    const error = await runDataSnapshotSyncChainedHttp(base, config).catch((e: unknown) => e);
    expectLibFailure(error, "address", "ChainedNetworkError");
    expect((error as PartialDataSnapshotSyncError).partial).toEqual({
      customer: counts,
      address: null,
      container: null
    });
    expect(JSON.stringify([error, ...records])).not.toContain(credential);
  });

  it("stream error carries the fixed identity, code and partial counts", async () => {
    const stream = controlledBody();
    responses.set("address", () => stream.response);
    const pending = runDataSnapshotSyncChainedHttp(base, config).catch((e: unknown) => e);
    stream.fail();
    const error = await pending;
    expectLibFailure(error, "address", "ChainedResponseReadError");
    expect((error as PartialDataSnapshotSyncError).partial).toEqual({
      customer: counts,
      address: null,
      container: null
    });
  });

  it("timeout carries the fixed identity, code and partial counts", async () => {
    vi.useFakeTimers();
    responses.set("address", () => new Promise<Response>(() => {}));
    const pending = runDataSnapshotSyncChainedHttp(base, timeoutConfig).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(51);
    const error = await pending;
    expectLibFailure(error, "address", "ChainedTimeoutError");
    expect((error as PartialDataSnapshotSyncError).partial).toEqual({
      customer: counts,
      address: null,
      container: null
    });
  });
});

describe("cron refusal records keep kind and next_action for all six kinds", () => {
  type CronCase = {
    label: string;
    kind: string;
    status?: number;
    fakeTimers: boolean;
    setup: () => void;
  };
  const cronCases: CronCase[] = [
    {
      label: "http",
      kind: "ChainedHttpError",
      status: 500,
      fakeTimers: false,
      setup: () => {
        responses.set("address", () => new Response(`<html>${marker}</html>`, { status: 500 }));
      }
    },
    {
      label: "network",
      kind: "ChainedNetworkError",
      fakeTimers: false,
      setup: () => {
        responses.set("address", () => {
          throw new TypeError(`fetch failed ${marker} ${credential}`);
        });
      }
    },
    {
      label: "read",
      kind: "ChainedResponseReadError",
      fakeTimers: false,
      setup: () => {
        const stream = controlledBody();
        responses.set("address", () => stream.response);
        stream.fail();
      }
    },
    {
      label: "too-large",
      kind: "ChainedResponseTooLargeError",
      fakeTimers: false,
      setup: () => {
        responses.set("address", () => chunked(paddedJson(byteCeiling + 1), 1023));
      }
    },
    {
      label: "invalid-json",
      kind: "ChainedInvalidJsonError",
      fakeTimers: false,
      setup: () => {
        responses.set("address", () => new Response(`{"upserted":3,"deleted":"${marker}"}`));
      }
    },
    {
      label: "timeout",
      kind: "ChainedTimeoutError",
      fakeTimers: true,
      setup: () => {
        responses.set("address", () => new Promise<Response>(() => {}));
      }
    }
  ];

  it.each(cronCases.map((c) => [c.label, c] as const))(
    "%s refusal records kind, next_action and completed tables",
    async (_label, cronCase) => {
      cronCase.setup();
      if (cronCase.fakeTimers) {
        vi.useFakeTimers();
        const pending = runCron();
        await vi.advanceTimersByTimeAsync(180_001);
        await pending;
      } else {
        await runCron();
      }
      const line = cronRecord("failed");
      expect(line).toMatchObject({
        kind: cronCase.kind,
        next_action: nextAction,
        table: "address",
        tables: { customer: counts, address: null, container: null }
      });
      if (cronCase.status === undefined) {
        expect(line).not.toHaveProperty("status");
      } else {
        expect(line.status).toBe(cronCase.status);
      }
      expect(line).not.toHaveProperty("error");
      expect(JSON.stringify(records)).not.toContain(marker);
      expect(JSON.stringify(records)).not.toContain(secret);
      expect(JSON.stringify(records)).not.toContain(credential);
      expect(attempted).toEqual(["customer", "address"]);
    }
  );
});
