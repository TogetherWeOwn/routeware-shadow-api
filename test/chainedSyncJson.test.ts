import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PartialDataSnapshotSyncError,
  runDataSnapshotSyncChainedHttp
} from "../src/lib/snapshot/orchestration";

const tables = ["customer", "address", "container"] as const;
const base = "https://api.example.test";
const config = {
  CUSTOMER_REPORT_QUERY_ID: "23",
  ADDRESS_REPORT_QUERY_ID: "24",
  CONTAINER_REPORT_QUERY_ID: "25",
  CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret"
} as unknown as Env;
const counts = { upserted: 3, rowCount: 4 };
let responses: Map<string, Response>;
let attempted: string[];

beforeEach(() => {
  responses = new Map();
  attempted = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const table = tables.find((t) => url === `${base}/api/v1/${t}-snapshot/sync`);
    if (!table || init?.method !== "POST") {
      throw new Error("Unexpected chained request");
    }
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-secret");
    attempted.push(table);
    return responses.get(table) ?? Response.json(counts);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe.each(tables)("chained %s response validation", (table) => {
  const badBodies = [
    ["HTML", "<html>synthetic-private-marker</html>"],
    ["empty body", ""],
    ["truncated JSON", '{"synthetic-private-marker":'],
    ["problem JSON", '{"type":"about:blank","detail":"synthetic-private-marker"}'],
    ["null", "null"],
    ["array", "[]"],
    ["string", '"synthetic-private-marker"'],
    ["boolean", "true"],
    ["number", "42"],
    ["missing upserted", '{"rowCount":4}'],
    ["missing rowCount", '{"upserted":3}'],
    ["string upserted", '{"upserted":"3","rowCount":4}'],
    ["null rowCount", '{"upserted":3,"rowCount":null}'],
    ["boolean upserted", '{"upserted":true,"rowCount":4}'],
    ["negative count", '{"upserted":-1,"rowCount":4}'],
    ["fractional count", '{"upserted":3,"rowCount":1.5}'],
    ["overflow count", '{"upserted":1e400,"rowCount":4}'],
    ["unsafe integer", '{"upserted":3,"rowCount":9007199254740992}'],
    ["truthy skipped string", '{"skipped":"false","upserted":3,"rowCount":4}'],
    ["null skipped", '{"skipped":null,"upserted":3,"rowCount":4}']
  ];

  it.each(badBodies)("rejects %s with table context and no response data", async (_label, body) => {
    responses.set(table, new Response(body));
    const error = await runDataSnapshotSyncChainedHttp(base, config).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PartialDataSnapshotSyncError);
    const failure = error as PartialDataSnapshotSyncError;
    expect(failure.message).toMatch(new RegExp(`^\\[chained ${table}\\]`));
    expect(failure.message).not.toContain("synthetic-private-marker");
    expect(failure.cause).toBeInstanceOf(Error);
    expect((failure.cause as Error).message).not.toContain("synthetic-private-marker");
    expect((failure.cause as Error).cause).toBeUndefined();
    expect(failure.failedTable).toBe(table);
    const index = tables.indexOf(table);
    expect(attempted).toEqual(tables.slice(0, index + 1));
    expect(failure.partial).toEqual(Object.fromEntries(
      tables.map((t, i) => [t, i < index ? counts : null])
    ));
  });

  it.each([401, 429, 500])("keeps HTTP %s failure distinct and scrubs its body", async (status) => {
    responses.set(table, new Response("synthetic-private-marker", { status }));
    const error = await runDataSnapshotSyncChainedHttp(base, config).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PartialDataSnapshotSyncError);
    expect((error as Error).message).toBe(
      `[chained ${table}] POST /api/v1/${table}-snapshot/sync → ${status}`
    );
    expect(attempted).toEqual(tables.slice(0, tables.indexOf(table) + 1));
  });

  it("accepts zero counts, false skipped and validated R2 status, dropping row data", async () => {
    responses.set(table, Response.json({
      upserted: 0,
      rowCount: 0,
      skipped: false,
      syntheticPrivateField: "synthetic-private-marker",
      r2: { status: "disabled" }
    }));
    const result = await runDataSnapshotSyncChainedHttp(base, config);

    expect(result[table]).toEqual({ upserted: 0, rowCount: 0, r2: { status: "disabled" } });
    expect(attempted).toEqual(tables);
  });

  it("accepts numeric counts without skipped and ignores malformed R2 status", async () => {
    responses.set(table, Response.json({ ...counts, r2: { status: "unknown" } }));
    const result = await runDataSnapshotSyncChainedHttp(base, config);

    expect(result[table]).toEqual(counts);
  });

  it("accepts an explicit skipped result without counts", async () => {
    responses.set(table, Response.json({ skipped: true }));
    const result = await runDataSnapshotSyncChainedHttp(base, config);

    expect(result[table]).toBeNull();
    expect(attempted).toEqual(tables);
  });
});
