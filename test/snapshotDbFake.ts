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
};

export type RecordingDbOptions = {
  /** Make `batch()` throw from this call index onward (0 = fail immediately). */
  failFromBatch?: number;
  /** `meta.changes` for `run()`. Omit to return `meta` with no `changes` key. */
  changes?: number;
};

export function recordingDb(opts: RecordingDbOptions = {}): RecordingDb {
  const batches: Recorded[][] = [];
  const runs: Recorded[] = [];
  let batchCalls = 0;

  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          const rec: Recorded = { sql, binds };
          return {
            rec,
            async run() {
              runs.push(rec);
              return { meta: opts.changes === undefined ? {} : { changes: opts.changes } };
            }
          };
        }
      };
    },
    async batch(stmts: Array<{ rec: Recorded }>) {
      const index = batchCalls++;
      if (opts.failFromBatch !== undefined && index >= opts.failFromBatch) {
        throw new Error("D1_ERROR: too many SQL variables");
      }
      batches.push(stmts.map((s) => s.rec));
      return [];
    }
  };

  return { db: db as unknown as D1Database, batches, runs };
}
