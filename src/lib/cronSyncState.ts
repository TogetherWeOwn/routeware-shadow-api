/**
 * Cron last-run persistence (TOG-8883).
 *
 * The daily cron (`src/scheduled.ts`) upserts one row per table here after
 * every run, so `GET /api/v1/readiness` can report when the sync last ran
 * without reading logs (see `docs/CRON-SYNC-ALARM-RUNBOOK.md` §2 — the
 * `synced_at` ground-truth query, machine-readable).
 *
 * Only outcome/mode/counts/timestamps are stored — never row data, report
 * contents, or error text (CONVENTIONS.md §5: the snapshot path carries
 * customer PII, so this table stays counts-and-status only by construction;
 * there is no column that could hold either).
 *
 * Per-table `outcome` is `success` (the table synced), `skipped` (no report
 * source configured for it), or `failed` (the run threw before any table
 * result was recorded). `ran_at` is an ISO 8601 UTC timestamp shared by the
 * run's three rows; `upserted`/`row_count`/`deleted` are null for
 * skipped/failed rows.
 */

import type {
  CronSyncMode,
  CronSyncOutcome,
  CronSyncTableCounts,
} from "../scheduled";

export const CRON_SYNC_TABLES = ["customer", "address", "container"] as const;

export type CronSyncTableName = (typeof CRON_SYNC_TABLES)[number];

export type CronTableOutcome = "success" | "skipped" | "failed";

export type CronRunRecord = {
  outcome: CronSyncOutcome;
  mode: CronSyncMode;
  tables: Record<CronSyncTableName, CronSyncTableCounts>;
  /** ISO 8601 UTC timestamp shared by the run's rows. */
  ranAt: string;
  durationMs: number;
};

export type CronStateRow = {
  tableName: CronSyncTableName;
  outcome: CronTableOutcome;
  mode: CronSyncMode;
  upserted: number | null;
  rowCount: number | null;
  deleted: number | null;
  ranAt: string;
  durationMs: number;
};

function isTableName(value: string): value is CronSyncTableName {
  return (CRON_SYNC_TABLES as readonly string[]).includes(value);
}

function tableOutcome(
  runOutcome: CronSyncOutcome,
  counts: CronSyncTableCounts
): CronTableOutcome {
  if (runOutcome === "failed") {
    return "failed";
  }
  return counts ? "success" : "skipped";
}

/**
 * Upsert the run's three per-table rows. Best-effort by design: the caller
 * (`src/scheduled.ts`) catches a rejection and keeps the run's log line as
 * the record — a D1 write failure must never turn a successful sync into a
 * cron failure, nor reject the `waitUntil` promise.
 *
 * Returns `"skipped"` (silently, no log) when no D1 binding is present — the
 * unit-test envs that drive the handler without a database.
 */
export async function recordCronRun(
  db: D1Database | undefined,
  run: CronRunRecord
): Promise<"recorded" | "skipped"> {
  if (!db) {
    return "skipped";
  }
  const stmts = CRON_SYNC_TABLES.map((name) => {
    const counts = run.tables[name];
    return db
      .prepare(
        "INSERT INTO cron_sync_state " +
          "(table_name, outcome, mode, upserted, row_count, deleted, ran_at, duration_ms) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (table_name) DO UPDATE SET outcome = excluded.outcome, " +
          "mode = excluded.mode, upserted = excluded.upserted, " +
          "row_count = excluded.row_count, deleted = excluded.deleted, " +
          "ran_at = excluded.ran_at, duration_ms = excluded.duration_ms"
      )
      .bind(
        name,
        tableOutcome(run.outcome, counts),
        run.mode,
        counts?.upserted ?? null,
        counts?.rowCount ?? null,
        counts?.deleted ?? null,
        run.ranAt,
        run.durationMs
      );
  });
  await db.batch(stmts);
  return "recorded";
}

type CronStateSelectRow = {
  table_name: string;
  outcome: string;
  mode: string;
  upserted: number | null;
  row_count: number | null;
  deleted: number | null;
  ran_at: string;
  duration_ms: number;
};

/**
 * Read back the persisted rows. Returns `null` when the table is unreadable
 * (migrations not applied, binding misconfigured) — the caller reports that
 * as never-ran rather than throwing, so readiness stays a probe, not a
 * crash site. Unknown `table_name` values are dropped, never trusted.
 */
export async function readCronState(
  db: D1Database | undefined
): Promise<CronStateRow[] | null> {
  if (!db) {
    return null;
  }
  try {
    const res = await db
      .prepare(
        "SELECT table_name, outcome, mode, upserted, row_count, deleted, " +
          "ran_at, duration_ms FROM cron_sync_state"
      )
      .all<CronStateSelectRow>();
    const rows: CronStateRow[] = [];
    for (const r of res.results ?? []) {
      if (!isTableName(r.table_name)) {
        continue;
      }
      rows.push({
        tableName: r.table_name,
        outcome: r.outcome as CronTableOutcome,
        mode: r.mode as CronSyncMode,
        upserted: r.upserted,
        rowCount: r.row_count,
        deleted: r.deleted,
        ranAt: r.ran_at,
        durationMs: r.duration_ms,
      });
    }
    return rows;
  } catch {
    return null;
  }
}
