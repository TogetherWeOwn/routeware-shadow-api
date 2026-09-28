# R2 snapshot restore runbook — recover D1 from the CSV archive

**Status:** runbook + code. `restoreSnapshotCsvFromR2` (`src/lib/r2SnapshotArchive.ts`), drill `test/r2SnapshotRestore.test.ts`.
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Archive bucket `SNAPSHOTS` (`routeware-csv-snapshots`), keys `snapshots/YYYY-MM-DD/{customer|address|container}.csv` (UTC date), D1 `CUSTOMER_DB`.
**Why:** the daily sync archives the same CSV bytes it writes to D1 (`archiveReportCsvToR2AfterD1`), but nothing ever read them back. This doc is the recovery procedure: fetch the archived CSVs out of R2 and re-import them into D1 in FK order.

Two restore paths: **§2 operator path** (R2 CLI → `.../import` HTTP — no code, works against any deployed Worker) and **§6 in-code path** (`restoreSnapshotCsvFromR2` → `sync*FromStream` — for programmatic/full restores). Both were drilled 2026-09-28 (see §7).

## 0. Prerequisites

- Repo root, dependencies installed.
- `.dev.vars` beside `wrangler.toml` with a non-empty `CUSTOMER_SNAPSHOT_SYNC_SECRET` (the import routes match the **sync secret** only — `SHADOW_API_TOKEN` gets a 401; same as `docs/BACKFILL-RUNBOOK.md` §1).
- PII warning: archived CSVs are real Routeware exports. Keep downloaded files out of git (`*.csv` is gitignored and CI fails on it) and delete them when done.
- Two terminals: **A** runs the Worker, **B** runs commands.

## 1. Pick the archive date and confirm the keys exist

Keys are date-predictable, so construct them — `wrangler r2 object` has no list subcommand (wrangler 4.84), and the E2E test asserts the exact names (`test/snapshotSyncE2E.test.ts`: `snapshots/${day}/{address,container,customer}.csv`).

```bash
DATE=2026-09-27   # UTC date of the archive to restore (YYYY-MM-DD)
BUCKET=routeware-csv-snapshots   # remote default env; see §4 for --env/--local variants
for T in customer address container; do
  echo "== $T =="
  npx wrangler r2 object get "$BUCKET/snapshots/$DATE/$T.csv" --remote --pipe 2>&1 | head -c 300; echo
done
# each prints the CSV header line (CustomerID,… / PickupAddressID,… / ContainerID,…).
# "The specified key does not exist." → wrong date or the archive was disabled
# that day (SNAPSHOTS_R2_ENABLED=false or unbound binding logs the reason at
# sync time; an absent archive is distinguishable from a failed one by design).
```

Missing-key semantics in code: `restoreSnapshotCsvFromR2` returns `null` for a missing key and throws only when the archive is disabled/unbound (pinned in `test/r2SnapshotRestore.test.ts`).

## 2. Download the three CSVs

```bash
mkdir -p /tmp/r2-restore && cd /tmp/r2-restore
for T in customer address container; do
  npx wrangler r2 object get "$BUCKET/snapshots/$DATE/$T.csv" --remote --file "$DATE-$T.csv"
done
ls -la
# expect three non-empty $DATE-{customer,address,container}.csv files
```

## 3. Restore into D1 in FK order (customer → address → container)

Terminal A (blocking — leave it running; point `$BASE` at your target — local dev URL here, deployed Worker URL for a real restore):

```bash
npm run dev
```

```bash
BASE=http://127.0.0.1:8787
SECRET=<the CUSTOMER_SNAPSHOT_SYNC_SECRET value from .dev.vars>
```

Terminal B, **in this order** — D1 enforces the FK chain unconditionally and a misordered import 400s with `Dangling reference` instead of writing orphans (`docs/BACKFILL-RUNBOOK.md` §2):

```bash
curl -s -X POST "$BASE/api/v1/customer-snapshot/import" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: text/csv" \
  --data-binary @/tmp/r2-restore/$DATE-customer.csv; echo
# expect {"upserted":N,"rowCount":N,"deleted":0}

curl -s -X POST "$BASE/api/v1/address-snapshot/import" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: text/csv" \
  --data-binary @/tmp/r2-restore/$DATE-address.csv; echo
# expect {"upserted":M,"rowCount":M,"deleted":0}

curl -s -X POST "$BASE/api/v1/container-snapshot/import" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: text/csv" \
  --data-binary @/tmp/r2-restore/$DATE-container.csv; echo
# expect {"upserted":K,"rowCount":K,"deleted":0}
```

Unlike `.../sync`, `.../import` requires data rows (`requireDataRows: true`) and never deletes: it restores exactly what the archive holds and reconciles nothing. If the archive is newer than D1, upserts overwrite in place (re-sync is idempotent — pinned in `test/snapshotSyncE2E.test.ts`).

## 4. Targeting: which bucket and which D1

| Target | R2 flag | D1 flag / base |
|---|---|---|
| Local dev | `--local` (bucket `routeware-csv-snapshots` in local state) | `... --local`, `$BASE=http://127.0.0.1:8787` |
| Deployed default env | `--remote` | deployed Worker URL |
| Test env | `-e test --remote` (bucket `routeware-csv-snapshots-test`) | test Worker URL |

Local-dev caveat: `wrangler dev` reads the **top-level** bucket binding (`routeware-csv-snapshots`), while the vitest pool uses the `[env.test]` bucket (`routeware-csv-snapshots-test`). They are different stores — an archive written by the drill test is not visible to `wrangler dev` and vice versa. Always pair the R2 flag with the matching D1/Worker.

## 5. Verify

```bash
for T in customer_snapshot address_snapshot container_snapshot; do
  npx wrangler d1 execute routeware-customer-snapshot --remote --json \
    --command "SELECT COUNT(*) AS n FROM $T"
done
# compare against the import rowCounts above (rowCount per table)

# Spot-check values, not just counts:
npx wrangler d1 execute routeware-customer-snapshot --remote --json \
  --command "SELECT customer_id, company_name FROM customer_snapshot ORDER BY customer_id LIMIT 5"
```

Then delete the scratch CSVs: `rm -rf /tmp/r2-restore` (PII — see §0).

## 6. Programmatic restore (in-code path)

`restoreSnapshotCsvFromR2(env, table, date?)` returns the archived bytes as a `ReadableStream` (or `null` when the key is absent). Feed it straight into the same sync functions the cron uses:

```ts
import { restoreSnapshotCsvFromR2 } from "./lib/r2SnapshotArchive";
import { syncCustomerSnapshotFromStream } from "./lib/snapshot/streamSync";

const body = await restoreSnapshotCsvFromR2(env, "customer", new Date("2026-09-27T00:00:00Z"));
if (body === null) {
  throw new Error("no archive for that date");
}
await syncCustomerSnapshotFromStream(env.CUSTOMER_DB, body);
```

Restore in FK order (customer → address → container), same as §3. No new route was added deliberately: the existing `.../import` routes already accept raw CSV bodies, so the operator path needs no deploy.

## 7. Drill evidence

2026-09-28, `test/r2SnapshotRestore.test.ts` (3/3 green): archive → wipe D1 → restore from R2 → re-sync, against the real test D1 + R2 bindings. Archived 2-row fixtures per table, verified all three keys under `snapshots/<today>/`, wiped all tables to 0, restored in FK order (`{upserted: 2, rowCount: 2, deleted: 0}` per table), and asserted post-restore rows equal pre-wipe rows (counts **and** values). Missing-date returns `null`; unbound bucket throws with the disabled reason.

CLI leg validated live against local R2 state the same day: `r2 object put` + `r2 object get --local --pipe` round-tripped a seed CSV byte-identical, `--remote` on the same key returned "does not exist" (confirming no remote writes were made), scratch key deleted after.
