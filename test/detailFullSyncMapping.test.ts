import { describe, expect, it } from "vitest";

import { mapCurrentCustomerToRow, mapDetailFullToRows } from "../src/lib/detailFullSync";

/**
 * `mapDetailFullToRows` decides what the shadow copy of a customer actually
 * contains. It was at 0% coverage, and every bug in it is silent: the upsert
 * succeeds, no error is logged, and `/api/v1/data/*` then serves wrong data
 * until the next full report sync overwrites it.
 *
 * Two classes of defect are pinned here.
 *
 * Field renames. Routeware calls the name fields `NameFirst` / `NameMI` /
 * `NameLast`, the snapshot row calls them `firstName` / `middleInitial` /
 * `lastName`, and nothing but this function connects the two. A typo produces a
 * row full of nulls, not a type error.
 *
 * Absent-key defaults. `extrasAllowed`, `enabled` and `gpsLocked` are read with
 * an explicit `!== undefined` guard because the raw coercion of `undefined` is
 * `false`. Dropping that guard would silently mark every address disabled.
 */

const CUSTOMER = {
  CustomerID: 5,
  CustomerTypeID: 2,
  CompanyName: "Acme",
  NameFirst: "Ada",
  NameMI: "B",
  NameLast: "Lovelace",
  NameSuffix: "Jr",
  CustomerNumber: "C-1",
  SubCustomerNumber: "S-1",
  Phone1: "555-0100",
  Phone2: "555-0101",
  Comments: "note",
  Enabled: true
};

/** A minimal address item; individual tests override the keys they care about. */
function addressItem(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { PickupAddressID: 10, CustomerID: 5, Address: "1 Main St", ...extra };
}

function detailFull(
  data: unknown[],
  currentCustomer: Record<string, unknown> = CUSTOMER
): { data: unknown[]; currentCustomer: Record<string, unknown> } {
  return { data, currentCustomer };
}

describe("mapCurrentCustomerToRow", () => {
  it("maps Routeware's renamed name fields onto the snapshot row", () => {
    // Arrange / Act
    const row = mapCurrentCustomerToRow(CUSTOMER);

    // Assert
    expect(row).toEqual({
      customerId: 5,
      customerTypeId: 2,
      companyName: "Acme",
      firstName: "Ada",
      middleInitial: "B",
      lastName: "Lovelace",
      nameSuffix: "Jr",
      customerNumber: "C-1",
      subCustomerNumber: "S-1",
      phone1: "555-0100",
      phone2: "555-0101",
      comments: "note",
      enabled: true
    });
  });

  it("accepts the lowercase customerID spelling", () => {
    // Arrange / Act — the upstream JSON is inconsistent about this key's casing.
    const row = mapCurrentCustomerToRow({ customerID: 7 });

    // Assert
    expect(row.customerId).toBe(7);
  });

  it("throws when there is no customer id in either spelling", () => {
    // Arrange / Act / Assert
    expect(() => mapCurrentCustomerToRow({ CompanyName: "Acme" })).toThrowError(
      "currentCustomer missing CustomerID"
    );
  });

  it("parses numeric strings and trims text, turning blanks into null", () => {
    // Arrange / Act
    const row = mapCurrentCustomerToRow({
      CustomerID: "5",
      CustomerTypeID: "2",
      CompanyName: "  Acme  ",
      Phone1: "   "
    });

    // Assert
    expect(row.customerId).toBe(5);
    expect(row.customerTypeId).toBe(2);
    expect(row.companyName).toBe("Acme");
    expect(row.phone1).toBeNull();
  });

  it("nulls a customer type that is not a number", () => {
    // Arrange / Act
    const row = mapCurrentCustomerToRow({ CustomerID: 5, CustomerTypeID: "n/a" });

    // Assert
    expect(row.customerTypeId).toBeNull();
  });

  it.each([
    [true, true],
    [1, true],
    ["1", true],
    ["true", true],
    ["YES", true],
    [false, false],
    [0, false],
    ["0", false],
    ["no", false],
    // Absent Enabled defaults to true, matching the cron CSV
    // path, the address/container guards, and the D1 DEFAULT 1.
    [undefined, true]
  ])("reads Enabled=%o as %s", (enabled, expected) => {
    // Arrange / Act
    const row = mapCurrentCustomerToRow({ CustomerID: 5, Enabled: enabled });

    // Assert
    expect(row.enabled).toBe(expected);
  });
});

describe("mapDetailFullToRows", () => {
  it("throws when the payload has no currentCustomer", () => {
    // Arrange / Act / Assert
    expect(() => mapDetailFullToRows({ data: [] })).toThrowError(
      "GetCustomerDetailFull missing currentCustomer"
    );
  });

  it("returns the customer with no addresses when data is absent", () => {
    // Arrange / Act
    const result = mapDetailFullToRows({ currentCustomer: CUSTOMER });

    // Assert
    expect(result.customer.customerId).toBe(5);
    expect(result.addresses).toEqual([]);
    expect(result.containers).toEqual([]);
  });

  it("skips entries in data that are not objects", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(detailFull([null, "junk", 42, addressItem()]));

    // Assert
    expect(result.addresses).toHaveLength(1);
    expect(result.addresses[0].pickupAddressId).toBe(10);
  });

  it("throws when an address item has no PickupAddressID", () => {
    // Arrange / Act / Assert
    expect(() => mapDetailFullToRows(detailFull([{ CustomerID: 5 }]))).toThrowError(
      "address item missing PickupAddressID or CustomerID"
    );
  });

  it("throws when an address item has no CustomerID", () => {
    // Arrange / Act / Assert
    expect(() => mapDetailFullToRows(detailFull([{ PickupAddressID: 10 }]))).toThrowError(
      "address item missing PickupAddressID or CustomerID"
    );
  });

  it("defaults ExtrasAllowed and Enabled to true when the keys are absent", () => {
    // Arrange / Act — the raw coercion of `undefined` is false, so losing the
    // `!== undefined` guard would mark every address disabled.
    const result = mapDetailFullToRows(detailFull([addressItem()]));

    // Assert
    expect(result.addresses[0].extrasAllowed).toBe(true);
    expect(result.addresses[0].enabled).toBe(true);
  });

  it("honours an explicit false for ExtrasAllowed and Enabled", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(
      detailFull([addressItem({ ExtrasAllowed: false, Enabled: "0" })])
    );

    // Assert
    expect(result.addresses[0].extrasAllowed).toBe(false);
    expect(result.addresses[0].enabled).toBe(false);
  });

  it("falls back to the lowercase 'driver note' key", () => {
    // Arrange / Act — some exports spell it with a space and no capitals.
    const result = mapDetailFullToRows(
      detailFull([addressItem({ "driver note": "gate code 1234" })])
    );

    // Assert
    expect(result.addresses[0].driverNote).toBe("gate code 1234");
  });

  it("prefers DriverNote over the lowercase fallback", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(
      detailFull([addressItem({ DriverNote: "primary", "driver note": "fallback" })])
    );

    // Assert
    expect(result.addresses[0].driverNote).toBe("primary");
  });
});

describe("mapDetailFullToRows container handling", () => {
  it("inherits the parent address id when the container omits its own", () => {
    // Arrange / Act — a container attached to the wrong address corrupts the
    // graph that invalidateCustomerGraph and the bundle reads both walk.
    const result = mapDetailFullToRows(
      detailFull([addressItem({ Containers: [{ ContainerID: 100 }] })])
    );

    // Assert
    expect(result.containers).toHaveLength(1);
    expect(result.containers[0].pickupAddressId).toBe(10);
  });

  it("keeps the container's own PickupAddressID when it has one", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(
      detailFull([addressItem({ Containers: [{ ContainerID: 100, PickupAddressID: 11 }] })])
    );

    // Assert
    expect(result.containers[0].pickupAddressId).toBe(11);
  });

  it("throws when a container has no ContainerID", () => {
    // Arrange / Act / Assert
    expect(() =>
      mapDetailFullToRows(detailFull([addressItem({ Containers: [{ SerialNumber: "x" }] })]))
    ).toThrowError("container missing ContainerID");
  });

  it("skips container entries that are not objects", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(
      detailFull([addressItem({ Containers: [null, "junk", { ContainerID: 100 }] })])
    );

    // Assert
    expect(result.containers).toHaveLength(1);
  });

  it("ignores a Containers value that is not an array", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(detailFull([addressItem({ Containers: "none" })]));

    // Assert
    expect(result.containers).toEqual([]);
  });

  it("joins Routes into comma-separated route and frequency ids", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(
      detailFull([
        addressItem({
          Containers: [
            {
              ContainerID: 100,
              Routes: [
                { RouteID: 1, FrequencyID: 7 },
                { RouteID: 2, FrequencyID: 8 }
              ]
            }
          ]
        })
      ])
    );

    // Assert
    expect(result.containers[0].routeIds).toBe("1,2");
    expect(result.containers[0].frequencyIds).toBe("7,8");
  });

  it("nulls the joined ids when Routes is empty or unusable", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(
      detailFull([
        addressItem({ Containers: [{ ContainerID: 100, Routes: [{ RouteID: "n/a" }] }] })
      ])
    );

    // Assert
    expect(result.containers[0].routeIds).toBeNull();
    expect(result.containers[0].frequencyIds).toBeNull();
  });

  it("defaults GPSLocked to false and Enabled to true when absent", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(
      detailFull([addressItem({ Containers: [{ ContainerID: 100 }] })])
    );

    // Assert
    expect(result.containers[0].gpsLocked).toBe(false);
    expect(result.containers[0].enabled).toBe(true);
  });

  it("falls back across the alternate location, note and service-code keys", () => {
    // Arrange / Act — the upstream payload uses different names than the CSV
    // export does.
    const result = mapDetailFullToRows(
      detailFull([
        addressItem({
          Containers: [
            {
              ContainerID: 100,
              Address: "2 Side St",
              ContainerNotes: "back alley",
              FrequencyCode: "W1"
            }
          ]
        })
      ])
    );

    // Assert
    const container = result.containers[0];
    expect(container.locationAddress).toBe("2 Side St");
    expect(container.containerNote).toBe("back alley");
    expect(container.serviceCode).toBe("W1");
  });

  it("prefers the primary location, note and service-code keys", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(
      detailFull([
        addressItem({
          Containers: [
            {
              ContainerID: 100,
              LocationAddress: "primary",
              Address: "fallback",
              Note: "primary note",
              ContainerNotes: "fallback note",
              ChangeCode: "CC",
              FrequencyCode: "FC"
            }
          ]
        })
      ])
    );

    // Assert
    const container = result.containers[0];
    expect(container.locationAddress).toBe("primary");
    expect(container.containerNote).toBe("primary note");
    expect(container.serviceCode).toBe("CC");
  });

  it("collects containers from every address in order", () => {
    // Arrange / Act
    const result = mapDetailFullToRows(
      detailFull([
        addressItem({ PickupAddressID: 10, Containers: [{ ContainerID: 100 }] }),
        addressItem({ PickupAddressID: 11, Containers: [{ ContainerID: 101 }] })
      ])
    );

    // Assert
    expect(result.addresses.map((a) => a.pickupAddressId)).toEqual([10, 11]);
    expect(result.containers.map((c) => c.containerId)).toEqual([100, 101]);
    expect(result.containers.map((c) => c.pickupAddressId)).toEqual([10, 11]);
  });
});
