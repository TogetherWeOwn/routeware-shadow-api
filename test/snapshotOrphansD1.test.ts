import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getSnapshotOrphans } from "../src/lib/snapshot/reconcile";

/**
 * Real local D1 regression for an import repairing parents during an audit.
 * These minimal fixture tables deliberately lack FKs to model legacy or
 * out-of-band data; the production migrations and FK enforcement are unchanged.
 */
const db = (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;

beforeAll(async () => {
  await db.batch([
    db.prepare("CREATE TABLE customer_snapshot (customer_id INTEGER PRIMARY KEY)"),
    db.prepare(
      "CREATE TABLE address_snapshot (pickup_address_id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL)"
    ),
    db.prepare(
      "CREATE TABLE container_snapshot (container_id INTEGER PRIMARY KEY, pickup_address_id INTEGER NOT NULL)"
    ),
    db.prepare("INSERT INTO customer_snapshot VALUES (1)"),
    db.prepare("INSERT INTO address_snapshot VALUES (10, 1), (12, 3), (11, 2)"),
    db.prepare("INSERT INTO container_snapshot VALUES (100, 10), (101, 11), (102, 99)")
  ]);
});

describe("getSnapshotOrphans with local D1", () => {
  it("keeps both counts and samples consistent when missing parents arrive", async () => {
    let repaired = false;
    const batchSizes: number[] = [];

    async function repairParents() {
      if (repaired) return;
      await db.batch([
        db.prepare("INSERT INTO customer_snapshot VALUES (2), (3)"),
        db.prepare("INSERT INTO address_snapshot VALUES (99, 1)")
      ]);
      repaired = true;
    }

    // Inject the repair immediately after the first completed read operation.
    // For the old implementation that is COUNT.first(): its following samples
    // see repaired parents. A batch finishes all four reads before the repair.
    const originals = new Map<D1PreparedStatement, D1PreparedStatement>();
    const interleavedDb = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        const wrapped = {
          bind: (...values: unknown[]) => statement.bind(...values),
          async first<T>() {
            const row = await statement.first<T>();
            await repairParents();
            return row;
          }
        } as unknown as D1PreparedStatement;
        originals.set(wrapped, statement);
        return wrapped;
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        batchSizes.push(statements.length);
        const results = await db.batch<T>(
          statements.map((statement) => originals.get(statement) ?? statement)
        );
        await repairParents();
        return results;
      }
    } as unknown as D1Database;

    const report = await getSnapshotOrphans(interleavedDb);

    expect(repaired).toBe(true);
    expect(report).toEqual({
      orphanAddresses: { count: 2, sampleIds: [11, 12] },
      orphanContainers: { count: 1, sampleIds: [102] }
    });
    expect(batchSizes).toEqual([4]);
    expect(await getSnapshotOrphans(db)).toEqual({
      orphanAddresses: { count: 0, sampleIds: [] },
      orphanContainers: { count: 0, sampleIds: [] }
    });
  });
});
