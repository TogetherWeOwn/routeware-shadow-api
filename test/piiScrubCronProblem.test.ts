import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PII-scrub extension (TOG-7378): cron summary + problem-detail paths.
 *
 * `test/piiScrub.test.ts` (TOG-5821) pins the scrub where untrusted upstream
 * text used to enter a thrown `Error`. Its audit table marks two further
 * emission paths as "clean" without a single assertion proving it:
 *
 * - site 1: `src/scheduled.ts` copies per-table results into the
 *   `data-snapshot-sync` log record. A spread there would carry any extra
 *   property (company name, phone, …) straight into the cron log.
 * - site 11: `runDataSnapshotSyncChainedHttp` used to embed a 1200-char slice
 *   of each per-table subrequest body in its throw, which landed in the cron
 *   `error` field. FIXED twice: TOG-9205 (R4-04/B1) cut the throw to step tag +
 *   status only, and the structured logger drops exception text entirely — the
 *   failure record carries only the allowlisted `table`. Pinned below by
 *   feeding PII-shaped extras through both and proving only counts (success)
 *   or the fixed shape (failure) survive.
 *
 * - problem+json `detail`/`instance`: every route builds them from numeric
 *   ids, fixed strings and pathnames. Query strings here can carry customer
 *   PII (company-name substrings), so the tests below feed PII-shaped values
 *   at each constructor and prove none survive.
 *
 * No real secrets appear anywhere in this file: the PII stand-ins below are
 * `555-01xx` / `Example` values, and cookie stand-ins are `FAKE-…` literals.
 */

const PII_NAME = "Jane Example";
const PII_PHONE = "555-0199";
const PII_COOKIE = "FAKE-SESSION-VALUE";
const PII_COMPANY = "Acme PII Probe Co";

/** No byte of row data may survive in an emission. */
function expectNoPii(text: string): void {
  expect(text).not.toContain(PII_NAME);
  expect(text).not.toContain(PII_PHONE);
  expect(text).not.toContain(PII_COOKIE);
  expect(text).not.toContain(PII_COMPANY);
  expect(text).not.toContain("Set-Cookie");
}

// ---------------------------------------------------------------------------
// Cron log record (`src/scheduled.ts`, audit site 1).
// ---------------------------------------------------------------------------

const cronBehavior: {
  result: {
    customer: Record<string, unknown> | null;
    address: Record<string, unknown> | null;
    container: Record<string, unknown> | null;
  };
  error: string | null;
} = {
  result: { customer: null, address: null, container: null },
  error: null
};

/*
 * Plain functions, not vi.fn(): the spy wrapper records each call's settled
 * result, which turns a deliberate rejection into an unhandled rejection under
 * @cloudflare/vitest-pool-workers (house pattern).
 */
vi.mock("../src/lib/d1SnapshotSync", () => ({
  runDataSnapshotSyncChainedHttp: async () => {
    if (cronBehavior.error) {
      throw new Error(cronBehavior.error);
    }
    return cronBehavior.result;
  },
  runDataSnapshotSync: async () => {
    if (cronBehavior.error) {
      throw new Error(cronBehavior.error);
    }
    return cronBehavior.result;
  }
}));

const { scheduled } = await import("../src/scheduled");
const { runDataSnapshotSyncChainedHttp } = await import(
  "../src/lib/snapshot/orchestration"
);
const { validationFailureHook, foreignKeyProblem } = await import(
  "../src/routes/shared"
);
const { rejectOversizedSnapshotImport, mapSnapshotImportError } = await import(
  "../src/routes/snapshotImport"
);
const { notFoundProblem } = await import("../src/lib/problem");
const {
  syncCustomerSnapshotFromStream,
  isSnapshotTooLarge,
  InvalidSnapshotCsvError,
  SNAPSHOT_IMPORT_MAX_BYTES
} = await import("../src/lib/snapshot/streamSync");
const { stringToUint8Stream } = await import("../src/lib/csvStream");
const { SnapshotForeignKeyError } = await import("../src/lib/snapshot/upsert");
const { customerSnapshotRoutes } = await import("../src/routes/customerSnapshot");

// logEvent hands the console one structured object per record, so the spies keep
// the object and assertions read its fields. Serialize before any leak check.
const logs: Record<string, unknown>[] = [];
const errors: Record<string, unknown>[] = [];
const warns: Record<string, unknown>[] = [];
const real = { info: console.info, error: console.error, warn: console.warn };

/** Captures the promise handed to waitUntil so the test can await it. */
function fakeCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return {
    ctx,
    settled: async () => {
      await Promise.all(pending);
    }
  };
}

function envWith(publicBase?: string): Env {
  return (publicBase === undefined
    ? {}
    : { SHADOW_API_PUBLIC_BASE: publicBase }) as unknown as Env;
}

function controllerWith(): ScheduledController {
  return {
    cron: "0 7 * * *",
    scheduledTime: Date.parse("2026-09-27T07:00:00.000Z")
  } as ScheduledController;
}

async function runScheduled(env: Env): Promise<void> {
  const { ctx, settled } = fakeCtx();
  await scheduled(controllerWith(), env, ctx);
  await settled();
}

/** The single primary outcome record (info level); its envelope is checked before any field is read. */
function loggedLine(): Record<string, unknown> {
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    level: "info",
    msg: "data-snapshot-sync",
    route: "scheduled.data-snapshot-sync"
  });
  expect(typeof logs[0].ms).toBe("number");
  return logs[0];
}

/** The single failure record (error level); its envelope is checked before any field is read. */
function errorLine(): Record<string, unknown> {
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    level: "error",
    msg: "data-snapshot-sync failed",
    route: "scheduled.data-snapshot-sync"
  });
  expect(typeof errors[0].ms).toBe("number");
  return errors[0];
}

beforeEach(() => {
  cronBehavior.result = { customer: null, address: null, container: null };
  cronBehavior.error = null;
  logs.length = 0;
  errors.length = 0;
  warns.length = 0;
  console.info = (...a: unknown[]) => {
    logs.push(a[0] as Record<string, unknown>);
  };
  console.error = (...a: unknown[]) => {
    errors.push(a[0] as Record<string, unknown>);
  };
  console.warn = (...a: unknown[]) => {
    warns.push(a[0] as Record<string, unknown>);
  };
});

afterEach(() => {
  console.info = real.info;
  console.error = real.error;
  console.warn = real.warn;
});

describe("cron success line carries counts only (site 1)", () => {
  it("strips PII-shaped extra keys from per-table results", async () => {
    // Arrange — a future result shape smuggling row fields alongside counts.
    // `tableCounts` must pick counts explicitly, never spread.
    cronBehavior.result = {
      customer: {
        upserted: 3,
        rowCount: 4,
        deleted: 1,
        company_name: PII_COMPANY,
        first_name: PII_NAME,
        phone1: PII_PHONE
      },
      address: { upserted: 5, rowCount: 6 },
      container: null
    };

    // Act — single-invocation path; the record is shared by both modes.
    await runScheduled(envWith());

    // Assert — exact tables, counts in the summary, row data nowhere.
    const line = loggedLine();
    expect(line).toMatchObject({
      outcome: "success",
      mode: "single-invocation",
      configSource: "fallback-single-invocation",
      d1LimitRisk: true
    });
    expect(line.tables).toEqual({
      customer: { upserted: 3, rowCount: 4, deleted: 1 },
      address: { upserted: 5, rowCount: 6 },
      container: null
    });
    expect(line.summary).toContain("customer: 3 upserted, 4 rows, 1 deleted");
    // The fallback warning is its own record and must carry no row data either.
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      level: "warn",
      msg: "SHADOW_API_PUBLIC_BASE is not set; data-snapshot-sync is using one invocation",
      route: "scheduled.data-snapshot-sync",
      ms: null
    });
    expectNoPii(JSON.stringify(line));
    expectNoPii(JSON.stringify(logs));
    expectNoPii(JSON.stringify(warns));
  });

  it("emits exact key sets on every table", async () => {
    // Arrange
    cronBehavior.result = {
      customer: { upserted: 1, rowCount: 1, deleted: 0 },
      address: { upserted: 2, rowCount: 2 },
      container: { upserted: 3, rowCount: 3, deleted: 4 }
    };

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert — a new key on the record or on any table breaks the contract loudly.
    const line = loggedLine();
    expect(Object.keys(line).sort()).toEqual([
      "configSource",
      "cron",
      "d1LimitRisk",
      "durationMs",
      "event",
      "level",
      "mode",
      "ms",
      "msg",
      "outcome",
      "route",
      "scheduledTime",
      "summary",
      "tables"
    ]);
    const tables = line.tables as Record<string, Record<string, unknown> | null>;
    expect(Object.keys(tables.customer ?? {}).sort()).toEqual([
      "deleted",
      "rowCount",
      "upserted"
    ]);
    expect(Object.keys(tables.address ?? {}).sort()).toEqual(["rowCount", "upserted"]);
    expect(Object.keys(tables.container ?? {}).sort()).toEqual([
      "deleted",
      "rowCount",
      "upserted"
    ]);
    expectNoPii(JSON.stringify(line));
  });
});

describe("cron failure line carries the allowlisted table only (site 1)", () => {
  it("logs the table without message, row data, stack, or table results", async () => {
    // Arrange — the realistic D1 failure shape (status text, no body).
    cronBehavior.error = "[customer snapshot] D1_ERROR: database is locked";

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert — failures are one error record (`data-snapshot-sync failed`) with
    // null tables and the fixed summary, and no primary info record. Only the
    // allowlisted `table` travels — the exception text (which could carry row
    // data or upstream body bytes) never reaches the log.
    expect(logs).toEqual([]);
    const line = errorLine();
    expect(line).toMatchObject({
      event: "data-snapshot-sync",
      outcome: "failed",
      mode: "chained-http",
      configSource: "SHADOW_API_PUBLIC_BASE",
      d1LimitRisk: false,
      cron: "0 7 * * *",
      scheduledTime: "2026-09-27T07:00:00.000Z",
      table: "customer"
    });
    expect(Object.keys(line).sort()).toEqual([
      "configSource",
      "cron",
      "d1LimitRisk",
      "durationMs",
      "event",
      "level",
      "mode",
      "ms",
      "msg",
      "outcome",
      "route",
      "scheduledTime",
      "summary",
      "table",
      "tables"
    ]);
    expect(line).not.toHaveProperty("error");
    expect(line.tables).toEqual({ customer: null, address: null, container: null });
    expect(line.summary).toBe("sync threw before any table result was recorded");
    expectNoPii(JSON.stringify(line));
  });
});

describe("chained runner carries counts, never row data (site 11)", () => {
  const realFetch = globalThis.fetch;
  const chainedBehavior: { status: number; body: string } = { status: 200, body: "" };

  beforeEach(() => {
    chainedBehavior.status = 200;
    chainedBehavior.body = "";
    // Plain function, not vi.fn() (house pattern — see top of file).
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/v1/customer-snapshot/sync")) {
        return new Response(chainedBehavior.body, {
          status: chainedBehavior.status,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function chainedEnv(): Env {
    return {
      CUSTOMER_DB: {},
      CUSTOMER_REPORT_QUERY_ID: "23",
      CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret"
    } as unknown as Env;
  }

  it("drops PII-shaped extra keys from subrequest bodies", async () => {
    // Arrange — a misbehaving subrequest answering row fields with counts.
    // `syncJsonToResult` picks counts explicitly, so row data cannot ride the
    // chained result into the cron line.
    chainedBehavior.body = JSON.stringify({
      upserted: 2,
      rowCount: 2,
      company_name: PII_COMPANY,
      phone1: PII_PHONE,
      currentCustomer: { first_name: PII_NAME }
    });

    // Act
    const result = await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      chainedEnv()
    );

    // Assert
    expect(result).toEqual({
      customer: { upserted: 2, rowCount: 2 },
      address: null,
      container: null
    });
    expectNoPii(JSON.stringify(result));
  });

  it("failure carries zero subrequest body bytes, even for a PII-shaped problem body (TOG-9205)", async () => {
    // Arrange — the subrequest answers a problem+json body smuggling
    // PII-shaped row fields alongside the fixed shape. The thrown message
    // lands verbatim in the cron `data-snapshot-sync failed` record's `error`
    // field, so it carries step tag + status only — the body is consumed and
    // discarded (R4-04/B1).
    chainedBehavior.status = 500;
    chainedBehavior.body = JSON.stringify({
      type: "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#misconfigured",
      title: "Service Unavailable",
      status: 503,
      detail: `Row for ${PII_NAME} ${PII_PHONE} failed. ${PII_COOKIE}`,
      instance: "/api/v1/customer-snapshot/sync",
      company_name: PII_COMPANY
    });

    // Act
    const error = (await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      chainedEnv()
    ).catch((e: unknown) => e)) as Error;

    // Assert — fixed shape, exact match: no slice, no body bytes.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "[chained customer] POST /api/v1/customer-snapshot/sync → 500"
    );
    expectNoPii(error.message);
  });
});

describe("problem+json detail/instance fields carry ids and fixed strings", () => {
  type ProblemBody = {
    type: string;
    title: string;
    status: number;
    detail?: string;
    instance?: string;
  };

  it("validation hook names rejected fields, never rejected values (PII)", async () => {
    // Arrange — `q` carries a company-name substring; zod messages echo it,
    // but the hook only forwards field paths.
    const res = validationFailureHook({
      success: false,
      target: "query",
      error: { issues: [{ path: ["q"] }, { path: ["limit"] }] }
    });

    // Assert
    expect(res).toBeInstanceOf(Response);
    const body = (await res?.json()) as ProblemBody;
    expect(body.detail).toBe(
      "Invalid request query (q, limit). See docs/PROBLEMS.md#bad-request."
    );
    expectNoPii(JSON.stringify(body));
  });

  it("oversized-import 413 echoes the byte count with a pathname-only instance", async () => {
    // Arrange — the URL carries a PII-shaped query; the declared length is huge.
    const res = rejectOversizedSnapshotImport(
      {
        url: `http://test.local/api/v1/customer-snapshot/import?company=${encodeURIComponent(PII_COMPANY)}&phone=${encodeURIComponent(PII_PHONE)}`,
        contentLength: String(100 * 1024 * 1024)
      },
      SNAPSHOT_IMPORT_MAX_BYTES
    );

    // Assert — instance is the pathname (query stripped), detail names bytes only.
    expect(res).toBeInstanceOf(Response);
    expect(res?.status).toBe(413);
    const body = (await res?.json()) as ProblemBody;
    expect(body.instance).toBe("/api/v1/customer-snapshot/import");
    expectNoPii(JSON.stringify(body));
  });

  it("import-error mapping uses fixed details with a pathname-only instance", async () => {
    // Arrange — PII-shaped query on the URL for both error classes.
    const url = `http://test.local/api/v1/address-snapshot/import?q=${encodeURIComponent(PII_COMPANY)}`;
    const tooLarge = mapSnapshotImportError(
      url,
      new Error("Snapshot import body exceeds the 52428800 byte limit."),
      (e) => e instanceof Error && e.message.includes("exceeds"),
      (e) => e instanceof InvalidSnapshotCsvError
    );
    const invalid = mapSnapshotImportError(
      url,
      new InvalidSnapshotCsvError("Customer report is not valid CSV (missing CustomerID header)."),
      (e) => e instanceof Error && (e as Error).message.includes("exceeds"),
      (e) => e instanceof InvalidSnapshotCsvError
    );

    // Assert — fixed strings, never the submitted bytes; query never in instance.
    expect(tooLarge?.status).toBe(413);
    expect(invalid?.status).toBe(400);
    const tooLargeBody = (await tooLarge?.json()) as ProblemBody;
    const invalidBody = (await invalid?.json()) as ProblemBody;
    for (const body of [tooLargeBody, invalidBody]) {
      expect(body.instance).toBe("/api/v1/address-snapshot/import");
      expectNoPii(JSON.stringify(body));
    }
    expect(invalidBody.detail).toBe(
      "Snapshot import body is not valid CSV. See docs/PROBLEMS.md#bad-request."
    );
  });

  it("dangling-FK detail carries integer keys only, even with a PII-laden cause", async () => {
    // Arrange — the D1 driver message in the cause chain carries row text;
    // the detail must use only the typed integer keys.
    const cause = new Error(
      `D1_ERROR: FOREIGN KEY constraint failed for ${PII_NAME} ${PII_PHONE}`
    );
    const fk = new SnapshotForeignKeyError(
      {
        table: "address_snapshot",
        column: "customer_id",
        parentTable: "customer_snapshot",
        missingKeys: [9999],
        rowOffset: 0
      },
      { cause }
    );
    const wrapped = new Error("[address snapshot] sync failed", { cause: fk });

    // Act
    const res = foreignKeyProblem(wrapped);

    // Assert
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as ProblemBody;
    expect(body.detail).toContain("address_snapshot.customer_id=9999");
    expectNoPii(JSON.stringify(body));
  });

  it("not-found problem carries the path only", async () => {
    // Act
    const res = notFoundProblem("/api/v1/does-not-exist");

    // Assert
    const body = (await res.json()) as ProblemBody;
    expect(body.detail).toBe(
      "No operation registered for /api/v1/does-not-exist. See docs/PROBLEMS.md#not-found."
    );
    expect(body.instance).toBe("/api/v1/does-not-exist");
    expectNoPii(JSON.stringify(body));
  });

  it("by-id param rejection echoes no value; missing-row 404 names the numeric id", async () => {
    // Arrange — a PII-shaped path param (rejected by the schema hook before
    // the handler runs) and a numeric id with no row behind it.
    const ctx = {
      waitUntil() {},
      passThroughOnException() {}
    } as unknown as ExecutionContext;
    const env = {
      CUSTOMER_DB: {
        prepare() {
          return {
            bind() {
              return {
                async first<T>() {
                  return null as T;
                },
                async all<T>() {
                  return { results: [] } as unknown as T;
                }
              };
            }
          };
        }
      }
    } as unknown as Env;

    // Act — non-numeric param carries a PII-shaped token.
    const rejected = await customerSnapshotRoutes.fetch(
      new Request(`http://test.local/api/v1/customer-snapshot/${PII_NAME.replace(/ /g, "")}${PII_PHONE}`),
      env,
      ctx
    );
    // Act — numeric id, empty table.
    const missing = await customerSnapshotRoutes.fetch(
      new Request("http://test.local/api/v1/customer-snapshot/9999"),
      env,
      ctx
    );

    // Assert — the rejected value appears nowhere; the 404 names the id only.
    expect(rejected.status).toBe(400);
    expectNoPii(JSON.stringify(await rejected.json()));
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as ProblemBody;
    expect(body.detail).toBe(
      "No snapshot row for customer_id=9999. See docs/PROBLEMS.md#not-found."
    );
    expect(body.instance).toBe("/api/v1/customer-snapshot/9999#customer_id=9999");
    expectNoPii(JSON.stringify(body));
  });

  it("invalid-CSV import error carries no submitted bytes", async () => {
    // Arrange — a header line smuggling PII-shaped markers where the
    // CustomerID header must be.
    const csv = `X-Bad-Header,${PII_COMPANY},${PII_PHONE}\n1,2,3`;

    // Act
    const error = (await syncCustomerSnapshotFromStream(
      {} as unknown as D1Database,
      stringToUint8Stream(csv),
      80,
      { requireDataRows: true }
    ).catch((e: unknown) => e)) as Error;

    // Assert — the fixed message names the missing header, never the bytes.
    expect(error).toBeInstanceOf(InvalidSnapshotCsvError);
    expect(error.message).toBe(
      "Customer report is not valid CSV (missing CustomerID header). Check CUSTOMER_REPORT_EXPORT_PATH or query-id pipeline."
    );
    expectNoPii(error.message);
  });

  it("oversized-stream error carries the byte limit, never the rows", async () => {
    // Arrange — PII-shaped rows under a tiny cap: the cap trips first.
    const csv = [
      "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled",
      `1,,${PII_COMPANY},${PII_NAME},,,,${PII_PHONE},,,,true`
    ].join("\n");

    // Act
    const error = (await syncCustomerSnapshotFromStream(
      {} as unknown as D1Database,
      stringToUint8Stream(csv),
      80,
      { requireDataRows: true, maxBytes: 10 }
    ).catch((e: unknown) => e)) as Error;

    // Assert — the cap error (direct or stream-wrapped) is a fixed string.
    expect(isSnapshotTooLarge(error)).toBe(true);
    expectNoPii(error.message);
    expectNoPii(String((error as Error).cause ?? ""));
  });
});
