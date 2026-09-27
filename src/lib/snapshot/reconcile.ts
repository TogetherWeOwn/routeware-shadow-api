/**
 * FK reconciliation reads for the D1 snapshot tables.
 *
 * `customer_snapshot` → `address_snapshot` → `container_snapshot` declares
 * foreign keys, but D1 does not enforce them (no `PRAGMA foreign_keys`) and a
 * streamed sync spans many `db.batch` calls rather than one transaction — so
 * an address row can point at a customer that was never imported (or has since
 * been reconciled away), and a container row can point at a missing address.
 * Import order (`getDataSnapshotPlan`) prevents *new* orphans; these queries
 * detect the ones already in the tables.
 *
 * Both queries are `LEFT JOIN ... IS NULL` anti-joins over indexed PK columns,
 * so they stay cheap at snapshot scale. Sample ids are ordered by primary key
 * so repeated reads page deterministically.
 */

/** One side of the orphan report: how many, plus a deterministic id sample. */
export type SnapshotOrphanSample = {
  count: number;
  sampleIds: number[];
};

/** Orphan rows on each FK edge of the snapshot chain. */
export type SnapshotOrphanReport = {
  /** Address rows whose `customer_id` has no `customer_snapshot` row. */
  orphanAddresses: SnapshotOrphanSample;
  /** Container rows whose `pickup_address_id` has no `address_snapshot` row. */
  orphanContainers: SnapshotOrphanSample;
};

export const ORPHAN_SAMPLE_LIMIT_DEFAULT = 100;
export const ORPHAN_SAMPLE_LIMIT_MAX = 500;

/** Clamp a caller-supplied sample limit into the documented range. */
function clampSampleLimit(sampleLimit: number): number {
  if (!Number.isFinite(sampleLimit)) {
    return ORPHAN_SAMPLE_LIMIT_DEFAULT;
  }
  return Math.min(
    Math.max(Math.floor(sampleLimit), 1),
    ORPHAN_SAMPLE_LIMIT_MAX
  );
}

/**
 * Count and sample orphan rows on both FK edges.
 *
 * Four read-only statements: one `COUNT(*)` and one ordered, limited id
 * select per edge. `first()`/`all()` fall back to zero/empty when D1 answers
 * with no row, so the report degrades to zeros rather than throwing.
 */
export async function getSnapshotOrphans(
  db: D1Database,
  sampleLimit: number = ORPHAN_SAMPLE_LIMIT_DEFAULT
): Promise<SnapshotOrphanReport> {
  const limit = clampSampleLimit(sampleLimit);

  const orphanAddressCount =
    (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM address_snapshot a
           LEFT JOIN customer_snapshot c ON c.customer_id = a.customer_id
           WHERE c.customer_id IS NULL`
        )
        .first<{ n: number }>()
    )?.n ?? 0;
  const { results: orphanAddressRows } = await db
    .prepare(
      `SELECT a.pickup_address_id AS id FROM address_snapshot a
       LEFT JOIN customer_snapshot c ON c.customer_id = a.customer_id
       WHERE c.customer_id IS NULL
       ORDER BY a.pickup_address_id LIMIT ?`
    )
    .bind(limit)
    .all<{ id: number }>();

  const orphanContainerCount =
    (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM container_snapshot t
           LEFT JOIN address_snapshot a ON a.pickup_address_id = t.pickup_address_id
           WHERE a.pickup_address_id IS NULL`
        )
        .first<{ n: number }>()
    )?.n ?? 0;
  const { results: orphanContainerRows } = await db
    .prepare(
      `SELECT t.container_id AS id FROM container_snapshot t
       LEFT JOIN address_snapshot a ON a.pickup_address_id = t.pickup_address_id
       WHERE a.pickup_address_id IS NULL
       ORDER BY t.container_id LIMIT ?`
    )
    .bind(limit)
    .all<{ id: number }>();

  return {
    orphanAddresses: {
      count: orphanAddressCount,
      sampleIds: (orphanAddressRows ?? []).map((r) => r.id)
    },
    orphanContainers: {
      count: orphanContainerCount,
      sampleIds: (orphanContainerRows ?? []).map((r) => r.id)
    }
  };
}
