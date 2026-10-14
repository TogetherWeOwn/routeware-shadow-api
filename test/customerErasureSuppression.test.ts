import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { customerSnapshotRoutes } from "../src/routes/customerSnapshot";
import { syncCustomerSnapshotFromCsvText } from "../src/lib/snapshot/streamSync";
import { upsertCustomerSnapshotRows } from "../src/lib/snapshot/upsert";
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
