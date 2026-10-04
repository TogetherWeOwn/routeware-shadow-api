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

/**
 * `src/lib/snapshot/tableSql.ts` builds the INSERT/UPSERT SQL and row bindings
 * the daily cron writes customer PII to D1 with. `snapshotUpsert.test.ts`
 * pins column/placeholder/binding-count agreement; the invariants pinned here
 * are the ones that corrupt data *silently*:
 *
 * 1. Binding order must match column order exactly. Swapping two bindings of
 *    the same JS type (phone1/phone2, latitude/longitude) keeps every count
 *    green and writes wrong data to every row. Every field below carries a
 *    distinct sentinel so a mis-ordering fails.
 * 2. Booleans must coerce to 1/0. D1 has no boolean column affinity guarantee
 *    here; a raw `true` binds differently than `1`.
 * 3. The UPSERT guard (`ON CONFLICT(pk) ... WHERE <table>.synced_at <=
 *    excluded.synced_at`) is what makes re-syncs last-write-wins instead of
 *    last-write-loses. Dropping the WHERE clause regresses to stale
 *    overwrites with no error.
 */

const SYNCED_AT = "2026-08-07T00:00:00.000Z";

function fullCustomerRow(): CustomerSnapshotRow {
  return {
    customerId: 42,
    customerTypeId: 7,
    companyName: "Acme",
    firstName: "Ada",
    middleInitial: "L",
    lastName: "Lovelace",
    nameSuffix: "Jr",
    customerNumber: "C-1",
    subCustomerNumber: "S-2",
    phone1: "111",
    phone2: "222",
    comments: "note",
    enabled: true
  };
}

function fullAddressRow(): AddressSnapshotRow {
  return {
    pickupAddressId: 11,
    customerId: 42,
    routeId: 5,
    address: "1 Main St",
    city: "Springfield",
    state: "IL",
    zip: "62701",
    franchiseId: "F9",
    comments: "c",
    extrasAllowed: true,
    enabled: false,
    driverNote: "dn",
    latitude: "41.0",
    longitude: "-87.0",
    lastAuditDate: "2026-01-02"
  };
}

function fullContainerRow(): ContainerSnapshotRow {
  return {
    containerId: 101,
    pickupAddressId: 11,
    containerTypeId: 3,
    serialNumber: "SN1",
    rfid: "RF1",
    onCall: true,
    eventCode: "E",
    gpsLocked: false,
    latitude: "41",
    longitude: "-87",
    enabled: true,
    locationAddress: "loc",
    city: "c",
    state: "s",
    zip: "z",
    containerNote: "n",
    udCostShareUd: "u1",
    udEnclosureDoorsUd: "u2",
    udLastCompactorInspectionUd: "u3",
    udLastEnclosureInspectionUd: "u4",
    udMaterialStreamUd: "u5",
    color: "red",
    serviceCodeType: "t",
    serviceCodeInput: "i",
    serviceCode: "sc",
    serviceDate: "2026-03-04",
    routeIds: "r1",
    frequencyIds: "f1"
  };
}

/** Each `(?, ...)` value tuple starts with `(?`, so this counts row tuples. */
function tupleCount(sql: string): number {
  return (sql.match(/\(\?/g) ?? []).length;
}

describe("customerBindings", () => {
  it("emits every field in column order with synced_at last", () => {
    // Arrange / Act
    const binds = customerBindings(fullCustomerRow(), SYNCED_AT);

    // Assert — distinct sentinels: any swap fails.
    expect(binds).toEqual([
      42, 7, "Acme", "Ada", "L", "Lovelace", "Jr", "C-1", "S-2",
      "111", "222", "note", 1, SYNCED_AT
    ]);
  });

  it("coerces enabled true to 1 and false to 0", () => {
    // Arrange / Act / Assert
    expect(customerBindings({ ...fullCustomerRow(), enabled: false }, SYNCED_AT)[12]).toBe(0);
    expect(customerBindings({ ...fullCustomerRow(), enabled: true }, SYNCED_AT)[12]).toBe(1);
  });

  it("passes nulls through unchanged", () => {
    // Arrange — every nullable field null, so positions are still pinned.
    const row: CustomerSnapshotRow = {
      customerId: 1,
      customerTypeId: null,
      companyName: null,
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

    // Act / Assert
    expect(customerBindings(row, SYNCED_AT)).toEqual([
      1, null, null, null, null, null, null, null, null, null, null, null, 1, SYNCED_AT
    ]);
  });
});

describe("addressBindings", () => {
  it("emits every field in column order with synced_at last", () => {
    // Arrange / Act
    const binds = addressBindings(fullAddressRow(), SYNCED_AT);

    // Assert — extrasAllowed true, enabled false: the 1/0 pair pins order.
    expect(binds).toEqual([
      11, 42, 5, "1 Main St", "Springfield", "IL", "62701", "F9", "c",
      1, 0, "dn", "41.0", "-87.0", "2026-01-02", SYNCED_AT
    ]);
  });

  it("coerces each boolean flag independently", () => {
    // Arrange
    const base = fullAddressRow();

    // Act / Assert — index 9 is extras_allowed, index 10 is enabled.
    expect(addressBindings({ ...base, extrasAllowed: false, enabled: false }, SYNCED_AT).slice(9, 11)).toEqual([0, 0]);
    expect(addressBindings({ ...base, extrasAllowed: true, enabled: true }, SYNCED_AT).slice(9, 11)).toEqual([1, 1]);
  });
});

describe("containerBindings", () => {
  it("emits every field in column order with synced_at last", () => {
    // Arrange / Act
    const binds = containerBindings(fullContainerRow(), SYNCED_AT);

    // Assert — 29 columns; onCall 1, gpsLocked 0, enabled 1 pin the flag slots.
    expect(binds).toEqual([
      101, 11, 3, "SN1", "RF1", 1, "E", 0, "41", "-87", 1,
      "loc", "c", "s", "z", "n",
      "u1", "u2", "u3", "u4", "u5",
      "red", "t", "i", "sc", "2026-03-04", "r1", "f1", SYNCED_AT
    ]);
  });

  it("coerces each boolean flag independently", () => {
    // Arrange
    const base = fullContainerRow();

    // Act — indexes 5 (oncall), 7 (gps_locked), 10 (enabled).
    const allFalse = containerBindings(
      { ...base, onCall: false, gpsLocked: false, enabled: false }, SYNCED_AT
    );
    const allTrue = containerBindings(
      { ...base, onCall: true, gpsLocked: true, enabled: true }, SYNCED_AT
    );

    // Assert
    expect([allFalse[5], allFalse[7], allFalse[10]]).toEqual([0, 0, 0]);
    expect([allTrue[5], allTrue[7], allTrue[10]]).toEqual([1, 1, 1]);
  });
});

const SQL_TABLES = [
  {
    name: "customer",
    table: "customer_snapshot",
    conflictKey: "customer_id",
    sqlFor: customerMultiInsertSql,
    rowsPerStmt: CUST_R_PER_STMT,
    expectedRowsPerStmt: 7
  },
  {
    name: "address",
    table: "address_snapshot",
    conflictKey: "pickup_address_id",
    sqlFor: addressMultiInsertSql,
    rowsPerStmt: ADDR_R_PER_STMT,
    expectedRowsPerStmt: 6
  },
  {
    name: "container",
    table: "container_snapshot",
    conflictKey: "container_id",
    sqlFor: containerMultiInsertSql,
    rowsPerStmt: CONT_R_PER_STMT,
    expectedRowsPerStmt: 3
  }
] as const;

describe("multi-insert SQL shape", () => {
  for (const t of SQL_TABLES) {
    it(`inserts into ${t.table} with one tuple per row`, () => {
      // Arrange / Act
      const one = t.sqlFor(1);
      const full = t.sqlFor(t.rowsPerStmt);

      // Assert
      expect(one.startsWith(`INSERT INTO ${t.table} (`)).toBe(true);
      expect(tupleCount(one)).toBe(1);
      expect(tupleCount(full)).toBe(t.rowsPerStmt);
    });

    it(`upserts ${t.name} on ${t.conflictKey} with a synced_at last-write-wins guard`, () => {
      // Arrange / Act
      const sql = t.sqlFor(2);

      // Assert — without the WHERE guard a stale re-sync would clobber fresh rows.
      expect(sql).toContain(`ON CONFLICT(${t.conflictKey}) DO UPDATE SET`);
      expect(sql).toContain(`WHERE ${t.table}.synced_at <= excluded.synced_at`);
      expect(sql).toContain("synced_at = excluded.synced_at");
    });
  }
});

describe("rows-per-statement packing", () => {
  it("packs 7 customer, 6 address and 3 container rows per statement", () => {
    // Arrange / Act / Assert — floor(100 / ncols) capped per table: losing a
    // row here means the D1 100-bind ceiling math drifted.
    expect(CUST_R_PER_STMT).toBe(7);
    expect(ADDR_R_PER_STMT).toBe(6);
    expect(CONT_R_PER_STMT).toBe(3);
  });

  for (const t of SQL_TABLES) {
    it(`derives ${t.name} rows-per-statement from the D1 bind ceiling`, () => {
      // Arrange / Act / Assert
      expect(t.rowsPerStmt).toBe(t.expectedRowsPerStmt);
    });
  }
});
