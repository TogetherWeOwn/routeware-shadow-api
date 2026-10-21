import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PartialDataSnapshotSyncError,
  runDataSnapshotSyncChainedHttp
} from "../src/lib/snapshot/orchestration";
import { scheduled } from "../src/scheduled";

const tables = ["customer", "address", "container"] as const;
type Table = typeof tables[number];
const base = "http://test.local";
const counts = { upserted: 3, rowCount: 4 };
const marker = "SYNTHETIC-PRIVATE-RESPONSE-MARKER";
const secret = "synthetic-sync-secret";
const config = {
  CUSTOMER_REPORT_QUERY_ID: "23",
  ADDRESS_REPORT_QUERY_ID: "24",
  CONTAINER_REPORT_QUERY_ID: "25",
  CUSTOMER_SNAPSHOT_SYNC_SECRET: secret
} as unknown as Env;

let responses: Map<Table, () => Response | Promise<Response>>;
let attempted: Table[];
let requests: { table: Table; url: URL; headers: Headers; signal: AbortSignal }[];
let unexpected: string[];
let records: Record<string, unknown>[];
let cleanups: (() => void)[];
let pending: Promise<unknown>[];

/**
 * Behavioral handoff, not a new production export: 64 KiB inclusive UTF-8
 * response ceiling; the existing CHAINED_SYNC_TIMEOUT_MS (default 180s)
 * covers headers AND body as one per-table budget. Tests use a 50ms override.
 * Timer-driven fixtures are forcibly released after observation, so even the
 * old unbounded reader fails assertions rather than hanging the test runner.
 * New cron refusals use fixed kind + next_action, never replay a sync POST.
 *
 * Focused check:
 * npx vitest run test/chainedSyncResponseBoundary.acceptance.test.ts \
 *   test/chainedSyncJson.test.ts test/chainedSyncPartialFailure.test.ts \
 *   test/syncSummaryContract.test.ts
 */
const byteCeiling = 65_536;
const timeoutConfig = { ...config, CHAINED_SYNC_TIMEOUT_MS: "50" } as unknown as Env;
const nextAction = "inspect_table_sync_before_resubmitting";

beforeEach(() => {
  responses = new Map();
  attempted = [];
  requests = [];
  unexpected = [];
  records = [];
  cleanups = [];
  pending = [];
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
      throw new Error("Unexpected network request in chained response acceptance suite");
    }
    attempted.push(table);
    requests.push({ table, url, headers: request.headers, signal: request.signal });
    return responses.get(table)?.() ?? Response.json(counts);
  });
});

afterEach(async () => {
  for (const cleanup of cleanups) cleanup();
  await Promise.all(pending);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

function reply(table: Table, body: unknown): void {
  responses.set(table, () => Response.json(body));
}

function startSync(syncConfig = timeoutConfig) {
  let state: { value?: Awaited<ReturnType<typeof runDataSnapshotSyncChainedHttp>>; error?: unknown } | undefined;
  const done = runDataSnapshotSyncChainedHttp(base, syncConfig).then(
    (value) => { state = { value }; },
    (error: unknown) => { state = { error }; }
  );
  pending.push(done);
  return { done, state: () => state };
}

function failure(error: unknown, table: Table): PartialDataSnapshotSyncError {
  expect(error).toBeInstanceOf(PartialDataSnapshotSyncError);
  const result = error as PartialDataSnapshotSyncError;
  expect(result.failedTable).toBe(table);
  const index = tables.indexOf(table);
  expect(attempted).toEqual(tables.slice(0, index + 1));
  expect(result.partial).toEqual(Object.fromEntries(
    tables.map((t, i) => [t, i < index ? counts : null])
  ));
  expect(result.message).toMatch(new RegExp(`^\\[chained ${table}\\]`));
  expect(result.message).not.toContain(marker);
  expect(result.cause).toBeInstanceOf(Error);
  expect((result.cause as Error).message).not.toContain(marker);
  expect((result.cause as Error).cause).toBeUndefined();
  expect(JSON.stringify([result, ...records])).not.toContain(marker);
  return result;
}

function controlledBody(prefix = "", status = 200, cancelHangs = false) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancels = 0;
  let releaseCancel: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (prefix) c.enqueue(new TextEncoder().encode(prefix));
    },
    cancel() {
      cancels += 1;
      if (cancelHangs) return new Promise<void>((resolve) => { releaseCancel = resolve; });
      return undefined;
    }
  });
  cleanups.push(() => {
    releaseCancel?.();
    try { controller.close(); } catch { /* Already cancelled or errored. */ }
  });
  return {
    response: new Response(body, { status }),
    cancels: () => cancels,
    finish: (suffix = "") => {
      if (suffix) controller.enqueue(new TextEncoder().encode(suffix));
      controller.close();
    },
    fail: () => controller.error(new Error(marker))
  };
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

describe.each(tables)("chained %s full response deadline", (table) => {
  it.each(["", `{"private":"${marker}",`])("bounds headers then a stalled body (prefix=%s)", async (prefix) => {
    vi.useFakeTimers();
    const stream = controlledBody(prefix);
    responses.set(table, () => stream.response);
    const sync = startSync();
    await vi.advanceTimersByTimeAsync(51);

    expect(sync.state(), "body observation must settle within the per-table budget").toBeDefined();
    const error = failure(sync.state()?.error, table);
    expect(error.cause).toMatchObject({ name: "ChainedTimeoutError" });
    expect(stream.cancels()).toBe(1);
    expect(requests.at(-1)?.signal.aborted).toBe(true);
  });

  it("does not await a nonsettling cancellation promise on timeout", async () => {
    vi.useFakeTimers();
    const stream = controlledBody(`{"private":"${marker}",`, 200, true);
    responses.set(table, () => stream.response);
    const sync = startSync();
    await vi.advanceTimersByTimeAsync(51);

    expect(stream.cancels()).toBe(1);
    expect(sync.state(), "cancellation must not delay the refusal").toBeDefined();
    expect(failure(sync.state()?.error, table).cause).toMatchObject({ name: "ChainedTimeoutError" });
  });

  it("spends the same deadline on slow headers and body, not a fresh body budget", async () => {
    vi.useFakeTimers();
    const stream = controlledBody();
    responses.set(table, () => new Promise((resolve) => setTimeout(() => resolve(stream.response), 40)));
    const sync = startSync();
    await vi.advanceTimersByTimeAsync(40);
    expect(sync.state()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(11);

    expect(sync.state(), "40ms headers leave only 10ms for the body").toBeDefined();
    expect(failure(sync.state()?.error, table).cause).toMatchObject({ name: "ChainedTimeoutError" });
    expect(stream.cancels()).toBe(1);
  });

  it("scrubs a source read exception instead of exposing its message or cause", async () => {
    const stream = controlledBody();
    responses.set(table, () => stream.response);
    const sync = startSync(config);
    stream.fail();
    await sync.done;
    failure(sync.state()?.error, table);
  });

  it.each([302, 401, 429, 500])("rejects HTTP %s without waiting for or trusting its body", async (status) => {
    vi.useFakeTimers();
    const stream = controlledBody(marker, status, true);
    responses.set(table, () => stream.response);
    const sync = startSync();
    await vi.advanceTimersByTimeAsync(51);

    expect(sync.state(), "a discarded error body must not hold the table open").toBeDefined();
    const error = failure(sync.state()?.error, table);
    expect(error.message).toBe(`[chained ${table}] POST /api/v1/${table}-snapshot/sync → ${status}`);
    expect(error.cause).toMatchObject({ name: "ChainedHttpError", status });
    expect(stream.cancels()).toBe(1);
  });
});

function paddedJson(bytes: number, multibyte = false): string {
  const prefix = '{"upserted":3,"rowCount":4,"ignored":"';
  const suffix = '"}';
  const available = bytes - new TextEncoder().encode(prefix + suffix).byteLength;
  const padding = multibyte ? "é".repeat(Math.floor(available / 2)) + "x".repeat(available % 2) : "x".repeat(available);
  return prefix + padding + suffix;
}

function chunked(text: string, chunkBytes: number, contentLength?: string): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset === bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(offset, offset + chunkBytes));
      offset = Math.min(bytes.length, offset + chunkBytes);
    }
  }), { headers: contentLength ? { "content-length": contentLength } : undefined });
}

describe("chained response byte ceiling", () => {
  it("accepts bodies completed within the remaining budget and gives each table its own deadline", async () => {
    vi.useFakeTimers();
    const streams = tables.map(() => controlledBody());
    tables.forEach((table, i) => responses.set(table, () => new Promise((resolve) => {
      setTimeout(() => resolve(streams[i].response), 40);
    })));
    const sync = startSync();
    for (const stream of streams) {
      await vi.advanceTimersByTimeAsync(49);
      stream.finish(JSON.stringify(counts));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(sync.state()).toEqual({ value: { customer: counts, address: counts, container: counts } });
    expect(streams.map((stream) => stream.cancels())).toEqual([0, 0, 0]);
    expect(requests.every((request) => !request.signal.aborted)).toBe(true);
    expect(attempted).toEqual(tables);
  });

  it.each([false, true])("accepts the exact inclusive UTF-8 byte boundary (multibyte=%s)", async (multibyte) => {
    const body = paddedJson(byteCeiling, multibyte);
    expect(new TextEncoder().encode(body).byteLength).toBe(65_536);
    responses.set("address", () => chunked(body, 1023));
    const result = await runDataSnapshotSyncChainedHttp(base, config);
    expect(result).toEqual({ customer: counts, address: counts, container: counts });
    expect(attempted).toEqual(tables);
  });

  it.each([
    ["buffered", 65_537, undefined, false],
    ["chunked without length", 1023, undefined, false],
    ["misleading short length", 1023, "1", false],
    ["UTF-8 not UTF-16 length", 1023, undefined, true]
  ] as const)("rejects one byte over the ceiling: %s", async (_label, chunkBytes, length, multibyte) => {
    responses.set("address", () => chunked(paddedJson(byteCeiling + 1, multibyte), chunkBytes, length));
    const error = await runDataSnapshotSyncChainedHttp(base, config).catch((e: unknown) => e);
    expect(failure(error, "address").cause).toMatchObject({ name: "ChainedResponseTooLargeError" });
  });

  it.each([false, true])("cancels as soon as an unclosed body crosses the ceiling (cancelHangs=%s)", async (cancelHangs) => {
    vi.useFakeTimers();
    const stream = controlledBody(paddedJson(byteCeiling + 1), 200, cancelHangs);
    responses.set("address", () => stream.response);
    const sync = startSync();
    await vi.advanceTimersByTimeAsync(51);

    expect(stream.cancels()).toBe(1);
    expect(sync.state(), "refuse without waiting for EOF or cancellation").toBeDefined();
    expect(failure(sync.state()?.error, "address").cause).toMatchObject({ name: "ChainedResponseTooLargeError" });
  });

  it("stops a never-ending chunk producer after the byte limit, not after draining it", async () => {
    vi.useFakeTimers();
    let emitted = 0;
    let cancels = 0;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const timer = setInterval(() => {
      emitted += 1;
      controller.enqueue(new TextEncoder().encode(" ".repeat(16_384)));
    }, 1);
    const body = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      cancel() { cancels += 1; clearInterval(timer); }
    });
    cleanups.push(() => {
      clearInterval(timer);
      try { controller.close(); } catch { /* Already cancelled. */ }
    });
    responses.set("address", () => new Response(body));
    const sync = startSync();
    await vi.advanceTimersByTimeAsync(10);

    expect(sync.state(), "a producer need not reach EOF to be oversized").toBeDefined();
    expect(failure(sync.state()?.error, "address").cause).toMatchObject({ name: "ChainedResponseTooLargeError" });
    expect(cancels).toBe(1);
    expect(emitted).toBeLessThanOrEqual(6);
  });
});

describe.each(tables)("chained %s deleted validation", (table) => {
  it.each([
    ["negative", "-1"], ["fraction", "0.5"], ["string", '"1"'],
    ["null", "null"], ["boolean", "true"], ["object", "{}"],
    ["array", "[]"], ["unsafe integer", "9007199254740992"], ["overflow", "1e400"]
  ])("rejects %s deleted without coercion or partial success", async (_label, deleted) => {
    responses.set(table, () => new Response(`{"upserted":3,"rowCount":4,"deleted":${deleted},"private":"${marker}"}`));
    const error = await runDataSnapshotSyncChainedHttp(base, config).catch((e: unknown) => e);
    expect(failure(error, table).cause).toMatchObject({ name: "ChainedInvalidJsonError" });
  });

  it.each([0, 2, Number.MAX_SAFE_INTEGER])("preserves valid deleted=%s for cron", async (deleted) => {
    reply(table, { ...counts, deleted });
    const result = await runDataSnapshotSyncChainedHttp(base, config);
    expect(result[table]).toEqual({ ...counts, deleted });
  });

  it("keeps absent deleted absent and skipped results null even with irrelevant malformed metadata", async () => {
    reply(table, { skipped: true, deleted: marker, r2: { status: "failed", reason: marker } });
    const result = await runDataSnapshotSyncChainedHttp(base, config);
    expect(result[table]).toBeNull();
    for (const other of tables.filter((t) => t !== table)) expect(result[other]).toEqual(counts);
  });
});

describe("R2 wire projection before cron reporting", () => {
  it.each(["stored", "disabled", "failed"])("retains %s but drops arbitrary fields, nested values, raw reason and key", async (status) => {
    reply("customer", {
      ...counts,
      private: marker,
      r2: { status, reason: marker, key: marker, private: marker, nested: { credential: marker } }
    });
    const result = await runDataSnapshotSyncChainedHttp(base, config);
    expect(result.customer).toMatchObject({ ...counts, r2: { status } });
    expect(JSON.stringify(result)).not.toContain(marker);
    const r2 = result.customer?.r2;
    expect(Object.keys(r2 ?? {}).every((key) => ["status", "reason", "key"].includes(key))).toBe(true);
  });

  it.each(["SNAPSHOTS binding unbound", "SNAPSHOTS_R2_ENABLED=false"])("preserves the sanctioned fixed disabled reason: %s", async (reason) => {
    reply("customer", { ...counts, r2: { status: "disabled", reason, private: marker } });
    const result = await runDataSnapshotSyncChainedHttp(base, config);
    expect(result.customer).toEqual({ ...counts, r2: { status: "disabled", reason } });
  });

  it.each([
    ["failed", "R2 publication unavailable"],
    ["failed", "daily alias: R2 publication unavailable"],
    ["stored", "manifest: history manifest: R2 publication unavailable"],
    ["stored", "manifest: daily manifest: R2 publication unavailable"],
    ["stored", "manifest: latest pointer: R2 publication unavailable"]
  ])("keeps the fixed archive stage classification: %s / %s", async (status, reason) => {
    reply("customer", { ...counts, r2: { status, reason } });
    const result = await runDataSnapshotSyncChainedHttp(base, config);
    expect(result.customer).toEqual({ ...counts, r2: { status, reason } });
  });

  it.each([null, [], marker, { status: "unknown", private: marker }])("ignores malformed R2 metadata without inventing a successful archive: %j", async (r2) => {
    reply("customer", { ...counts, r2 });
    const result = await runDataSnapshotSyncChainedHttp(base, config);
    expect(result.customer).toEqual(counts);
  });

  it.each(["stored", "failed", "disabled"])("does not let nested/non-string reason or key cross a valid %s status", async (status) => {
    reply("customer", { ...counts, r2: { status, reason: { private: marker }, key: [marker] } });
    const result = await runDataSnapshotSyncChainedHttp(base, config);
    expect(result.customer).toEqual({ ...counts, r2: { status } });
  });

  it("cron keeps archive failure useful without disclosing any untrusted text", async () => {
    reply("customer", { ...counts, deleted: 2, r2: { status: "failed", reason: marker, key: marker, private: marker } });
    reply("address", { ...counts, r2: { status: "stored", nested: { private: marker } } });
    reply("container", { ...counts, r2: { status: "disabled", reason: "SNAPSHOTS_R2_ENABLED=false", private: marker } });
    await runCron();

    const line = cronRecord("success");
    expect(line).toMatchObject({ mode: "chained-http", tables: {
      customer: { ...counts, deleted: 2, r2: { status: "failed" } },
      address: { ...counts, r2: { status: "stored" } },
      container: { ...counts, r2: { status: "disabled", reason: "SNAPSHOTS_R2_ENABLED=false" } }
    } });
    expect(line.summary).toContain("r2: failed");
    expect(line.summary).toContain("r2: disabled");
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(attempted).toEqual(tables);
  });
});

describe("combined HTTP and cron compatibility", () => {
  it("preserves exact combined counts/null, dry-run forwarding, authentication and correlation IDs", async () => {
    const runId = "12345678-1234-4234-8234-123456789abc";
    reply("customer", { ...counts, deleted: 2, r2: { status: "stored" } });
    reply("address", { skipped: true });
    reply("container", { upserted: 0, rowCount: 0, deleted: 0, r2: { status: "disabled" } });
    const response = await exports.default.fetch(`${base}/api/v1/data-snapshot/sync?dryRun=true`, {
      method: "POST", headers: { authorization: "Bearer test-sync-secret", "x-run-id": runId }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customer: counts, address: null, container: { upserted: 0, rowCount: 0 } });
    expect(attempted).toEqual(tables);
    for (const request of requests) {
      expect(request.url.searchParams.get("dryRun")).toBe("true");
      expect(request.headers.get("x-run-id")).toBe(runId);
      expect(request.headers.get("authorization")).toBe("Bearer test-sync-secret");
    }
  });

  it("shares a cron run ID across all tables and logs, without adding deleted or R2 when absent", async () => {
    await runCron();
    const line = cronRecord("success");
    expect(line.tables).toEqual({ customer: counts, address: counts, container: counts });
    expect(line.runId).toMatch(/^[0-9a-f-]{36}$/i);
    for (const request of requests) {
      expect(request.headers.get("x-run-id")).toBe(line.runId);
      expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
    }
  });

  it.each([
    ["oversize", "ChainedResponseTooLargeError"],
    ["deleted", "ChainedInvalidJsonError"]
  ])("cron exposes fixed %s classification and next action, preserving completed tables", async (mode, kind) => {
    responses.set("address", () => mode === "oversize"
      ? new Response(paddedJson(byteCeiling + 1))
      : Response.json({ ...counts, deleted: marker }));
    await runCron();
    const line = cronRecord("failed");
    expect(line).toMatchObject({ kind, next_action: nextAction, table: "address", tables: {
      customer: counts, address: null, container: null
    } });
    expect(line).not.toHaveProperty("error");
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(attempted).toEqual(["customer", "address"]);
  });

  it("cron emits a fixed timeout and next action even when body cancellation never settles", async () => {
    vi.useFakeTimers();
    const stream = controlledBody(marker, 200, true);
    responses.set("address", () => stream.response);
    let finished = false;
    const cron = runCron().then(() => { finished = true; });
    pending.push(cron);
    await vi.advanceTimersByTimeAsync(180_001);
    expect(finished).toBe(true);
    expect(cronRecord("failed")).toMatchObject({
      kind: "ChainedTimeoutError", next_action: nextAction, table: "address",
      tables: { customer: counts, address: null, container: null }
    });
    expect(stream.cancels()).toBe(1);
    expect(JSON.stringify(records)).not.toContain(marker);
    expect(attempted).toEqual(["customer", "address"]);
  });
});
