import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { stringToUint8Stream } from "../src/lib/csvStream";
import {
  archiveReportCsvToR2AfterD1,
  restoreSnapshotCsvFromR2,
  snapshotR2ObjectKey
} from "../src/lib/r2SnapshotArchive";
import {
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * R2 restore drill (TOG-7394): the archive leg (`archiveReportCsvToR2AfterD1`)
 * is write-only by design, and `restoreSnapshotCsvFromR2` is its read-back
 * inverse. This test proves the round trip against the REAL test D1 and the
 * REAL test R2 bucket (same bindings as `test/snapshotSyncE2E.test.ts`):
 * archive → wipe D1 → restore from R2 → re-sync → rows and values match.
 *
 * Minimal fixtures (2 rows per table) keep the drill fast; FK order
 * (customer → address → container) is exercised because D1 enforces it —
 * restoring out of order 400s/fails instead of writing orphans, which is
 * also what the runbook (`docs/R2-RESTORE-RUNBOOK.md`) prescribes.
 */

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
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote",
  "301,201,,SN-301,,false,,false,,,true,201 Main St,Killeen,TX,76541,",
  "302,202,,SN-302,,false,,false,,,true,202 Main St,Killeen,TX,76541,"
].join("\n");

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

function testEnv(): Env {
  return env as unknown as Env;
}

async function count(table: string): Promise<number> {
  const r = await db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).all<{ n: number }>();
  return r.results[0]?.n ?? -1;
}

describe("R2 restore drill", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  it("archive → wipe → restore → re-sync round-trips all three tables", async () => {
    // Arrange — archive all three CSVs through the real archive leg (which
    // also syncs them into D1, exactly like the daily cron).
    const testEnvValue = testEnv();
    await archiveReportCsvToR2AfterD1(testEnvValue, "customer", stringToUint8Stream(CUSTOMER_CSV), (s) =>
      syncCustomerSnapshotFromStream(db(), s)
    );
    await archiveReportCsvToR2AfterD1(testEnvValue, "address", stringToUint8Stream(ADDRESS_CSV), (s) =>
      syncAddressSnapshotFromStream(db(), s)
    );
    await archiveReportCsvToR2AfterD1(testEnvValue, "container", stringToUint8Stream(CONTAINER_CSV), (s) =>
      syncContainerSnapshotFromStream(db(), s)
    );

    // Assert — all three keys landed in R2 under today's prefix.
    const bucket = (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
    const day = new Date().toISOString().slice(0, 10);
    const listed = await bucket.list({ prefix: `snapshots/${day}/` });
    const keys = listed.objects.map((o) => o.key).sort();
    expect(keys).toEqual([
      `snapshots/${day}/address.csv`,
      `snapshots/${day}/container.csv`,
      `snapshots/${day}/customer.csv`
    ]);

    // Arrange — record the archived state, then wipe D1 in reverse FK order.
    const customersBefore = await db()
      .prepare("SELECT customer_id, company_name FROM customer_snapshot ORDER BY customer_id")
      .all<{ customer_id: number; company_name: string }>();
    const addressesBefore = await db()
      .prepare("SELECT pickup_address_id, customer_id, address FROM address_snapshot ORDER BY pickup_address_id")
      .all<{ pickup_address_id: number; customer_id: number; address: string }>();
    const containersBefore = await db()
      .prepare("SELECT container_id, pickup_address_id, serial_number FROM container_snapshot ORDER BY container_id")
      .all<{ container_id: number; pickup_address_id: number; serial_number: string }>();
    expect(customersBefore.results).toHaveLength(2);

    await db().prepare("DELETE FROM container_snapshot").run();
    await db().prepare("DELETE FROM address_snapshot").run();
    await db().prepare("DELETE FROM customer_snapshot").run();
    expect(await count("customer_snapshot")).toBe(0);
    expect(await count("address_snapshot")).toBe(0);
    expect(await count("container_snapshot")).toBe(0);

    // Act — restore each archived CSV from R2 and re-sync into D1 in FK order.
    const customerStream = await restoreSnapshotCsvFromR2(testEnvValue, "customer");
    expect(customerStream).not.toBeNull();
    const customerResult = await syncCustomerSnapshotFromStream(db(), customerStream!);
    expect(customerResult).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });

    const addressStream = await restoreSnapshotCsvFromR2(testEnvValue, "address");
    expect(addressStream).not.toBeNull();
    const addressResult = await syncAddressSnapshotFromStream(db(), addressStream!);
    expect(addressResult).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });

    const containerStream = await restoreSnapshotCsvFromR2(testEnvValue, "container");
    expect(containerStream).not.toBeNull();
    const containerResult = await syncContainerSnapshotFromStream(db(), containerStream!);
    expect(containerResult).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });

    // Assert — row counts AND values match the pre-wipe state.
    const customersAfter = await db()
      .prepare("SELECT customer_id, company_name FROM customer_snapshot ORDER BY customer_id")
      .all<{ customer_id: number; company_name: string }>();
    const addressesAfter = await db()
      .prepare("SELECT pickup_address_id, customer_id, address FROM address_snapshot ORDER BY pickup_address_id")
      .all<{ pickup_address_id: number; customer_id: number; address: string }>();
    const containersAfter = await db()
      .prepare("SELECT container_id, pickup_address_id, serial_number FROM container_snapshot ORDER BY container_id")
      .all<{ container_id: number; pickup_address_id: number; serial_number: string }>();
    expect(customersAfter.results).toEqual(customersBefore.results);
    expect(addressesAfter.results).toEqual(addressesBefore.results);
    expect(containersAfter.results).toEqual(containersBefore.results);
  });

  it("returns null for a date with no archive — absent, not an error", async () => {
    // Arrange — a date that was never archived (keys are per-UTC-date).
    const empty = new Date("2000-01-01T00:00:00.000Z");

    // Act
    const stream = await restoreSnapshotCsvFromR2(testEnv(), "customer", empty);

    // Assert — null, and the key probed is the expected one.
    expect(stream).toBeNull();
    expect(snapshotR2ObjectKey("customer", empty)).toBe("snapshots/2000-01-01/customer.csv");
  });

  it("throws when the archive is disabled — restore cannot proceed unbound", async () => {
    // Arrange — no SNAPSHOTS binding at all.
    const envNoBucket = {} as unknown as Env;

    // Act
    const error = await restoreSnapshotCsvFromR2(envNoBucket, "customer").catch(
      (e: unknown) => e
    );

    // Assert — same disabled-reason wording as the write path.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "R2 snapshot restore unavailable for customer: SNAPSHOTS binding unbound"
    );
  });
});
