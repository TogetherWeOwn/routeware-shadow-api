# Manual backfill runbook — snapshot D1 from saved CSVs

**Status:** runbook only. No code, schema, or config changes. No new services, secrets, or paid tiers.
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Tables `customer_snapshot` → `address_snapshot` → `container_snapshot` in D1 (`CUSTOMER_DB`).
**Why:** import/sync order and FK-reconciliation caveats live in `CUSTOMER_SNAPSHOT.md`, but there was no operator checklist a reviewer could follow alone. This doc is that checklist: it takes a **fresh local D1** from empty to verified using only per-table `.../import` calls and `d1 execute` queries.

## 0. Prerequisites

- Repo root, dependencies installed (`npm ci --include=dev` if `tsc`/`vitest` are missing).
- `.dev.vars` beside `wrangler.toml` with `LOGIN_USERNAME`, `LOGIN_PASSWORD`, and a non-empty `CUSTOMER_SNAPSHOT_SYNC_SECRET` (see `.dev.vars.example`; `npm run dev` runs `check:devvars` first and refuses without a client token — the backfill itself needs the sync secret specifically, see §1).
- Your backfill CSVs on disk as files (never committed — `*.csv` exports are gitignored and CI fails on them). Real Routeware exports contain PII; the synthetic examples in §2 have the same shape with fake rows.
- Two terminals: **A** runs the Worker, **B** runs commands.

## 1. Fresh local D1

Terminal B (dev server need not be running for these). Wipe **before** starting the server: deleting `.wrangler/state/v3/d1` while `wrangler dev` is running leaves its D1 binding pointed at a deleted file and every import 500s (`SQLITE_CANTOPEN`) until you restart the server (hit while validating this doc, 2026-09-27).

```bash
# Wipe local D1 state so the backfill starts empty.
rm -rf .wrangler/state/v3/d1
npm run db:migrate:local
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT COUNT(*) AS n FROM customer_snapshot"
# expect [{"n": 0}]
```

Then terminal A (blocking — leave it running):

```bash
npm run dev
```

`wrangler dev` prints its URL (default `http://127.0.0.1:8787`). The rest of this doc uses it as `$BASE`:

```bash
BASE=http://127.0.0.1:8787
SECRET=<the CUSTOMER_SNAPSHOT_SYNC_SECRET value from .dev.vars>
```

If the default port is already taken (e.g. another checkout's dev server on a shared host — `Address already in use` while `/api/v1/health` still answers), start your own on a free port (`npx wrangler dev --port 8791`) and point `$BASE` at it. Never import through another checkout's server: its D1 binding belongs to a different worktree.

Use the **sync secret**, not `SHADOW_API_TOKEN`: the app-wide gate accepts either, but the in-handler check on every `.../import` route (`requireSnapshotAuth`, `src/routes/shared.ts:81-93`) matches the sync secret only — the API token gets a 401 here.

## 2. Import order: customers → addresses → containers

D1 declares the FK chain (`address.customer_id` → customer, `container.pickup_address_id` → address) and D1 **enforces it unconditionally**: importing an address whose customer is missing (or a container whose address is missing) fails with a 400 `bad-request` naming the dangling key (e.g. `Dangling reference: address_snapshot.customer_id=999 has no row in customer_snapshot.customer_id …`). Only the failing batch is lost — earlier batches in the same file still land — but the write never creates silent orphans, so import order is enforced, not just convention: customers first, then addresses, then containers. The combined `POST /api/v1/data-snapshot/sync` and `getDataSnapshotPlan` (`src/lib/snapshot/orchestration.ts:117-136`) enforce the same order the other way: address is skipped unless customer is configured, container unless both are.

Prefer per-table `.../import` (raw CSV body) for backfill: unlike `.../sync` it needs no report path/query vars and never deletes (see §5). One call per table, **in this order**.

```bash
curl -s -X POST "$BASE/api/v1/customer-snapshot/import" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: text/csv" \
  --data-binary @backfill-customers.csv; echo
# expect {"upserted":N,"rowCount":N,"deleted":0}

curl -s -X POST "$BASE/api/v1/address-snapshot/import" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: text/csv" \
  --data-binary @backfill-addresses.csv; echo
# expect {"upserted":M,"rowCount":M,"deleted":0}

curl -s -X POST "$BASE/api/v1/container-snapshot/import" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: text/csv" \
  --data-binary @backfill-containers.csv; echo
# expect {"upserted":K,"rowCount":K,"deleted":0}
```

Minimal CSV shapes (headers are case-insensitive; extra Routeware columns are ignored). Each file's **first header must be** `CustomerID` / `PickupAddressID` / `ContainerID` respectively — the check normalizes (trims, strips a leading BOM, lowercases, honours CSV quoting), so `"CustomerID"`, padded or lowercase variants all pass. A wrong first header fails with a 400 `bad-request` that names the column (`Customer import body must start with a header row whose first column is CustomerID…`; address and container name their own column). Other invalid bodies, such as a header with no data rows, fail with a 400 `bad-request` (`Snapshot import body is not valid CSV…`, §7). Neither case imports anything:

```csv
CustomerID,CompanyName,Enabled
1,Acme Manufacturing,true
2,Bluebonnet Foods,true
```

```csv
PickupAddressID,CustomerID,Address,City,State,Zip,Enabled
10,1,100 Industrial Pkwy,Killeen,TX,76541,true
11,2,200 Farm Rd,Temple,TX,76501,true
```

```csv
ContainerID,PickupAddressID,Address,SerialNumber,Enabled
100,10,100 Industrial Pkwy,SN-100,true
101,11,200 Farm Rd,SN-101,true
```

(Containers read the street from the `Address` column into `location_address`; `SerialNumber` is optional but useful for §3 spot checks. Booleans accept `true`/`1`/`yes` — and an omitted `Enabled` column imports as **true** (`parseBoolDefaultTrue("")` is true on main, `src/lib/csvParse.ts:78-84`), so a CSV without an `Enabled` column lands every row enabled. Include `Enabled` explicitly to control it.)

**Do not mix a partial `import` with a `sync` mid-backfill:** a `sync` run against a half-loaded chain fails loudly — child rows referencing not-yet-imported parents 400 at the upsert batch (dangling-reference `bad-request`), and a parent reconcile whose export dropped still-referenced rows 500s at the delete (§5, §7). Finish all three imports, verify (§3–4), then hand over to the daily cron/`sync` path.

## 3. Per-table verification

Row counts must match the `rowCount` each import reported, and every CSV id must be present:

```bash
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT COUNT(*) AS n, MAX(synced_at) AS last_sync FROM customer_snapshot"
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT COUNT(*) AS n, MAX(synced_at) AS last_sync FROM address_snapshot"
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT COUNT(*) AS n, MAX(synced_at) AS last_sync FROM container_snapshot"
```

Spot-check one row per table (values must match the CSV, not just exist):

```bash
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT customer_id, company_name, enabled FROM customer_snapshot ORDER BY customer_id LIMIT 5"
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT pickup_address_id, customer_id, address, enabled FROM address_snapshot ORDER BY pickup_address_id LIMIT 5"
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT container_id, pickup_address_id, serial_number, enabled FROM container_snapshot ORDER BY container_id LIMIT 5"
```

The same reads are available over HTTP (same bearer): `GET /api/v1/customer-snapshot?limit=5`, `GET /api/v1/address-snapshot?limit=5`, `GET /api/v1/container-snapshot?limit=5`.

## 4. Orphan checks (must both be zero)

On the local D1 the FK chain is enforced, so an out-of-order `import` fails at the offending batch (§2) rather than writing orphans — but a zero orphan count is still the acceptance proof (and on any D1 where FKs are *not* enforced, a `sync` that reconciles a parent away can strand children). The counts below must be `0` before the backfill is accepted. (An HTTP equivalent, `GET /api/v1/data-snapshot/orphans`, lands with [TOG-5814](/TOG/issues/TOG-5814) and is not on `main` yet — use the SQL here.)

```bash
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT COUNT(*) AS n FROM address_snapshot a LEFT JOIN customer_snapshot c ON c.customer_id = a.customer_id WHERE c.customer_id IS NULL"
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT COUNT(*) AS n FROM container_snapshot t LEFT JOIN address_snapshot a ON a.pickup_address_id = t.pickup_address_id WHERE a.pickup_address_id IS NULL"
```

On this local D1 a nonzero count is not reachable through `import` (FK rejects the batch first — §2); a nonzero count here means rows arrived another way (e.g. a D1 where FKs are unenforced, or a parent row removed by hand). List the offenders (deterministic order, first 100) and fix the source CSV, then re-import **in order** — re-importing just the parent table is enough, since imports are upserts:

```bash
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT a.pickup_address_id AS id FROM address_snapshot a LEFT JOIN customer_snapshot c ON c.customer_id = a.customer_id WHERE c.customer_id IS NULL ORDER BY a.pickup_address_id LIMIT 100"
npx wrangler d1 execute routeware-customer-snapshot --local --json \
  --command "SELECT t.container_id AS id FROM container_snapshot t LEFT JOIN address_snapshot a ON a.pickup_address_id = t.pickup_address_id WHERE a.pickup_address_id IS NULL ORDER BY t.container_id LIMIT 100"
```


## 5. Caveats that bite (import vs sync, reconciliation)

- **`import` is treated as possibly-partial and never deletes** (`deleted` is always `0`; the reconcile step only runs on the `sync` path with `reconcile: true`). A bad import's rows persist: re-importing the corrected CSVs heals values (upserts overwrite), but rows the bad file *added* stay until a correct full `sync` reconciles them away or you `DELETE` them explicitly.
- **`sync` deletes rows absent from its export** (`deleted` count in the response) so upstream deletions propagate — but the delete is **skipped when a run yields zero data rows**, so a bad/empty export never wipes a table. An all-zero `rowCount` with `deleted: 0` means "export was empty, table untouched", not success.
- **No cross-table transaction.** Each table's import is many `db.batch` calls (80 rows per chunk for customers/addresses, 40 for containers: `STREAM_BATCH_*` in `streamSync.ts`); a crash between §2's calls leaves a half-backfilled chain. Within one import, chunks are atomic per batch: a batch containing an FK-violating row 400s and lands nothing, but earlier batches in the same file stay (verified: a 100-row address file with one bad row in batch 2 left 2 + 80 = 82 rows). Recovery is fixing the CSV and re-running the remaining imports in order (upserts are idempotent), not rolling back.
- **FKs also block parent deletes.** `DELETE FROM customer_snapshot` fails with `FOREIGN KEY constraint failed` while any address still references the customer (verified direct-SQL, count unchanged) — and the `sync` reconcile path issues the same `DELETE`s (`reconcileDeleteStale`). So on this D1, a customer `sync` whose export dropped a customer that still has addresses fails at reconcile: recover by syncing children first (address, then container — their reconciles remove the referencing rows), then re-running the customer sync.
- **Large files** can hit D1's ~1000-operations-per-invocation budget through a single import. If an import fails with a D1 limit error, split that table's CSV into smaller files and import them sequentially in the same table order (same-table splits are safe; cross-table splits still need customer → address → container). See `CUSTOMER_SNAPSHOT.md` § "D1: Too many API requests".

## 6. Rollback note

There is no undo log — every write is an `INSERT … ON CONFLICT DO UPDATE` keyed on the table PK. To roll back a backfill:

1. Re-import the previous good CSVs in §2 order (restores values for all rows present in both).
2. Rows the bad backfill *added* are not removed by step 1 (import never deletes): remove them with an explicit `DELETE FROM <table> WHERE <pk> IN (…)` per offending id from §4's sample queries, or run one correct full `sync` per table and confirm via its `deleted` count.
3. Nuclear option for local dev only: redo §1 (wipe `.wrangler/state/v3/d1`, migrate, re-import). Never point this at `--remote`.

## 7. Failure table

| Symptom | Cause | Fix |
|---|---|---|
| `Customer import body must start with a header row whose first column is CustomerID...` 400 `bad-request` (address and container name their own column; other invalid bodies return `Snapshot import body is not valid CSV...`, from `mapSnapshotImportError` in `src/routes/snapshotImport.ts`) | Normalized first CSV cell is not `CustomerID` / `PickupAddressID` / `ContainerID` (exact match after trim, BOM-strip, lowercase and CSV unquoting — `"CustomerID"` or padded/lowercase variants pass; `firstHeaderCell`, `streamSync.ts`) | Fix the header row (§2); nothing was imported |
| `Dangling reference: <table>.<column>=<key> has no row in <parent>.<column> …` 400 `bad-request` (FK details also in the Worker log) | Out-of-order import or a child row pointing at a missing parent id | Only the failing batch is lost — import the parents first, then fix the CSV and re-import in order (§2) |
| `SQLITE_CANTOPEN` / `unable to open database file` in the Worker log, every import 500s | `.wrangler/state/v3/d1` was wiped while `wrangler dev` was running (§1) | Restart `wrangler dev` |
| `401` problem+json on import | Bearer missing/wrong, or the API token sent instead of the sync secret (`requireSnapshotAuth` matches the sync secret only) | Use the `.dev.vars` `CUSTOMER_SNAPSHOT_SYNC_SECRET` value for `$SECRET`; restart `wrangler dev` after editing `.dev.vars` |
| `503 misconfigured` on a `.../sync` route | No `*_REPORT_EXPORT_PATH` / `*_REPORT_QUERY_ID` for that table | Backfill uses `.../import`, not `.../sync`; for sync setup see `CUSTOMER_SNAPSHOT.md` § "Checklist" |
| Combined `data-snapshot/sync` returns a table as `null` / `{"skipped":true}` | FK guard: address needs customer configured, container needs both (`getDataSnapshotPlan`) | Configure the missing table's report vars, or backfill that table via `.../import` |
| Customer `sync` fails at reconcile with `FOREIGN KEY constraint failed` | Export dropped a customer that still has address rows; parent deletes are FK-blocked (§5) | Sync address then container first (their reconciles remove the referencing rows), then re-run the customer sync |
| Orphan count nonzero after all three imports | Not reachable through `import` on this D1 (FK rejects first) — rows arrived another way | §4 sample queries → fix source → re-import in order |
| Upstream HTML-200 during `sync` (login page, not CSV) | Routeware session lost, not a D1 problem | Diagnose on body shape/content-type, not status (`docs/CONVENTIONS.md` §1 fact 1); re-verify tenant `LOGIN_USERNAME` + `LOGIN_PASSWORD` in the Routeware UI and re-put the Worker secrets (`npx wrangler secret put LOGIN_USERNAME`, `npx wrangler secret put LOGIN_PASSWORD`), then update local `.dev.vars` |

## 8. Done criteria

Backfill is accepted when, on the fresh local D1 from §1: the three §3 counts match the three `rowCount`s, both §4 orphan counts are `0`, and spot checks match the CSVs. At that point the tables are ready for the daily cron/`sync` path to take over (`CUSTOMER_SNAPSHOT.md` checklist steps 5–6; alarm loop in `docs/CRON-SYNC-ALARM-RUNBOOK.md`).
