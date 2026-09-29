import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-9209 (gap QA1) — full sync-route test for the R2-disabled path.
 *
 * `SNAPSHOTS_R2_ENABLED=false` had unit coverage only (`test/r2SnapshotArchive.test.ts`):
 * nothing drove the real per-table sync routes or the combined route with the flag off.
 * This file does that end to end through the real app (`src/app.ts`) against the real
 * test `CUSTOMER_DB` (migrated via `./d1TestMigrations`):
 *
 * - `POST /api/v1/{customer,address,container}-snapshot/sync` each answer 200 with the
 *   exact reconciling body, land their D1 rows, and leave the real test R2 bucket empty;
 * - `POST /api/v1/data-snapshot/sync` (the chained per-table path) answers 200 with the
 *   exact combined body, lands all three tables, and leaves R2 empty;
 * - every table logs `R2 snapshot archive disabled for <table>: SNAPSHOTS_R2_ENABLED=false`,
 *   pinning the *reason* (flag off, not binding unbound).
 *
 * Hermetic like `test/snapshotSyncE2E.test.ts`: only `src/lib/httpAuth` is mocked (the
 * login strategy is stubbed but publishes through the REAL `storeSession`, so the
 * session wiring is exercised, not reimplemented). The fetch stub serves CSV only for
 * `QueryExecuteDownload`, answers the `QueryRequestIsComplete` poll as complete,
 * forwards the chained per-table subrequests back into the app in-process **with the
 * same R2-disabled env** (the pool default has R2 on, so forwarding via `exports` would
 * silently test the wrong path), and throws on any other upstream URL — no test can
 * reach `killeen.routeware.com`.
 *
 * Reviewer acceptance: run ONLY this file green, then flip `R2_ENABLED_UNDER_TEST` to
 * `"true"` and re-run — every R2-emptiness assertion (and the disabled-log pins) must go
 * red, proving the disabled path is what was exercised.
 *
 * Deliberately does NOT pin the login-redirect retry (owned by
 * `test/snapshotSyncE2E.test.ts`), problem+json wording (owned by
 * `test/snapshotAuth.test.ts`), or R2 byte identity (owned by
 * `test/r2SnapshotArchive.test.ts`).
 */

const httpLoginCalls = { count: 0 };

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub) => {
    httpLoginCalls.count += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=r2-disabled-test-session", Date.now() + 60_000);
  })
}));

import { env } from "cloudflare:workers";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

const SYNC_SECRET = "test-sync-secret";

// THE flip point for the reviewer acceptance above: "false" under test. Setting this
// to "true" must turn this file red (R2 keys appear, disabled-log lines vanish).
const R2_ENABLED_UNDER_TEST = "false";

/** Test env with R2 archiving forced off; every other binding/var is the pool default. */
function r2DisabledEnv(): Env {
  return { ...env, SNAPSHOTS_R2_ENABLED: R2_ENABLED_UNDER_TEST } as unknown as Env;
}

const CTX = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

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
  /** R2 archive outcome (TOG-6549): always `disabled` in this file. */
  r2?: { status: string; reason?: string; key?: string };
};

type CombinedSummary = {
  customer: { upserted: number; rowCount: number } | null;
  address: { upserted: number; rowCount: number } | null;
  container: { upserted: number; rowCount: number } | null;
};

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

async function postSync(path: string): Promise<{ status: number; body: SyncResult }> {
  const res = await app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${SYNC_SECRET}` }
    }),
    r2DisabledEnv(),
    CTX
  );
  const body = (await res.json()) as SyncResult;
  return { status: res.status, body };
}

/**
 * The "no R2 calls attempted" proof: the archive leg is the only writer to this
 * prefix, so an empty listing means no put/multipart call ran. Each test file gets a
 * fresh test bucket (like the fresh D1), and nothing else in this file writes to R2.
 */
async function expectR2Untouched(): Promise<void> {
  const bucket = (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
  const listed = await bucket.list({ prefix: "snapshots/" });
  expect(listed.objects.map((o) => o.key)).toEqual([]);
}

function expectDisabledLogged(table: "customer" | "address" | "container"): void {
  expect(
    logged.some((l) =>
      l.includes(`R2 snapshot archive disabled for ${table}: SNAPSHOTS_R2_ENABLED=false`)
    ),
    `expected the R2-disabled log line for ${table}`
  ).toBe(true);
}

const logged: string[] = [];
const realConsoleLog = console.log;

describe("sync routes with R2 archiving disabled", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(async () => {
    logged.length = 0;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Chained per-table subrequests from POST /api/v1/data-snapshot/sync go back
      // into this same Worker (origin http://test.local). Dispatch them in-process
      // through the real app WITH THE R2-DISABLED ENV — the pool default has R2 on,
      // so forwarding via `exports` here would silently test the wrong path.
      if (url.startsWith("http://test.local/api/v1/")) {
        return app.fetch(
          new Request(url, {
            method: init?.method ?? "GET",
            headers: init?.headers as HeadersInit | undefined
          }),
          r2DisabledEnv(),
          CTX
        );
      }
      // TOG-6543: every query-id fetch polls QueryRequestIsComplete before its
      // download. The poll answers complete immediately (no 302 re-auth dance:
      // the retry leg is pinned by snapshotSyncE2E.test.ts, not here).
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
      // Fail loudly on any other upstream URL instead of hitting the network.
      if (url.includes("killeen.routeware.com")) {
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    // FK-safe wipe order so each test starts from its own seeds, independent of
    // file order.
    await db().batch([
      db().prepare("DELETE FROM container_snapshot"),
      db().prepare("DELETE FROM address_snapshot"),
      db().prepare("DELETE FROM customer_snapshot")
    ]);
  });

  afterEach(() => {
    console.log = realConsoleLog;
    globalThis.fetch = originalFetch;
  });

  it("per-table syncs answer 200, land D1 rows, and never touch R2", async () => {
    // Arrange — a stale customer row the reconcile step must delete.
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
      )
      .run();

    // Act — customer first: address rows point at these customers.
    const customer = await postSync("/api/v1/customer-snapshot/sync");

    // Assert — exact reconciling body, rows landed, R2 untouched, reason logged.
    expect(customer.status).toBe(200);
    expect(customer.body).toEqual({
      upserted: 2,
      rowCount: 2,
      deleted: 1,
      r2: { status: "disabled", reason: "SNAPSHOTS_R2_ENABLED=false" }
    });
    const customers = await db()
      .prepare("SELECT customer_id, company_name FROM customer_snapshot ORDER BY customer_id")
      .all<{ customer_id: number; company_name: string }>();
    expect(customers.results).toEqual([
      { customer_id: 101, company_name: "Acme Corp" },
      { customer_id: 102, company_name: "Beta LLC" }
    ]);
    await expectR2Untouched();
    expectDisabledLogged("customer");

    // Act — address second: customer_id FKs now exist.
    const address = await postSync("/api/v1/address-snapshot/sync");

    // Assert
    expect(address.status).toBe(200);
    expect(address.body).toEqual({
      upserted: 2,
      rowCount: 2,
      deleted: 0,
      r2: { status: "disabled", reason: "SNAPSHOTS_R2_ENABLED=false" }
    });
    const addresses = await db()
      .prepare(
        "SELECT pickup_address_id, customer_id, address FROM address_snapshot ORDER BY pickup_address_id"
      )
      .all<{ pickup_address_id: number; customer_id: number; address: string }>();
    expect(addresses.results).toEqual([
      { pickup_address_id: 201, customer_id: 101, address: "201 Main St" },
      { pickup_address_id: 202, customer_id: 102, address: "202 Main St" }
    ]);
    await expectR2Untouched();
    expectDisabledLogged("address");

    // Act — container last: pickup_address_id FKs now exist.
    const container = await postSync("/api/v1/container-snapshot/sync");

    // Assert
    expect(container.status).toBe(200);
    expect(container.body).toEqual({
      upserted: 2,
      rowCount: 2,
      deleted: 0,
      r2: { status: "disabled", reason: "SNAPSHOTS_R2_ENABLED=false" }
    });
    const containers = await db()
      .prepare(
        `SELECT c.container_id, c.pickup_address_id, c.serial_number, a.customer_id
         FROM container_snapshot c JOIN address_snapshot a
           ON a.pickup_address_id = c.pickup_address_id
         ORDER BY c.container_id`
      )
      .all<{
        container_id: number;
        pickup_address_id: number;
        serial_number: string;
        customer_id: number;
      }>();
    expect(containers.results).toEqual([
      { container_id: 301, pickup_address_id: 201, serial_number: "SN-301", customer_id: 101 },
      { container_id: 302, pickup_address_id: 202, serial_number: "SN-302", customer_id: 102 }
    ]);
    await expectR2Untouched();
    expectDisabledLogged("container");
  });

  it("combined data-snapshot/sync answers 200, lands all three tables, and never touches R2", async () => {
    // Act — the chained per-table path production cron uses: customer → address →
    // container as subrequests in FK order, each under the R2-disabled env.
    const res = await app.fetch(
      new Request("http://test.local/api/v1/data-snapshot/sync", {
        method: "POST",
        headers: { authorization: `Bearer ${SYNC_SECRET}` }
      }),
      r2DisabledEnv(),
      CTX
    );

    // Assert — exact combined body: per-table `{upserted, rowCount}` only, no
    // `deleted` leak (the combined-shape contract); each table holds its rows.
    expect(res.status).toBe(200);
    const summary = (await res.json()) as CombinedSummary;
    expect(summary).toEqual({
      customer: { upserted: 2, rowCount: 2 },
      address: { upserted: 2, rowCount: 2 },
      container: { upserted: 2, rowCount: 2 }
    });
    for (const table of [
      "customer_snapshot",
      "address_snapshot",
      "container_snapshot"
    ] as const) {
      const n = await db()
        .prepare(`SELECT COUNT(*) as n FROM ${table}`)
        .first<{ n: number }>();
      expect(n?.n, `${table} holds exactly the synced rows`).toBe(2);
    }
    await expectR2Untouched();
    expectDisabledLogged("customer");
    expectDisabledLogged("address");
    expectDisabledLogged("container");
  });
});
