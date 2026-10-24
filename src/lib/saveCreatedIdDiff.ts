import { errorKind, logEvent } from "./logger";

/**
 * Owner-scoped id snapshots behind create-id D1 diffing (R21-05). Split from
 * `dataEntitySave.ts` under the 800-line source-file guard; behavior unchanged.
 *
 * Ids for one snapshot column under one owner — the pre/post-save snapshots
 * behind create-id D1 diffing. Rows are `INTEGER PRIMARY KEY`, so every id is
 * positive by schema and no filtering is applied.
 */
async function columnIds(db: D1Database, sql: string, owner: number): Promise<number[]> {
  const out = await db.prepare(sql).bind(owner).all<{ id: number }>();
  return out.results.map((row) => row.id);
}

/**
 * Best-effort id snapshot for create-id D1 diffing. An unavailable read
 * disables diffing (the caller keeps a null id), never the upstream save,
 * its refresh, or graph invalidation.
 */
export async function snapshotIdsQuietly(
  route: string,
  msg: string,
  work: () => Promise<number[]>
): Promise<number[] | null> {
  try {
    return await work();
  } catch (snapshotErr) {
    logEvent({
      level: "error",
      msg,
      route,
      kind: errorKind(snapshotErr)
    });
    return null;
  }
}

/** Pre-save address ids for the owning customer (R21-05 create diff input). */
export function queryCustomerAddressIds(db: D1Database, customerId: number): Promise<number[]> {
  return columnIds(
    db,
    "SELECT pickup_address_id AS id FROM address_snapshot WHERE customer_id = ? ORDER BY pickup_address_id",
    customerId
  );
}

/** Container ids scoped to one owning address (R21-05 create diff input). */
export function queryAddressContainerIds(db: D1Database, addressId: number): Promise<number[]> {
  return columnIds(
    db,
    "SELECT container_id AS id FROM container_snapshot WHERE pickup_address_id = ? ORDER BY container_id",
    addressId
  );
}

/**
 * Singleton post-minus-pre difference wins; empty/ambiguous stays null. The
 * caller keeps the existing `localSync` codes either way — resolution failure
 * is reported as a null id, never as a new outcome code.
 */
export function diffSingleton(pre: number[], post: number[]): number | null {
  const before = new Set(pre);
  const added = post.filter((id) => !before.has(id));
  // The length guard guarantees presence (`noUncheckedIndexedAccess` types
  // the index as `number | undefined`); same `!` idiom as orchestration.ts.
  return added.length === 1 ? added[0]! : null;
}
