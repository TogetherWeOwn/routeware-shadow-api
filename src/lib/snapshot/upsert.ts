import type { AddressSnapshotRow } from "../csvAddressSnapshot";
import type { ContainerSnapshotRow } from "../csvContainerSnapshot";
import type { CustomerSnapshotRow } from "../csvCustomerSnapshot";
import {
  ADDR_R_PER_STMT,
  CONT_R_PER_STMT,
  CUST_R_PER_STMT,
  addressBindings,
  addressMultiInsertSql,
  containerBindings,
  containerMultiInsertSql,
  customerBindings,
  customerMultiInsertSql
} from "./tableSql";

/**
 * Foreign keys (`address.customer_id`, `container.pickup_address_id`) are
 * declared in the schema but D1 does not enforce them (no `PRAGMA foreign_keys`),
 * and a streamed sync spans many `db.batch` calls rather than one transaction —
 * so integrity relies on import order (customer → address → container) plus the
 * reconcile step below, not on the database. A report `sync` (not `import`)
 * deletes rows not seen in the current run so upstream deletions are reflected;
 * it is skipped when a run yields zero data rows to avoid wiping a table on a
 * bad/empty export.
 *
 * That skip-on-empty guard is not in this module: it is the
 * `options.reconcile && cols && dataRows > 0` condition applied per table in
 * `./streamSync`, which is the only caller of `reconcileDeleteStale`.
 */

/**
 * Delete rows whose `synced_at` predates this run (i.e. not present upstream anymore).
 *
 * Internal to `src/lib/snapshot/` — exported only so `./streamSync` can call it,
 * and deliberately not re-exported from `../d1SnapshotSync`. `table` interpolates
 * directly into the SQL, so it is constrained to a literal union and must only
 * ever be called with a literal: never pass caller-controlled text.
 */
export async function reconcileDeleteStale(
  db: D1Database,
  table: "customer_snapshot" | "address_snapshot" | "container_snapshot",
  syncedAt: string
): Promise<number> {
  const res = await db
    .prepare(`DELETE FROM ${table} WHERE synced_at < ?`)
    .bind(syncedAt)
    .run();
  return res.meta.changes ?? 0;
}

/** Reconcile one complete customer graph, including containers of removed addresses. */
export async function reconcileCustomerChildren(
  db: D1Database,
  customerId: number,
  syncedAt: string
): Promise<{ addressIds: number[]; containerIds: number[] }> {
  // Keep the address scope alive until its containers have been deleted. Batch
  // makes the two deletes atomic; RETURNING also gives cache invalidation the
  // removed ids without a racy read-before-delete or a large IN bind list.
  const [containers, addresses] = await db.batch<{ id: number }>([
    db.prepare(`DELETE FROM container_snapshot
      WHERE pickup_address_id IN (
        SELECT pickup_address_id FROM address_snapshot WHERE customer_id = ?
      ) AND synced_at < ? RETURNING container_id AS id`).bind(customerId, syncedAt),
    db.prepare(`DELETE FROM address_snapshot
      WHERE customer_id = ? AND synced_at < ?
      RETURNING pickup_address_id AS id`).bind(customerId, syncedAt)
  ]);
  return {
    addressIds: addresses.results.map((r) => r.id),
    containerIds: containers.results.map((r) => r.id)
  };
}

export type SnapshotSyncCounts = {
  upserted: number;
  rowCount: number;
  deleted: number;
};

export type StreamSyncOptions = {
  /** Delete rows not seen in this run (report sync). Off for partial imports. */
  reconcile?: boolean;
  /** Observation boundary captured before fetching the report, not after download. */
  syncedAt?: string;
};

export async function upsertCustomerSnapshotRows(
  db: D1Database,
  rows: CustomerSnapshotRow[],
  batchSize = 80,
  syncedAt = new Date().toISOString()
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const stmts: D1PreparedStatement[] = [];
    for (let j = 0; j < chunk.length; j += CUST_R_PER_STMT) {
      const n = Math.min(CUST_R_PER_STMT, chunk.length - j);
      const slice = chunk.slice(j, j + n);
      const flat = slice.flatMap((r) => customerBindings(r, syncedAt));
      stmts.push(db.prepare(customerMultiInsertSql(n)).bind(...flat));
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(
        `D1 customer_snapshot batch at row offset ${i} (${chunk.length} rows, ${stmts.length} SQL ops): ${m}`,
        { cause: e }
      );
    }
    upserted += chunk.length;
  }
  return { upserted };
}

export async function upsertAddressSnapshotRows(
  db: D1Database,
  rows: AddressSnapshotRow[],
  batchSize = 80,
  syncedAt = new Date().toISOString()
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const stmts: D1PreparedStatement[] = [];
    for (let j = 0; j < chunk.length; j += ADDR_R_PER_STMT) {
      const n = Math.min(ADDR_R_PER_STMT, chunk.length - j);
      const slice = chunk.slice(j, j + n);
      const flat = slice.flatMap((r) => addressBindings(r, syncedAt));
      stmts.push(db.prepare(addressMultiInsertSql(n)).bind(...flat));
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(
        `D1 address_snapshot batch at row offset ${i} (${chunk.length} rows, ${stmts.length} SQL ops): ${m}`,
        { cause: e }
      );
    }
    upserted += chunk.length;
  }
  return { upserted };
}

export async function upsertContainerSnapshotRows(
  db: D1Database,
  rows: ContainerSnapshotRow[],
  batchSize = 50,
  syncedAt = new Date().toISOString()
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const stmts: D1PreparedStatement[] = [];
    for (let j = 0; j < chunk.length; j += CONT_R_PER_STMT) {
      const n = Math.min(CONT_R_PER_STMT, chunk.length - j);
      const slice = chunk.slice(j, j + n);
      const flat = slice.flatMap((r) => containerBindings(r, syncedAt));
      stmts.push(db.prepare(containerMultiInsertSql(n)).bind(...flat));
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(
        `D1 container_snapshot batch at row offset ${i} (${chunk.length} rows, ${stmts.length} SQL ops): ${m}`,
        { cause: e }
      );
    }
    upserted += chunk.length;
  }
  return { upserted };
}
