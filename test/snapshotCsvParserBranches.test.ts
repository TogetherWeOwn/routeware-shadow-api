import { describe, expect, it } from "vitest";

import { parseAddressSnapshotCsv } from "../src/lib/csvAddressSnapshot";
import { parseContainerSnapshotCsv } from "../src/lib/csvContainerSnapshot";
import { parseCustomerSnapshotCsv } from "../src/lib/csvCustomerSnapshot";

/**
 * Close the `csv*Snapshot.ts` bulk-parser branch gaps (58.3% /
 * 58.3% / 71.4% at baseline). The row parsers were covered through the
 * import routes, but the bulk entry points never saw an empty body, a
 * header-only file, a whitespace-only line, or an unparseable data row —
 * so the short-input guard, the `?? ""` header fallback, the blank-line
 * skip and the null-row filter each kept an untaken branch.
 *
 * Tests only — no production-code change.
 */

const ADDRESS_HEADER = "PickupAddressID,CustomerID";
const CONTAINER_HEADER = "ContainerID,PickupAddressID";
const CUSTOMER_HEADER = "CustomerID,CompanyName";

describe("parseAddressSnapshotCsv edges", () => {
  it("returns an empty header and no rows for an empty body", () => {
    // Arrange / Act
    const result = parseAddressSnapshotCsv("");

    // Assert
    expect(result).toEqual({ header: "", rows: [] });
  });

  it("returns the header and no rows for a header-only file", () => {
    // Arrange / Act
    const result = parseAddressSnapshotCsv(ADDRESS_HEADER);

    // Assert
    expect(result).toEqual({ header: ADDRESS_HEADER, rows: [] });
  });

  it("skips whitespace-only lines and unparseable rows", () => {
    // Arrange — the middle lines carry no usable IDs, so the null-row
    // filter drops them while the good row still parses.
    const csv = [ADDRESS_HEADER, "   ", ",,", "1,2"].join("\n");

    // Act
    const result = parseAddressSnapshotCsv(csv);

    // Assert
    expect(result.header).toBe(ADDRESS_HEADER);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ pickupAddressId: 1, customerId: 2 });
  });
});

describe("parseContainerSnapshotCsv edges", () => {
  it("returns an empty header and no rows for an empty body", () => {
    // Arrange / Act
    const result = parseContainerSnapshotCsv("");

    // Assert
    expect(result).toEqual({ header: "", rows: [] });
  });

  it("returns the header and no rows for a header-only file", () => {
    // Arrange / Act
    const result = parseContainerSnapshotCsv(CONTAINER_HEADER);

    // Assert
    expect(result).toEqual({ header: CONTAINER_HEADER, rows: [] });
  });

  it("skips whitespace-only lines and unparseable rows", () => {
    // Arrange
    const csv = [CONTAINER_HEADER, "   ", ",,", "10,20"].join("\n");

    // Act
    const result = parseContainerSnapshotCsv(csv);

    // Assert
    expect(result.header).toBe(CONTAINER_HEADER);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ containerId: 10, pickupAddressId: 20 });
  });
});

describe("parseCustomerSnapshotCsv edges", () => {
  it("returns an empty header and no rows for an empty body", () => {
    // Arrange / Act
    const result = parseCustomerSnapshotCsv("");

    // Assert
    expect(result).toEqual({ header: "", rows: [] });
  });

  it("returns the header and no rows for a header-only file", () => {
    // Arrange / Act
    const result = parseCustomerSnapshotCsv(CUSTOMER_HEADER);

    // Assert
    expect(result).toEqual({ header: CUSTOMER_HEADER, rows: [] });
  });

  it("skips whitespace-only lines and unparseable rows", () => {
    // Arrange — "abc" is not a finite customer id, so the row parser
    // rejects it and the null-row filter drops it.
    const csv = [CUSTOMER_HEADER, "   ", "abc,", "1,Acme"].join("\n");

    // Act
    const result = parseCustomerSnapshotCsv(csv);

    // Assert
    expect(result.header).toBe(CUSTOMER_HEADER);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ customerId: 1, companyName: "Acme" });
  });
});
