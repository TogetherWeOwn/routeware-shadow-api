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
 * Import order is customer → address → container, matching the declared
 * foreign keys and `getDataSnapshotPlan` (docs/TEST-INVARIANTS.md). Each sync
 * runs with `reconcile: true` (the route default via `run*SnapshotSync`): stale
 * rows are deleted from all three tables while surviving parent rows remain.
 * Bad/empty exports must not wipe the tables (unit-pinned in
 * `test/snapshotStreamSync.test.ts`). The combined route dispatches its internal
 * POSTs back through the real Worker at a synthetic request origin.
 *
 * Deliberately does NOT assert problem+json wording — those strings are owned
 * by slice A (`test/snapshotAuth.test.ts`).
 */

const httpLoginCalls = { count: 0 };

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    httpLoginCalls.count += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=e2e-test-session", Date.now() + 60_000, lockToken);
  })
}));

import { env, exports } from "cloudflare:workers";
import { ensureD1TestTables } from "./d1TestMigrations";

const SYNC_SECRET = "test-sync-secret";
const CHAIN_ORIGIN = "https://snapshot-e2e.invalid:8443";
const TABLES = ["customer", "address", "container"] as const;
type Table = (typeof TABLES)[number];
type DataSyncResult = Record<Table, SyncResult | null>;

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

type SyncResult = {
  upserted: number;
  rowCount: number;
  deleted?: number;
  /** R2 archive outcome stamped by the sync route (TOG-6549). Key is date+table only — no PII. */
  r2?: { status: string; key?: string; reason?: string };
};

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

async function sync<T = SyncResult>(
  path: string,
  origin = "http://test.local"
): Promise<{ status: number; body: T }> {
  const resp = await exports.default.fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SYNC_SECRET}` }
  });
  const body = (await resp.json()) as T;
  return { status: resp.status, body };
}

async function seedStaleRows(): Promise<void> {
  // Stale children reference surviving parents, not the stale customer or
  // address: their deletes must come from reconciliation, not FK cascades.
  await db().batch([
    db().prepare(
      "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (101, 'Acme Corp', 1, '2000-01-01T00:00:00.000Z'), (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
    ),
    db().prepare(
      "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (201, 101, '201 Main St', 1, '2000-01-01T00:00:00.000Z'), (998, 101, 'Stale Test Address', 1, '2000-01-01T00:00:00.000Z')"
    ),
    db().prepare(
      "INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (997, 201, 'STALE-TEST', 1, '2000-01-01T00:00:00.000Z')"
    )
  ]);
}

async function expectArchiveBytes(table: Table, result: SyncResult, startedDay: string): Promise<void> {
  expect(result.r2?.status).toBe("stored");
  const key = result.r2?.key;
  expect(key).toMatch(new RegExp(`^snapshot-history/\\d{4}-\\d{2}-\\d{2}/[^/]+/${table}\\.csv$`));
  // Preserve the current-UTC-day guard, allowing a sync to straddle midnight.
  expect([startedDay, new Date().toISOString().slice(0, 10)]).toContain(key?.split("/")[1]);
  const bucket = (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
  const object = await bucket.get(key!);
  expect(object).not.toBeNull();
  const csv = CSV_BY_QID[{
    customer: CUSTOMER_QID,
    address: ADDRESS_QID,
    container: CONTAINER_QID
  }[table]];
  expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new TextEncoder().encode(csv));
}

describe("hermetic snapshot sync e2e", () => {
  const originalFetch = globalThis.fetch;
  // First download attempt per report fails with the silent-expiry signal
  // (302 → /Account/Login with HTTP 200-shaped production behavior documented
  // in docs/HANDOVER.md fact 1), so every table exercises the re-auth retry:
  // re-read the session after establishSession rather than reusing the stale one.
  const downloadAttempts = new Map<string, number>();
  const chainedRequests: string[] = [];

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(async () => {
    await db().batch([
      db().prepare("DELETE FROM container_snapshot"),
      db().prepare("DELETE FROM address_snapshot"),
      db().prepare("DELETE FROM customer_snapshot")
    ]);
    downloadAttempts.clear();
    chainedRequests.length = 0;
    httpLoginCalls.count = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url);
      if (parsed.origin === CHAIN_ORIGIN) {
        expect(TABLES.map((table) => `/api/v1/${table}-snapshot/sync`)).toContain(parsed.pathname);
        expect(parsed.search).toBe("");
        const request = new Request(input instanceof Request ? input : url, init);
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe(`Bearer ${SYNC_SECRET}`);
        chainedRequests.push(url);
        return exports.default.fetch(request);
      }
      // TOG-6543: every query-id fetch polls QueryRequestIsComplete before
      // its download. The poll answers complete immediately so the e2e keeps
      // exercising the download retry leg (first download 302s, then CSV).
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
      // No fallthrough to the network, including a wrongly hardcoded chain origin.
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("syncs customer → address → container in FK order with login, retry, parse and upsert", async () => {
    const startedDay = new Date().toISOString().slice(0, 10);
    await seedStaleRows();

    // Act — customer first: address rows point at these customers.
    const customer = await sync("/api/v1/customer-snapshot/sync");

    // Assert — login ran (not bypassed), the expired-session retry fired, the
    // CSV parsed, rows upserted, and the stale row reconciled away.
    expect(customer.status).toBe(200);
    expect(customer.body).toMatchObject({ upserted: 2, rowCount: 2, deleted: 1 });
    // A stored archive names its immutable history key (timestamp/run/table, no PII).
    expect(customer.body.r2?.status).toBe("stored");
    expect(customer.body.r2?.key).toMatch(/^snapshot-history\/\d{4}-\d{2}-\d{2}\/[^/]+\/customer\.csv$/);
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
    expect(address.body).toMatchObject({ upserted: 2, rowCount: 2, deleted: 1 });
    expect(address.body.r2?.status).toBe("stored");
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
    expect(container.body).toMatchObject({ upserted: 2, rowCount: 2, deleted: 1 });
    expect(container.body.r2?.status).toBe("stored");
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

    // Assert actual object bytes, not just keys or re-serialized parsed rows.
    await expectArchiveBytes("customer", customer.body, startedDay);
    await expectArchiveBytes("address", address.body, startedDay);
    await expectArchiveBytes("container", container.body, startedDay);
  });

  it("POSTs data-snapshot/sync at the request origin through real per-table routes in FK order", async () => {
    await seedStaleRows();

    const combined = await sync<DataSyncResult>("/api/v1/data-snapshot/sync", CHAIN_ORIGIN);

    expect(combined.status).toBe(200);
    expect(chainedRequests).toEqual(TABLES.map((table) =>
      `${CHAIN_ORIGIN}/api/v1/${table}-snapshot/sync`
    ));
    for (const table of TABLES) {
      expect(combined.body[table]).toMatchObject({ upserted: 2, rowCount: 2 });
    }
    expect(httpLoginCalls.count).toBe(3);
    for (const qid of [CUSTOMER_QID, ADDRESS_QID, CONTAINER_QID]) {
      expect(downloadAttempts.get(qid)).toBe(2);
    }
    const customers = await db()
      .prepare("SELECT customer_id FROM customer_snapshot ORDER BY customer_id")
      .all<{ customer_id: number }>();
    const addresses = await db()
      .prepare("SELECT pickup_address_id, customer_id FROM address_snapshot ORDER BY pickup_address_id")
      .all<{ pickup_address_id: number; customer_id: number }>();
    const containers = await db()
      .prepare("SELECT container_id, pickup_address_id FROM container_snapshot ORDER BY container_id")
      .all<{ container_id: number; pickup_address_id: number }>();
    expect(customers.results).toEqual([{ customer_id: 101 }, { customer_id: 102 }]);
    expect(addresses.results).toEqual([
      { pickup_address_id: 201, customer_id: 101 },
      { pickup_address_id: 202, customer_id: 102 }
    ]);
    expect(containers.results).toEqual([
      { container_id: 301, pickup_address_id: 201 },
      { container_id: 302, pickup_address_id: 202 }
    ]);
  });

  it("re-syncing is idempotent: upserts overwrite, no duplicates, nothing stale to delete", async () => {
    // Arrange independently so this test also passes when selected alone.
    const first = await sync("/api/v1/customer-snapshot/sync");
    expect(first.status).toBe(200);

    // Act
    const again = await sync("/api/v1/customer-snapshot/sync");

    // Assert
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ upserted: 2, rowCount: 2, deleted: 0 });
    expect(again.body.r2?.status).toBe("stored");
    const n = await db()
      .prepare("SELECT COUNT(*) as n FROM customer_snapshot")
      .first<{ n: number }>();
    expect(n?.n).toBe(2);
  });
});
