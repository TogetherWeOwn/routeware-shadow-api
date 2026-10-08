/**
 * FK reconciliation reads for the D1 snapshot tables.
 *
 * D1 enforces `customer_snapshot` → `address_snapshot` → `container_snapshot`
 * foreign keys on writes and parent deletes. Normal streamed syncs cannot
 * strand child rows. This defensive audit detects legacy or out-of-band rows
 * in a database whose schema did not enforce those constraints; a nonzero
 * report warrants investigating the schema and data provenance, not import order.
 * Source: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
 *
 * Counts and samples use `LEFT JOIN ... IS NULL` anti-joins over indexed PK
 * columns. Sample ids are ordered by primary key for deterministic sampling.
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
 * Count and sample orphan rows on both FK edges in one read-only transaction.
 *
 * A single D1 batch keeps all four reads on the same database state, even if
 * a concurrent import supplies missing parents while the report is running.
 * Source: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 */
export async function getSnapshotOrphans(
  db: D1Database,
  sampleLimit: number = ORPHAN_SAMPLE_LIMIT_DEFAULT
): Promise<SnapshotOrphanReport> {
  const limit = clampSampleLimit(sampleLimit);

  const [addressCount, addressRows, containerCount, containerRows] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS n FROM address_snapshot a
       LEFT JOIN customer_snapshot c ON c.customer_id = a.customer_id
       WHERE c.customer_id IS NULL`
    ),
    db.prepare(
      `SELECT a.pickup_address_id AS id FROM address_snapshot a
       LEFT JOIN customer_snapshot c ON c.customer_id = a.customer_id
       WHERE c.customer_id IS NULL
       ORDER BY a.pickup_address_id LIMIT ?`
    ).bind(limit),
    db.prepare(
      `SELECT COUNT(*) AS n FROM container_snapshot t
       LEFT JOIN address_snapshot a ON a.pickup_address_id = t.pickup_address_id
       WHERE a.pickup_address_id IS NULL`
    ),
    db.prepare(
      `SELECT t.container_id AS id FROM container_snapshot t
       LEFT JOIN address_snapshot a ON a.pickup_address_id = t.pickup_address_id
       WHERE a.pickup_address_id IS NULL
       ORDER BY t.container_id LIMIT ?`
    ).bind(limit)
  ]) as [
    D1Result<{ n: number }>,
    D1Result<{ id: number }>,
    D1Result<{ n: number }>,
    D1Result<{ id: number }>
  ];

  return {
    orphanAddresses: {
      count: addressCount.results[0]?.n ?? 0,
      sampleIds: addressRows.results.map((r) => r.id)
    },
    orphanContainers: {
      count: containerCount.results[0]?.n ?? 0,
      sampleIds: containerRows.results.map((r) => r.id)
    }
  };
}
