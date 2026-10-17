import { beforeAll, describe, expect, it } from "vitest";

/**
 * A snapshot import whose rows reference missing parents must 400,
 * not 500.
 *
 * D1 enforces the snapshot FK chain (`address.customer_id` →
 * `customer_snapshot`, `container.pickup_address_id` → `address_snapshot`)
 * unconditionally, so `upsert*SnapshotRows` (`src/lib/snapshot/upsert.ts`)
 * throws a typed `SnapshotForeignKeyError` (missing integer keys only — no
 * PII, no secrets) and the address/container import handlers
 * (`src/routes/addressSnapshot.ts`, `src/routes/containerSnapshot.ts`) map it
 * to 400 `bad-request` problem+json via the shared `foreignKeyProblem()`
 * helper (`src/routes/shared.ts`) — same mapping the `.../sync` handlers use.
 *
 * What this file proves, against the REAL D1 in the workerd pool (not a
 * fake), through the real route modules (migrated via `./d1TestMigrations`):
 *
 * - an address import with a dangling `customer_id` 400s with a detail naming
 *   the table, the column and the missing key;
 * - a container import with a dangling `pickup_address_id` does the same;
 * - the failing batch lands nothing, while earlier batches in the same file
 *   still land (batch atomicity, per `docs/BACKFILL-RUNBOOK.md` §5).
 *
 * The route modules are fetched directly rather than through `src/app.ts`
 * (the `test/snapshotRoutes.test.ts` pattern), allowing each test to supply
 * the real pool `CUSTOMER_DB` with the pool's own sync secret.
 *
 * Synthetic ids only (9xxx/2xxx/3xxx ranges, distinct per test — the file
 * shares one D1, top-to-bottom). Deliberately does NOT assert problem+json
 * wording owned by `test/snapshotAuth.test.ts`, nor the happy-path summary
 * shape owned by `test/syncSummaryContract.test.ts`.
 */

import { env } from "cloudflare:workers";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import { SnapshotForeignKeyError } from "../src/lib/snapshot/upsert";
import { addressSnapshotRoutes } from "../src/routes/addressSnapshot";
import { containerSnapshotRoutes } from "../src/routes/containerSnapshot";
import { foreignKeyProblem } from "../src/routes/shared";
import { ensureD1TestTables } from "./d1TestMigrations";

const BAD_REQUEST_TYPE = `${PROBLEM_TYPE_BASE}bad-request`;
const PROBLEM_JSON = "application/problem+json";

const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";
const CONTAINER_HEADER =
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote,UD-Cost_Share-UD,UD-Enclosure_Doors-UD,UD-Last_Compactor_Inspection-UD,UD-Last_Enclosure_Inspection-UD,UD-Material_Stream-UD,Color,ServiceCodeType,ServiceCode_input,ServiceCode,ServiceDate,RouteIDs,FrequencyIDs";

function addressRow(pickupId: number, customerId: number): string {
  return `${pickupId},${customerId},,${pickupId} Test St,Killeen,TX,76541,,,false,true,,,,`;
}

function containerRow(containerId: number, pickupId: number): string {
  return (
    `${containerId},${pickupId},,SN-${containerId},,false,,false,,,true,` +
    `${pickupId} Test St,Killeen,TX,76541,,,,,,,,,,,,,`
  );
}

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

/** The pool's own sync secret — matches the inner gate in every environment. */
function syncSecret(): string {
  return (env as unknown as { CUSTOMER_SNAPSHOT_SYNC_SECRET: string })
    .CUSTOMER_SNAPSHOT_SYNC_SECRET;
}

type RouteModule = typeof addressSnapshotRoutes;

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
};

async function importCsv(
  routes: RouteModule,
  path: string,
  csv: string
): Promise<{ status: number; contentType: string | null; body: ProblemBody }> {
  const requestEnv = {
    CUSTOMER_DB: db(),
    CUSTOMER_SNAPSHOT_SYNC_SECRET: syncSecret()
  } as unknown as Env;
  const ctx = {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  const resp = await routes.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${syncSecret()}`,
        "content-type": "text/csv"
      },
      body: csv
    }),
    requestEnv,
    ctx
  );
  const body = (await resp.json()) as ProblemBody;
  return { status: resp.status, contentType: resp.headers.get("content-type"), body };
}

describe("snapshot import dangling-FK mapping", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  it("address import with a dangling customer_id 400s naming table, column and key", async () => {
    // Arrange — parent 9001 exists; 9999 never will.
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (9001, 'FK Parent 9001', 1, '2026-09-27T00:00:00.000Z')"
      )
      .run();
    const csv = [ADDRESS_HEADER, addressRow(2901, 9999)].join("\n");

    // Act
    const res = await importCsv(addressSnapshotRoutes, "/api/v1/address-snapshot/import", csv);

    // Assert
    expect(res.status).toBe(400);
    expect(res.contentType).toContain(PROBLEM_JSON);
    expect(res.body.type).toBe(BAD_REQUEST_TYPE);
    expect(res.body.title).toBe("Bad Request");
    expect(res.body.detail).toBe(
      "Dangling reference: address_snapshot.customer_id=9999 has no row in " +
        "customer_snapshot.customer_id (batch at row offset 0). " +
        "Import customers first. See docs/PROBLEMS.md#bad-request."
    );
    // Assert — the failing batch landed nothing.
    const written = await db()
      .prepare("SELECT pickup_address_id FROM address_snapshot WHERE pickup_address_id = 2901")
      .first<{ pickup_address_id: number }>();
    expect(written).toBeNull();
  });

  it("container import with a dangling pickup_address_id 400s naming table and key", async () => {
    // Arrange — the address parent chain exists for 2998 (customer 9002 →
    // address 2998); 2999 is dangling.
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (9002, 'FK Parent 9002', 1, '2026-09-27T00:00:00.000Z')"
      )
      .run();
    await db()
      .prepare(
        "INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (2998, 9002, 1, '2026-09-27T00:00:00.000Z')"
      )
      .run();
    const csv = [CONTAINER_HEADER, containerRow(3901, 2999)].join("\n");

    // Act
    const res = await importCsv(
      containerSnapshotRoutes,
      "/api/v1/container-snapshot/import",
      csv
    );

    // Assert
    expect(res.status).toBe(400);
    expect(res.contentType).toContain(PROBLEM_JSON);
    expect(res.body.type).toBe(BAD_REQUEST_TYPE);
    expect(res.body.detail).toContain("container_snapshot.pickup_address_id=2999");
    expect(res.body.detail).toContain("address_snapshot.pickup_address_id");
    expect(res.body.detail).toContain("Import addresses first.");
    const written = await db()
      .prepare("SELECT container_id FROM container_snapshot WHERE container_id = 3901")
      .first<{ container_id: number }>();
    expect(written).toBeNull();
  });

  it("an earlier good batch still lands when a later batch dangles", async () => {
    // Arrange — the stream batch size is fixed at 80, so 81 rows force two
    // stream batches, each its own upsert call: rows 3001..3080 reference the
    // seeded parent 9003, row 3100 dangles on 9999. The reported offset is
    // relative to the failing upsert call (as with the generic batch error),
    // so the second stream batch reports offset 0.
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (9003, 'FK Parent 9003', 1, '2026-09-27T00:00:00.000Z')"
      )
      .run();
    const good = Array.from({ length: 80 }, (_, i) => addressRow(3001 + i, 9003));
    const csv = [ADDRESS_HEADER, ...good, addressRow(3100, 9999)].join("\n");

    // Act
    const res = await importCsv(addressSnapshotRoutes, "/api/v1/address-snapshot/import", csv);

    // Assert — 400 naming the dangling key…
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("address_snapshot.customer_id=9999");
    expect(res.body.detail).toContain("batch at row offset 0");
    // …but the first batch landed.
    const n = await db()
      .prepare(
        "SELECT COUNT(*) as n FROM address_snapshot WHERE pickup_address_id >= 3001 AND pickup_address_id < 3081"
      )
      .first<{ n: number }>();
    expect(n?.n).toBe(80);
    const bad = await db()
      .prepare("SELECT pickup_address_id FROM address_snapshot WHERE pickup_address_id = 3100")
      .first<{ pickup_address_id: number }>();
    expect(bad).toBeNull();
  });
});

describe("foreignKeyProblem helper", () => {
  function fkError(missingKeys: number[]): SnapshotForeignKeyError {
    return new SnapshotForeignKeyError(
      {
        table: "address_snapshot",
        column: "customer_id",
        parentTable: "customer_snapshot",
        missingKeys,
        rowOffset: 4
      },
      { cause: new Error("D1_ERROR: FOREIGN KEY constraint failed") }
    );
  }

  it("maps a [step]-wrapped FK error (the sync path) to 400", async () => {
    // Arrange — orchestration.ts wraps step failures as `[step] msg` with
    // `cause`; the .../sync handlers must still find the typed error.
    const wrapped = new Error("[address snapshot] Dangling reference", {
      cause: fkError([999])
    });

    // Act
    const res = foreignKeyProblem(wrapped);

    // Assert
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(body.detail).toContain("address_snapshot.customer_id=999");
  });

  it("lists up to 20 keys, then +N more", async () => {
    // Arrange
    const keys = Array.from({ length: 25 }, (_, i) => i + 1);

    // Act
    const res = foreignKeyProblem(fkError(keys));

    // Assert — integer keys only, first 20 named, remainder counted.
    const body = (await res?.json()) as ProblemBody;
    expect(body.detail).toContain(
      "address_snapshot.customer_id=1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 +5 more"
    );
    expect(body.detail).not.toContain("21,");
  });

  it("returns null for a non-FK error so the caller keeps the generic path", () => {
    // Arrange / Act / Assert
    expect(foreignKeyProblem(new Error("D1_ERROR: too many SQL variables"))).toBeNull();
    expect(foreignKeyProblem(null)).toBeNull();
  });
});
