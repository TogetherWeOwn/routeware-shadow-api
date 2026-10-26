import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  CONTAINER_READ_CHUNK_SIZE,
  getCustomerBundleFromD1
} from "../src/lib/dataEntityRead";
import { D1_MAX_BINDS } from "../src/lib/snapshot/tableSql";
import {
  upsertAddressSnapshotRows,
  upsertContainerSnapshotRows,
  upsertCustomerSnapshotRows
} from "../src/lib/snapshot/upsert";
import type { AddressSnapshotRow } from "../src/lib/csvAddressSnapshot";
import type { ContainerSnapshotRow } from "../src/lib/csvContainerSnapshot";
import type { CustomerSnapshotRow } from "../src/lib/csvCustomerSnapshot";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * `getCustomerBundleFromD1` fanned container reads out in `IN (...)`
 * chunks of exactly 100 binds — equal to D1's 100-bind cap — so a ~100-address
 * customer risked a bind-limit 500 on `GET /api/v1/data/customer`.
 *
 * Two complementary proofs, because neither alone closes the case:
 *
 * 1. A cap-enforcing fake D1 throws on any container read with binds at/above
 *    the cap. Miniflare's local SQLite does not enforce D1's service-side bind
 *    limit, so a seeded-D1 test alone cannot prove the margin — this fake does.
 *    It fails on the old `BIND_CHUNK = 100` code (one 100-bind query) and
 *    passes with chunking below the cap.
 * 2. A seeded-D1 test with 120 addresses proves the real read path serves a
 *    100+-address customer end to end (the acceptance's "gets 200" substance
 *    at the read layer; the non-null bundle → 200 mapping is pinned in
 *    `test/dataEntityHandlers.test.ts`).
 *
 * Fixtures are synthetic ids with null names — no PII (CONVENTIONS.md § 4-5).
 */

const CUSTOMER_ID = 9001;

function customerRow(): CustomerSnapshotRow {
  return {
    customerId: CUSTOMER_ID,
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
}

function addressRow(n: number): AddressSnapshotRow {
  return {
    pickupAddressId: 91_000 + n,
    customerId: CUSTOMER_ID,
    routeId: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    franchiseId: null,
    comments: null,
    extrasAllowed: true,
    enabled: true,
    driverNote: null,
    latitude: null,
    longitude: null,
    lastAuditDate: null
  };
}

function containerRow(n: number): ContainerSnapshotRow {
  return {
    containerId: 92_000 + n,
    pickupAddressId: 91_000 + n,
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

/**
 * Fake D1 that enforces the bind cap the way the D1 service does: any
 * container read binding at/above `D1_MAX_BINDS` parameters throws instead
 * of returning rows. Records per-query bind counts so tests can prove the
 * margin, not just the absence of a throw.
 */
function capEnforcingDb(addressCount: number) {
  const stats = { containerQueries: 0, maxBinds: 0 };
  const addresses = Array.from({ length: addressCount }, (_, n) => ({
    pickup_address_id: 91_000 + n,
    customer_id: CUSTOMER_ID
  }));
  const containers = Array.from({ length: addressCount }, (_, n) => ({
    container_id: 92_000 + n,
    pickup_address_id: 91_000 + n
  }));
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM customer_snapshot")) {
                return { customer_id: CUSTOMER_ID } as T;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes("FROM address_snapshot")) {
                return { results: addresses as T[] };
              }
              if (sql.includes("FROM container_snapshot")) {
                stats.containerQueries += 1;
                stats.maxBinds = Math.max(stats.maxBinds, args.length);
                if (args.length >= D1_MAX_BINDS) {
                  throw new Error(
                    `D1_ERROR: too many SQL variables (binds=${args.length}, cap=${D1_MAX_BINDS})`
                  );
                }
                const ids = new Set(args as number[]);
                return {
                  results: containers.filter((c) => ids.has(c.pickup_address_id)) as T[]
                };
              }
              return { results: [] as T[] };
            }
          };
        }
      };
    }
  };
  return { db: db as unknown as D1Database, stats };
}

describe("customer-bundle bind chunking", () => {
  it("sizes the chunk strictly below the D1 bind cap", () => {
    // Arrange / Act / Assert — the static margin proof. If D1 ever lowers
    // the cap, this fails at the constant rather than in production.
    expect(CONTAINER_READ_CHUNK_SIZE).toBeLessThan(D1_MAX_BINDS);
  });

  it("serves exactly 100 addresses without touching the cap", async () => {
    // Arrange — the incident size: the old chunk of 100 issued a single
    // 100-bind query here, which this fake rejects.
    const { db, stats } = capEnforcingDb(100);

    // Act
    const bundle = await getCustomerBundleFromD1(db, CUSTOMER_ID);

    // Assert — complete graph, spread over two sub-cap queries.
    expect(bundle).not.toBeNull();
    expect(bundle!.addresses).toHaveLength(100);
    expect(stats.containerQueries).toBe(2);
    expect(stats.maxBinds).toBeLessThan(D1_MAX_BINDS);
    for (const a of bundle!.addresses) {
      expect(a.containers).toHaveLength(1);
    }
  });

  it("chunks a 120-address customer and returns every container", async () => {
    // Arrange
    const { db, stats } = capEnforcingDb(120);

    // Act
    const bundle = await getCustomerBundleFromD1(db, CUSTOMER_ID);

    // Assert
    expect(bundle).not.toBeNull();
    expect(bundle!.addresses).toHaveLength(120);
    expect(stats.containerQueries).toBe(
      Math.ceil(120 / CONTAINER_READ_CHUNK_SIZE)
    );
    expect(stats.maxBinds).toBeLessThan(D1_MAX_BINDS);
    expect(
      bundle!.addresses.reduce((n, a) => n + a.containers.length, 0)
    ).toBe(120);
  });
});

describe("100+-address customer against seeded D1", () => {
  const db = env.CUSTOMER_DB;

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM container_snapshot"),
      db.prepare("DELETE FROM address_snapshot"),
      db.prepare("DELETE FROM customer_snapshot")
    ]);
    const syncedAt = new Date().toISOString();
    await upsertCustomerSnapshotRows(db, [customerRow()], 80, syncedAt);
    await upsertAddressSnapshotRows(
      db,
      Array.from({ length: 120 }, (_, n) => addressRow(n)),
      80,
      syncedAt
    );
    await upsertContainerSnapshotRows(
      db,
      Array.from({ length: 120 }, (_, n) => containerRow(n)),
      50,
      syncedAt
    );
  });

  it("reads a 120-address customer whole: 200-substance at the read layer", async () => {
    // Arrange / Act — the multi-chunk path against real D1 tables.
    const bundle = await getCustomerBundleFromD1(db, CUSTOMER_ID);

    // Assert — a non-null, complete bundle is what the handler maps to 200
    // (the 404 branch is pinned in `test/dataEntityHandlers.test.ts`).
    expect(bundle).not.toBeNull();
    expect(bundle!.addresses).toHaveLength(120);
    for (const a of bundle!.addresses) {
      expect(a.containers).toHaveLength(1);
      expect(a.containers[0].pickup_address_id).toBe(a.pickup_address_id);
    }
  });
});
