import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic end-to-end snapshot sync: login → download → parse → upsert,
 * driven through the real `POST /api/v1/{customer,address,container}-snapshot/sync`
 * routes against the real test `CUSTOMER_DB` (migrated via
 * `./d1TestMigrations`), with the real `QueryExecuteDownload` fetch path
 * (`src/lib/routewareQueryReportCsv.ts`, including its login-redirect retry)
 * and the real R2 archive leg.
 *
 * Only `src/lib/httpAuth` is mocked (per `test/establishSession.test.ts`: the
 * login strategies are stubbed but publish through the REAL `storeSession`, so
 * the session-refresh wiring is exercised, not reimplemented). The fetch mock
 * serves CSV **only** for `QueryExecuteDownload` and throws on any other
 * upstream URL, so no test can reach `killeen.routeware.com`.
 *
 * Import order is customer → address → container: D1 does not enforce the
 * declared foreign keys, so the order is the only thing preventing orphan rows
 * (see docs/TEST-INVARIANTS.md § `getDataSnapshotPlan`). Each sync runs with
 * `reconcile: true` (the route default via `run*SnapshotSync`), and the
 * customer sync pins the reconcile guard behaviorally: a pre-seeded stale row
 * is deleted while a bad/empty export must not wipe the table (unit-pinned in
 * `test/snapshotStreamSync.test.ts`; asserted end-to-end here for the delete
 * path).
 *
 * Deliberately does NOT assert problem+json wording — those strings are owned
 * by slice A (`test/snapshotAuth.test.ts`).
 */

const httpLoginCalls = { count: 0 };

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub) => {
    httpLoginCalls.count += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=e2e-test-session", Date.now() + 60_000);
  })
}));

import { env, exports } from "cloudflare:workers";
import { ensureD1TestTables } from "./d1TestMigrations";

const SYNC_SECRET = "test-sync-secret";

// Report query ids from wrangler.toml [env.test.vars].
const CUSTOMER_QID = "23";
const ADDRESS_QID = "24";
const CONTAINER_QID = "25";

const CUSTOMER_CSV = [
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled",
  "101,,Acme Corp,John,,Doe,,,,,,,true",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true"
].join("\n");

const ADDRESS_CSV = [
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date",
  "201,101,,201 Main St,Killeen,TX,76541,,,false,true,,,,",
  "202,102,,202 Main St,Killeen,TX,76541,,,false,true,,,,"
].join("\n");

const CONTAINER_CSV = [
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote,UD-Cost_Share-UD,UD-Enclosure_Doors-UD,UD-Last_Compactor_Inspection-UD,UD-Last_Enclosure_Inspection-UD,UD-Material_Stream-UD,Color,ServiceCodeType,ServiceCode_input,ServiceCode,ServiceDate,RouteIDs,FrequencyIDs",
  "301,201,,SN-301,,false,,false,,,true,201 Main St,Killeen,TX,76541,,,,,,,,,,,,,",
  "302,202,,SN-302,,false,,false,,,true,202 Main St,Killeen,TX,76541,,,,,,,,,,,,,"
].join("\n");

const CSV_BY_QID: Record<string, string> = {
  [CUSTOMER_QID]: CUSTOMER_CSV,
  [ADDRESS_QID]: ADDRESS_CSV,
  [CONTAINER_QID]: CONTAINER_CSV
};

type SyncResult = { upserted: number; rowCount: number; deleted?: number };

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

async function sync(path: string): Promise<{ status: number; body: SyncResult }> {
  const resp = await exports.default.fetch(`http://test.local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SYNC_SECRET}` }
  });
  const body = (await resp.json()) as SyncResult;
  return { status: resp.status, body };
}

describe("hermetic snapshot sync e2e", () => {
  const originalFetch = globalThis.fetch;
  // First download attempt per report fails with the silent-expiry signal
  // (302 → /Account/Login with HTTP 200-shaped production behavior documented
  // in docs/HANDOVER.md fact 1), so every table exercises the re-auth retry:
  // re-read the session after establishSession rather than reusing the stale one.
  const downloadAttempts = new Map<string, number>();

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(() => {
    downloadAttempts.clear();
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/Reports/QueryExecuteDownload")) {
        const qid = new URL(url).searchParams.get("queryID") ?? "";
        const csv = CSV_BY_QID[qid];
        if (!csv) {
          throw new Error(`Unexpected report queryID in test: ${qid}`);
        }
        const n = (downloadAttempts.get(qid) ?? 0) + 1;
        downloadAttempts.set(qid, n);
        if (n === 1) {
          return new Response("", {
            status: 302,
            headers: { location: "https://killeen.routeware.com/WebRW/Account/Login?expired=1" }
          });
        }
        return new Response(csv, {
          status: 200,
          headers: { "content-type": "text/csv" }
        });
      }
      // Fail loudly on any other upstream URL instead of hitting the network.
      if (url.includes("killeen.routeware.com")) {
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
      return originalFetch(input);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("syncs customer → address → container in FK order with login, retry, parse and upsert", async () => {
    // Arrange — a stale customer row the reconcile step must delete.
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
      )
      .run();
    httpLoginCalls.count = 0;

    // Act — customer first: address rows point at these customers.
    const customer = await sync("/api/v1/customer-snapshot/sync");

    // Assert — login ran (not bypassed), the expired-session retry fired, the
    // CSV parsed, rows upserted, and the stale row reconciled away.
    expect(customer.status).toBe(200);
    expect(customer.body).toEqual({ upserted: 2, rowCount: 2, deleted: 1 });
    expect(httpLoginCalls.count).toBe(1);
    expect(downloadAttempts.get(CUSTOMER_QID)).toBe(2);
    const customers = await db()
      .prepare("SELECT customer_id, company_name FROM customer_snapshot ORDER BY customer_id")
      .all<{ customer_id: number; company_name: string }>();
    expect(customers.results).toEqual([
      { customer_id: 101, company_name: "Acme Corp" },
      { customer_id: 102, company_name: "Beta LLC" }
    ]);

    // Act — address second: customer_id FKs now exist.
    const address = await sync("/api/v1/address-snapshot/sync");

    // Assert
    expect(address.status).toBe(200);
    expect(address.body).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
    expect(httpLoginCalls.count).toBe(2);
    const addresses = await db()
      .prepare(
        "SELECT pickup_address_id, customer_id, address FROM address_snapshot ORDER BY pickup_address_id"
      )
      .all<{ pickup_address_id: number; customer_id: number; address: string }>();
    expect(addresses.results).toEqual([
      { pickup_address_id: 201, customer_id: 101, address: "201 Main St" },
      { pickup_address_id: 202, customer_id: 102, address: "202 Main St" }
    ]);

    // Act — container last: pickup_address_id FKs now exist.
    const container = await sync("/api/v1/container-snapshot/sync");

    // Assert — including the full-width container columns (UD-*, service codes).
    expect(container.status).toBe(200);
    expect(container.body).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
    expect(httpLoginCalls.count).toBe(3);
    const containers = await db()
      .prepare(
        `SELECT c.container_id, c.pickup_address_id, c.serial_number, a.customer_id
         FROM container_snapshot c JOIN address_snapshot a
           ON a.pickup_address_id = c.pickup_address_id
         ORDER BY c.container_id`
      )
      .all<{ container_id: number; pickup_address_id: number; serial_number: string; customer_id: number }>();
    expect(containers.results).toEqual([
      { container_id: 301, pickup_address_id: 201, serial_number: "SN-301", customer_id: 101 },
      { container_id: 302, pickup_address_id: 202, serial_number: "SN-302", customer_id: 102 }
    ]);

    // Assert — the R2 archive leg stored all three CSVs (same stream as D1).
    const bucket = (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
    const day = new Date().toISOString().slice(0, 10);
    const listed = await bucket.list({ prefix: `snapshots/${day}/` });
    const keys = listed.objects.map((o) => o.key).sort();
    expect(keys).toEqual([
      `snapshots/${day}/address.csv`,
      `snapshots/${day}/container.csv`,
      `snapshots/${day}/customer.csv`
    ]);
  });

  it("re-syncing is idempotent: upserts overwrite, no duplicates, nothing stale to delete", async () => {
    // Arrange — table state comes from the previous test's sync in this file.
    // (Each test file gets a fresh D1; order within the file is top-to-bottom.)

    // Act
    const again = await sync("/api/v1/customer-snapshot/sync");

    // Assert
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
    const n = await db()
      .prepare("SELECT COUNT(*) as n FROM customer_snapshot")
      .first<{ n: number }>();
    expect(n?.n).toBe(2);
  });
});
