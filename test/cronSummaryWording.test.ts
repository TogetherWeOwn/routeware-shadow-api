import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduled } from "../src/scheduled";

/**
 * Pin operator-facing wording through the real chained HTTP runner, not a
 * mocked DataSnapshotResult: dropping counts at the subrequest boundary must
 * fail the same test as a formatter change. Only fetch and console are stubbed;
 * no report download, D1 write, R2 upload or network request runs here.
 */

const BASE = "https://cron-summary.example.test";
const PREFIX = "data-snapshot-sync ";
const SYNC_SECRET = "cron-summary-test-secret";
const paths = [
  "/api/v1/customer-snapshot/sync",
  "/api/v1/address-snapshot/sync",
  "/api/v1/container-snapshot/sync"
];

const responses: Record<string, Record<string, unknown>> = {};
const requested: string[] = [];
const logs: string[] = [];
const errors: string[] = [];
let failingPath: string | null = null;

function loggedOutcome(lines: string[]): Record<string, unknown> {
  const outcomes = lines.filter((line) => line.startsWith(PREFIX));
  expect(outcomes).toHaveLength(1);
  return JSON.parse(outcomes[0].slice(PREFIX.length)) as Record<string, unknown>;
}

async function runCron(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  // Intentionally no CUSTOMER_DB: cron-state persistence is best-effort and
  // independent of this transport/wording contract.
  const env = {
    SHADOW_API_PUBLIC_BASE: BASE,
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC_SECRET,
    CUSTOMER_REPORT_QUERY_ID: "23",
    ADDRESS_REPORT_QUERY_ID: "24",
    CONTAINER_REPORT_QUERY_ID: "25"
  } as unknown as Env;
  const controller = {
    cron: "0 7 * * *",
    scheduledTime: Date.parse("2026-09-28T07:00:00.000Z")
  } as ScheduledController;
  await scheduled(controller, env, ctx);
  await Promise.all(pending);
}

beforeEach(() => {
  requested.length = 0;
  logs.length = 0;
  errors.length = 0;
  failingPath = null;
  responses[paths[0]] = {
    upserted: 7, rowCount: 11, deleted: 2, r2: { status: "stored", key: "test/customer.json" }
  };
  responses[paths[1]] = {
    upserted: 13, rowCount: 17, deleted: 0, r2: { status: "stored", key: "test/address.json" }
  };
  responses[paths[2]] = {
    upserted: 19, rowCount: 23, r2: { status: "stored", key: "test/container.json" }
  };
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== BASE || !paths.includes(url.pathname) || url.search) {
      throw new Error(`Unexpected fetch in cron summary test: ${request.url}`);
    }
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe(`Bearer ${SYNC_SECRET}`);
    requested.push(url.pathname);
    return url.pathname === failingPath
      ? new Response("", { status: 503 })
      : Response.json(responses[url.pathname]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chained cron summary wording", () => {
  it("pins table order, distinct counts, zero deletes and absent deletes across HTTP", async () => {
    await runCron();

    const line = loggedOutcome(logs);
    expect(line.mode).toBe("chained-http");
    expect(line.outcome).toBe("success");
    expect(line.tables).toEqual({
      customer: { upserted: 7, rowCount: 11, deleted: 2, r2: { status: "stored", key: "test/customer.json" } },
      address: { upserted: 13, rowCount: 17, deleted: 0, r2: { status: "stored", key: "test/address.json" } },
      container: { upserted: 19, rowCount: 23, r2: { status: "stored", key: "test/container.json" } }
    });
    expect(line.summary).toBe(
      "customer: 7 upserted, 11 rows, 2 deleted; address: 13 upserted, 17 rows, 0 deleted; container: 19 upserted, 23 rows"
    );
    expect(requested).toEqual(paths);
    expect(errors).toEqual([]);
  });

  it("pins failed, disabled and unknown R2 suffixes without losing sync counts", async () => {
    responses[paths[0]].r2 = { status: "failed", reason: "synthetic archive failure" };
    responses[paths[1]].r2 = { status: "disabled", reason: "SNAPSHOTS_R2_ENABLED=false" };
    delete responses[paths[2]].r2;

    await runCron();

    const line = loggedOutcome(logs);
    expect(line.outcome).toBe("success");
    expect(line.summary).toBe(
      "customer: 7 upserted, 11 rows, 2 deleted, r2: failed; address: 13 upserted, 17 rows, 0 deleted, r2: disabled; container: 19 upserted, 23 rows, r2: unknown"
    );
    expect(requested).toEqual(paths);
    expect(errors).toEqual([]);
  });

  it("pins mixed wording when a zero-row sync succeeds and a subrequest is skipped", async () => {
    responses[paths[0]] = {
      upserted: 0, rowCount: 0, deleted: 0, r2: { status: "stored", key: "test/empty.json" }
    };
    responses[paths[2]] = { upserted: 0, rowCount: 0, skipped: true };

    await runCron();

    const line = loggedOutcome(logs);
    expect(line.outcome).toBe("success");
    expect((line.tables as Record<string, unknown>).container).toBeNull();
    expect(line.summary).toBe(
      "customer: 0 upserted, 0 rows, 0 deleted; address: 13 upserted, 17 rows, 0 deleted; container: skipped (no report path configured)"
    );
    expect(requested).toEqual(paths);
    expect(errors).toEqual([]);
  });

  it.each([
    {
      table: "address",
      path: paths[1],
      attempted: paths.slice(0, 2),
      summary: "customer: 7 upserted, 11 rows, 2 deleted; address: skipped (no report path configured); container: skipped (no report path configured); failed: address"
    },
    {
      table: "container",
      path: paths[2],
      attempted: paths,
      summary: "customer: 7 upserted, 11 rows, 2 deleted; address: 13 upserted, 17 rows, 0 deleted; container: skipped (no report path configured); failed: container"
    }
  ])("pins completed-table counts and the failed: $table suffix", async ({ table, path, attempted, summary }) => {
    failingPath = path;

    await runCron();

    const line = loggedOutcome(errors);
    expect(line.mode).toBe("chained-http");
    expect(line.outcome).toBe("failed");
    expect(line.summary).toBe(summary);
    expect(line.error).toBe(`[chained ${table}] POST ${path} → 503`);
    expect(requested).toEqual(attempted);
    expect(logs.filter((entry) => entry.startsWith(PREFIX))).toEqual([]);
  });
});
