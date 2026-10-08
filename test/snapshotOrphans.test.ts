import { describe, expect, it } from "vitest";

import { getSnapshotOrphans } from "../src/lib/snapshot/reconcile";

/**
 * D1 enforces both snapshot FK edges on writes and parent deletes. This is a
 * defensive audit for legacy or out-of-band rows in a schema without those
 * constraints, not a failure expected from normal streamed syncs.
 *
 * The fake evaluates count and sample query shapes in a single batch, keyed
 * off the parent table in each anti-join. The real D1 regression lives in
 * `test/snapshotOrphansD1.test.ts`.
 */

type OrphanFixture = {
  /** customer_ids present in `customer_snapshot`. */
  customers: number[];
  /** [pickup_address_id, customer_id] rows in `address_snapshot`. */
  addresses: Array<[number, number]>;
  /** [container_id, pickup_address_id] rows in `container_snapshot`. */
  containers: Array<[number, number]>;
};

function orphanDb(fixture: OrphanFixture): {
  db: D1Database;
  queries: string[];
} {
  const customerIds = new Set(fixture.customers);
  const addressIds = new Set(fixture.addresses.map(([id]) => id));
  const queries: string[] = [];

  function edgeOf(sql: string): "address" | "container" {
    // Both count and sample queries join the child edge to its parent; the
    // parent table named in the JOIN identifies the edge.
    return sql.includes("customer_snapshot") ? "address" : "container";
  }

  function orphans(edge: "address" | "container"): number[] {
    if (edge === "address") {
      return fixture.addresses
        .filter(([, customerId]) => !customerIds.has(customerId))
        .map(([id]) => id)
        .sort((a, b) => a - b);
    }
    return fixture.containers
      .filter(([, addressId]) => !addressIds.has(addressId))
      .map(([id]) => id)
      .sort((a, b) => a - b);
  }

  type Statement = { sql: string; limit?: number };
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      const statement: Statement = { sql };
      return {
        ...statement,
        bind(...binds: unknown[]) {
          queries.push(`BIND ${binds.join(",")}`);
          return { ...statement, limit: Number(binds[0]) };
        }
      };
    },
    async batch(statements: Statement[]) {
      queries.push(`BATCH ${statements.length}`);
      return statements.map(({ sql, limit }) => {
        const ids = orphans(edgeOf(sql));
        return {
          results: sql.includes("COUNT(*)")
            ? [{ n: ids.length }]
            : ids.slice(0, limit).map((id) => ({ id }))
        };
      });
    }
  };
  return { db: db as unknown as D1Database, queries };
}

/** Seeded orphans on both edges plus one healthy row per table. */
const MIXED: OrphanFixture = {
  customers: [1],
  addresses: [
    [10, 1], // healthy: customer 1 exists
    [11, 2], // orphan: customer 2 was never imported
    [12, 3] // orphan: legacy row written without FK enforcement
  ],
  containers: [
    [100, 10], // healthy: address 10 exists
    [101, 11], // NOT an orphan: address 11 exists (even though it is itself orphaned)
    [102, 99] // orphan: address 99 was never imported
  ]
};

describe("getSnapshotOrphans", () => {
  it("reports fixture orphans on each edge with deterministic id samples", async () => {
    // Arrange — addresses 11/12 lack customers; container 102 lacks an
    // address. Container 101's parent exists, so it is not reported even
    // though its grandparent is missing.
    const { db, queries } = orphanDb(MIXED);

    // Act
    const report = await getSnapshotOrphans(db);

    // Assert
    expect(report).toEqual({
      orphanAddresses: { count: 2, sampleIds: [11, 12] },
      orphanContainers: { count: 1, sampleIds: [102] }
    });
    expect(queries.filter((q) => q.startsWith("BATCH"))).toEqual(["BATCH 4"]);
  });

  it("reports zeros when every row has its parent", async () => {
    // Arrange
    const { db } = orphanDb({
      customers: [1],
      addresses: [[10, 1]],
      containers: [[100, 10]]
    });

    // Act
    const report = await getSnapshotOrphans(db);

    // Assert
    expect(report).toEqual({
      orphanAddresses: { count: 0, sampleIds: [] },
      orphanContainers: { count: 0, sampleIds: [] }
    });
  });

  it("caps each id sample at the requested limit while keeping full counts", async () => {
    // Arrange — five orphan addresses; a limit of 2 samples only two.
    const { db, queries } = orphanDb({
      customers: [],
      addresses: [
        [1, 9],
        [2, 9],
        [3, 9],
        [4, 9],
        [5, 9]
      ],
      containers: []
    });

    // Act
    const report = await getSnapshotOrphans(db, 2);

    // Assert — the count still sees all five; only the sample is truncated.
    expect(report.orphanAddresses).toEqual({ count: 5, sampleIds: [1, 2] });
    expect(queries.filter((q) => q === "BIND 2")).toHaveLength(2);
  });

  it("clamps an over-limit request to the 500 ceiling", async () => {
    // Arrange
    const { db, queries } = orphanDb(MIXED);

    // Act
    const report = await getSnapshotOrphans(db, 10_000);

    // Assert — the bind carries 500, not 10000; the fixture still resolves.
    expect(queries.filter((q) => q === "BIND 500")).toHaveLength(2);
    expect(report.orphanAddresses.count).toBe(2);
  });

  it.each([
    [0, 1],
    [-5, 1],
    [2.9, 2],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100]
  ])("clamps library sampleLimit %s to %s", async (requested, expected) => {
    const { db, queries } = orphanDb(MIXED);
    await getSnapshotOrphans(db, requested);
    expect(queries.filter((q) => q === `BIND ${expected}`)).toHaveLength(2);
  });

  it("propagates a failed batch instead of reporting a healthy zero", async () => {
    const { db } = orphanDb(MIXED);
    db.batch = async () => {
      throw new Error("D1 audit unavailable");
    };
    await expect(getSnapshotOrphans(db)).rejects.toThrow("D1 audit unavailable");
  });

  it("uses anti-joins so containers with present addresses are never reported", async () => {
    // Arrange — container 101's address exists; only the JOIN-based orphan
    // predicate can distinguish it from container 102.
    const { db, queries } = orphanDb(MIXED);

    // Act
    await getSnapshotOrphans(db);

    // Assert — LEFT JOIN + IS NULL on both edges, and the container edge
    // joins addresses (not customers).
    expect(queries.some((q) => q.includes("LEFT JOIN customer_snapshot"))).toBe(true);
    expect(queries.some((q) => q.includes("LEFT JOIN address_snapshot"))).toBe(true);
    expect(queries.some((q) => q.includes("c.customer_id IS NULL"))).toBe(true);
    expect(queries.some((q) => q.includes("a.pickup_address_id IS NULL"))).toBe(true);
  });

  it("orders each sample by primary key for deterministic paging", async () => {
    // Arrange
    const { db, queries } = orphanDb(MIXED);

    // Act
    await getSnapshotOrphans(db);

    // Assert
    expect(queries.some((q) => q.includes("ORDER BY a.pickup_address_id"))).toBe(true);
    expect(queries.some((q) => q.includes("ORDER BY t.container_id"))).toBe(true);
  });
});
