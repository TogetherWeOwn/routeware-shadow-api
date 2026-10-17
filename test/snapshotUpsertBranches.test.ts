import { describe, expect, it } from "vitest";

import type { AddressSnapshotRow } from "../src/lib/csvAddressSnapshot";
import type { ContainerSnapshotRow } from "../src/lib/csvContainerSnapshot";
import type { CustomerSnapshotRow } from "../src/lib/csvCustomerSnapshot";
import {
  countStaleRows,
  countWouldDeleteStale,
  SnapshotForeignKeyError,
  upsertAddressSnapshotRows,
  upsertContainerSnapshotRows,
  upsertCustomerSnapshotRows
} from "../src/lib/snapshot/upsert";
import { recordingDb } from "./snapshotDbFake";
import type { Recorded } from "./snapshotDbFake";

/**
 * Close the `src/lib/snapshot/upsert.ts` branch gaps (63.8% at
 * baseline). Every test below targets a branch the suite never took:
 * default `batchSize`/`syncedAt`, non-`Error` D1 failures (`String(e)`),
 * the missing-parent fallback (`missing : distinct`), the
 * `res.results ?? []` shape, the null-count `?? 0`s, the empty-`seenKeys`
 * early return, and the container parent-lookup-failure path.
 *
 * Tests only — no production-code change. The one branch left uncovered is
 * the empty-`keys` early return in `missingParentKeys`: every upsert chunk
 * holds at least one row, so `distinct` can never be empty through the
 * module's public functions.
 */

const SYNCED_AT = "2026-08-07T00:00:00.000Z";
const FK_MESSAGE = "D1_ERROR: FOREIGN KEY constraint failed";

function customerRow(id: number): CustomerSnapshotRow {
  return {
    customerId: id,
    customerTypeId: null,
    companyName: `Co ${id}`,
    firstName: null,
    middleInitial: null,
    lastName: null,
    nameSuffix: null,
    customerNumber: null,
    subCustomerNumber: null,
    phone1: null,
    phone2: null,
    comments: null,
    enabled: true
  };
}

function addressRow(id: number, customerId = 1): AddressSnapshotRow {
  return {
    pickupAddressId: id,
    customerId,
    routeId: null,
    address: `${id} Main St`,
    city: null,
    state: null,
    zip: null,
    franchiseId: null,
    comments: null,
    extrasAllowed: false,
    enabled: true,
    driverNote: null,
    latitude: null,
    longitude: null,
    lastAuditDate: null
  };
}

function containerRow(id: number, pickupAddressId = 1): ContainerSnapshotRow {
  return {
    containerId: id,
    pickupAddressId,
    containerTypeId: null,
    serialNumber: null,
    rfid: null,
    onCall: false,
    eventCode: null,
    gpsLocked: false,
    latitude: null,
    longitude: null,
    enabled: true,
    locationAddress: null,
    city: null,
    state: null,
    zip: null,
    containerNote: null,
    udCostShareUd: null,
    udEnclosureDoorsUd: null,
    udLastCompactorInspectionUd: null,
    udLastEnclosureInspectionUd: null,
    udMaterialStreamUd: null,
    color: null,
    serviceCodeType: null,
    serviceCodeInput: null,
    serviceCode: null,
    serviceDate: null,
    routeIds: null,
    frequencyIds: null
  };
}

/** Minimal D1 double whose `batch()` throws a caller-chosen value. */
function throwingBatchDb(throwWith: unknown, allValue: unknown = { results: [] }) {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return allValue;
            },
            async first() {
              return { n: 0 };
            },
            async run() {
              return { meta: {} };
            }
          };
        }
      };
    },
    async batch() {
      throw throwWith;
    }
  };
  return db as unknown as D1Database;
}

/** Minimal D1 double whose `first()` resolves `null` (no count row). */
function nullFirstDb() {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: [] };
            },
            async first() {
              return null;
            },
            async run() {
              return { meta: {} };
            }
          };
        }
      };
    },
    async batch() {
      return [];
    }
  };
  return db as unknown as D1Database;
}

/**
 * Every `*Bindings` row trails with its `syncedAt` bind, so the trailing
 * bind of each bound row across these statements is the default timestamp.
 * `rowWidth` is read off the single-row batch (one row per statement there)
 * instead of hardcoding the field count.
 */
function defaultSyncedAts(batches: Recorded[][], rowWidth: number): unknown[] {
  return batches
    .flat()
    .flatMap((s) => s.binds.filter((_, i) => (i + 1) % rowWidth === 0));
}

function expectSingleIsoTimestamp(synced: unknown[], rowCount: number) {
  expect(synced).toHaveLength(rowCount);
  expect(new Set(synced).size).toBe(1);
  for (const stamp of synced) {
    expect(typeof stamp).toBe("string");
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(stamp as string))).toBe(false);
  }
}

describe("upsert default batchSize/syncedAt", () => {
  it("upserts customers without explicit batchSize or syncedAt", async () => {
    // Arrange — 81 rows exceeds the default customer batchSize of 80, so
    // the chunking default is observable as two batches.
    const { db, batches } = recordingDb();
    const rows = Array.from({ length: 81 }, (_, i) => customerRow(i + 1));

    // Act — defaults are 80 rows per batch with a fresh timestamp.
    const result = await upsertCustomerSnapshotRows(db, rows);

    // Assert
    expect(result).toEqual({ upserted: 81 });
    expect(batches).toHaveLength(2);
    const rowWidth = batches[1][0].binds.length;
    const firstBatchRows = batches[0].reduce((n, s) => n + s.binds.length / rowWidth, 0);
    expect(firstBatchRows).toBe(80);
    expectSingleIsoTimestamp(defaultSyncedAts(batches, rowWidth), 81);
  });

  it("upserts addresses without explicit batchSize or syncedAt", async () => {
    // Arrange — 81 rows exceeds the default address batchSize of 80.
    const { db, batches } = recordingDb();
    const rows = Array.from({ length: 81 }, (_, i) => addressRow(i + 1));

    // Act
    const result = await upsertAddressSnapshotRows(db, rows);

    // Assert
    expect(result).toEqual({ upserted: 81 });
    expect(batches).toHaveLength(2);
    const rowWidth = batches[1][0].binds.length;
    const firstBatchRows = batches[0].reduce((n, s) => n + s.binds.length / rowWidth, 0);
    expect(firstBatchRows).toBe(80);
    expectSingleIsoTimestamp(defaultSyncedAts(batches, rowWidth), 81);
  });

  it("upserts containers without explicit batchSize or syncedAt", async () => {
    // Arrange — 51 rows exceeds the default container batchSize of 50.
    const { db, batches } = recordingDb();
    const rows = Array.from({ length: 51 }, (_, i) => containerRow(i + 1));

    // Act
    const result = await upsertContainerSnapshotRows(db, rows);

    // Assert
    expect(result).toEqual({ upserted: 51 });
    expect(batches).toHaveLength(2);
    const rowWidth = batches[1][0].binds.length;
    const firstBatchRows = batches[0].reduce((n, s) => n + s.binds.length / rowWidth, 0);
    expect(firstBatchRows).toBe(50);
    expectSingleIsoTimestamp(defaultSyncedAts(batches, rowWidth), 51);
  });
});

describe("upsert non-Error D1 failures", () => {
  it("maps a thrown string into the generic customer batch error", async () => {
    // Arrange — D1 drivers reject with `Error`, but the catch handles any
    // thrown value via `String(e)`.
    const db = throwingBatchDb("D1_ERROR: too many SQL variables");

    // Act
    const error = (await upsertCustomerSnapshotRows(
      db,
      [customerRow(1)],
      80,
      SYNCED_AT
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).not.toBeInstanceOf(SnapshotForeignKeyError);
    expect(error.message).toBe(
      "D1 customer_snapshot batch at row offset 0 (1 rows, 1 SQL ops): D1_ERROR: too many SQL variables"
    );
  });

  it("treats a thrown non-FK string as a generic address batch error", async () => {
    // Arrange — a bare string walks the FK cause scan as a string message
    // (not an `Error`), finds no FK text, and breaks out of the scan.
    const db = throwingBatchDb("D1_ERROR: too many SQL variables");

    // Act
    const error = (await upsertAddressSnapshotRows(
      db,
      [addressRow(1)],
      80,
      SYNCED_AT
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).not.toBeInstanceOf(SnapshotForeignKeyError);
    expect(error.message).toBe(
      "D1 address_snapshot batch at row offset 0 (1 rows, 1 SQL ops): D1_ERROR: too many SQL variables"
    );
  });

  it("maps a thrown FK string into the foreign-key error", async () => {
    // Arrange — a bare string carrying FK text walks the cause scan as a
    // string message (not an `Error`) and matches the FK detector.
    const db = throwingBatchDb(FK_MESSAGE, {});

    // Act
    const error = (await upsertAddressSnapshotRows(
      db,
      [{ ...addressRow(1), customerId: 999 }],
      80,
      SYNCED_AT
    ).catch((e: unknown) => e)) as SnapshotForeignKeyError;

    // Assert
    expect(error).toBeInstanceOf(SnapshotForeignKeyError);
    expect(error.missingKeys).toEqual([999]);
  });

  it("treats a thrown plain object as a generic address batch error", async () => {
    // Arrange — neither an `Error` nor a string, so the FK cause scan
    // reads no message off it and falls through to the generic error.
    const db = throwingBatchDb({ code: "D1_BUSY" });

    // Act
    const error = (await upsertAddressSnapshotRows(
      db,
      [addressRow(1)],
      80,
      SYNCED_AT
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).not.toBeInstanceOf(SnapshotForeignKeyError);
    expect(error.message).toContain("D1 address_snapshot batch at row offset 0");
  });

  it("treats a thrown non-FK string as a generic container batch error", async () => {
    // Arrange
    const db = throwingBatchDb("D1_ERROR: too many SQL variables");

    // Act
    const error = (await upsertContainerSnapshotRows(
      db,
      [containerRow(1)],
      50,
      SYNCED_AT
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).not.toBeInstanceOf(SnapshotForeignKeyError);
    expect(error.message).toBe(
      "D1 container_snapshot batch at row offset 0 (1 rows, 1 SQL ops): D1_ERROR: too many SQL variables"
    );
  });
});

describe("upsert FK parent-lookup branches", () => {
  it("falls back to the full distinct set when every parent row exists", async () => {
    // Arrange — the batch failed on an FK, but by lookup time every parent
    // has landed, so the diff is empty and the error names the whole
    // distinct set rather than an empty list.
    const { db, selects } = recordingDb({
      failFromBatch: 0,
      failMessage: FK_MESSAGE,
      allResults: [{ customer_id: 5 }, { customer_id: 7 }]
    });
    const rows = [addressRow(1, 7), addressRow(2, 5), addressRow(3, 7)];

    // Act
    const error = (await upsertAddressSnapshotRows(db, rows, 80, SYNCED_AT).catch(
      (e: unknown) => e
    )) as SnapshotForeignKeyError;

    // Assert
    expect(error).toBeInstanceOf(SnapshotForeignKeyError);
    expect(error.missingKeys).toEqual([5, 7]);
    expect(selects[0].binds).toEqual([5, 7]);
  });

  it("names keys when the parent lookup returns no results shape", async () => {
    // Arrange — `all()` resolves `{}` (no `results` key), so the lookup
    // falls back to `?? []` and every distinct key counts as missing.
    const db = throwingBatchDb(new Error(FK_MESSAGE), {});

    // Act
    const error = (await upsertAddressSnapshotRows(
      db,
      [{ ...addressRow(1), customerId: 999 }],
      80,
      SYNCED_AT
    ).catch((e: unknown) => e)) as SnapshotForeignKeyError;

    // Assert
    expect(error).toBeInstanceOf(SnapshotForeignKeyError);
    expect(error.missingKeys).toEqual([999]);
  });

  it("keeps the generic container batch error when the parent lookup fails", async () => {
    // Arrange — the address path pins this; the container path had no such test.
    const { db } = recordingDb({
      failFromBatch: 0,
      failMessage: FK_MESSAGE,
      failAll: true
    });

    // Act
    const error = (await upsertContainerSnapshotRows(
      db,
      [{ ...containerRow(1), pickupAddressId: 999 }],
      50,
      SYNCED_AT
    ).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).not.toBeInstanceOf(SnapshotForeignKeyError);
    expect(error.message).toContain("D1 container_snapshot batch at row offset 0");
  });
});

describe("stale-row count helpers", () => {
  it("reports zero when D1 returns no count row", async () => {
    // Arrange
    const db = nullFirstDb();

    // Act
    const stale = await countStaleRows(db, "customer_snapshot", SYNCED_AT);

    // Assert
    expect(stale).toBe(0);
  });

  it("returns the total stale count when no keys were seen", async () => {
    // Arrange — an empty import sees nothing, so nothing was refreshed.
    const { db, selects } = recordingDb({ firstCounts: [5] });

    // Act
    const wouldDelete = await countWouldDeleteStale(
      db,
      "customer_snapshot",
      "customer_id",
      SYNCED_AT,
      []
    );

    // Assert
    expect(wouldDelete).toBe(5);
    // One total-stale SELECT, no per-chunk counts.
    expect(selects).toHaveLength(1);
  });

  it("counts read-only when the count rows are null", async () => {
    // Arrange
    const db = nullFirstDb();

    // Act
    const wouldDelete = await countWouldDeleteStale(
      db,
      "customer_snapshot",
      "customer_id",
      SYNCED_AT,
      [1, 2]
    );

    // Assert
    expect(wouldDelete).toBe(0);
  });
});
