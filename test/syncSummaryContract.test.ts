import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isUpstreamUrl } from "./upstreamHost";

/**
 * Sync-summary response contract, hermetic end-to-end.
 *
 * `test/snapshotSyncE2E.test.ts` pins the per-table **sync** bodies
 * (`{upserted, rowCount, deleted}`) through the real routes, but nothing pins
 * the other two halves of the summary contract:
 *
 * 1. the three **import** endpoints (`POST ...-snapshot/import`), whose bodies
 *    must carry `{upserted, rowCount, deleted: 0}` — and, critically, must
 *    never delete: an import is possibly-partial, so the reconcile step stays
 *    off and a pre-existing row absent from the upload must survive; and
 * 2. the **combined** endpoint (`POST /api/v1/data-snapshot/sync`), whose
 *    per-table summaries are `{upserted, rowCount}` only — the `deleted`
 *    counts from the chained per-table syncs must not leak through, and a
 *    table whose subrequest reports `skipped: true` must surface as `null`,
 *    not as a zero-row success.
 *
 * Every assertion below is an exact `toEqual` on the response body through the
 * real app (`exports.default.fetch`) against the real test `CUSTOMER_DB`
 * (migrated via `./d1TestMigrations`): renaming, dropping or retyping a
 * summary field turns the suite red. Only `src/lib/httpAuth` is mocked (same
 * pattern as `snapshotSyncE2E.test.ts`); the fetch stub serves CSV only for
 * `QueryExecuteDownload`, forwards the chained per-table subrequests back
 * into the app, and throws on any other upstream URL.
 *
 * Deliberately does NOT assert problem+json wording — owned by
 * `test/snapshotAuth.test.ts` — nor the R2 archive leg — owned by
 * `test/snapshotSyncE2E.test.ts`.
 */

const httpLoginCalls = { count: 0 };

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    httpLoginCalls.count += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=summary-contract-test-session", Date.now() + 60_000, lockToken);
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

type ImportSummary = { upserted: number; rowCount: number; deleted?: number };
type CombinedSummary = {
  customer: { upserted: number; rowCount: number } | null;
  address: { upserted: number; rowCount: number } | null;
  container: { upserted: number; rowCount: number } | null;
};

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

async function importCsv(
  path: string,
  csv: string
): Promise<{ status: number; body: ImportSummary }> {
  const resp = await exports.default.fetch(`http://test.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SYNC_SECRET}`,
      "content-type": "text/csv"
    },
    body: csv
  });
  const body = (await resp.json()) as ImportSummary;
  return { status: resp.status, body };
}

async function combinedSync(): Promise<{ status: number; body: CombinedSummary }> {
  const resp = await exports.default.fetch("http://test.local/api/v1/data-snapshot/sync", {
    method: "POST",
    headers: { authorization: `Bearer ${SYNC_SECRET}` }
  });
  const body = (await resp.json()) as CombinedSummary;
  return { status: resp.status, body };
}

describe("sync summary contract", () => {
  const originalFetch = globalThis.fetch;
  // First download attempt per report fails with the silent-expiry signal
  // (302 → /Account/Login), so every table exercises the re-auth retry.
  const downloadAttempts = new Map<string, number>();
  // When true, the container chained subrequest answers `skipped: true`
  // without running, pinning the skipped → null mapping end to end.
  const behavior = { containerSkipped: false };

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(() => {
    downloadAttempts.clear();
    behavior.containerSkipped = false;
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
      // Chained per-table subrequests from POST /api/v1/data-snapshot/sync go
      // back into this same Worker (origin http://test.local). Dispatch them
      // in-process through the real app — same routes, same auth gates, same
      // D1 — rather than the network, where `test.local` cannot resolve.
      if (url.startsWith("http://test.local/api/v1/")) {
        if (behavior.containerSkipped && url.endsWith("/container-snapshot/sync")) {
          return new Response(JSON.stringify({ upserted: 0, rowCount: 0, skipped: true }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return exports.default.fetch(url, {
          method: init?.method ?? "GET",
          headers: init?.headers as HeadersInit | undefined
        });
      }
      // Every query-id fetch polls QueryRequestIsComplete before
      // its download. The poll answers complete immediately so the sync keeps
      // exercising the download re-auth retry leg (first download 302s, then
      // CSV).
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
      // Fail loudly on any other upstream URL instead of hitting the network.
      if (isUpstreamUrl(url)) {
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("import endpoints", () => {
    it("customer import pins the exact summary body and writes the rows", async () => {
      // Arrange / Act
      const res = await importCsv("/api/v1/customer-snapshot/import", CUSTOMER_CSV);

      // Assert — `deleted: 0` is part of the contract: imports never
      // reconcile, so the key must be present and zero, not absent.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
      const rows = await db()
        .prepare("SELECT customer_id FROM customer_snapshot ORDER BY customer_id")
        .all<{ customer_id: number }>();
      expect(rows.results).toEqual([{ customer_id: 101 }, { customer_id: 102 }]);
    });

    it("address import pins the exact summary body and writes the rows", async () => {
      // Arrange / Act
      const res = await importCsv("/api/v1/address-snapshot/import", ADDRESS_CSV);

      // Assert
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
      const rows = await db()
        .prepare("SELECT pickup_address_id FROM address_snapshot ORDER BY pickup_address_id")
        .all<{ pickup_address_id: number }>();
      expect(rows.results).toEqual([{ pickup_address_id: 201 }, { pickup_address_id: 202 }]);
    });

    it("container import pins the exact summary body and writes the rows", async () => {
      // Arrange / Act
      const res = await importCsv("/api/v1/container-snapshot/import", CONTAINER_CSV);

      // Assert
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
      const rows = await db()
        .prepare("SELECT container_id FROM container_snapshot ORDER BY container_id")
        .all<{ container_id: number }>();
      expect(rows.results).toEqual([{ container_id: 301 }, { container_id: 302 }]);
    });

    it("imports never delete: rows absent from a partial upload survive on all three tables", async () => {
      // Arrange — stale rows predating the uploads (a partial import must
      // leave every row it did not see alone).
      await db()
        .prepare(
          "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
        )
        .run();
      await db()
        .prepare(
          "INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (999, 101, 1, '2000-01-01T00:00:00.000Z')"
        )
        .run();
      await db()
        .prepare(
          "INSERT INTO container_snapshot (pickup_address_id, container_id, enabled, synced_at) VALUES (201, 999, 1, '2000-01-01T00:00:00.000Z')"
        )
        .run();

      // Act — re-import CSVs that do not contain the stale rows.
      const customer = await importCsv("/api/v1/customer-snapshot/import", CUSTOMER_CSV);
      const address = await importCsv("/api/v1/address-snapshot/import", ADDRESS_CSV);
      const container = await importCsv("/api/v1/container-snapshot/import", CONTAINER_CSV);

      // Assert — zero deletes reported, and the unseen rows are still there.
      expect(customer.body).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
      expect(address.body).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
      expect(container.body).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
      const staleCustomer = await db()
        .prepare("SELECT customer_id FROM customer_snapshot WHERE customer_id = 999")
        .first<{ customer_id: number }>();
      const staleAddress = await db()
        .prepare("SELECT pickup_address_id FROM address_snapshot WHERE pickup_address_id = 999")
        .first<{ pickup_address_id: number }>();
      const staleContainer = await db()
        .prepare("SELECT container_id FROM container_snapshot WHERE container_id = 999")
        .first<{ container_id: number }>();
      expect(staleCustomer).toEqual({ customer_id: 999 });
      expect(staleAddress).toEqual({ pickup_address_id: 999 });
      expect(staleContainer).toEqual({ container_id: 999 });
    });
  });

  describe("combined data-snapshot/sync", () => {
    it("pins the exact per-table summary: upserted + rowCount only, no deleted leak", async () => {
      // Arrange
      httpLoginCalls.count = 0;

      // Act
      const res = await combinedSync();

      // Assert — each table ran its real download (one login per table after
      // the forced 302), and the summary carries exactly the two documented
      // keys: the per-table `deleted` counts must not leak into the combined
      // shape, or a client reading `deleted` would mistake a sync total for
      // an import-style reconcile report.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        customer: { upserted: 2, rowCount: 2 },
        address: { upserted: 2, rowCount: 2 },
        container: { upserted: 2, rowCount: 2 }
      });
      expect(Object.keys(res.body.customer ?? {}).sort()).toEqual(["rowCount", "upserted"]);
      expect(Object.keys(res.body.address ?? {}).sort()).toEqual(["rowCount", "upserted"]);
      expect(Object.keys(res.body.container ?? {}).sort()).toEqual(["rowCount", "upserted"]);
      expect(httpLoginCalls.count).toBe(3);
    });

    it("maps a skipped table to null instead of a zero-row success", async () => {
      // Arrange — the container subrequest reports skipped (unconfigured
      // report path in production); only two downloads run.
      httpLoginCalls.count = 0;
      behavior.containerSkipped = true;

      // Act
      const res = await combinedSync();

      // Assert — `container: null` must survive as null: zeros would read as
      // "synced successfully, upstream is empty" and mask a misconfiguration.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        customer: { upserted: 2, rowCount: 2 },
        address: { upserted: 2, rowCount: 2 },
        container: null
      });
      expect(httpLoginCalls.count).toBe(2);
    });
  });
});
