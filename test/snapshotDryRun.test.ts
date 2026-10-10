import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=dry-run-test-session", Date.now() + 60_000, lockToken);
  })
}));

import { env, exports } from "cloudflare:workers";
import { stringToUint8Stream } from "../src/lib/csvStream";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import {
  InvalidSnapshotCsvError,
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
import { ensureD1TestTables } from "./d1TestMigrations";
import { recordingDb } from "./snapshotDbFake";

/**
 * Dry-run mode on the sync/import routes (TOG-9203, round-4 gap F3).
 *
 * `?dryRun=true` must run the full parse/validate path, return the counts
 * that WOULD apply, and write nothing — no D1 upserts, no reconcile deletes,
 * no R2 archive. FK validation is skipped too: would-be parent rows are
 * invisible to later tables, so checking dangling references against current
 * D1 would false-fail the customer → address → container flow.
 *
 * Unit half (recording D1 double): exact would-be counts, the read-only
 * statement shape (`SELECT COUNT` only — zero batches, zero `run()` calls),
 * the 99-key IN-chunk arithmetic, and that the parse/validate path still runs
 * (bad header and empty import still throw).
 *
 * E2E half (real app + real test D1 + real test R2 bucket, like
 * `test/snapshotSyncE2E.test.ts`): the reviewer acceptance — customer sync
 * with `?dryRun=true` twice carries the would-be counts while D1 row counts
 * and R2 keys are unchanged — plus the `?dryRun=false` control, the strict
 * `?dryRun=maybe` 400, the dangling-FK dry-run import contrast (dry-run 200s
 * where the real import 400s), and the combined route forwarding the flag to
 * every chained subrequest.
 *
 * Deliberately does NOT assert problem+json wording (owned by
 * `test/snapshotAuth.test.ts`) or the R2 byte identity (owned by
 * `test/r2SnapshotArchive.test.ts`).
 */

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";
const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments," +
  "ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";
const CONTAINER_HEADER =
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked," +
  "Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote";

const customerRow = (id: number) => `${id},,Co ${id},,,,,,,,,,true`;
const addressRow = (id: number, customerId: number) =>
  `${id},${customerId},,${id} Main St,Killeen,TX,76541,,,false,true,,,,`;
const containerRow = (id: number, addressId: number) =>
  `${id},${addressId},,SN-${id},,false,,false,,,true,${id} Main St,Killeen,TX,76541,`;

function customerCsv(ids: number[]): string {
  return [CUSTOMER_HEADER, ...ids.map(customerRow)].join("\n");
}

describe("snapshot dry-run (unit, recording D1)", () => {
  it("customer dry-run returns would-be counts with SELECT COUNT only — no batches, no run() calls", async () => {
    // Arrange — 3 stale rows in D1, 2 of which the CSV would refresh.
    const { db, batches, runs, selects } = recordingDb({ firstCounts: [3, 2] });

    // Act
    const result = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(customerCsv([101, 102])),
      80,
      { reconcile: true, dryRun: true }
    );

    // Assert — exact would-be counts (3 stale − 2 refreshed = 1 deleted),
    // and the only statements issued are the two read-only counts.
    expect(result).toEqual({ upserted: 2, rowCount: 2, deleted: 1 });
    expect(batches).toEqual([]);
    expect(runs).toEqual([]);
    expect(selects).toHaveLength(2);
    for (const s of selects) {
      expect(s.sql.startsWith("SELECT COUNT")).toBe(true);
    }
    expect(selects.some((s) => /^DELETE/i.test(s.sql))).toBe(false);
  });

  it("customer dry-run chunks seen keys into 99-key IN queries under the D1 variable ceiling", async () => {
    // Arrange — 120 CSV keys span two IN chunks (99 + 21), plus the total.
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    const { db, batches, runs, selects } = recordingDb({
      firstCounts: [125, 99, 21]
    });

    // Act — small batch size also exercises multi-flush counting.
    const result = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(customerCsv(ids)),
      50,
      { reconcile: true, dryRun: true }
    );

    // Assert — 125 stale − (99 + 21) refreshed = 5 would-be deletes, one
    // SELECT COUNT per chunk, each within 100 bind variables.
    expect(result).toEqual({ upserted: 120, rowCount: 120, deleted: 5 });
    expect(batches).toEqual([]);
    expect(runs).toEqual([]);
    expect(selects).toHaveLength(3);
    expect(selects[1].binds).toHaveLength(100);
    expect(selects[2].binds).toHaveLength(22);
  });

  it("address dry-run with a dangling FK succeeds without touching D1", async () => {
    // Arrange — customer 999 does not exist; the recording double answers
    // every parent lookup empty, so a real flush would FK-fail.
    const { db, batches, runs, selects } = recordingDb();

    // Act
    const result = await syncAddressSnapshotFromStream(
      db,
      stringToUint8Stream([ADDRESS_HEADER, addressRow(201, 999)].join("\n")),
      80,
      { dryRun: true }
    );

    // Assert — shape validated, would-be counts returned, D1 untouched, and
    // no FK parent lookup was even attempted (counts only).
    expect(result).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(batches).toEqual([]);
    expect(runs).toEqual([]);
    for (const s of selects) {
      expect(s.sql.startsWith("SELECT COUNT")).toBe(true);
    }
  });

  it("container dry-run returns would-be counts without touching D1", async () => {
    // Arrange
    const { db, batches, runs } = recordingDb();

    // Act
    const result = await syncContainerSnapshotFromStream(
      db,
      stringToUint8Stream([CONTAINER_HEADER, containerRow(301, 201)].join("\n")),
      40,
      { dryRun: true }
    );

    // Assert
    expect(result).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(batches).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("dry-run still rejects a non-CSV body instead of returning silent zeros", async () => {
    // Arrange — the lapsed-session HTML login page shape.
    const { db, batches, runs } = recordingDb();

    // Act
    const error = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream("<!DOCTYPE html>\n<html><body>Sign in</body></html>"),
      80,
      { dryRun: true }
    ).catch((e: unknown) => e);

    // Assert — the parse path runs even when nothing is written.
    expect(error).toBeInstanceOf(InvalidSnapshotCsvError);
    expect(batches).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("dry-run import still rejects a header-only CSV with requireDataRows", async () => {
    // Arrange
    const { db } = recordingDb();

    // Act
    const error = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(CUSTOMER_HEADER),
      80,
      { requireDataRows: true, dryRun: true }
    ).catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(InvalidSnapshotCsvError);
  });

  it("omitting dryRun writes (control)", async () => {
    // Arrange
    const { db, batches } = recordingDb();

    // Act
    const result = await syncCustomerSnapshotFromStream(
      db,
      stringToUint8Stream(customerCsv([101, 102])),
      80,
      { reconcile: true }
    );

    // Assert — the same CSV flushes real batches when the flag is absent.
    expect(result).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
    expect(batches.length).toBeGreaterThan(0);
  });
});

const SYNC_SECRET = "test-sync-secret";
const BAD_REQUEST = `${PROBLEM_TYPE_BASE}bad-request`;

// Report query ids from wrangler.toml [env.test.vars].
const CUSTOMER_QID = "23";
const ADDRESS_QID = "24";
const CONTAINER_QID = "25";

const E2E_CUSTOMER_CSV = [
  CUSTOMER_HEADER,
  "101,,Acme Corp,John,,Doe,,,,,,,true",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true"
].join("\n");

const E2E_ADDRESS_CSV = [
  ADDRESS_HEADER,
  "201,101,,201 Main St,Killeen,TX,76541,,,false,true,,,,",
  "202,102,,202 Main St,Killeen,TX,76541,,,false,true,,,,"
].join("\n");

const E2E_CONTAINER_CSV = [
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote,UD-Cost_Share-UD,UD-Enclosure_Doors-UD,UD-Last_Compactor_Inspection-UD,UD-Last_Enclosure_Inspection-UD,UD-Material_Stream-UD,Color,ServiceCodeType,ServiceCode_input,ServiceCode,ServiceDate,RouteIDs,FrequencyIDs",
  "301,201,,SN-301,,false,,false,,,true,201 Main St,Killeen,TX,76541,,,,,,,,,,,,,",
  "302,202,,SN-302,,false,,false,,,true,202 Main St,Killeen,TX,76541,,,,,,,,,,,,,"
].join("\n");

const CSV_BY_QID: Record<string, string> = {
  [CUSTOMER_QID]: E2E_CUSTOMER_CSV,
  [ADDRESS_QID]: E2E_ADDRESS_CSV,
  [CONTAINER_QID]: E2E_CONTAINER_CSV
};

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

async function postApp(
  path: string,
  body?: string
): Promise<{ status: number; raw: string }> {
  const resp = await exports.default.fetch(`http://test.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SYNC_SECRET}`,
      ...(body === undefined ? {} : { "content-type": "text/csv" })
    },
    body
  });
  return { status: resp.status, raw: await resp.text() };
}

async function rowCount(table: string): Promise<number> {
  const row = await db()
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

async function r2Keys(): Promise<string[]> {
  const bucket = (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
  const listed = await bucket.list({ prefix: "snapshots/" });
  return listed.objects.map((o) => o.key).sort();
}

describe("snapshot dry-run (e2e, real app + D1 + R2)", () => {
  const originalFetch = globalThis.fetch;
  /** Chained per-table subrequest URLs the combined runner attempted. */
  const requested: string[] = [];

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(async () => {
    await db().prepare("DELETE FROM container_snapshot").run();
    await db().prepare("DELETE FROM address_snapshot").run();
    await db().prepare("DELETE FROM customer_snapshot").run();
    requested.length = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      // Chained per-table subrequests go back into this same Worker (origin
      // http://test.local). Dispatch them in-process through the real app —
      // same routes, same auth gates, same D1 — rather than the network,
      // where `test.local` cannot resolve.
      if (url.startsWith("http://test.local/api/v1/")) {
        requested.push(url);
        return exports.default.fetch(url, {
          method: init?.method ?? "GET",
          headers: init?.headers as HeadersInit | undefined
        });
      }
      if (url.includes("/Reports/QueryRequestIsComplete")) {
        return new Response("true", {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/Reports/QueryExecuteDownload")) {
        const qid = new URL(url).searchParams.get("queryID") ?? "";
        const csv = CSV_BY_QID[qid];
        if (!csv) {
          throw new Error(`Unexpected report queryID in test: ${qid}`);
        }
        return new Response(csv, {
          status: 200,
          headers: { "content-type": "text/csv" }
        });
      }
      if (url.includes("killeen.routeware.com")) {
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("customer dry-run twice carries the would-be counts while D1 and R2 stay unchanged", async () => {
    // Arrange — one stale row the real sync would reconcile away.
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
      )
      .run();
    const r2Before = await r2Keys();

    // Act — the reviewer acceptance: the same dry-run, twice.
    const first = await postApp("/api/v1/customer-snapshot/sync?dryRun=true");
    const d1AfterFirst = await rowCount("customer_snapshot");
    const r2AfterFirst = await r2Keys();
    const second = await postApp("/api/v1/customer-snapshot/sync?dryRun=true");

    // Assert — both answers carry the would-be counts (2 upserted, 1 stale
    // row the real run would delete), and neither run wrote D1 or R2: the
    // stale row is still there, no new rows landed, no archive keys appeared.
    expect(first.status).toBe(200);
    expect(JSON.parse(first.raw)).toEqual({ upserted: 2, rowCount: 2, deleted: 1 });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.raw)).toEqual({ upserted: 2, rowCount: 2, deleted: 1 });
    expect(d1AfterFirst).toBe(1);
    expect(await rowCount("customer_snapshot")).toBe(1);
    const stale = await db()
      .prepare("SELECT customer_id FROM customer_snapshot WHERE customer_id = 999")
      .first<{ customer_id: number }>();
    expect(stale?.customer_id).toBe(999);
    expect(r2AfterFirst).toEqual(r2Before);
    expect(await r2Keys()).toEqual(r2Before);
  });

  it("dry-run=false writes for real (control)", async () => {
    // Arrange — no rows; the flag is explicit but negative.

    // Act
    const res = await postApp("/api/v1/customer-snapshot/sync?dryRun=false");

    // Assert — a cautious `?dryRun=false` probe is a REAL write (the enum
    // schema exists precisely so this is explicit, never a coerced accident).
    // A real write also runs the R2 leg, so main's TOG-6549 outcome stamping
    // rides the response; the dry-run path skips that leg and carries no `r2`.
    expect(res.status).toBe(200);
    expect(JSON.parse(res.raw)).toMatchObject({
      upserted: 2,
      rowCount: 2,
      deleted: 0,
      r2: { status: "stored" }
    });
    expect(await rowCount("customer_snapshot")).toBe(2);
  });

  it("dry-run=maybe answers 400, never a silent write", async () => {
    // Act
    const res = await postApp("/api/v1/customer-snapshot/sync?dryRun=maybe");

    // Assert — the flag is strict: anything but exactly "true"/"false" is
    // rejected before the handler runs, so a typo can never arm a write.
    expect(res.status).toBe(400);
    const body = JSON.parse(res.raw) as { type: string; status: number };
    expect(body.type).toBe(BAD_REQUEST);
    expect(body.status).toBe(400);
    expect(await rowCount("customer_snapshot")).toBe(0);
  });

  it("dry-run import 200s on a dangling FK where the real import 400s, and writes nothing", async () => {
    // Arrange — address rows pointing at a customer that does not exist.

    // Act — dry-run first: shape validates, would-be counts returned.
    const dry = await postApp("/api/v1/address-snapshot/import?dryRun=true", E2E_ADDRESS_CSV);

    // Assert — 200 with the counts, D1 untouched.
    expect(dry.status).toBe(200);
    expect(JSON.parse(dry.raw)).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
    expect(await rowCount("address_snapshot")).toBe(0);

    // Act — the same CSV for real: the dangling FK is a client-actionable 400.
    const real = await postApp("/api/v1/address-snapshot/import", E2E_ADDRESS_CSV);

    // Assert — 400 bad-request, still nothing written.
    expect(real.status).toBe(400);
    const body = JSON.parse(real.raw) as { type: string; status: number };
    expect(body.type).toBe(BAD_REQUEST);
    expect(body.status).toBe(400);
    expect(await rowCount("address_snapshot")).toBe(0);
  });

  it("combined dry-run forwards the flag to every chained subrequest and writes nothing", async () => {
    // Arrange — one stale row per table, so every table reports a would-be delete.
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
      )
      .run();
    const r2Before = await r2Keys();

    // Act
    const res = await postApp("/api/v1/data-snapshot/sync?dryRun=true");

    // Assert — combined shape (no `deleted` leak), every chained subrequest
    // carried `?dryRun=true` (a real write hiding behind one subrequest would
    // defeat the no-write guarantee), and D1 + R2 are unchanged.
    expect(res.status).toBe(200);
    expect(JSON.parse(res.raw)).toEqual({
      customer: { upserted: 2, rowCount: 2 },
      address: { upserted: 2, rowCount: 2 },
      container: { upserted: 2, rowCount: 2 }
    });
    expect(requested).toEqual([
      "http://test.local/api/v1/customer-snapshot/sync?dryRun=true",
      "http://test.local/api/v1/address-snapshot/sync?dryRun=true",
      "http://test.local/api/v1/container-snapshot/sync?dryRun=true"
    ]);
    expect(await rowCount("customer_snapshot")).toBe(1);
    expect(await rowCount("address_snapshot")).toBe(0);
    expect(await rowCount("container_snapshot")).toBe(0);
    expect(await r2Keys()).toEqual(r2Before);
  });
});
