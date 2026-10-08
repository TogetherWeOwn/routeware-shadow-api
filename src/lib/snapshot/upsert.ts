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
 * declared in the schema and enforced by D1 unconditionally in every
 * transaction/batch — an orphan row is rejected with
 * `FOREIGN KEY constraint failed`, not just convention — so integrity relies
 * on import order (customer → address → container) plus the reconcile step
 * below. A dangling-FK batch surfaces as `SnapshotForeignKeyError` (mapped to
 * 400 `bad-request` by the snapshot routes) rather than the generic batch
 * error. A report `sync` (not `import`)
 * deletes rows not seen in the current run so upstream deletions are reflected;
 * it is skipped when a run yields zero data rows to avoid wiping a table on a
 * bad/empty export.
 *
 * That skip-on-empty guard is not in this module: it is the
 * `options.reconcile && cols && dataRows > 0` condition applied per table in
 * `./streamSync`, which is the only caller of `reconcileDeleteStale`.
 */

/**
 * A D1 batch rejected for a dangling foreign key: the chunk references parent
 * rows that do not exist. Carries integer keys only (no PII, no secrets).
 */
export class SnapshotForeignKeyError extends Error {
  readonly table: "address_snapshot" | "container_snapshot";
  readonly column: "customer_id" | "pickup_address_id";
  readonly parentTable: "customer_snapshot" | "address_snapshot";
  /** Distinct missing parent keys, ascending. */
  readonly missingKeys: number[];
  /** Row offset of the failed chunk within the upsert call. */
  readonly rowOffset: number;

  constructor(
    opts: {
      table: "address_snapshot" | "container_snapshot";
      column: "customer_id" | "pickup_address_id";
      parentTable: "customer_snapshot" | "address_snapshot";
      missingKeys: number[];
      rowOffset: number;
    },
    options?: ErrorOptions
  ) {
    super(
      `D1 ${opts.table} foreign key violation at row offset ${opts.rowOffset}: ` +
        `${opts.missingKeys.length} missing ${opts.parentTable} key(s)`,
      options
    );
    this.name = "SnapshotForeignKeyError";
    this.table = opts.table;
    this.column = opts.column;
    this.parentTable = opts.parentTable;
    this.missingKeys = opts.missingKeys;
    this.rowOffset = opts.rowOffset;
  }
}

/** True when a D1 error message reports a foreign-key constraint failure. */
export function isForeignKeyConstraintFailure(msg: string): boolean {
  return /foreign key constraint failed/i.test(msg);
}

/**
 * Walk the `cause` chain for a `SnapshotForeignKeyError`. The snapshot sync
 * routes use this to map a dangling-FK failure (possibly wrapped with
 * `[step]` context by `orchestration.ts`) to 400 `bad-request`.
 */
export function findForeignKeyError(err: unknown): SnapshotForeignKeyError | null {
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (
    cur !== null &&
    cur !== undefined &&
    (typeof cur === "object" || typeof cur === "function") &&
    !seen.has(cur)
  ) {
    if (cur instanceof SnapshotForeignKeyError) {
      return cur;
    }
    seen.add(cur);
    const cause = (cur as { cause?: unknown }).cause;
    if (cause === undefined) {
      break;
    }
    cur = cause;
  }
  return null;
}

/** True when the error or any error in its `cause` chain names an FK failure. */
function batchFailedOnForeignKey(err: unknown): boolean {
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    const msg =
      cur instanceof Error ? cur.message : typeof cur === "string" ? cur : null;
    if (msg !== null && isForeignKeyConstraintFailure(msg)) {
      return true;
    }
    if (typeof cur !== "object" && typeof cur !== "function") {
      break;
    }
    seen.add(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Error-path-only parent lookup: given the distinct FK values from a failed
 * chunk, return the ones with no parent row, ascending. Falls back to the
 * full distinct set when the diff is empty (e.g. a parent landed between the
 * batch and this query) so the error still names actionable keys. Returns
 * `null` when the lookup itself fails, in which case the caller keeps the
 * generic batch error. The happy path never calls this.
 */
async function missingParentKeys(
  db: D1Database,
  parentTable: "customer_snapshot" | "address_snapshot",
  parentColumn: "customer_id" | "pickup_address_id",
  keys: number[]
): Promise<number[] | null> {
  const distinct = [...new Set(keys)].sort((a, b) => a - b);
  if (distinct.length === 0) {
    return [];
  }
  try {
    const placeholders = distinct.map(() => "?").join(", ");
    const res = await db
      .prepare(
        `SELECT ${parentColumn} FROM ${parentTable} WHERE ${parentColumn} IN (${placeholders})`
      )
      .bind(...distinct)
      .all<Record<string, number>>();
    const existing = new Set((res.results ?? []).map((r) => r[parentColumn]));
    const missing = distinct.filter((k) => !existing.has(k));
    return missing.length > 0 ? missing : distinct;
  } catch {
    return null;
  }
}

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

/**
 * Read-only stale-row count for dry runs (TOG-9203): the rows
 * `reconcileDeleteStale` would delete (synced_at predates this run), counted
 * without deleting them. Same literal-union constraint as
 * `reconcileDeleteStale`: `table` interpolates directly into the SQL, so only
 * ever call with a literal, never caller-controlled text.
 */
export async function countStaleRows(
  db: D1Database,
  table: "customer_snapshot" | "address_snapshot" | "container_snapshot",
  syncedAt: string
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as n FROM ${table} WHERE synced_at < ?`)
    .bind(syncedAt)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Exact would-be delete count for a dry run (TOG-9203): stale rows whose
 * primary key was NOT seen in the parsed CSV — i.e. what `reconcileDeleteStale`
 * would remove after the real upserts refreshed every seen row. Rows present
 * in the CSV are excluded even though their stored `synced_at` is still old
 * (the real run would have restamped them), so a re-sync of unchanged data
 * correctly reports `deleted: 0` instead of the whole table.
 *
 * Computed as total stale rows minus stale rows whose key WAS seen (one
 * `IN` count per 99-key chunk, staying under D1's 100-variable ceiling).
 * Summing per-chunk `NOT IN` counts instead would overcount whenever the key
 * set spans more than one chunk — each chunk's query counts the stale rows
 * excluded only from that chunk.
 *
 * Read-only (`SELECT COUNT` only). `table` and `pkColumn` interpolate directly
 * into the SQL and are constrained to literal unions — only ever call with
 * literals, never caller-controlled text.
 */
export async function countWouldDeleteStale(
  db: D1Database,
  table: "customer_snapshot" | "address_snapshot" | "container_snapshot",
  pkColumn: "customer_id" | "pickup_address_id" | "container_id",
  syncedAt: string,
  seenKeys: number[]
): Promise<number> {
  const totalStale = await countStaleRows(db, table, syncedAt);
  const distinct = [...new Set(seenKeys)];
  if (distinct.length === 0) {
    return totalStale;
  }
  let refreshed = 0;
  for (let i = 0; i < distinct.length; i += 99) {
    const chunk = distinct.slice(i, i + 99);
    const placeholders = chunk.map(() => "?").join(", ");
    const row = await db
      .prepare(
        `SELECT COUNT(*) as n FROM ${table} WHERE synced_at < ? AND ${pkColumn} IN (${placeholders})`
      )
      .bind(syncedAt, ...chunk)
      .first<{ n: number }>();
    refreshed += row?.n ?? 0;
  }
  return totalStale - refreshed;
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
  /**
   * Dry run (TOG-9203): run the full parse/validate path but write nothing
   * (no upserts, no reconcile deletes). The caller reports would-be counts.
   * FK validation is also skipped — would-be parent rows are not visible to
   * later tables, so checking dangling references against current D1 would
   * false-fail the customer → address → container flow.
   */
  dryRun?: boolean;
  /** Observation boundary captured before fetching the report, not after download. */
  syncedAt?: string;
  /**
   * Reject an import that yields zero data rows (empty body, header-only CSV,
   * or no parseable rows) with `InvalidSnapshotCsvError` instead of returning
   * silent all-zero counts. Set by the `...-snapshot/import` routes; the
   * report `sync` path leaves it off so a bad/empty export returns zeros and
   * skips reconciliation rather than throwing.
   */
  requireDataRows?: boolean;
  /** Reject controls before trimming/binding on imports, not upstream reports. */
  rejectControlCharacters?: boolean;
  /**
   * Cap on request body bytes, enforced by a streaming counter so a huge
   * actual body is rejected with `SnapshotTooLargeError` without buffering.
   * Set by the `...-snapshot/import` routes; unset (the report `sync` path)
   * means no cap — upstream report size is the operator's own config.
   */
  maxBytes?: number;
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
      if (batchFailedOnForeignKey(e)) {
        const missing = await missingParentKeys(
          db,
          "customer_snapshot",
          "customer_id",
          chunk.map((r) => r.customerId)
        );
        if (missing !== null) {
          throw new SnapshotForeignKeyError(
            {
              table: "address_snapshot",
              column: "customer_id",
              parentTable: "customer_snapshot",
              missingKeys: missing,
              rowOffset: i
            },
            { cause: e }
          );
        }
      }
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
      if (batchFailedOnForeignKey(e)) {
        const missing = await missingParentKeys(
          db,
          "address_snapshot",
          "pickup_address_id",
          chunk.map((r) => r.pickupAddressId)
        );
        if (missing !== null) {
          throw new SnapshotForeignKeyError(
            {
              table: "container_snapshot",
              column: "pickup_address_id",
              parentTable: "address_snapshot",
              missingKeys: missing,
              rowOffset: i
            },
            { cause: e }
          );
        }
      }
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
