import { describe, expect, it } from "vitest";

import type { AddressSnapshotRow } from "../src/lib/csvAddressSnapshot";
import type { ContainerSnapshotRow } from "../src/lib/csvContainerSnapshot";
import type { CustomerSnapshotRow } from "../src/lib/csvCustomerSnapshot";
import {
  ADDR_R_PER_STMT,
  CONT_R_PER_STMT,
  CUST_R_PER_STMT,
  addressBindings,
  addressMultiInsertSql,
  containerBindings,
  containerMultiInsertSql,
  customerBindings,
  customerMultiInsertSql
} from "../src/lib/snapshot/tableSql";
import {
  reconcileDeleteStale,
  upsertAddressSnapshotRows,
  upsertContainerSnapshotRows,
  upsertCustomerSnapshotRows
} from "../src/lib/snapshot/upsert";
import { recordingDb } from "./snapshotDbFake";

/**
 * `src/lib/snapshot/upsert.ts` and `tableSql.ts` are what the daily cron writes
 * customer PII to D1 with, and both were at 0% coverage.
 *
 * The invariants pinned here are the ones that fail *silently in production*:
 *
 * 1. Column list, placeholder count, and binding count must agree. Adding a
 *    column to a header without updating the matching `*Bindings` (or the
 *    `*_NCOLS` the rows-per-statement is derived from) produces SQL that D1
 *    rejects at runtime — during an unattended cron run, not at build time.
 * 2. Rows-per-statement × bindings-per-row must stay within D1's 100 bound
 *    parameter ceiling. Widening a table silently pushes a statement over it.
 * 3. The batch error must name the row offset and preserve `cause`, because a
 *    mid-sync D1 failure is otherwise unattributable across ~609k rows.
 */

/** D1 allows at most 100 bound parameters per query (see D1 platform limits). */
const D1_MAX_BINDS = 100;
const SYNCED_AT = "2026-08-07T00:00:00.000Z";
const CUST_NCOLS = 14;

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

function addressRow(id: number): AddressSnapshotRow {
  return {
    pickupAddressId: id,
    customerId: 1,
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

function containerRow(id: number): ContainerSnapshotRow {
  return {
    containerId: id,
    pickupAddressId: 1,
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

/** Column names between `INSERT INTO <table> (` and `) VALUES`. */
function columnsOf(sql: string): string[] {
  return sql
    .slice(sql.indexOf("(") + 1, sql.indexOf(") VALUES"))
    .split(",")
    .map((s) => s.trim());
}

function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

const TABLES = [
  {
    name: "customer",
    sqlFor: customerMultiInsertSql,
    binds: customerBindings(customerRow(1), SYNCED_AT),
    rowsPerStmt: CUST_R_PER_STMT
  },
  {
    name: "address",
    sqlFor: addressMultiInsertSql,
    binds: addressBindings(addressRow(1), SYNCED_AT),
    rowsPerStmt: ADDR_R_PER_STMT
  },
  {
    name: "container",
    sqlFor: containerMultiInsertSql,
    binds: containerBindings(containerRow(1), SYNCED_AT),
    rowsPerStmt: CONT_R_PER_STMT
  }
] as const;

describe("tableSql keeps columns, placeholders and bindings in agreement", () => {
  for (const table of TABLES) {
    it(`names exactly one ${table.name}_snapshot column per bound value`, () => {
      // Arrange / Act
      const columns = columnsOf(table.sqlFor(1));

      // Assert — drift here means the INSERT is malformed at runtime.
      expect(columns).toHaveLength(table.binds.length);
    });

    it(`emits one ${table.name} placeholder per bound value per row`, () => {
      // Arrange / Act
      const sql = table.sqlFor(3);

      // Assert
      expect(placeholderCount(sql)).toBe(table.binds.length * 3);
    });

    it(`keeps a full ${table.name} statement within D1's bound-parameter ceiling`, () => {
      // Arrange / Act
      const bindsPerFullStatement = table.rowsPerStmt * table.binds.length;

      // Assert
      expect(bindsPerFullStatement).toBeLessThanOrEqual(D1_MAX_BINDS);
      expect(table.rowsPerStmt).toBeGreaterThan(0);
    });

    it(`ends every ${table.name} binding row with synced_at`, () => {
      // Arrange / Act / Assert — synced_at is last in the column list, and the
      // reconcile step deletes on it, so a misplaced value deletes live rows.
      expect(columnsOf(table.sqlFor(1)).at(-1)).toBe("synced_at");
      expect(table.binds.at(-1)).toBe(SYNCED_AT);
    });
  }
});

describe("upsertCustomerSnapshotRows", () => {
  it("packs rows into statements of CUST_R_PER_STMT and reports every row upserted", async () => {
    // Arrange — one batch, deliberately not a multiple of the rows per statement.
    const { db, batches } = recordingDb();
    const rows = Array.from({ length: 16 }, (_, i) => customerRow(i + 1));

    // Act
    const result = await upsertCustomerSnapshotRows(db, rows, 16, SYNCED_AT);

    // Assert
    expect(result).toEqual({ upserted: 16 });
    expect(batches).toHaveLength(1);
    const perStatementRows = batches[0].map((s) => s.binds.length / CUST_NCOLS);
    expect(perStatementRows).toEqual([CUST_R_PER_STMT, CUST_R_PER_STMT, 16 - 2 * CUST_R_PER_STMT]);
  });

  it("splits rows across batches of batchSize", async () => {
    // Arrange
    const { db, batches } = recordingDb();
    const rows = Array.from({ length: 10 }, (_, i) => customerRow(i + 1));

    // Act
    const result = await upsertCustomerSnapshotRows(db, rows, 4, SYNCED_AT);

    // Assert — 4 + 4 + 2.
    expect(result).toEqual({ upserted: 10 });
    expect(batches).toHaveLength(3);
    const rowsPerBatch = batches.map((b) =>
      b.reduce((n, s) => n + s.binds.length / CUST_NCOLS, 0)
    );
    expect(rowsPerBatch).toEqual([4, 4, 2]);
  });

  it("binds every row exactly once and in order", async () => {
    // Arrange
    const { db, batches } = recordingDb();
    const rows = Array.from({ length: 9 }, (_, i) => customerRow(i + 1));

    // Act
    await upsertCustomerSnapshotRows(db, rows, 80, SYNCED_AT);

    // Assert — the customer_id is the first binding of each row group.
    const flat = batches.flat().flatMap((s) => s.binds);
    const ids = flat.filter((_, i) => i % CUST_NCOLS === 0);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("does not touch the database when there are no rows", async () => {
    // Arrange
    const { db, batches } = recordingDb();

    // Act
    const result = await upsertCustomerSnapshotRows(db, [], 80, SYNCED_AT);

    // Assert
    expect(result).toEqual({ upserted: 0 });
    expect(batches).toEqual([]);
  });

  it("reports the failing row offset, batch size and op count, preserving the cause", async () => {
    // Arrange — succeed on the first batch, fail on the second, so the offset
    // under test is non-zero and cannot be a hard-coded 0.
    const { db } = recordingDb({ failFromBatch: 1 });
    const rows = Array.from({ length: 10 }, (_, i) => customerRow(i + 1));

    // Act
    const error = (await upsertCustomerSnapshotRows(db, rows, 4, SYNCED_AT).catch(
      (e: unknown) => e
    )) as Error & { cause?: unknown };

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "D1 customer_snapshot batch at row offset 4 (4 rows, 1 SQL ops): D1_ERROR: too many SQL variables"
    );
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe("upsertAddressSnapshotRows and upsertContainerSnapshotRows", () => {
  it("packs address rows into statements of ADDR_R_PER_STMT", async () => {
    // Arrange
    const { db, batches } = recordingDb();
    const rows = Array.from({ length: ADDR_R_PER_STMT + 1 }, (_, i) => addressRow(i + 1));

    // Act
    const result = await upsertAddressSnapshotRows(db, rows, 80, SYNCED_AT);

    // Assert
    expect(result).toEqual({ upserted: ADDR_R_PER_STMT + 1 });
    expect(batches[0]).toHaveLength(2);
  });

  it("names the address table in its batch error", async () => {
    // Arrange
    const { db } = recordingDb({ failFromBatch: 0 });

    // Act
    const error = (await upsertAddressSnapshotRows(db, [addressRow(1)], 80, SYNCED_AT).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error.message).toContain(
      "D1 address_snapshot batch at row offset 0 (1 rows, 1 SQL ops)"
    );
  });

  it("packs container rows into statements of CONT_R_PER_STMT", async () => {
    // Arrange
    const { db, batches } = recordingDb();
    const rows = Array.from({ length: CONT_R_PER_STMT + 1 }, (_, i) => containerRow(i + 1));

    // Act
    const result = await upsertContainerSnapshotRows(db, rows, 50, SYNCED_AT);

    // Assert
    expect(result).toEqual({ upserted: CONT_R_PER_STMT + 1 });
    expect(batches[0]).toHaveLength(2);
  });

  it("names the container table in its batch error", async () => {
    // Arrange
    const { db } = recordingDb({ failFromBatch: 0 });

    // Act
    const error = (await upsertContainerSnapshotRows(db, [containerRow(1)], 50, SYNCED_AT).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error.message).toContain(
      "D1 container_snapshot batch at row offset 0 (1 rows, 1 SQL ops)"
    );
  });
});

describe("reconcileDeleteStale", () => {
  it("deletes only rows older than this run's synced_at", async () => {
    // Arrange
    const { db, runs } = recordingDb({ changes: 7 });

    // Act
    const deleted = await reconcileDeleteStale(db, "customer_snapshot", SYNCED_AT);

    // Assert
    expect(deleted).toBe(7);
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toBe("DELETE FROM customer_snapshot WHERE synced_at < ?");
    expect(runs[0].binds).toEqual([SYNCED_AT]);
  });

  it("targets the table it is given", async () => {
    // Arrange
    const { db, runs } = recordingDb({ changes: 0 });

    // Act
    await reconcileDeleteStale(db, "address_snapshot", SYNCED_AT);
    await reconcileDeleteStale(db, "container_snapshot", SYNCED_AT);

    // Assert
    expect(runs.map((r) => r.sql)).toEqual([
      "DELETE FROM address_snapshot WHERE synced_at < ?",
      "DELETE FROM container_snapshot WHERE synced_at < ?"
    ]);
  });

  it("reports zero when D1 omits the changes count", async () => {
    // Arrange — meta.changes absent rather than 0.
    const { db } = recordingDb();

    // Act
    const deleted = await reconcileDeleteStale(db, "customer_snapshot", SYNCED_AT);

    // Assert
    expect(deleted).toBe(0);
  });
});
