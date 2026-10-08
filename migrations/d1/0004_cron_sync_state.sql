-- TOG-8883: cron last-run outcome per table (see CUSTOMER_SNAPSHOT.md § "Readiness: cron staleness").
--
-- The daily cron (`src/scheduled.ts`) upserts one row per table after every
-- run, so `GET /api/v1/readiness` can report when the sync last ran without
-- reading logs. Only outcome/mode/counts/timestamps are stored — never row
-- data or report contents (CONVENTIONS.md § 5: the snapshot path carries
-- customer PII, so this table must stay counts-and-status only).
--
-- `outcome` is per-table: `success` (table synced), `skipped` (no report
-- source configured for it), or `failed` (the run threw). `ran_at` is an ISO
-- 8601 UTC timestamp shared by the run's three rows; `upserted`/`row_count`/
-- `deleted` are null for skipped/failed rows.

CREATE TABLE cron_sync_state (
  table_name TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  mode TEXT NOT NULL,
  upserted INTEGER,
  row_count INTEGER,
  deleted INTEGER,
  ran_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);
