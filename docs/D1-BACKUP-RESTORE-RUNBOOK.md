# D1 backup/restore runbook — snapshot tables

**Status:** runbook only. No code, schema, or config changes. No new services, secrets, or paid tiers.
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Tables `customer_snapshot` → `address_snapshot` → `container_snapshot` in D1 (`CUSTOMER_DB`, `routeware-customer-snapshot`).
**Why:** snapshot data lives in D1 with no other documented backup/restore path (gap G19). This doc is the operator checklist: export before risky work, restore after; §5 summarises the drill evidence.

> **Never `--remote` for a drill.** Every command below targets the **local** D1 (`--local`). Remote export/restore touches production data and needs CEO sign-off first (owner-reserved: irreversible data operations). The drill in §4 ran entirely against local scratch state.

## 0. Prerequisites

- Repo root, dependencies installed (`npm ci --include=dev` if `wrangler` is missing).
- `wrangler` authenticated only if you touch `--remote` (not needed for this runbook's local path).

## 1. Export (backup)

Full backup (schema + data) for archiving:

```bash
npx wrangler d1 export routeware-customer-snapshot --local \
  --output d1-backup-YYYYMMDD.sql
```

Data-only backup of just the snapshot tables (the **restore input** — see §2 for why):

```bash
npx wrangler d1 export routeware-customer-snapshot --local --no-schema \
  --table customer_snapshot --table address_snapshot --table container_snapshot \
  --output d1-backup-YYYYMMDD-data.sql
```

Sanity-check the file before trusting it: it must contain one `INSERT INTO` per row per table, in parent→child order (customers, then addresses, then containers — the exporter emits tables in the `--table` order given):

```bash
grep -c '^INSERT INTO "customer_snapshot"' d1-backup-YYYYMMDD-data.sql
grep -c '^INSERT INTO "address_snapshot"' d1-backup-YYYYMMDD-data.sql
grep -c '^INSERT INTO "container_snapshot"' d1-backup-YYYYMMDD-data.sql
```

Compare against live counts (`npx wrangler d1 execute routeware-customer-snapshot --local --json --command "SELECT (SELECT COUNT(*) FROM customer_snapshot) AS c, (SELECT COUNT(*) FROM address_snapshot) AS a, (SELECT COUNT(*) FROM container_snapshot) AS t"`).

Backup files may contain PII from real exports — never commit them (`*.sql` dumps are not gitignored by default; keep them out of the tree or delete after the restore).

## 2. Restore

Restore the **data-only** file from §1 into a migrated database:

```bash
npx wrangler d1 execute routeware-customer-snapshot --local \
  --file d1-backup-YYYYMMDD-data.sql
```

Two gotchas, both hit during the §4 drill:

1. **Do not restore the full (schema-bearing) export into an existing database.** It contains `CREATE TABLE` statements that fail with `near "id": syntax error` / table-exists errors against a migrated DB. The full export is for archive/audit; the data-only export (`--no-schema --table …`) is the restore input.
2. **Restore into an empty-or-wiped table set, in FK order.** The data file lists parents before children, and D1 enforces the FK chain (`address.customer_id` → customer, `container.pickup_address_id` → address). Restoring over existing rows with colliding PKs fails or conflicts — wipe first on scratch (`DELETE FROM container_snapshot; DELETE FROM address_snapshot; DELETE FROM customer_snapshot;`, children first), or restore into a fresh DB (`rm -rf .wrangler/state/v3/d1` **while `wrangler dev` is stopped**, then `npm run db:migrate:local` — wiping while the dev server runs leaves its binding pointed at a deleted file, see `docs/BACKFILL-RUNBOOK.md` §1).

For production-scale restores (thousands of rows), the same D1 ~1000-operations-per-invocation budget from `docs/BACKFILL-RUNBOOK.md` §5 applies: split the data file per table if `execute --file` hits a D1 limit error, keeping customer → address → container order.

## 3. Verify after restore

Row counts must match the pre-restore counts (or the §1 grep counts):

```bash
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT (SELECT COUNT(*) FROM customer_snapshot) AS c, (SELECT COUNT(*) FROM address_snapshot) AS a, (SELECT COUNT(*) FROM container_snapshot) AS t"
```

Orphan checks must both be `0` (same queries as `docs/BACKFILL-RUNBOOK.md` §4):

```bash
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT COUNT(*) AS n FROM address_snapshot a LEFT JOIN customer_snapshot c ON c.customer_id = a.customer_id WHERE c.customer_id IS NULL"
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT COUNT(*) AS n FROM container_snapshot t LEFT JOIN address_snapshot a ON a.pickup_address_id = t.pickup_address_id WHERE a.pickup_address_id IS NULL"
```

Spot-check one row per table against the source data (values, not just counts).

## 4. RTO note

For a snapshot-table-only loss on the order of this repo's data volume (hundreds–low-thousands of rows): **export < 1 min, restore < 1 min, verify < 5 min — RTO ≈ 10 minutes operator time** once the operator has this runbook and a known-good backup file. Measured in the drill: export instant, `execute --file` instant, verification two queries. The dominant cost is human: locating the right backup file and confirming counts, not the transfer. There is no point-in-time recovery — RPO is the age of the last export, so schedule exports before every migration/backfill/sync-config change, not on a timer this runbook owns.

## 5. Drill evidence

2026-09-28, local scratch D1 only (never production): seeded 2 customers / 1 address / 1 container with synthetic `Drill …` rows → data-only export (4 `INSERT`s) → wiped all three tables (0/0/0) → restored via `execute --file` (5 batches, all ok) → verified 2/1/1 with identical values and 0/0 orphans. The full drill log was kept with the internal drill record and is not published here; the counts above are the published evidence.
