import { beforeAll, describe, expect, it } from "vitest";

/**
 * TOG-8876: `DELETE /api/v1/customer-snapshot/{customerId}` erases one
 * customer row from the cached report extract.
 *
 * This is the GDPR-style erasure half of the R3 gap "no snapshot row erasure
 * endpoint (609k PII rows, no GDPR-style delete API; only internal reconcile
 * DELETEs)". It deletes the D1 extract row only — upstream Routeware is never
 * touched (it exposes no customer hard delete; `DELETE
 * /api/v1/routeware/customer` 405s per `docs/PROBLEMS.md#method-not-allowed`).
 *
 * FK-safe by refusal, not by cascade: D1 enforces the snapshot FK chain
 * unconditionally, so deleting a customer that still has address rows fails
 * closed and is mapped to 400 `bad-request` naming the blocking children —
 * an orphan is never written.
 *
 * Against the REAL D1 in the workerd pool (not a fake), through the real
 * route module (migrated via `./d1TestMigrations`) — the
 * `test/snapshotImportForeignKey.test.ts` pattern. Synthetic ids only
 * (95xx range — 90xx/91xx/92xx/93xx are taken by sibling FK/contract files;
 * the pool shares one D1, top-to-bottom). Deliberately does NOT assert
 * problem+json wording owned by `test/snapshotAuth.test.ts`, nor the
 * OpenAPI pin owned by `test/openapiContract.test.ts`.
 */

import { env } from "cloudflare:workers";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import { customerSnapshotRoutes } from "../src/routes/customerSnapshot";
import { ensureD1TestTables } from "./d1TestMigrations";

const BAD_REQUEST_TYPE = `${PROBLEM_TYPE_BASE}bad-request`;
const NOT_FOUND_TYPE = `${PROBLEM_TYPE_BASE}not-found`;
const PROBLEM_JSON = "application/problem+json";

const SYNCED_AT = "2026-09-28T00:00:00.000Z";

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

/** The pool's own sync secret — matches the inner gate in every environment. */
function syncSecret(): string {
  return (env as unknown as { CUSTOMER_SNAPSHOT_SYNC_SECRET: string })
    .CUSTOMER_SNAPSHOT_SYNC_SECRET;
}

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
};

type DeleteBody = ProblemBody & { customerId?: number; deleted?: number };

async function erase(
  customerId: number | string
): Promise<{ status: number; contentType: string | null; body: DeleteBody }> {
  const requestEnv = {
    CUSTOMER_DB: db(),
    CUSTOMER_SNAPSHOT_SYNC_SECRET: syncSecret()
  } as unknown as Env;
  const ctx = {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  const resp = await customerSnapshotRoutes.fetch(
    new Request(`http://test.local/api/v1/customer-snapshot/${customerId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${syncSecret()}` }
    }),
    requestEnv,
    ctx
  );
  const body = (await resp.json()) as DeleteBody;
  return { status: resp.status, contentType: resp.headers.get("content-type"), body };
}

async function seedCustomer(customerId: number): Promise<void> {
  await db()
    .prepare(
      "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Erasure Probe', 1, ?)"
    )
    .bind(customerId, SYNCED_AT)
    .run();
}

async function seedAddress(pickupId: number, customerId: number): Promise<void> {
  await db()
    .prepare(
      "INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (?, ?, 1, ?)"
    )
    .bind(pickupId, customerId, SYNCED_AT)
    .run();
}

async function customerRow(customerId: number): Promise<{ customer_id: number } | null> {
  return db()
    .prepare("SELECT customer_id FROM customer_snapshot WHERE customer_id = ?")
    .bind(customerId)
    .first<{ customer_id: number }>();
}

async function readRow(customerId: number): Promise<Response> {
  const requestEnv = {
    CUSTOMER_DB: db(),
    CUSTOMER_SNAPSHOT_SYNC_SECRET: syncSecret()
  } as unknown as Env;
  const ctx = {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return customerSnapshotRoutes.fetch(
    new Request(`http://test.local/api/v1/customer-snapshot/${customerId}`, {
      headers: { authorization: `Bearer ${syncSecret()}` }
    }),
    requestEnv,
    ctx
  );
}

describe("customer snapshot row erasure (TOG-8876)", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  it("deletes a childless row, then GET 404s for the same id", async () => {
    // Arrange — customer 9501 has no addresses.
    await seedCustomer(9501);

    // Act
    const res = await erase(9501);

    // Assert — exact 200 shape, and the row is really gone.
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    expect(res.body).toEqual({ customerId: 9501, deleted: 1 });
    expect(await customerRow(9501)).toBeNull();

    // Assert — the by-id read now 404s on the erased id.
    const reread = await readRow(9501);
    expect(reread.status).toBe(404);
    const rereadBody = (await reread.json()) as ProblemBody;
    expect(rereadBody.type).toBe(NOT_FOUND_TYPE);
  });

  it("deleting an absent id 404s", async () => {
    // Arrange — 9502 is never seeded.

    // Act
    const res = await erase(9502);

    // Assert
    expect(res.status).toBe(404);
    expect(res.contentType).toContain(PROBLEM_JSON);
    expect(res.body.type).toBe(NOT_FOUND_TYPE);
    expect(res.body.title).toBe("Not Found");
    expect(res.body.detail).toBe(
      "No snapshot row for customer_id=9502. See docs/PROBLEMS.md#not-found."
    );
  });

  it("refuses a customer with live address children as 400, deleting nothing", async () => {
    // Arrange — 9503 keeps address 9503 (D1 enforces the FK unconditionally).
    await seedCustomer(9503);
    await seedAddress(9503, 9503);

    // Act
    const res = await erase(9503);

    // Assert — FK-safe by refusal: 400 naming the blocking child keys…
    expect(res.status).toBe(400);
    expect(res.contentType).toContain(PROBLEM_JSON);
    expect(res.body.type).toBe(BAD_REQUEST_TYPE);
    expect(res.body.title).toBe("Bad Request");
    expect(res.body.detail).toContain("Cannot delete customer_id=9503");
    expect(res.body.detail).toContain("pickup_address_id=9503");
    expect(res.body.detail).toContain("See docs/PROBLEMS.md#bad-request.");

    // …and nothing was removed: both the parent and the child survive.
    expect(await customerRow(9503)).not.toBeNull();
    const child = await db()
      .prepare("SELECT pickup_address_id FROM address_snapshot WHERE pickup_address_id = 9503")
      .first<{ pickup_address_id: number }>();
    expect(child).not.toBeNull();

    // Cleanup — remove the child so this probe leaves no residue behind.
    await db()
      .prepare("DELETE FROM address_snapshot WHERE pickup_address_id = 9503")
      .run();
    await db()
      .prepare("DELETE FROM customer_snapshot WHERE customer_id = 9503")
      .run();
  });

  it("rejects a non-numeric id at the schema before any query runs", async () => {
    // Act
    const res = await erase("abc");

    // Assert
    expect(res.status).toBe(400);
    expect(res.contentType).toContain(PROBLEM_JSON);
    expect(res.body.type).toBe(BAD_REQUEST_TYPE);
  });

  it("rejects the API token at the inner sync-secret check", async () => {
    // Arrange — a valid outer-gate token that is NOT the sync secret. Reads
    // the pool env rather than hardcoding, so this holds in every env.
    const apiToken = (env as unknown as { SHADOW_API_TOKEN?: string }).SHADOW_API_TOKEN;
    if (!apiToken) {
      return;
    }
    const requestEnv = {
      CUSTOMER_DB: db(),
      CUSTOMER_SNAPSHOT_SYNC_SECRET: syncSecret()
    } as unknown as Env;
    const ctx = {
      waitUntil() {},
      passThroughOnException() {}
    } as unknown as ExecutionContext;

    // Act
    const res = await customerSnapshotRoutes.fetch(
      new Request("http://test.local/api/v1/customer-snapshot/9504", {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiToken}` }
      }),
      requestEnv,
      ctx
    );

    // Assert — cleared the outer gate, stopped at the inner check.
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain(PROBLEM_JSON);
  });
});
