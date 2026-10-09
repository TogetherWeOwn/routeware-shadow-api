# R2 snapshot restore runbook — recover D1 from the CSV archive

**Status:** runbook + code. `restoreSnapshotCsvFromR2` (`src/lib/r2SnapshotArchive.ts`), drill `test/r2SnapshotRestore.test.ts`.
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Archive bucket `SNAPSHOTS` (`routeware-csv-snapshots`), date-alias keys `snapshots/YYYY-MM-DD/{customer|address|container}.csv` (UTC date; per-run `snapshot-history/` keys and `snapshot-latest/` pointers are in `docs/R2-RETENTION.md`), D1 `CUSTOMER_DB`.
**Why:** the daily sync archives the same CSV bytes it writes to D1 (`archiveReportCsvToR2AfterD1`), but nothing ever read them back. This doc is the recovery procedure: fetch the archived CSVs out of R2 and re-import them into D1 in FK order.

**Use §6's in-code path for report-origin archive recovery.** It retrieves the archived stream and uses the same permissive parsing as upstream report sync. Public `.../import` is not a general disaster-recovery route: it rejects forbidden controls and lone CR cell content, even when those bytes came from our archive or `.../export`.

The optional **§2–3 HTTP path** is only for CSVs whose entire contents are already known to satisfy the import policy in `docs/PROBLEMS.md#csv-control-characters-bad-request`. A passing integrity manifest proves byte integrity, not import compatibility. Do not start an HTTP restore to discover whether the CSV is compatible: a late 400 can leave earlier batches written. Neither restore path is atomic. Historical drill evidence is in §7; the control-boundary regression is pinned by `test/snapshotRestoreControlBoundary.test.ts`.

## 0. Prerequisites

- Repo root, dependencies installed; Python 3 for the offline pre-check and curl 7.76+ for `--fail-with-body`.
- `.dev.vars` beside `wrangler.toml` with a non-empty `CUSTOMER_SNAPSHOT_SYNC_SECRET` (the import routes match the **sync secret** only — `SHADOW_API_TOKEN` gets a 401; same as `docs/BACKFILL-RUNBOOK.md` §1).
- PII warning: archived CSVs are real Routeware exports. Keep downloaded files out of git (`*.csv` is gitignored and CI fails on it) and delete them when done.
- Two terminals: **A** runs the Worker, **B** runs commands.

## 1. Pick the archive date and confirm the keys exist

Date-alias keys are date-predictable, so construct them — `wrangler r2 object` has no list subcommand (wrangler 4.84), and `test/r2SnapshotRestore.test.ts` asserts the exact alias names (`snapshots/${day}/{address,container,customer}.csv`).

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

### Verify-first gate (must PASS before either restore path)

`.../import` is upsert-only and never deletes, so a truncated or tampered CSV
would silently overwrite good D1 rows — and the §5 count/spot checks only catch
it if a damaged row happens to be sampled. Each UTC date's archive carries a
sidecar integrity manifest, `snapshots/<date>.manifest.json` (sha256 + byte
size per CSV, written by `src/lib/r2SnapshotArchive.ts`, TOG-8881). Verify the
archive against it before importing:

```bash
node scripts/verify-r2-manifest.mjs --date=$DATE --remote
# expect: r2-manifest: PASS — snapshots/$DATE.manifest.json: 3 passed, 0 mismatched, 0 missing (exit 0)
```

Pair the flags with §4's target: `--remote` for a deployed-default-env restore
(read-only GETs; needs `CLOUDFLARE_API_TOKEN` in the environment, never a
flag); drop `--remote` for a local-dev restore (credential-free) and add
`--persist-to <dir>` when `wrangler dev` uses a custom persist dir, or
`--bucket routeware-csv-snapshots-test` for the test env. (`npm run
verify:r2-manifest -- --date=$DATE ...` runs the same checker.)

On FAIL — including a missing manifest (archives written before TOG-8881 have
no sidecar) — **stop: do not run any §3 import or §6 in-code restore**. Treat the archive as suspect
(truncated, tampered, or wrong date/bucket) and re-pull or escalate instead of
importing blind. The reviewer tamper recipe in the `verify-r2-manifest.mjs`
header comment replays this gate end-to-end (flip one CSV byte → exit 1).

## 3. Optional HTTP upsert of import-compatible CSVs

Use this path only after the §2 integrity gate passes and the following offline control pre-check passes for **all three complete CSVs**. It is read-only and prints filenames/reasons, never cell values. It checks strict UTF-8, all import-forbidden code points and lone CR; it conservatively rejects even valid CR-only record separators. It does not certify headers, data rows, byte limits or FK consistency, so other HTTP 400/413 errors remain possible. Imports are non-atomic even after pre-checking.

```bash
python3 - "$DATE" <<'PY'
from datetime import date
from pathlib import Path
import sys

try:
    day = date.fromisoformat(sys.argv[1]).isoformat()
except (IndexError, ValueError):
    sys.exit("Invalid DATE; expected YYYY-MM-DD.")

failed = False
for table in ("customer", "address", "container"):
    path = Path("/tmp/r2-restore") / f"{day}-{table}.csv"
    try:
        text = path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        print(f"{path}: unreadable or invalid UTF-8; STOP")
        failed = True
        continue
    rejected = any(
        (ord(ch) < 0x20 and ch not in "\t\n\r")
        or 0x7f <= ord(ch) <= 0x9f
        or (ch == "\r" and text[i + 1:i + 2] != "\n")
        for i, ch in enumerate(text)
    )
    if rejected:
        print(f"{path}: control-incompatible; use §6, not HTTP import")
        failed = True
if failed:
    sys.exit(1)
print("All three CSVs passed the offline control pre-check.")
PY
```

On a failed pre-check, **do not run the HTTP commands**: use §6's code-deployment procedure or a separately verified D1 backup. Do not strip controls from a recovery archive to make the check pass. Keep FK order customer → address → container. The `&&` chain below stops after a failed request without exiting the interactive shell; `--fail-with-body` retains the row-numbered problem response. Do not continue the chain after an error.

Terminal A (blocking — leave it running; point `$BASE` at your target — local dev URL here, deployed Worker URL for a real restore):

```bash
npm run dev
```

```bash
BASE=http://127.0.0.1:8787
SECRET=<the CUSTOMER_SNAPSHOT_SYNC_SECRET value from .dev.vars>
```

Terminal B, **in this order** — only after the §2 verify-first gate PASSES — D1 enforces the FK chain unconditionally and a misordered import 400s with `Dangling reference` instead of writing orphans (`docs/BACKFILL-RUNBOOK.md` §2):

```bash
curl -sS --fail-with-body -X POST "$BASE/api/v1/customer-snapshot/import" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: text/csv" \
  --data-binary @/tmp/r2-restore/$DATE-customer.csv &&
printf '\n' &&
curl -sS --fail-with-body -X POST "$BASE/api/v1/address-snapshot/import" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: text/csv" \
  --data-binary @/tmp/r2-restore/$DATE-address.csv &&
printf '\n' &&
curl -sS --fail-with-body -X POST "$BASE/api/v1/container-snapshot/import" \
  -H "Authorization: Bearer $SECRET" -H "Content-Type: text/csv" \
  --data-binary @/tmp/r2-restore/$DATE-container.csv
# Each successful response has upserted/rowCount/deleted; any error stops the chain.
```

Unlike `.../sync`, `.../import` requires data rows (`requireDataRows: true`), validates controls before binding, and never reconciles/deletes. It upserts import-compatible business cells, but cannot restore every archive: rejected control content is not stripped or silently repaired. If the archive is newer than D1, upserts overwrite in place (re-sync is idempotent — pinned in `test/snapshotSyncE2E.test.ts`). Re-apply erasures after any restore: an archive taken before a customer erasure re-inserts the erased row, so track erased `customerId` values out of band (the API keeps no suppression list) and re-`DELETE` each one after the restore (see `docs/R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched-tog-18933`).

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

**Required for control-bearing report archives, but not currently a runnable production command.** The repository has no route, CLI or deployed caller for this helper; the existing drill runs in Vitest only. An operator must first implement and deploy an authorized restore entry point using the sample below, validate it against staging bindings, and obtain the normal production-change authorization before executing a real recovery. Do not try to paste this TypeScript into a shell, or assume `wrangler` exposes an invocation for it. This runbook does not claim that entry point is already shipped.

After that prerequisite, pass the §2 integrity gate against the same date and bucket: `restoreSnapshotCsvFromR2` retrieves bytes but does not verify the manifest. The deployed entry point needs the intended `SNAPSHOTS` R2 and `CUSTOMER_DB` D1 bindings and must run the three tables in FK order. Keep it separate from public HTTP import; do not add an import-validation opt-out.

`restoreSnapshotCsvFromR2(env, table, date?)` returns the archived bytes as a `ReadableStream` (or `null` when the key is absent). Feed it straight into the same sync functions the cron uses, leaving `rejectControlCharacters` disabled (the default):

```ts
import { restoreSnapshotCsvFromR2 } from "./lib/r2SnapshotArchive";
import { syncCustomerSnapshotFromStream } from "./lib/snapshot/streamSync";

const body = await restoreSnapshotCsvFromR2(env, "customer", new Date("2026-09-27T00:00:00Z"));
if (body === null) {
  throw new Error("no archive for that date");
}
await syncCustomerSnapshotFromStream(env.CUSTOMER_DB, body);
```

Restore in FK order (customer → address → container), using `syncCustomerSnapshotFromStream`, `syncAddressSnapshotFromStream`, then `syncContainerSnapshotFromStream`; stop on a missing archive or failed sync. The default options upsert without reconciliation/deletion and restamp `synced_at`. They preserve the existing report-parser behavior for control-bearing business cells. Public HTTP import remains strict, including for the API's own exports; use §3 only for import-compatible CSVs, not arbitrary archive recovery. Re-apply erasures after any restore here too: the default upsert-without-reconciliation options re-insert rows erased before the archive date, and the API keeps no suppression list — re-`DELETE` each tracked-erased `customerId` afterwards.

## 7. Drill evidence

2026-09-28, `test/r2SnapshotRestore.test.ts` (3/3 green): archive → wipe D1 → restore from R2 → re-sync, against the real test D1 + R2 bindings. Archived 2-row fixtures per table, verified all three keys under `snapshots/<today>/`, wiped all tables to 0, restored in FK order (`{upserted: 2, rowCount: 2, deleted: 0}` per table), and asserted post-restore rows equal pre-wipe rows (counts **and** values). Missing-date returns `null`; unbound bucket throws with the disabled reason.

CLI leg validated live against local R2 state the same day: `r2 object put` + `r2 object get --local --pipe` round-tripped a seed CSV byte-identical, `--remote` on the same key returned "does not exist" (confirming no remote writes were made), scratch key deleted after.
