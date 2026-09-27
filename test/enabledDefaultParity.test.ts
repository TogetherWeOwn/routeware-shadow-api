import { describe, expect, it } from "vitest";

import { parseAddressSnapshotRow } from "../src/lib/csvAddressSnapshot";
import { parseContainerSnapshotRow } from "../src/lib/csvContainerSnapshot";
import { parseCustomerSnapshotRow } from "../src/lib/csvCustomerSnapshot";
import {
  mapCsvHeaders,
  parseBool,
  parseBoolDefaultTrue
} from "../src/lib/csvParse";
import { mapDetailFullToRows } from "../src/lib/detailFullSync";

/**
 * TOG-6542: the same entity flapped disabled/enabled between the cron CSV
 * path and the POST write-through path when `Enabled`/`ExtrasAllowed` were
 * absent. Cron collapses "column absent" and "empty cell" to `""` (via
 * `cell()`), and `parseBool("")` is `false`; write-through
 * (`detailFullSync.ts`) and the D1 schema (`DEFAULT 1`) default absent
 * flags to `true`. Both paths now agree on `true`, while an explicit false
 * still disables on both.
 *
 * Fixtures are synthetic ids/strings only — no customer PII.
 */

describe("parseBoolDefaultTrue", () => {
  it.each([
    ["", true],
    ["   ", true],
    ["true", true],
    ["True", true],
    ["1", true],
    ["yes", true],
    ["YES", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["junk", false]
  ])("reads %o as %s", (input, expected) => {
    // Arrange / Act / Assert
    expect(parseBoolDefaultTrue(input)).toBe(expected);
  });

  it("leaves plain parseBool empty-means-false for OnCall/GPSLocked", () => {
    // Arrange / Act / Assert — the container parser still uses `parseBool`
    // for these (DB DEFAULT 0, write-through defaults false).
    expect(parseBool("")).toBe(false);
  });
});

describe("cron CSV path defaults absent flags to true", () => {
  it("defaults customer Enabled to true when the cell is empty or the column is absent", () => {
    // Arrange — full header with an empty Enabled cell, plus a header that
    // omits the column entirely (both collapse to "" via cell()).
    const fullCols = mapCsvHeaders(
      "CustomerID,CustomerTypeID,CompanyName,Enabled"
    );
    const bareCols = mapCsvHeaders("CustomerID,CustomerTypeID,CompanyName");

    // Act
    const emptyCell = parseCustomerSnapshotRow(fullCols, "5,,Acme,");
    const missingCol = parseCustomerSnapshotRow(bareCols, "5,,Acme");

    // Assert
    expect(emptyCell?.enabled).toBe(true);
    expect(missingCol?.enabled).toBe(true);
  });

  it("honours an explicit customer Enabled=false in CSV", () => {
    // Arrange / Act
    const cols = mapCsvHeaders("CustomerID,CustomerTypeID,CompanyName,Enabled");
    const row = parseCustomerSnapshotRow(cols, "5,,Acme,false");

    // Assert
    expect(row?.enabled).toBe(false);
  });

  it("defaults address ExtrasAllowed/Enabled to true when absent, honours explicit false", () => {
    // Arrange
    const bareCols = mapCsvHeaders("PickupAddressID,CustomerID,Address");
    const fullCols = mapCsvHeaders(
      "PickupAddressID,CustomerID,Address,ExtrasAllowed,Enabled"
    );

    // Act
    const missing = parseAddressSnapshotRow(bareCols, "10,5,1 Main St");
    const empty = parseAddressSnapshotRow(fullCols, "10,5,1 Main St,,");
    const explicit = parseAddressSnapshotRow(fullCols, "10,5,1 Main St,false,0");

    // Assert
    expect(missing?.extrasAllowed).toBe(true);
    expect(missing?.enabled).toBe(true);
    expect(empty?.extrasAllowed).toBe(true);
    expect(empty?.enabled).toBe(true);
    expect(explicit?.extrasAllowed).toBe(false);
    expect(explicit?.enabled).toBe(false);
  });

  it("defaults container Enabled to true when absent but keeps OnCall/GPSLocked false", () => {
    // Arrange
    const bareCols = mapCsvHeaders("ContainerID,PickupAddressID,SerialNumber");
    const fullCols = mapCsvHeaders(
      "ContainerID,PickupAddressID,SerialNumber,OnCall,GPSLocked,Enabled"
    );

    // Act
    const missing = parseContainerSnapshotRow(bareCols, "100,10,SN-1");
    const empty = parseContainerSnapshotRow(fullCols, "100,10,SN-1,,,");
    const explicit = parseContainerSnapshotRow(fullCols, "100,10,SN-1,false,false,no");

    // Assert
    expect(missing?.enabled).toBe(true);
    expect(empty?.enabled).toBe(true);
    expect(explicit?.enabled).toBe(false);
    // The intentional asymmetry: these stay empty-means-false.
    expect(empty?.onCall).toBe(false);
    expect(empty?.gpsLocked).toBe(false);
  });
});

describe("write-through path defaults absent flags to true", () => {
  it("defaults customer/address/container flags to true when the keys are absent", () => {
    // Arrange / Act — no Enabled/ExtrasAllowed/GPSLocked keys anywhere.
    const result = mapDetailFullToRows({
      currentCustomer: { CustomerID: 5 },
      data: [{ PickupAddressID: 10, CustomerID: 5, Containers: [{ ContainerID: 100 }] }]
    });

    // Assert
    expect(result.customer.enabled).toBe(true);
    expect(result.addresses[0].extrasAllowed).toBe(true);
    expect(result.addresses[0].enabled).toBe(true);
    expect(result.containers[0].enabled).toBe(true);
    expect(result.containers[0].gpsLocked).toBe(false);
  });
});

describe("cron/write-through parity for one entity with absent flags", () => {
  it("yields the same Enabled/ExtrasAllowed values both ways", () => {
    // Arrange — the same synthetic entity, flags absent on both paths.
    const customerRow = parseCustomerSnapshotRow(
      mapCsvHeaders("CustomerID,CompanyName"),
      "5,Acme"
    );
    const addressRow = parseAddressSnapshotRow(
      mapCsvHeaders("PickupAddressID,CustomerID,Address"),
      "10,5,1 Main St"
    );
    const containerRow = parseContainerSnapshotRow(
      mapCsvHeaders("ContainerID,PickupAddressID,SerialNumber"),
      "100,10,SN-1"
    );
    const { customer, addresses, containers } = mapDetailFullToRows({
      currentCustomer: { CustomerID: 5 },
      data: [{ PickupAddressID: 10, CustomerID: 5, Containers: [{ ContainerID: 100 }] }]
    });

    // Act / Assert — reviewer acceptance: same value both ways.
    expect(customerRow?.enabled).toBe(customer.enabled);
    expect(addressRow?.extrasAllowed).toBe(addresses[0].extrasAllowed);
    expect(addressRow?.enabled).toBe(addresses[0].enabled);
    expect(containerRow?.enabled).toBe(containers[0].enabled);
  });
});
