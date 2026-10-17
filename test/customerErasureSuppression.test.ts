import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { customerSnapshotRoutes } from "../src/routes/customerSnapshot";
import { stringToUint8Stream } from "../src/lib/csvStream";
import {
  syncAddressSnapshotFromCsvText,
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromCsvText,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromCsvText,
  syncCustomerSnapshotFromStream
} from "../src/lib/snapshot/streamSync";
import {
  upsertAddressSnapshotRows,
  upsertContainerSnapshotRows,
  upsertCustomerSnapshotRows
} from "../src/lib/snapshot/upsert";
import { ensureD1TestTables } from "./d1TestMigrations";

const DELETE_ID = 9811;
const IMPORT_ID = 9812;
const SYNC_SECRET = () =>
  (env as unknown as { CUSTOMER_SNAPSHOT_SYNC_SECRET: string })
    .CUSTOMER_SNAPSHOT_SYNC_SECRET;
const db = () => (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
const ctx = () => ({ waitUntil() {}, passThroughOnException() {} }) as unknown as ExecutionContext;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return customerSnapshotRoutes.fetch(
    new Request(`http://test.local${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${SYNC_SECRET()}`,
        ...(init.headers ?? {})
      }
    }),
    {
      CUSTOMER_DB: db(),
      CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC_SECRET()
    } as unknown as Env,
    ctx()
  );
}

async function customerExists(id: number): Promise<boolean> {
  return (await db().prepare("SELECT customer_id FROM customer_snapshot WHERE customer_id = ?").bind(id).first()) !== null;
}

describe("customer erasure suppression", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  it("keeps an erased customer absent from a later sync and post-save upsert", async () => {
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(DELETE_ID).run();
    expect((await request(`/api/v1/customer-snapshot/${DELETE_ID}`, { method: "DELETE" })).status).toBe(200);

    await syncCustomerSnapshotFromCsvText(
      db(),
      `CustomerID,CompanyName,Enabled\n${DELETE_ID},Synced Again,true\n`
    );
    // Detail-full proxy-save refresh uses this shared customer upsert path.
    await upsertCustomerSnapshotRows(db(), [{
      customerId: DELETE_ID,
      customerTypeId: null,
      companyName: "Saved Again",
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
    }]);

    expect(await customerExists(DELETE_ID)).toBe(false);
  });

  it("does not leave a tombstone when the FK refuses erasure", async () => {
    const id = 9813;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(id).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(id, id).run();

    const response = await request(`/api/v1/customer-snapshot/${id}`, { method: "DELETE" });
    const marker = await db().prepare("SELECT customer_id FROM customer_snapshot_erasure WHERE customer_id = ?").bind(id).first();

    expect(response.status).toBe(400);
    expect(await customerExists(id)).toBe(true);
    expect(marker).toBeNull();

    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(id).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(id).run();
  });

  it("keeps an erased customer absent when importing an older archive", async () => {
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(IMPORT_ID).run();
    expect((await request(`/api/v1/customer-snapshot/${IMPORT_ID}`, { method: "DELETE" })).status).toBe(200);

    const imported = await request("/api/v1/customer-snapshot/import", {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: `CustomerID,CompanyName,Enabled\n${IMPORT_ID},Restored Archive,true\n`
    });

    expect(imported.status).toBe(200);
    expect(await customerExists(IMPORT_ID)).toBe(false);
  });
});

const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments," +
  "ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";
const CONTAINER_HEADER =
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked," +
  "Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote";

async function addressExists(pickupAddressId: number): Promise<boolean> {
  return (await db().prepare("SELECT pickup_address_id FROM address_snapshot WHERE pickup_address_id = ?").bind(pickupAddressId).first()) !== null;
}

async function containerExists(containerId: number): Promise<boolean> {
  return (await db().prepare("SELECT container_id FROM container_snapshot WHERE container_id = ?").bind(containerId).first()) !== null;
}

describe("erased-customer descendant suppression (scoped_skip)", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  it("suppresses address and container replay across a full sync cycle", async () => {
    const customerId = 9821;
    const addressId = 9821;
    const containerId = 9821;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(customerId).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(addressId, customerId).run();
    await db().prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(containerId, addressId).run();
    // FK-order cleanup, then erasure writes the tombstone.
    await db().prepare("DELETE FROM container_snapshot WHERE container_id = ?").bind(containerId).run();
    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    expect((await request(`/api/v1/customer-snapshot/${customerId}`, { method: "DELETE" })).status).toBe(200);

    // Upstream still holds the whole graph: replay customer → address → container.
    await syncCustomerSnapshotFromCsvText(
      db(),
      `CustomerID,CompanyName,Enabled\n${customerId},Synced Again,true\n`
    );
    await syncAddressSnapshotFromCsvText(
      db(),
      `${ADDRESS_HEADER}\n${addressId},${customerId},,${addressId} Main St,Killeen,TX,76541,,,false,true,,,,`
    );
    await syncContainerSnapshotFromCsvText(
      db(),
      `${CONTAINER_HEADER}\n${containerId},${addressId},,SN-${containerId},,false,,false,,,true,${addressId} Main St,Killeen,TX,76541,`
    );

    expect(await customerExists(customerId)).toBe(false);
    expect(await addressExists(addressId)).toBe(false);
    expect(await containerExists(containerId)).toBe(false);
    // The suppressed address leaves an id-only lineage row (no PII beyond the keys).
    const lineage = await db().prepare("SELECT pickup_address_id, customer_id FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).first<{ pickup_address_id: number; customer_id: number }>();
    expect(lineage).toMatchObject({ pickup_address_id: addressId, customer_id: customerId });
  });

  it("suppresses descendant writes on the shared proxy-save upsert path", async () => {
    const customerId = 9822;
    const addressId = 9822;
    const containerId = 9822;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(customerId).run();
    expect((await request(`/api/v1/customer-snapshot/${customerId}`, { method: "DELETE" })).status).toBe(200);

    // Detail-full proxy-save refresh uses these shared upsert paths.
    await upsertCustomerSnapshotRows(db(), [{
      customerId,
      customerTypeId: null,
      companyName: "Saved Again",
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
    }]);
    await upsertAddressSnapshotRows(db(), [{
      pickupAddressId: addressId,
      customerId,
      routeId: null,
      address: "9822 Main St",
      city: "Killeen",
      state: "TX",
      zip: "76541",
      franchiseId: null,
      comments: null,
      extrasAllowed: false,
      enabled: true,
      driverNote: null,
      latitude: null,
      longitude: null,
      lastAuditDate: null
    }]);
    await upsertContainerSnapshotRows(db(), [{
      containerId,
      pickupAddressId: addressId,
      containerTypeId: null,
      serialNumber: `SN-${containerId}`,
      rfid: null,
      onCall: false,
      eventCode: null,
      gpsLocked: false,
      latitude: null,
      longitude: null,
      enabled: true,
      locationAddress: "9822 Main St",
      city: "Killeen",
      state: "TX",
      zip: "76541",
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
    }]);

    expect(await customerExists(customerId)).toBe(false);
    expect(await addressExists(addressId)).toBe(false);
    expect(await containerExists(containerId)).toBe(false);
  });

  it("keeps fail-closed foreign keys for descendants of non-erased customers", async () => {
    const unknownCustomer = 9831;
    const unknownAddress = 9831;
    await expect(
      syncAddressSnapshotFromCsvText(
        db(),
        `${ADDRESS_HEADER}\n${unknownAddress},${unknownCustomer},,${unknownAddress} Main St,Killeen,TX,76541,,,false,true,,,,`
      )
    ).rejects.toThrow(/foreign key/i);
    await expect(
      syncContainerSnapshotFromCsvText(
        db(),
        `${CONTAINER_HEADER}\n9832,${unknownAddress},,SN-9832,,false,,false,,,true,${unknownAddress} Main St,Killeen,TX,76541,`
      )
    ).rejects.toThrow(/foreign key/i);
    expect(await addressExists(unknownAddress)).toBe(false);
    expect(await containerExists(9832)).toBe(false);
  });
});

describe("erasure UPDATE suppression and raced deletes", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  it("does not update a tombstoned customer via sync or import", async () => {
    const id = 9845;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Original-9845', 1, '2026-10-01')").bind(id).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(id).run();

    await syncCustomerSnapshotFromCsvText(
      db(),
      `CustomerID,CompanyName,Enabled\n${id},Updated-9845,true\n`
    );
    const afterSync = await db().prepare("SELECT company_name FROM customer_snapshot WHERE customer_id = ?").bind(id).first<{ company_name: string }>();
    expect(afterSync?.company_name).toBe("Original-9845");

    const imported = await request("/api/v1/customer-snapshot/import", {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: `CustomerID,CompanyName,Enabled\n${id},Imported-9845,true\n`
    });
    expect(imported.status).toBe(200);
    const afterImport = await db().prepare("SELECT company_name FROM customer_snapshot WHERE customer_id = ?").bind(id).first<{ company_name: string }>();
    expect(afterImport?.company_name).toBe("Original-9845");

    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(id).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(id).run();
  });

  it("does not update a tombstoned address via upsert", async () => {
    const customerId = 9846;
    const addressId = 9846;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(customerId).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, 'Original St', 1, '2026-10-01')").bind(addressId, customerId).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(customerId).run();

    await upsertAddressSnapshotRows(db(), [{
      pickupAddressId: addressId,
      customerId,
      routeId: null,
      address: "Updated St",
      city: "Killeen",
      state: "TX",
      zip: "76541",
      franchiseId: null,
      comments: null,
      extrasAllowed: false,
      enabled: true,
      driverNote: null,
      latitude: null,
      longitude: null,
      lastAuditDate: null
    }]);

    const row = await db().prepare("SELECT address FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).first<{ address: string }>();
    expect(row?.address).toBe("Original St");

    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(customerId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(customerId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).run();
  });

  it("does not update a tombstoned container via upsert", async () => {
    const customerId = 9847;
    const addressId = 9847;
    const containerId = 9847;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(customerId).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(addressId, customerId).run();
    await db().prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (?, ?, 'SN-9847', 1, '2026-10-01')").bind(containerId, addressId).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(customerId).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure_address (pickup_address_id, customer_id, erased_at) VALUES (?, ?, '2026-10-15T00:00:00.000Z')").bind(addressId, customerId).run();

    await upsertContainerSnapshotRows(db(), [{
      containerId,
      pickupAddressId: addressId,
      containerTypeId: null,
      serialNumber: "SN-9847-NEW",
      rfid: null,
      onCall: false,
      eventCode: null,
      gpsLocked: false,
      latitude: null,
      longitude: null,
      enabled: true,
      locationAddress: "9847 Main St",
      city: "Killeen",
      state: "TX",
      zip: "76541",
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
    }]);

    const row = await db().prepare("SELECT serial_number FROM container_snapshot WHERE container_id = ?").bind(containerId).first<{ serial_number: string }>();
    expect(row?.serial_number).toBe("SN-9847");

    await db().prepare("DELETE FROM container_snapshot WHERE container_id = ?").bind(containerId).run();
    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(customerId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(customerId).run();
  });

  it("returns 404 with no marker when the row vanishes before the batch (raced delete)", async () => {
    const id = 9848;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(id).run();
    const realDb = db();
    const racingDb = {
      prepare: (sql: string) => (realDb as unknown as { prepare: (s: string) => unknown }).prepare(sql),
      batch: async (stmts: unknown[]) => {
        await realDb.prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(id).run();
        return (realDb as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch(stmts);
      }
    } as unknown as D1Database;
    const res = await customerSnapshotRoutes.fetch(
      new Request(`http://test.local/api/v1/customer-snapshot/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${SYNC_SECRET()}` }
      }),
      {
        CUSTOMER_DB: racingDb,
        CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC_SECRET()
      } as unknown as Env,
      ctx()
    );
    const marker = await realDb.prepare("SELECT customer_id FROM customer_snapshot_erasure WHERE customer_id = ?").bind(id).first();
    expect(res.status).toBe(404);
    expect(marker).toBeNull();
    expect(await customerExists(id)).toBe(false);
    await realDb.prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(id).run();
  });

  it("lets a re-homed address and its containers flow under the live owner", async () => {
    const erasedCustomer = 9871;
    const liveCustomer = 9872;
    const addressId = 9871;
    const containerId = 9871;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(erasedCustomer).run();
    expect((await request(`/api/v1/customer-snapshot/${erasedCustomer}`, { method: "DELETE" })).status).toBe(200);

    await syncAddressSnapshotFromCsvText(
      db(),
      `${ADDRESS_HEADER}\n${addressId},${erasedCustomer},,${addressId} Main St,Killeen,TX,76541,,,false,true,,,,`
    );
    expect(await addressExists(addressId)).toBe(false);

    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(liveCustomer).run();
    await syncAddressSnapshotFromCsvText(
      db(),
      `${ADDRESS_HEADER}\n${addressId},${liveCustomer},,${addressId} Main St,Killeen,TX,76541,,,false,true,,,,`
    );
    const addressRow = await db().prepare("SELECT customer_id FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(addressRow?.customer_id).toBe(liveCustomer);

    await syncContainerSnapshotFromCsvText(
      db(),
      `${CONTAINER_HEADER}\n${containerId},${addressId},,SN-${containerId},,false,,false,,,true,${addressId} Main St,Killeen,TX,76541,`
    );
    expect(await containerExists(containerId)).toBe(true);

    await db().prepare("DELETE FROM container_snapshot WHERE container_id = ?").bind(containerId).run();
    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(liveCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(erasedCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).run();
  });

  it("adopts legacy rows under an erased owner when the address re-homes to live", async () => {
    const erasedCustomer = 9881;
    const liveCustomer = 9882;
    const addressId = 9881;
    const containerId = 9881;
    // Legacy rows predate the marker, so the marker is inserted directly
    // instead of via the DELETE route (which would remove the rows first).
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(erasedCustomer).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, 'Legacy St', 1, '2026-10-01')").bind(addressId, erasedCustomer).run();
    await db().prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (?, ?, 'SN-LEGACY', 1, '2026-10-01')").bind(containerId, addressId).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(erasedCustomer).run();

    // Upstream re-homes the address to the live owner: the NEW-only UPDATE
    // trigger lets it flow instead of freezing under the erased id. Widening
    // the trigger to OLD would suppress this and leave the row erased-owned.
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(liveCustomer).run();
    await syncAddressSnapshotFromCsvText(
      db(),
      `${ADDRESS_HEADER}\n${addressId},${liveCustomer},,${addressId} Main St,Killeen,TX,76541,,,false,true,,,,`
    );
    const addressRow = await db().prepare("SELECT customer_id FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(addressRow?.customer_id).toBe(liveCustomer);

    // The adopted address's containers land, and no suppression fired anywhere
    // so no lineage row is left behind.
    await syncContainerSnapshotFromCsvText(
      db(),
      `${CONTAINER_HEADER}\n${containerId},${addressId},,SN-${containerId},,false,,false,,,true,${addressId} Main St,Killeen,TX,76541,`
    );
    const containerRow = await db().prepare("SELECT serial_number FROM container_snapshot WHERE container_id = ?").bind(containerId).first<{ serial_number: string }>();
    expect(containerRow?.serial_number).toBe(`SN-${containerId}`);
    const lineage = await db().prepare("SELECT pickup_address_id FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).first();
    expect(lineage).toBeNull();

    await db().prepare("DELETE FROM container_snapshot WHERE container_id = ?").bind(containerId).run();
    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(liveCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(erasedCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(erasedCustomer).run();
  });
});

describe("erasure direct-SQL UPDATE boundary and lineage cleanup", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  it("ignores a plain UPDATE that stays under a tombstoned customer", async () => {
    const id = 9851;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Original-9851', 1, '2026-10-01')").bind(id).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(id).run();

    // No app writer issues a bare UPDATE; this pins the UPDATE trigger for
    // direct-SQL writers. Dropping suppress_erased_customer_update lets it through.
    await db().prepare("UPDATE customer_snapshot SET company_name = 'Hacked-9851' WHERE customer_id = ?").bind(id).run();
    const row = await db().prepare("SELECT company_name FROM customer_snapshot WHERE customer_id = ?").bind(id).first<{ company_name: string }>();
    expect(row?.company_name).toBe("Original-9851");

    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(id).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(id).run();
  });

  it("ignores a plain UPDATE that stays under a tombstoned address owner", async () => {
    const customerId = 9852;
    const addressId = 9852;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(customerId).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, 'Original St', 1, '2026-10-01')").bind(addressId, customerId).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(customerId).run();

    // Pins suppress_erased_address_update for direct-SQL writers.
    await db().prepare("UPDATE address_snapshot SET address = 'Hacked St' WHERE pickup_address_id = ?").bind(addressId).run();
    const row = await db().prepare("SELECT address FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).first<{ address: string }>();
    expect(row?.address).toBe("Original St");
    // The skipped UPDATE records lineage so later container writes stay
    // suppressed (dropping the trigger's INSERT leaves the mapping absent).
    const lineage = await db().prepare("SELECT customer_id FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(lineage?.customer_id).toBe(customerId);

    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(customerId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(customerId).run();
  });

  it("keys the address UPDATE trigger on the NEW owner and refreshes lineage on conflict", async () => {
    // Sync upserts never reach the UPDATE trigger on a suppressed write (the
    // BEFORE INSERT trigger ignores the row first), so this pins the UPDATE
    // trigger directly for direct-SQL writers.
    const liveCustomer = 9856;
    const secondLiveCustomer = 9857;
    const erasedCustomer = 9858;
    const secondErasedCustomer = 9859;
    const addressId = 9856;
    const containerId = 9856;
    for (const id of [liveCustomer, secondLiveCustomer]) {
      await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(id).run();
    }
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(addressId, liveCustomer).run();
    await db().prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (?, ?, 'SN-9856', 1, '2026-10-01')").bind(containerId, addressId).run();
    for (const id of [erasedCustomer, secondErasedCustomer]) {
      await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(id).run();
    }

    // Live-to-erased re-home: skipped, stays under the live owner, lineage
    // recorded, and the erased-attributed containers removed so the stale
    // parent stays reconcilable.
    await db().prepare("UPDATE address_snapshot SET customer_id = ? WHERE pickup_address_id = ?").bind(erasedCustomer, addressId).run();
    const stayed = await db().prepare("SELECT customer_id FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(stayed?.customer_id).toBe(liveCustomer);
    expect(await containerExists(containerId)).toBe(false);
    const firstLineage = await db().prepare("SELECT customer_id FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(firstLineage?.customer_id).toBe(erasedCustomer);

    // Re-homed between erased owners: the lineage upsert refreshes the mapping
    // (DO UPDATE, not DO NOTHING).
    await db().prepare("UPDATE address_snapshot SET customer_id = ? WHERE pickup_address_id = ?").bind(secondErasedCustomer, addressId).run();
    const refreshed = await db().prepare("SELECT customer_id FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(refreshed?.customer_id).toBe(secondErasedCustomer);

    // Erased-to-live re-home flows (NEW-only): widening the trigger to OLD
    // would suppress this and freeze the row under the erased owner.
    await db().prepare("UPDATE address_snapshot SET customer_id = ? WHERE pickup_address_id = ?").bind(secondLiveCustomer, addressId).run();
    const adopted = await db().prepare("SELECT customer_id FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(adopted?.customer_id).toBe(secondLiveCustomer);

    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    for (const id of [liveCustomer, secondLiveCustomer]) {
      await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(id).run();
    }
    await db().prepare("DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).run();
    for (const id of [erasedCustomer, secondErasedCustomer]) {
      await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(id).run();
    }
  });

  it("ignores a plain UPDATE on a lineage-suppressed container", async () => {
    const customerId = 9853;
    const addressId = 9853;
    const containerId = 9853;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(customerId).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(addressId, customerId).run();
    await db().prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (?, ?, 'SN-9853', 1, '2026-10-01')").bind(containerId, addressId).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(customerId).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure_address (pickup_address_id, customer_id, erased_at) VALUES (?, ?, '2026-10-15T00:00:00.000Z')").bind(addressId, customerId).run();

    // Pins the NEW-lineage side of suppress_erased_container_update.
    await db().prepare("UPDATE container_snapshot SET serial_number = 'SN-HACKED' WHERE container_id = ?").bind(containerId).run();
    const row = await db().prepare("SELECT serial_number FROM container_snapshot WHERE container_id = ?").bind(containerId).first<{ serial_number: string }>();
    expect(row?.serial_number).toBe("SN-9853");

    await db().prepare("DELETE FROM container_snapshot WHERE container_id = ?").bind(containerId).run();
    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(customerId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(customerId).run();
  });

  it("ignores a plain UPDATE moving a container off a lineage-suppressed address", async () => {
    const liveCustomer = 9854;
    const liveAddress = 9854;
    const otherCustomer = 9855;
    const otherAddress = 9855;
    const containerId = 9854;
    const erasedCustomer = 9864;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(liveCustomer).run();
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(otherCustomer).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(liveAddress, liveCustomer).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(otherAddress, otherCustomer).run();
    await db().prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (?, ?, 'SN-9854', 1, '2026-10-01')").bind(containerId, liveAddress).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(erasedCustomer).run();
    // Stale mapping left by a suppressed live-to-erased re-home attempt.
    await db().prepare("INSERT INTO customer_snapshot_erasure_address (pickup_address_id, customer_id, erased_at) VALUES (?, ?, '2026-10-15T00:00:00.000Z')").bind(liveAddress, erasedCustomer).run();

    // Pins the OLD-lineage side of suppress_erased_container_update: the NEW
    // address is clean, so only the OLD side can refuse this. Fail-closed
    // until the next live address write clears the mapping.
    await db().prepare("UPDATE container_snapshot SET pickup_address_id = ? WHERE container_id = ?").bind(otherAddress, containerId).run();
    const row = await db().prepare("SELECT pickup_address_id FROM container_snapshot WHERE container_id = ?").bind(containerId).first<{ pickup_address_id: number }>();
    expect(row?.pickup_address_id).toBe(liveAddress);

    await db().prepare("DELETE FROM container_snapshot WHERE container_id = ?").bind(containerId).run();
    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(liveAddress).run();
    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(otherAddress).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(liveCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(otherCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(liveAddress).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(erasedCustomer).run();
  });

  it("clears stale lineage on a live-owner address write and fails closed after the address is gone", async () => {
    const erasedCustomer = 9861;
    const liveCustomer = 9862;
    const addressId = 9861;
    const containerId = 9861;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(erasedCustomer).run();
    expect((await request(`/api/v1/customer-snapshot/${erasedCustomer}`, { method: "DELETE" })).status).toBe(200);

    // Suppressed re-home attempt records lineage for this address.
    await syncAddressSnapshotFromCsvText(
      db(),
      `${ADDRESS_HEADER}\n${addressId},${erasedCustomer},,${addressId} Main St,Killeen,TX,76541,,,false,true,,,,`
    );
    expect(await addressExists(addressId)).toBe(false);

    // The live owner claims the address: it lands and the stale mapping is
    // deleted. Dropping clear_stale_erasure_lineage_on_address_insert leaves it.
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(liveCustomer).run();
    await syncAddressSnapshotFromCsvText(
      db(),
      `${ADDRESS_HEADER}\n${addressId},${liveCustomer},,${addressId} Main St,Killeen,TX,76541,,,false,true,,,,`
    );
    const addressRow = await db().prepare("SELECT customer_id FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(addressRow?.customer_id).toBe(liveCustomer);
    const lineage = await db().prepare("SELECT pickup_address_id FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).first();
    expect(lineage).toBeNull();

    // Containers flow again under the live owner.
    await syncContainerSnapshotFromCsvText(
      db(),
      `${CONTAINER_HEADER}\n${containerId},${addressId},,SN-${containerId},,false,,false,,,true,${addressId} Main St,Killeen,TX,76541,`
    );
    expect(await containerExists(containerId)).toBe(true);

    await db().prepare("DELETE FROM container_snapshot WHERE container_id = ?").bind(containerId).run();
    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(liveCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(erasedCustomer).run();

    // With the address row gone and no lineage left, a replayed container
    // fails closed on the address foreign key instead of being silently
    // suppressed (a lingering mapping would swallow it via RAISE(IGNORE)).
    await expect(
      syncContainerSnapshotFromCsvText(
        db(),
        `${CONTAINER_HEADER}\n${containerId},${addressId},,SN-${containerId},,false,,false,,,true,${addressId} Main St,Killeen,TX,76541,`
      )
    ).rejects.toThrow(/foreign key/i);
    expect(await containerExists(containerId)).toBe(false);
  });

  it("clears stale lineage on a live-owner plain address UPDATE", async () => {
    const liveCustomer = 9863;
    const addressId = 9863;
    const erasedCustomer = 9874;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(liveCustomer).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, 'Live St', 1, '2026-10-01')").bind(addressId, liveCustomer).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(erasedCustomer).run();
    await db().prepare("INSERT INTO customer_snapshot_erasure_address (pickup_address_id, customer_id, erased_at) VALUES (?, ?, '2026-10-15T00:00:00.000Z')").bind(addressId, erasedCustomer).run();

    // Stays under the live owner, so the write lands and the AFTER UPDATE
    // cleanup deletes the mapping. Dropping
    // clear_stale_erasure_lineage_on_address_update leaves it.
    await db().prepare("UPDATE address_snapshot SET address = 'Touched St' WHERE pickup_address_id = ?").bind(addressId).run();
    const row = await db().prepare("SELECT address FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).first<{ address: string }>();
    expect(row?.address).toBe("Touched St");
    const lineage = await db().prepare("SELECT pickup_address_id FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).first();
    expect(lineage).toBeNull();

    await db().prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(liveCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(erasedCustomer).run();
  });

  it("removes a live-to-erased re-home's containers and reconciles the stale address away", async () => {
    const liveCustomer = 9901;
    const erasedCustomer = 9902;
    const secondErasedCustomer = 9903;
    const addressId = 9901;
    const containerId = 9901;
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(liveCustomer).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(addressId, liveCustomer).run();
    await db().prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (?, ?, 'SN-OLD', 1, '2026-10-01')").bind(containerId, addressId).run();
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(erasedCustomer).run();
    expect((await request(`/api/v1/customer-snapshot/${erasedCustomer}`, { method: "DELETE" })).status).toBe(200);

    // Upstream re-homes the live address to the erased customer: the address
    // write is skipped and records lineage, the row stays under the live
    // owner, and the erased-attributed containers are removed at once so the
    // stale parent stays reconcilable. Dropping the trigger DELETE leaves the
    // SN-OLD child behind and the address reconcile below FK-aborts.
    await syncAddressSnapshotFromCsvText(
      db(),
      `${ADDRESS_HEADER}\n${addressId},${erasedCustomer},,${addressId} Main St,Killeen,TX,76541,,,false,true,,,,`
    );
    const addressRow = await db().prepare("SELECT customer_id FROM address_snapshot WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(addressRow?.customer_id).toBe(liveCustomer);
    expect(await containerExists(containerId)).toBe(false);
    // The skipped UPDATE trigger records lineage (dropping its INSERT leaves
    // nothing for the container trigger to key on).
    const lineage = await db().prepare("SELECT customer_id FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(lineage?.customer_id).toBe(erasedCustomer);

    // Lineage alone must suppress the erased owner's containers even with the
    // row gone: the replayed INSERT is skipped, not stored.
    await syncContainerSnapshotFromCsvText(
      db(),
      `${CONTAINER_HEADER}\n${containerId},${addressId},,SN-ERASED-OWNER,,false,,false,,,true,99 Erased Owner Ave,Killeen,TX,76541,`
    );
    expect(await containerExists(containerId)).toBe(false);

    // A second re-home between erased owners refreshes the mapping (the
    // lineage upsert is DO UPDATE, not DO NOTHING).
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(secondErasedCustomer).run();
    await syncAddressSnapshotFromCsvText(
      db(),
      `${ADDRESS_HEADER}\n${addressId},${secondErasedCustomer},,${addressId} Main St,Killeen,TX,76541,,,false,true,,,,`
    );
    const refreshed = await db().prepare("SELECT customer_id FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).first<{ customer_id: number }>();
    expect(refreshed?.customer_id).toBe(secondErasedCustomer);
    expect(await containerExists(containerId)).toBe(false);

    // Every later tick runs these three stages in order: the address stage
    // used to FK-abort on the stale parent with its live child, blocking the
    // container stage forever. Now it succeeds and nothing stale is left.
    const stamp = "2026-10-20T00:00:00.000Z";
    await expect(
      syncCustomerSnapshotFromStream(
        db(),
        stringToUint8Stream(`CustomerID,CompanyName,Enabled\n${liveCustomer},Live,true\n`),
        80,
        { reconcile: true, syncedAt: stamp }
      )
    ).resolves.toMatchObject({ upserted: 1 });
    await expect(
      syncAddressSnapshotFromStream(
        db(),
        stringToUint8Stream(`${ADDRESS_HEADER}\n${addressId},${secondErasedCustomer},,${addressId} Main St,Killeen,TX,76541,,,false,true,,,,\n`),
        80,
        { reconcile: true, syncedAt: stamp }
      )
    ).resolves.toMatchObject({ upserted: 1 });
    await expect(
      syncContainerSnapshotFromStream(
        db(),
        stringToUint8Stream(`${CONTAINER_HEADER}\n${containerId},${addressId},,SN-ERASED-OWNER,,false,,false,,,true,99 Erased Owner Ave,Killeen,TX,76541,\n`),
        50,
        { reconcile: true, syncedAt: stamp }
      )
    ).resolves.toMatchObject({ upserted: 1 });
    expect(await addressExists(addressId)).toBe(false);
    expect(await containerExists(containerId)).toBe(false);
    expect(await customerExists(liveCustomer)).toBe(true);

    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(liveCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = ?").bind(addressId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(erasedCustomer).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(secondErasedCustomer).run();
  });

  it("runs the documented backfill against re-inserted rows and survives a reconciling sync", async () => {
    const customerId = 9931;
    const addressId = 9931;
    const containerId = 9931;
    // Pre-migration erasure whose rows the next sync already re-inserted.
    await db().prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Synthetic', 1, '2026-10-01')").bind(customerId).run();
    await db().prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, '2026-10-01')").bind(addressId, customerId).run();
    await db().prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (?, ?, 'SN-9931', 1, '2026-10-01')").bind(containerId, addressId).run();

    // docs/R2-RETENTION.md backfill: marker first, then FK-order deletes.
    await db().prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (?, '2026-10-15T00:00:00.000Z')").bind(customerId).run();
    await db().prepare("DELETE FROM container_snapshot WHERE pickup_address_id IN (SELECT pickup_address_id FROM address_snapshot WHERE customer_id = ?)").bind(customerId).run();
    await db().prepare("DELETE FROM address_snapshot WHERE customer_id = ?").bind(customerId).run();
    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(customerId).run();

    // The documented verify step: marker remains, every row is gone.
    expect(await db().prepare("SELECT customer_id FROM customer_snapshot_erasure WHERE customer_id = ?").bind(customerId).first()).not.toBeNull();
    expect(await customerExists(customerId)).toBe(false);
    expect(await addressExists(addressId)).toBe(false);
    expect(await containerExists(containerId)).toBe(false);

    // A marker over remaining rows would freeze the customer without
    // restamping it, so the next reconciling report sync's stale-row delete
    // hits the address FK. With the rows deleted it passes and deletes nothing
    // it should keep.
    const liveId = 9932;
    await expect(
      syncCustomerSnapshotFromStream(
        db(),
        stringToUint8Stream(`CustomerID,CompanyName,Enabled\n${liveId},Live,true\n`),
        80,
        { reconcile: true, syncedAt: "2026-10-20T00:00:00.000Z" }
      )
    ).resolves.toMatchObject({ upserted: 1 });
    expect(await customerExists(customerId)).toBe(false);
    expect(await containerExists(containerId)).toBe(false);

    await db().prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(liveId).run();
    await db().prepare("DELETE FROM customer_snapshot_erasure WHERE customer_id = ?").bind(customerId).run();
  });
});
