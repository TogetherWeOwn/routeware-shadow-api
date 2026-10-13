import { describe, expect, it } from "vitest";
import {
  getAddressBundleFromD1,
  getContainerBundleFromD1,
  getCustomerBundleFromD1
} from "../src/lib/dataEntityRead";

type Row = Record<string, unknown>;

/**
 * Minimal fake D1 that dispatches by SQL substring and counts container queries,
 * so we can assert the customer bundle uses a single batched IN(...) query for
 * containers rather than one query per address (the N+1 fix).
 */
function fakeDb(customer: Row | null, addresses: Row[], containers: Row[]) {
  const stats = { containerQueries: 0 };
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM customer_snapshot")) {
                return (customer as T) ?? null;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes("FROM address_snapshot")) {
                return { results: addresses as T[] };
              }
              if (sql.includes("FROM container_snapshot")) {
                stats.containerQueries += 1;
                const ids = new Set(args as number[]);
                return {
                  results: containers.filter((c) => ids.has(c.pickup_address_id as number)) as T[]
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

function fakeBundleDb(rows: {
  address?: Row | null;
  container?: Row | null;
  customer?: Row | null;
}) {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first<T>() {
              if (sql.includes("FROM address_snapshot")) {
                return (rows.address as T) ?? null;
              }
              if (sql.includes("FROM container_snapshot")) {
                return (rows.container as T) ?? null;
              }
              if (sql.includes("FROM customer_snapshot")) {
                return (rows.customer as T) ?? null;
              }
              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            }
          };
        }
      };
    }
  };
  return db as unknown as D1Database;
}

describe("getAddressBundleFromD1", () => {
  it("returns null when the address row is absent", async () => {
    expect(await getAddressBundleFromD1(fakeBundleDb({}), 10)).toBeNull();
  });

  it("returns a null customer when the parent row is absent", async () => {
    const address = { pickup_address_id: 10, customer_id: 5 };
    const bundle = await getAddressBundleFromD1(fakeBundleDb({ address }), 10);

    expect(bundle).toEqual({ address, customer: null, containers: [] });
  });
});

describe("getContainerBundleFromD1", () => {
  it("returns null when the container row is absent", async () => {
    expect(await getContainerBundleFromD1(fakeBundleDb({}), 100)).toBeNull();
  });

  it("returns null address and customer when the parent address is absent", async () => {
    const container = { container_id: 100, pickup_address_id: 10 };
    const bundle = await getContainerBundleFromD1(fakeBundleDb({ container }), 100);

    expect(bundle).toEqual({ container, address: null, customer: null });
  });

  it("returns a null customer when the address customer row is absent", async () => {
    const container = { container_id: 100, pickup_address_id: 10 };
    const address = { pickup_address_id: 10, customer_id: 5 };
    const bundle = await getContainerBundleFromD1(fakeBundleDb({ container, address }), 100);

    expect(bundle).toEqual({ container, address, customer: null });
  });
});

describe("getCustomerBundleFromD1", () => {
  it("fetches containers for all addresses in one batched query and groups them", async () => {
    const customer = { customer_id: 5, company_name: "Acme" };
    const addresses = [
      { pickup_address_id: 10, customer_id: 5 },
      { pickup_address_id: 11, customer_id: 5 }
    ];
    const containers = [
      { container_id: 100, pickup_address_id: 10 },
      { container_id: 101, pickup_address_id: 10 },
      { container_id: 102, pickup_address_id: 11 }
    ];
    const { db, stats } = fakeDb(customer, addresses, containers);

    const bundle = await getCustomerBundleFromD1(db, 5);

    expect(stats.containerQueries).toBe(1); // not one query per address
    expect(bundle).not.toBeNull();
    expect(bundle!.addresses).toHaveLength(2);
    expect(bundle!.addresses[0].containers).toHaveLength(2);
    expect(bundle!.addresses[1].containers).toHaveLength(1);
  });

  it("returns null when the customer is absent", async () => {
    const { db } = fakeDb(null, [], []);
    expect(await getCustomerBundleFromD1(db, 999)).toBeNull();
  });

  it("does not query containers when the customer has no addresses", async () => {
    const { db, stats } = fakeDb({ customer_id: 7 }, [], []);
    const bundle = await getCustomerBundleFromD1(db, 7);
    expect(stats.containerQueries).toBe(0);
    expect(bundle!.addresses).toHaveLength(0);
  });
});
