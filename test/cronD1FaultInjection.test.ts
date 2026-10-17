import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Cron D1-fault-injection tests (round-3 gap §3).
 *
 * The gap asks for "tests injecting D1 failures into the scheduled handler;
 * cron returns 503 problem body, never PII, and logs the table name". The
 * three expectations map onto three different surfaces, because the cron
 * handler itself (`src/scheduled.ts`) has no HTTP surface — it returns void
 * inside `ctx.waitUntil` and reports only through its structured log line:
 *
 * - **Table name logged** — `src/lib/snapshot/orchestration.ts` rethrows every
 *   step failure tagged `[<table> snapshot]` (pinned at unit level by
 *   `test/snapshotOrchestration.test.ts`); these tests prove the tag survives
 *   end to end into the cron's `failed` log line for each table, on the real
 *   handler with the real orchestration/stream/upsert stack.
 * - **Never PII** — the failed line carries `error.message` verbatim, so every
 *   case asserts none of the fixture's PII-shaped values appears in any
 *   captured log line. A leak would be filed as its own bug card; none was
 *   found (see the sweep case).
 * - **503 problem body** — the only D1-down HTTP surface is `GET
 *   /api/v1/readiness` (D1 ping throws → 503 `degraded`; the binding-missing
 *   shape is pinned by `test/metaRoutes.test.ts`, the ping-throws shape is
 *   pinned here). An operational D1 failure *during* a sync is a 500
 *   `internal` problem body per `docs/PROBLEMS.md` (details are logged, not
 *   returned) — the per-table sync-route cases pin 500, and explicitly not
 *   503 (which stays reserved for "not configured") and not 200.
 *
 * Faults are injected at the D1 boundary only: a wrapper around the real
 * migrated test `CUSTOMER_DB` throws `D1_ERROR` for statements touching one
 * table (or only its reconcile `DELETE`, or only `cron_sync_state`), while
 * everything else — report fetch bodies, CSV parse, batching, the handler —
 * is real. Only the report download (`fetchReportCsvForPath`, which would
 * need a Routeware session) and the R2 archive leg (passthrough, same as
 * `test/snapshotOrchestration.test.ts`) are mocked.
 *
 * Fixtures are synthetic (`FaultCo Example`, `555-01xx`) — no real PII.
 */

const CUSTOMER_CSV = [
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled",
  "101,,FaultCo Example,Jane,,Doe,,,C-101,,555-0199,,fault comment,true",
  "102,,Beta LLC,John,,Smith,,,C-102,,555-0100,,ok,true"
].join("\n");

const ADDRESS_CSV = [
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date",
  "201,101,,9 Fault Ln,Killeen,TX,76541,,,false,true,,,,",
  "202,102,,8 Second St,Killeen,TX,76542,,,true,true,,,,"
].join("\n");

const CONTAINER_CSV = [
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote,UD-Cost_Share-UD,UD-Enclosure_Doors-UD,UD-Last_Compactor_Inspection-UD,UD-Last_Enclosure_Inspection-UD,UD-Material_Stream-UD,Color,ServiceCodeType,ServiceCode_input,ServiceCode,ServiceDate,RouteIDs,FrequencyIDs",
  "301,201,,FAULT-SN-1,,false,,false,,,true,9 Fault Ln,Killeen,TX,76541,,,,,,,,,,,,,",
  "302,202,,SN-302-B,,true,,true,,,true,8 Second St,Killeen,TX,76542,,,,,,,,,,,,,"
].join("\n");

/** PII-shaped fixture values that must never appear in any log line or body. */
const PII_MARKERS = ["FaultCo Example", "555-0199", "9 Fault Ln", "FAULT-SN-1"];

const CSV_BY_PATH: Record<string, string> = {
  "/reports/customer.csv": CUSTOMER_CSV,
  "/reports/address.csv": ADDRESS_CSV,
  "/reports/container.csv": CONTAINER_CSV
};

vi.mock("../src/lib/snapshot/reportFetch", () => ({
  createReportRequest: () => new Request("http://internal/report"),
  fetchReportCsvForPath: async (_env: unknown, path: string) => {
    const csv = CSV_BY_PATH[path];
    if (!csv) {
      throw new Error(`Unexpected report path in test: ${path}`);
    }
    return new Response(csv, {
      status: 200,
      headers: { "content-type": "text/csv" }
    });
  }
}));

vi.mock("../src/lib/r2SnapshotArchive", async (importOriginal) => {
  // Keep every other export (notably the `isR2ArchiveDetail` guard
  // `src/scheduled.ts` validates `r2` through) live: a factory that replaces
  // the whole module would leave them `undefined` and turn every success
  // line into a `TypeError` failure line.
  const actual = await importOriginal<typeof import("../src/lib/r2SnapshotArchive")>();
  return {
    ...actual,
    archiveReportCsvToR2AfterD1: async (
      _env: unknown,
      _kind: string,
      body: ReadableStream<Uint8Array>,
      run: (s: ReadableStream<Uint8Array>) => Promise<unknown>,
      onArchive?: (detail: { status: string }) => void
    ) => {
      // Mirror the real helper's contract: the callback fires on every
      // path, so a healthy table reads `stored` instead of the unreported
      // fallback. Same passthrough as `test/snapshotOrchestration.test.ts`.
      onArchive?.({ status: "stored" });
      // `return await`, not `return`: returning the inner promise makes this
      // frame adopt it, and workerd reports the intermediate rejected promise
      // as unhandled even though the caller catches the one it awaits.
      return await run(body);
    }
  };
});

import { env } from "cloudflare:workers";
import { checkReadiness } from "../src/lib/readiness";
import { readCronState } from "../src/lib/cronSyncState";
import { readinessResponseSchema } from "../src/routes/meta";
import { addressSnapshotRoutes } from "../src/routes/addressSnapshot";
import { containerSnapshotRoutes } from "../src/routes/containerSnapshot";
import { customerSnapshotRoutes } from "../src/routes/customerSnapshot";
import { scheduled } from "../src/scheduled";
import { ensureD1TestTables } from "./d1TestMigrations";

const D1_LOCKED = "D1_ERROR: database is locked";

function realDb(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

/**
 * D1-boundary fault injector: delegates to the real test database except for
 * statements matching `fail`, which throw `D1_ERROR` at their terminal
 * (`run`/`all`/`first`) or at `batch` time when they are batched upserts.
 *
 * Batched statements must throw in `batch()`, not just at a fake terminal:
 * the upsert path hands its prepared statements to the real `db.batch`,
 * which cannot serialize a foreign statement object (it rejects with a
 * ZodError instead of the injected fault). Throwing statements are tagged in
 * a set so `batch()` can reject the whole call with the driver error — the
 * same point a real D1 batch failure surfaces.
 */
function faultDb(
  fail: (sql: string) => boolean,
  message: string = D1_LOCKED
): D1Database {
  const real = realDb();
  const boom = (): never => {
    throw new Error(message);
  };
  const throwing = new Set<unknown>();
  const throwingStmt = {
    bind() {
      return throwingStmt;
    },
    run: boom,
    all: boom,
    first: boom
  };
  throwing.add(throwingStmt);
  return {
    prepare(sql: string) {
      if (fail(sql)) {
        return throwingStmt;
      }
      return (real.prepare as (s: string) => unknown).call(real, sql);
    },
    async batch(stmts: unknown[]) {
      if (stmts.some((s) => throwing.has(s))) {
        boom();
      }
      return (real.batch as (s: unknown[]) => Promise<unknown[]>).call(real, stmts);
    }
  } as unknown as D1Database;
}

const failTable = (table: string) => (sql: string) => sql.includes(table);
const failCustomerBatch = failTable("customer_snapshot");
const failAddressBatch = failTable("address_snapshot");
const failContainerBatch = failTable("container_snapshot");
/** Upserts succeed; only the reconcile `DELETE` throws. */
const failCustomerReconcile = (sql: string) =>
  sql.includes("customer_snapshot") && /^\s*DELETE/i.test(sql);
/** The sync succeeds; only the `cron_sync_state` persist leg throws. */
const failCronPersist = (sql: string) => sql.includes("cron_sync_state");

function cronEnv(db: D1Database): Env {
  return {
    CUSTOMER_DB: db,
    CUSTOMER_REPORT_EXPORT_PATH: "/reports/customer.csv",
    ADDRESS_REPORT_EXPORT_PATH: "/reports/address.csv",
    CONTAINER_REPORT_EXPORT_PATH: "/reports/container.csv"
  } as unknown as Env;
}

/** logEvent passes console one structured record per call; capture the objects. */
const captured: {
  logs: Record<string, unknown>[];
  errors: Record<string, unknown>[];
  warns: Record<string, unknown>[];
} = {
  logs: [],
  errors: [],
  warns: []
};

/** Serializes every record so PII checks see field values, not "[object Object]". */
function allCaptured(): string {
  return JSON.stringify([...captured.logs, ...captured.errors, ...captured.warns]);
}

/** No fixture PII marker may appear in any captured log line or response body. */
function expectNoPii(text: string, label: string): void {
  for (const marker of PII_MARKERS) {
    expect(text, `${label} leaks fixture PII ${JSON.stringify(marker)}`).not.toContain(marker);
  }
}

/** The single primary failure record: fixed msg, error level, shared route. */
function failedLine(): Record<string, unknown> {
  expect(captured.logs).toEqual([]);
  expect(captured.errors).toHaveLength(1);
  expect(captured.errors[0]).toMatchObject({
    level: "error",
    msg: "data-snapshot-sync failed",
    route: "scheduled.data-snapshot-sync"
  });
  expect(typeof captured.errors[0].ms).toBe("number");
  return captured.errors[0];
}

/** The single primary success record: fixed msg, info level, shared route. */
function successLine(): Record<string, unknown> {
  expect(captured.logs).toHaveLength(1);
  expect(captured.logs[0]).toMatchObject({
    level: "info",
    msg: "data-snapshot-sync",
    route: "scheduled.data-snapshot-sync"
  });
  expect(typeof captured.logs[0].ms).toBe("number");
  return captured.logs[0];
}

async function runScheduled(env: Env): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  // The handler must never reject: it runs inside `waitUntil`, so an escaping
  // error is an unattributed platform-level cron failure, not a log line.
  await expect(
    scheduled(
      { cron: "0 7 * * *", scheduledTime: Date.parse("2026-09-28T07:00:00.000Z") } as ScheduledController,
      env,
      ctx
    )
  ).resolves.toBeUndefined();
  await Promise.all(pending);
}

async function rowCount(table: string): Promise<number> {
  const row = await realDb()
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  await realDb().prepare("DELETE FROM container_snapshot").run();
  await realDb().prepare("DELETE FROM address_snapshot").run();
  await realDb().prepare("DELETE FROM customer_snapshot").run();
  await realDb().prepare("DELETE FROM cron_sync_state").run();
  captured.logs = [];
  captured.errors = [];
  captured.warns = [];
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => {
    captured.logs.push(a[0] as Record<string, unknown>);
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    captured.errors.push(a[0] as Record<string, unknown>);
  });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    captured.warns.push(a[0] as Record<string, unknown>);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled() D1 fault injection: table attribution + no PII", () => {
  it("customer batch failure logs failed with the customer step tag, writes nothing", async () => {
    // Arrange — D1 locks on the first table's upsert.
    // Act
    await runScheduled(cronEnv(faultDb(failCustomerBatch)));

    // Assert — the allowlisted table names the failed step; nothing synced, so
    // no table has counts to keep: the all-null line still applies when the
    // FIRST table fails. Exception and driver text never reach the log.
    const line = failedLine();
    expect(line.outcome).toBe("failed");
    expect(line.table).toBe("customer");
    expect(line).not.toHaveProperty("error");
    expect(line.tables).toEqual({ customer: null, address: null, container: null });
    expect(line.summary).toContain("failed: customer");
    expect(typeof line.durationMs).toBe("number");
    expect(await rowCount("customer_snapshot")).toBe(0);
    expect(await rowCount("address_snapshot")).toBe(0);
    expect(await rowCount("container_snapshot")).toBe(0);
    expectNoPii(allCaptured(), "customer fault");
  });

  it("address batch failure names address, keeps customer counts, skips container", async () => {
    // Arrange / Act
    await runScheduled(cronEnv(faultDb(failAddressBatch)));

    // Assert — orchestration stops after the failed step: customer rows from
    // this run are present, container never ran. The failed line
    // keeps the customer counts instead of all-null, and names the table.
    const line = failedLine();
    expect(line.outcome).toBe("failed");
    expect(line.table).toBe("address");
    expect(line).not.toHaveProperty("error");
    expect((line.tables as Record<string, unknown>).customer).toEqual({
      upserted: 2,
      rowCount: 2,
      deleted: 0,
      // The succeeded table's archive stored, so its R2 outcome
      // rides the partial counts onto the failed line.
      r2: { status: "stored" },
    });
    expect((line.tables as Record<string, unknown>).address).toBeNull();
    expect((line.tables as Record<string, unknown>).container).toBeNull();
    expect(String(line.summary)).toContain("customer: 2 upserted, 2 rows");
    expect(String(line.summary)).toContain("failed: address");
    expect(await rowCount("customer_snapshot")).toBe(2);
    expect(await rowCount("address_snapshot")).toBe(0);
    expect(await rowCount("container_snapshot")).toBe(0);
    expectNoPii(allCaptured(), "address fault");
  });

  it("container batch failure names container, keeps customer + address counts", async () => {
    // Arrange / Act
    await runScheduled(cronEnv(faultDb(failContainerBatch)));

    // Assert — both succeeded tables keep their counts on the
    // failed line; only the failed table is null.
    const line = failedLine();
    expect(line.outcome).toBe("failed");
    expect(line.table).toBe("container");
    expect(line).not.toHaveProperty("error");
    expect((line.tables as Record<string, unknown>).customer).toEqual({
      upserted: 2,
      rowCount: 2,
      deleted: 0,
      // Both succeeded tables archived cleanly before the
      // container leg failed, so the failed line carries their R2 outcomes.
      r2: { status: "stored" },
    });
    expect((line.tables as Record<string, unknown>).address).toEqual({
      upserted: 2,
      rowCount: 2,
      deleted: 0,
      r2: { status: "stored" },
    });
    expect((line.tables as Record<string, unknown>).container).toBeNull();
    expect(String(line.summary)).toContain("customer: 2 upserted, 2 rows");
    expect(String(line.summary)).toContain("address: 2 upserted, 2 rows");
    expect(String(line.summary)).toContain("failed: container");
    expect(await rowCount("customer_snapshot")).toBe(2);
    expect(await rowCount("address_snapshot")).toBe(2);
    expect(await rowCount("container_snapshot")).toBe(0);
    expectNoPii(allCaptured(), "container fault");
  });

  it("reconcile-delete failure still names the table after a successful upsert", async () => {
    // Arrange — the upsert INSERTs succeed; only the stale-row DELETE throws.
    // Act
    await runScheduled(cronEnv(faultDb(failCustomerReconcile)));

    // Assert — the allowlisted table covers the reconcile stage too, not just batches.
    const line = failedLine();
    expect(line.outcome).toBe("failed");
    expect(line.table).toBe("customer");
    expect(line).not.toHaveProperty("error");
    expect(await rowCount("customer_snapshot")).toBe(2);
    expectNoPii(allCaptured(), "reconcile fault");
  });

  it("failed runs persist per-table results: succeeded tables keep counts, the failed table is null", async () => {
    // Arrange / Act — address fails after customer synced.
    await runScheduled(cronEnv(faultDb(failAddressBatch)));

    // Assert — the readiness staleness probe still advances on fresh
    // evidence, and the persisted rows carry no error text (PII-free by
    // column construction, pinned here behaviorally). The succeeded table
    // keeps its counts; the failed and never-attempted tables record null.
    const rows = await readCronState(realDb());
    expect(rows).toHaveLength(3);
    const byTable = Object.fromEntries((rows ?? []).map((r) => [r.tableName, r]));
    expect(byTable.customer).toMatchObject({
      outcome: "failed",
      upserted: 2,
      rowCount: 2,
      deleted: 0,
    });
    expect(byTable.address).toMatchObject({
      outcome: "failed",
      upserted: null,
      rowCount: null,
      deleted: null,
    });
    expect(byTable.container).toMatchObject({
      outcome: "failed",
      upserted: null,
      rowCount: null,
      deleted: null,
    });
    expect(JSON.stringify(rows)).not.toContain("database is locked");
    expectNoPii(JSON.stringify(rows), "persisted failed rows");
  });

  it("PII sweep: no fault case echoes fixture row values into any log line", async () => {
    // Arrange — PII-shaped values sit in every table's CSV; each fault throws
    // before/after parsing them.
    const faults = [failCustomerBatch, failAddressBatch, failContainerBatch, failCustomerReconcile];

    // Act / Assert
    for (const fail of faults) {
      captured.logs = [];
      captured.errors = [];
      captured.warns = [];
      await realDb().prepare("DELETE FROM container_snapshot").run();
      await realDb().prepare("DELETE FROM address_snapshot").run();
      await realDb().prepare("DELETE FROM customer_snapshot").run();
      await runScheduled(cronEnv(faultDb(fail)));
      expectNoPii(allCaptured(), `fault ${fail.name || "case"}`);
    }
    // No leak found in any fault case — no bug card filed.
  });
});

describe("scheduled() persist-leg failure stays best-effort", () => {
  it("a cron_sync_state write failure keeps the success line, never turns the sync red", async () => {
    // Arrange — the sync is healthy; only the persist leg throws.
    // Act
    await runScheduled(cronEnv(faultDb(failCronPersist, "D1_ERROR: cron_sync_state is readonly")));

    // Assert — success still logs with counts; the persist failure is a
    // separate error record with a fixed msg and no `error` field, so the
    // driver text never reaches the log.
    const line = successLine();
    expect(line.outcome).toBe("success");
    expect(line.tables).toEqual({
      customer: { upserted: 2, rowCount: 2, deleted: 0, r2: { status: "stored" } },
      address: { upserted: 2, rowCount: 2, deleted: 0, r2: { status: "stored" } },
      container: { upserted: 2, rowCount: 2, deleted: 0, r2: { status: "stored" } }
    });
    expect(captured.errors).toHaveLength(1);
    expect(captured.errors[0]).toMatchObject({
      level: "error",
      msg: "data-snapshot-sync persistence failed",
      route: "scheduled.data-snapshot-sync",
      ms: expect.any(Number)
    });
    expect(captured.errors[0]).not.toHaveProperty("error");
    expect(allCaptured()).not.toContain("cron_sync_state is readonly");
    expectNoPii(allCaptured(), "persist fault");
  });
});

describe("sync routes under D1 outage: 500, never 503 or 200", () => {
  const routeCtx = {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;

  function syncEnv(db: D1Database, vars: Record<string, string>): Env {
    return {
      CUSTOMER_DB: db,
      CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-sync-secret",
      ...vars
    } as unknown as Env;
  }

  async function postSync(
    routes: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> },
    path: string,
    env: Env
  ): Promise<Response> {
    return await routes.fetch(
      new Request(`http://test.local${path}`, {
        method: "POST",
        headers: { authorization: "Bearer test-sync-secret" }
      }),
      env,
      routeCtx
    );
  }

  it.each([
    {
      name: "customer",
      routes: customerSnapshotRoutes,
      path: "/api/v1/customer-snapshot/sync",
      vars: { CUSTOMER_REPORT_EXPORT_PATH: "/reports/customer.csv" } as Record<string, string>,
      fail: failCustomerBatch
    },
    {
      name: "address",
      routes: addressSnapshotRoutes,
      path: "/api/v1/address-snapshot/sync",
      vars: { ADDRESS_REPORT_EXPORT_PATH: "/reports/address.csv" } as Record<string, string>,
      fail: failAddressBatch
    },
    {
      name: "container",
      routes: containerSnapshotRoutes,
      path: "/api/v1/container-snapshot/sync",
      vars: { CONTAINER_REPORT_EXPORT_PATH: "/reports/container.csv" } as Record<string, string>,
      fail: failContainerBatch
    }
  ])("POST $path with D1 down → 500 (not 503, not 200), PII-free", async (spec) => {
    // Arrange — configured route, real runner, D1 throwing at the boundary.
    const env = syncEnv(faultDb(spec.fail), spec.vars);

    // Act
    const res = await postSync(spec.routes, spec.path, env);

    // Assert — 503 stays reserved for "not configured" (pinned by
    // test/snapshotRoutes.test.ts); an operational D1 failure must not
    // resolve as a partial 200 either. The module-level 500 carries no row
    // data (the full app maps this to `internal` problem+json per
    // docs/PROBLEMS.md — details logged, not returned).
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(503);
    expect(res.status).not.toBe(200);
    expectNoPii(await res.text(), `${spec.name} route 500`);
  });
});

describe("readiness under D1 outage: 503 degraded problem surface", () => {
  function outageDb(): D1Database {
    return {
      prepare(_sql: string) {
        return {
          bind() {
            return {
              async first<T>(): Promise<T> {
                throw new Error(D1_LOCKED);
              },
              async all<T>(): Promise<{ results: T[] }> {
                throw new Error(D1_LOCKED);
              }
            };
          }
        };
      }
    } as unknown as D1Database;
  }

  it("a throwing D1 ping maps to HTTP 503 with a schema-valid, PII-free body", async () => {
    // Arrange — the binding resolves but D1 itself is down mid-ping; the
    // cron-state read throws too, so the advisory probe reports never-ran.
    const env = {
      CUSTOMER_DB: outageDb(),
      SNAPSHOTS: {} as unknown as R2Bucket,
      SNAPSHOTS_R2_ENABLED: "true",
      CUSTOMER_REPORT_QUERY_ID: "23",
      ADDRESS_REPORT_QUERY_ID: "24",
      CONTAINER_REPORT_QUERY_ID: "25"
    } as unknown as Env;

    // Act — through the lib (status mapping) and the route (HTTP mapping).
    const { report, httpStatus } = await checkReadiness(env);
    expect(httpStatus).toBe(503);
    expect(report.status).toBe("degraded");
    expect(report.checks.d1.ok).toBe(false);
    expect(report.checks.d1.detail).toContain("D1 ping failed");
    expect(readinessResponseSchema.safeParse(report).success).toBe(true);
    expectNoPii(JSON.stringify(report), "readiness 503");

    // Assert — same through the route: 503 with the degraded body.
    const res = await import("../src/routes/meta").then((m) =>
      m.metaRoutes.fetch(
        new Request("http://test.local/api/v1/readiness"),
        env,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
      )
    );
    expect(res.status).toBe(503);
    const body: unknown = await res.json();
    expect(readinessResponseSchema.safeParse(body).success).toBe(true);
    expectNoPii(JSON.stringify(body), "readiness route 503");
  });
});
