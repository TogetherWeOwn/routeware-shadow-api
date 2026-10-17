/**
 * Recording `D1Database` double for the snapshot sync tests.
 *
 * Shared by `snapshotUpsert.test.ts` and `snapshotStreamSync.test.ts`: both need
 * to assert on the exact statements issued (chunking arithmetic in one, the
 * reconcile-delete guard in the other), so the double records rather than stubs.
 */

export type Recorded = { sql: string; binds: unknown[] };

export type RecordingDb = {
  db: D1Database;
  /** One entry per `batch()` call, each listing that call's statements. */
  batches: Recorded[][];
  /** Statements executed via `run()` — the reconcile DELETEs. */
  runs: Recorded[];
  /** Statements executed via `all()` — the FK parent-lookup SELECT in `upsert.ts`. */
  selects: Recorded[];
};

export type RecordingDbOptions = {
  /** Make `batch()` throw from this call index onward (0 = fail immediately). */
  failFromBatch?: number;
  /** Message for the `batch()` failure (default "D1_ERROR: too many SQL variables"). */
  failMessage?: string;
  /** Rows returned by `all()` — the FK parent-lookup SELECT in `upsert.ts`. */
  allResults?: unknown[];
  /** Make `all()` throw (the parent lookup itself fails → generic batch error). */
  failAll?: boolean;
  /** `meta.changes` for `run()`. Omit to return `meta` with no `changes` key. */
  changes?: number;
  /**
   * Rows with a numeric `n` for the `countWouldDeleteStale` dry-run counts in
   * `upsert.ts`, consumed in call order — one entry per
   * `SELECT COUNT` (total-stale first, then one per 99-key IN chunk).
   * Omit to answer every count with `{ n: 0 }`.
   */
  firstCounts?: number[];
};

export function recordingDb(opts: RecordingDbOptions = {}): RecordingDb {
  const batches: Recorded[][] = [];
  const runs: Recorded[] = [];
  const selects: Recorded[] = [];
  let batchCalls = 0;
  let firstCalls = 0;

  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          const rec: Recorded = { sql, binds };
          return {
            rec,
            async first() {
              // Dry-run `SELECT COUNT` probe in `upsert.ts`.
              // Recorded in `selects` alongside the FK `all()` lookups so
              // tests can assert the read-only count shape.
              selects.push(rec);
              const counts = opts.firstCounts ?? [];
              return { n: counts[firstCalls++] ?? 0 };
            },
            async run() {
              runs.push(rec);
              return { meta: opts.changes === undefined ? {} : { changes: opts.changes } };
            },
            async all() {
              if (opts.failAll) {
                throw new Error("D1_ERROR: database is locked");
              }
              selects.push(rec);
              return { results: opts.allResults ?? [] };
            }
          };
        }
      };
    },
    async batch(stmts: Array<{ rec: Recorded }>) {
      const index = batchCalls++;
      if (opts.failFromBatch !== undefined && index >= opts.failFromBatch) {
        throw new Error(opts.failMessage ?? "D1_ERROR: too many SQL variables");
      }
      batches.push(stmts.map((s) => s.rec));
      return [];
    }
  };

  return { db: db as unknown as D1Database, batches, runs, selects };
}
