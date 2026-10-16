# R2 snapshot restore runbook — recover D1 from the CSV archive

**Scope:** §§2–5 are the credential-free reviewer drill to a **new, isolated local
D1**. They never deploy, write remote D1, or sync upstream. §7 separately documents
an **authorized incident recovery** to a deployed target; it is not a production
test and must not be executed as part of review or ordinary development.
Run from the repository root with Bash, Node >=22, Python 3, curl and the lockfile's
Wrangler installed (`npm ci --include=dev`). Commands were checked with Wrangler
4.84.1. Use two terminals: A for the local Worker, B for the recovery commands.

## 1. Archive layout and retention

The `SNAPSHOTS` binding names `routeware-csv-snapshots` in the default environment
and `routeware-csv-snapshots-test` in the test environment (`wrangler.toml`).
These are different buckets, including in local simulation.

| Object key | Contents |
|---|---|
| `snapshots/YYYY-MM-DD/customer.csv` | Raw customer report CSV; first header `CustomerID` |
| `snapshots/YYYY-MM-DD/address.csv` | Raw address report CSV; first header `PickupAddressID` |
| `snapshots/YYYY-MM-DD/container.csv` | Raw container report CSV; first header `ContainerID` |
| `snapshots/YYYY-MM-DD.manifest.json` | Version-1 manifest of uploaded files: keys, SHA-256 digests and byte sizes |

Date-alias keys are date-predictable (`snapshots/YYYY-MM-DD/{customer|address|container}.csv`,
UTC date). Per-run `snapshot-history/` keys and `snapshot-latest/` pointers are documented
in `docs/R2-RETENTION.md` and are not covered by this runbook's date-alias procedure;
do not substitute a history key for a date-alias key without a freshly reviewed procedure.

Dates are UTC. The manifest is **outside** the date directory. Its shape is
`{version:1,date:"YYYY-MM-DD",files:{"customer.csv":{key,sha256,bytes},...}}`.
An entry describes the exact CSV bytes, not parsed rows or a D1 SQL dump; it
contains no D1 schema or row count. See `src/lib/r2SnapshotArchive.ts`. A passing
manifest proves byte integrity, not import compatibility: public `.../import`
rejects forbidden control characters and lone-CR cell content even when those bytes
came from our archive or `.../export` (see `docs/PROBLEMS.md#csv-control-characters-bad-request`
and `test/snapshotRestoreControlBoundary.test.ts`). Do not start an HTTP restore to
discover whether the CSV is compatible: a late 400 can leave earlier batches written.
Neither restore path is atomic.

- A successful D1 sync precedes the best-effort archive upload. A successful
  sync does **not** prove that its R2 archive exists; check the object and manifest.
- Same-table re-runs on the same UTC day overwrite the same key. This is one
  daily slot, **not** immutable per-run history. Tables are archived separately;
  a date/manifest is not proof of a cross-table consistent database backup.
- The repository has **no age-based deletion or completed-object expiry policy**.
  There is no repository-enforced 7/30/90-day recovery window. An external R2
  lifecycle rule or operator deletion can shorten availability. **Live bucket
  lifecycle settings were not verified for this runbook.** Do not promise
  indefinite retention or enable/delete lifecycle rules as part of recovery.
- The multipart-abort cleanup in the writer concerns incomplete uploads, not
  retention of completed CSVs. A SHA-256 manifest detects byte mismatches; it is
  not a signature or proof of the archive's trusted provenance.

An authorized operator can inspect the selected remote bucket's lifecycle
without changing it:

```bash
npx wrangler r2 bucket lifecycle list "$BUCKET"
```

Record the matching prefix/expiration rules and inspection time privately.
Rules on `snapshots/` must account for both CSVs and sidecars. Never infer the
policy from the key's date. [R2 lifecycle documentation](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

## 2. Create private scratch state (terminal B)

In Paperclip use the run-owned scratch directory. Outside Paperclip, **export**
`PAPERCLIP_RUN_SCRATCH_DIR` to an approved private scratch parent first. Do **not**
erase `.wrangler/state`, point at an existing dev server, or substitute the
repository's production config.

Terminal B: choose `RECOVERY_BUCKET` in the block below before creating state.
The shown value names the **local fixture's simulated bucket**. For an authorized
incident, use the approved source bucket from §7.1 instead. After initialization,
the context is authoritative: changing a parent-shell `BUCKET` does not override
it. If you chose the wrong bucket, start a new context rather than mixing archives.
Create the private context file once in your ordinary Bash shell; this block does
not enable strict mode or call `exit` in your interactive shell.

```bash
export RECOVERY_BUCKET=routeware-csv-snapshots-test  # choose the approved source bucket here
if RECOVERY_CONTEXT="$(mktemp "${PAPERCLIP_RUN_SCRATCH_DIR:?set a private scratch parent}/r2-context.XXXXXX")"; then
  export RECOVERY_CONTEXT
  export SOURCE=local
  printf 'Private recovery context: %s\n' "$RECOVERY_CONTEXT"
else
  printf 'STOP: recovery context creation failed; do not continue\n' >&2
fi
```

Each following recovery block runs in a **subshell** `( ... )`: a failed command
stops that block, not your terminal. Stop the procedure on any failure; do not
paste the next block. The context file preserves only explicitly listed,
non-secret recovery settings, including the exact `RUN`. Later blocks source
that file, never downloaded archive content. After a STOP, inspect the cause and
resume only the failed step with the same context; do not repeat scratch creation
against existing state. Keep the context path private and available for cleanup.

```bash
(
set -euo pipefail
umask 077
: "${RECOVERY_CONTEXT:?create the private context file first}"
export ROOT="$PWD"
RUN="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:?set a private scratch parent}/r2-recovery.XXXXXX")"
[ -n "$RUN" ] && [ -d "$RUN" ] || { printf 'STOP: scratch creation failed\n' >&2; exit 1; }
export RUN
export DATE=2026-09-28  # choose the archive's UTC date before downloading
export BUCKET="${RECOVERY_BUCKET:?select the approved source bucket before creating state}"
export PORT=8797       # use a free local port; do not reuse another Worker's URL
export WRANGLER_SEND_METRICS=false
# Preserve the owned directory even if a later config/port check fails.
declare -p ROOT RUN DATE BUCKET PORT WRANGLER_SEND_METRICS > "$RECOVERY_CONTEXT"

python3 - <<'PY'
import json, os, pathlib, socket
root = pathlib.Path(os.environ['ROOT']).resolve()
run_value = os.environ.get('RUN', '')
if not run_value:
    raise SystemExit('STOP: RUN is empty')
run = pathlib.Path(run_value).resolve()
parent = pathlib.Path(os.environ['PAPERCLIP_RUN_SCRATCH_DIR']).resolve()
if (run == root or run.parent != parent or not run.is_dir() or
        not run.name.startswith('r2-recovery.') or any(run.iterdir())):
    raise SystemExit('STOP: RUN must be a new empty recovery directory under the scratch parent')
with socket.socket() as s:
    s.bind(('127.0.0.1', int(os.environ['PORT'])))  # fail if the port is occupied
q = lambda p: json.dumps(str(p))
(run / 'wrangler.toml').write_text(f'''name = "r2-recovery-scratch"
main = {q(root / 'src/worker.ts')}
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]
[vars]
TARGET_ORIGIN = "https://upstream.invalid"
SHADOW_API_TOKEN = "local-recovery-token"
CUSTOMER_SNAPSHOT_SYNC_SECRET = "local-recovery-sync"
SNAPSHOTS_R2_ENABLED = "false"
[[d1_databases]]
binding = "CUSTOMER_DB"
database_name = "r2-recovery-scratch"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = {q(root / 'migrations/d1')}
[[durable_objects.bindings]]
name = "AUTH_SESSION"
class_name = "AuthSession"
[[migrations]]
tag = "v1"
new_classes = ["AuthSession"]
''')
PY

npx wrangler d1 migrations apply CUSTOMER_DB --local \
  --config "$RUN/wrangler.toml" --persist-to "$RUN/state"
)
```

The generated config has a dummy D1 id, public **synthetic** local-only bearer
values, no report query ids, no cron, no live R2 binding and no real credentials.
It loads no repository `.dev.vars`. Every D1 command in §§2–5 uses that config and
`--local --persist-to "$RUN/state"`. No Cloudflare account provisioning is needed.
**Never import a real archive into this fixture Worker.** Its published bearer
values are safe only for synthetic rows; loopback does not isolate other users
on a shared host. Real-data local rehearsal needs separately approved access
isolation and private credentials, not this credential-free drill.

## 3. Credential-free reviewer fixture — synthetic data only

This is the complete one-table acceptance drill: seed synthetic CSV + sidecar
into **local** R2, then recover them using the same Wrangler download leg as §4.
It neither reads nor writes a remote bucket. Never manufacture a replacement
manifest for a real archive that is missing one.

```bash
(
set -euo pipefail
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { RUN, DATE } = process.env;
const csv = Buffer.from('CustomerID,CompanyName,Enabled\n101,"Recovery, Example",true\n102,Second Example,false\n');
writeFileSync(`${RUN}/seed.csv`, csv);
writeFileSync(`${RUN}/seed.manifest.json`, JSON.stringify({
  version: 1, date: DATE, files: { 'customer.csv': {
    key: `snapshots/${DATE}/customer.csv`,
    sha256: createHash('sha256').update(csv).digest('hex'), bytes: csv.length
  }}
}));
JS

npx wrangler r2 object put "$BUCKET/snapshots/$DATE/customer.csv" \
  --local --persist-to "$RUN/state" --file "$RUN/seed.csv"
npx wrangler r2 object put "$BUCKET/snapshots/$DATE.manifest.json" \
  --local --persist-to "$RUN/state" --file "$RUN/seed.manifest.json"
)
```

## 4. Download and verify the exact files that will be imported

For the §3 fixture, leave `SOURCE=local`. For a real recovery set `SOURCE=remote`
**only with authorized read access to the selected source bucket/date**. Remote
R2 GETs require the normal Wrangler authorization; never paste credentials into
this doc, commands, or evidence. Do not use a production archive for the reviewer
drill. Local R2 objects are not visible remotely and vice versa.

```bash
(
set -euo pipefail
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
case "${SOURCE:?set local or remote}" in
  local) R2_FLAGS=(--local --persist-to "$RUN/state") ;;
  remote) R2_FLAGS=(--remote) ;;
  *) printf 'STOP: SOURCE must be local or remote\n' >&2; exit 1 ;;
esac
npx wrangler r2 object get "$BUCKET/snapshots/$DATE/customer.csv" \
  "${R2_FLAGS[@]}" --file "$RUN/customer.csv"
npx wrangler r2 object get "$BUCKET/snapshots/$DATE.manifest.json" \
  "${R2_FLAGS[@]}" --file "$RUN/manifest.json"

node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { RUN, DATE } = process.env;
let manifest;
try {
  manifest = JSON.parse(readFileSync(`${RUN}/manifest.json`, 'utf8'));
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('invalid manifest shape');
  }
} catch {
  console.error('STOP: unreadable or invalid archive manifest');
  process.exit(1);  // never echo downloaded content or the parser's error
}
const entry = manifest.files?.['customer.csv'];
const csv = readFileSync(`${RUN}/customer.csv`);
const digest = createHash('sha256').update(csv).digest('hex');
if (manifest.version !== 1 || manifest.date !== DATE ||
    entry?.key !== `snapshots/${DATE}/customer.csv` ||
    !Number.isInteger(entry?.bytes) || entry.bytes <= 0 ||
    entry.bytes !== csv.length || !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? '') ||
    entry.sha256 !== digest) throw new Error('STOP: customer archive integrity mismatch');
console.log(`PASS customer.csv: ${csv.length} bytes, SHA-256 ${digest}`);
JS
)
```

**Stop before any import** on a missing CSV/manifest, parse error, missing entry,
wrong date/key, hash mismatch or size mismatch. Archives predating manifest
support cannot pass this gate; choose a known-good manifested archive or
escalate the recovery gap. Do not print CSV bodies/headers as an existence check.
Leave verified downloads unchanged; re-run the gate if you replace a file.

On main, the optional whole-date audit verifies every manifest entry in the
**selected** local bucket and persistence directory:

```bash
(
set -euo pipefail
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
node scripts/verify-r2-manifest.mjs --date="$DATE" --bucket="$BUCKET" \
  --persist-to "$RUN/state"
)
```

For an authorized remote audit, replace `--persist-to "$RUN/state"` with
`--remote`. This script specifically requires `CLOUDFLARE_API_TOKEN` already
available in the environment; Wrangler OAuth alone does not satisfy its gate.
Never pass the token as a flag or print it. The audit re-downloads objects and
is not a substitute for verifying the **specific downloaded bytes** imported here.

## 5. Recover the customer table into scratch D1

Terminal A: from the same repository root, export the **exact** `RECOVERY_CONTEXT`
path printed in terminal B (not its contents), then run the following in the
foreground. The file supplies the exact `RUN` and `PORT`. No `--remote`, `-e test`
or repository config. If startup fails, stop; do not import through an older
server already answering that port.

```bash
(
set -euo pipefail
source "${RECOVERY_CONTEXT:?export the exact context path from terminal B}"
CLOUDFLARE_INCLUDE_PROCESS_ENV=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  npx wrangler dev --local --config "$RUN/wrangler.toml" \
  --persist-to "$RUN/state" --ip 127.0.0.1 --port "$PORT"
)
```

The command-local overrides disable process-env and `.env` secret loading even
if inherited settings enable them. Otherwise an ambient sync secret can override
the synthetic binding (or expose unrelated process credentials to the Worker).
The new config has no `secrets.required`, and its directory has no `.dev.vars`.
See [Wrangler's local environment controls](https://developers.cloudflare.com/workers/local-development/environment-variables/#controlling-env-handling).

Wait for `Ready on http://127.0.0.1:<PORT>`. Terminal B:

```bash
(
set -euo pipefail
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
BASE="http://127.0.0.1:$PORT"
curl --noproxy 127.0.0.1 --fail-with-body --silent --show-error \
  "$BASE/api/v1/customer-snapshot/import" \
  -H 'Authorization: Bearer local-recovery-sync' -H 'Content-Type: text/csv' \
  --data-binary @"$RUN/customer.csv" > "$RUN/import.json"

npx wrangler d1 execute CUSTOMER_DB --local --config "$RUN/wrangler.toml" \
  --persist-to "$RUN/state" --json --command \
  'SELECT COUNT(*) AS customers FROM customer_snapshot;
   SELECT COUNT(*) AS addresses FROM address_snapshot;
   SELECT COUNT(*) AS containers FROM container_snapshot;' > "$RUN/counts.json"

python3 - <<'PY'
import csv, json, os, pathlib
csv.field_size_limit(50 * 1024 * 1024)  # match the import body's supported ceiling
run = pathlib.Path(os.environ['RUN'])
with (run / 'customer.csv').open(encoding='utf-8-sig', newline='') as f:
    expected = sum(1 for _ in csv.DictReader(f))
result = json.loads((run / 'import.json').read_text())
counts = json.loads((run / 'counts.json').read_text())
if expected <= 0:
    raise SystemExit('STOP: archive has no data rows')
if result['rowCount'] != expected or result['upserted'] != expected:
    raise SystemExit('STOP: import count mismatch')
if result['deleted'] != 0:
    raise SystemExit('STOP: import must not delete')
if [x['results'][0] for x in counts] != [
    {'customers': expected}, {'addresses': 0}, {'containers': 0}
]:
    raise SystemExit('STOP: D1 count mismatch or nonempty scratch target')
print(f'PASS: restored {expected} customers; address/container remain empty; deleted=0')
PY
)
```

For the synthetic fixture, additionally verify values, not just counts:

```bash
(
set -euo pipefail
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
npx wrangler d1 execute CUSTOMER_DB --local --config "$RUN/wrangler.toml" \
  --persist-to "$RUN/state" --json --command \
  'SELECT customer_id, company_name, enabled FROM customer_snapshot ORDER BY customer_id' \
  > "$RUN/values.json"
python3 - <<'PY'
import json, os, pathlib
rows = json.loads((pathlib.Path(os.environ['RUN']) / 'values.json').read_text())[0]['results']
if rows != [
    {'customer_id': 101, 'company_name': 'Recovery, Example', 'enabled': 1},
    {'customer_id': 102, 'company_name': 'Second Example', 'enabled': 0}
]:
    raise SystemExit('STOP: recovered values differ')
print('PASS: both synthetic rows match ids, quoted CSV values and booleans')
PY
)
```

§5 is **synthetic-only**. For a real archive, use the separately authorized target
in §7 and compare sampled ids/values to its CSV **privately**. Never load real PII
into the fixture Worker. Only post counts, digests and the reviewed SHA.
Duplicate ids, skipped/invalid rows or partial writes can make counts disagree;
a 200 alone is not acceptance. Diagnose the input, then repeat in a **new**
scratch directory. Imports upsert existing ids and never reconcile/delete rows.

To extend to addresses/containers, recover and verify their own CSV/manifest
entries, then import **customer → address → container** using the corresponding
`/api/v1/{address|container}-snapshot/import` route. Child rows require their
parents. Do not restore a child table alone into an empty D1. Imports are batched,
not a cross-table transaction; preserve per-table results and verify orphan
counts are zero. Never call `/sync` while recovering a partial chain.

## 6. Readback-route handoff and programmatic recovery

The round-4 readback route is `GET /api/v1/snapshots/{table}/{date}` (table:
`customer`, `address` or `container`; UTC `YYYY-MM-DD`; sync-secret authorization).
**Once that route is deployed to the selected source environment**, it supersedes
Wrangler's **CSV download leg** in §4. Until deployment is confirmed, retain the
CLI fallback. A download is not a D1 restore: it still needs a matching manifest,
the verify-first gate, an authorized import target and count/value checks. An
HTTP ETag is not the manifest's SHA-256. A 404 means the object is absent; 503
means the R2 binding is unavailable. Do not test imports on a production URL.

Main also exposes `restoreSnapshotCsvFromR2(env, table, date?)` in
`src/lib/r2SnapshotArchive.ts`: it returns the CSV stream, `null` for an absent
key, or throws when archiving is disabled/unbound. Programmatic recovery feeds
that stream into the existing per-table stream-sync functions in FK order.
This helper is not a standalone HTTP R2-to-D1 restore endpoint and does not
replace manifest verification or recovery authorization.

**Use this in-code path for report-origin archive recovery.** It retrieves the archived
stream and uses the same permissive parsing as upstream report sync (leave
`rejectControlCharacters` disabled, the default). Public `.../import` is not a general
disaster-recovery route: use §5/§7 HTTP imports only for CSVs whose entire contents are
already known to satisfy `docs/PROBLEMS.md#csv-control-characters-bad-request`, verified
by the offline control pre-check below. Do not strip controls from a recovery archive to
make the check pass. The pre-check runs like every other recovery block (subshell,
`set -euo pipefail`, sourced `RECOVERY_CONTEXT`) and checks only the selected tables:
`RECOVERY_TABLES` (or `SELECTED_TABLES`) as a space-separated subset, defaulting to
`customer` for the §3 drill, so a subset run does not demand absent tables.

```bash
(
set -euo pipefail
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
python3 - "$DATE" <<'PY'
from datetime import date
from pathlib import Path
import os
import sys
try:
    day = date.fromisoformat(sys.argv[1]).isoformat()
except (IndexError, ValueError):
    sys.exit("Invalid DATE; expected YYYY-MM-DD.")
allowed = ("customer", "address", "container")
selection = os.environ.get("RECOVERY_TABLES", os.environ.get("SELECTED_TABLES", "customer")).strip().split()
if not selection or any(t not in allowed for t in selection):
    sys.exit("Invalid table selection; expected subset of 'customer address container'.")
failed = False
for table in selection:
    path = Path(os.environ["RUN"]) / f"{table}.csv"
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
        print(f"{path}: control-incompatible; use the in-code path below, not HTTP import")
        failed = True
if failed:
    sys.exit(1)
print("All selected CSVs passed the offline control pre-check.")
PY
)
```

On a failed pre-check, do not run HTTP imports: use the code-deployment procedure next
or a separately verified D1 backup. The in-code path is not currently a runnable
production command: the repository has no route, CLI or deployed caller for this helper
(the existing drill runs in Vitest only). An operator must first implement and deploy an
authorized restore entry point using the sample below, validate it against staging
bindings, and obtain the normal production-change authorization before executing a real
recovery. Do not paste this TypeScript into a shell or assume `wrangler` exposes an
invocation for it. After that prerequisite, pass the §4 integrity gate against the same
date and bucket (`restoreSnapshotCsvFromR2` retrieves bytes but does not verify the
manifest), run the three tables in FK order with `syncCustomerSnapshotFromStream`,
`syncAddressSnapshotFromStream`, then `syncContainerSnapshotFromStream` (default
upsert-without-reconciliation options, restamping `synced_at`), and keep the entry point
separate from public HTTP import without adding an import-validation opt-out. Re-apply
customer erasures after any restore: an archive taken before a customer erasure re-inserts
the erased row (the API keeps no suppression list), so track erased `customerId` values
out of band and re-`DELETE` each one afterwards (see `docs/R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched-tog-18933`).

## 7. Deployed incident recovery — separately authorized, never a drill

**Do not execute this section during review.** Production recovery requires the
incident owner's explicit authorization and CEO sign-off for remote data writes,
as required by [the D1 runbook](D1-BACKUP-RESTORE-RUNBOOK.md). Record the approved
account, Worker URL, D1 id, environment, archive date, affected tables and undo
plan privately. Approval to read R2 or run a scratch drill is **not** approval to
write a deployed database. If authority or target identity is uncertain, stop.

Before writes, the operator must arrange an approved maintenance window that
quiesces the snapshot cron and other D1 writers and freezes Worker deployments and
binding edits. Do not disable a security gate, probe an import route, run `/sync`,
migrate schema, or wipe tables. This is an upsert recovery, **not** a point-in-time
rewind: existing ids are updated, missing ids are inserted, and ids absent from
the CSV remain. For an empty lost table, post-import count must equal its distinct
valid CSV ids. A nonempty target needs an approved merge plan (expected union of
ids and retained rows); do not assume its count equals the archive's count.
Whole-database rewind is a different, separately approved operation.

### 7.1 Bind the approved deployed target and capture an undo point

Use the maintained repo config, **not** `$RUN/wrangler.toml`. Match the approved
Worker's active `CUSTOMER_DB` binding to the same D1 id in that config; the Worker
URL alone does not establish identity. The `test` environment is not evidence of
a staging deployment or permission to write it.

| Approved environment | Wrangler environment flag | D1 name | Source R2 bucket |
|---|---|---|---|
| Default production | none | `routeware-customer-snapshot` | `routeware-csv-snapshots` |
| `test` | `--env test` | `routeware-customer-snapshot-test` | `routeware-csv-snapshots-test` |

In terminal B, export `RECOVERY_ENV` as exactly `default` or `test`, and
`RECOVERY_BASE` as the approved HTTPS Worker origin, with no path/query. Confirm
and export `RECOVERY_D1_ID` from the approved active Worker binding and
`RECOVERY_WORKER_VERSION_ID` from its active deployment. The deployment must
route 100% of traffic to one version; if it is split, or the binding/version is
unclear, stop. Also confirm and export `RECOVERY_WORKERS_PLAN`, the effective
`RECOVERY_WORKERS_SUBREQUEST_LIMIT`, `RECOVERY_WORKERS_CPU_LIMIT_MS`, and
incident-approved `RECOVERY_D1_BUDGET` for this exact deployed target as defined
in §7.2; if any value is unknown, stop.
Wrangler authorization and `CUSTOMER_SNAPSHOT_SYNC_SECRET` must come from the
approved secret store/environment injection. Never type the secret in a command,
put it in the context file, use a CLI token flag, or print it. Do not retrieve a
secret from git history or change credentials if authorization fails.

```bash
(
set +x
set -euo pipefail
umask 077
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
DEPLOYED_FLAGS=(--config "$ROOT/wrangler.toml")
case "${RECOVERY_ENV:?export the explicitly approved environment}" in
  default) D1_NAME=routeware-customer-snapshot; SOURCE_BUCKET=routeware-csv-snapshots ;;
  test) D1_NAME=routeware-customer-snapshot-test; SOURCE_BUCKET=routeware-csv-snapshots-test; DEPLOYED_FLAGS+=(--env test) ;;
  *) printf 'STOP: unapproved environment\n' >&2; exit 1 ;;
esac
[ "$BUCKET" = "$SOURCE_BUCKET" ] || { printf 'STOP: source bucket does not match the approved environment; create a new context\n' >&2; exit 1; }
export SOURCE_BUCKET
: "${RECOVERY_BASE:?export the approved Worker origin}"
: "${RECOVERY_D1_ID:?confirm the active Worker D1 binding id}"
: "${RECOVERY_WORKER_VERSION_ID:?confirm the active Worker version id}"
: "${RECOVERY_WORKERS_PLAN:?confirm the deployed target plan}"
: "${RECOVERY_WORKERS_SUBREQUEST_LIMIT:?confirm the deployed internal-service limit}"
: "${RECOVERY_WORKERS_CPU_LIMIT_MS:?confirm the deployed CPU limit in ms}"
: "${RECOVERY_D1_BUDGET:?record the approved per-import budget}"
export RECOVERY_ENV D1_NAME SOURCE_BUCKET RECOVERY_D1_ID \
  RECOVERY_WORKER_VERSION_ID RECOVERY_WORKERS_PLAN \
  RECOVERY_WORKERS_SUBREQUEST_LIMIT RECOVERY_WORKERS_CPU_LIMIT_MS \
  RECOVERY_D1_BUDGET
declare -p RECOVERY_ENV D1_NAME DEPLOYED_FLAGS RECOVERY_BASE SOURCE_BUCKET \
  RECOVERY_D1_ID RECOVERY_WORKER_VERSION_ID RECOVERY_WORKERS_PLAN \
  RECOVERY_WORKERS_SUBREQUEST_LIMIT RECOVERY_WORKERS_CPU_LIMIT_MS \
  RECOVERY_D1_BUDGET > "$RUN/deployed-context.bash"
npx wrangler d1 info "$D1_NAME" "${DEPLOYED_FLAGS[@]}" --json > "$RUN/deployed-d1-info.json"
npx wrangler deployments status "${DEPLOYED_FLAGS[@]}" --json > "$RUN/worker-deployment-before.json"
npx wrangler d1 time-travel info "$D1_NAME" "${DEPLOYED_FLAGS[@]}" --json > "$RUN/pre-recovery-bookmark.json"
npx wrangler d1 execute "$D1_NAME" "${DEPLOYED_FLAGS[@]}" --remote --json --command \
  'SELECT COUNT(*) AS customers FROM customer_snapshot;
   SELECT COUNT(*) AS addresses FROM address_snapshot;
   SELECT COUNT(*) AS containers FROM container_snapshot;' > "$RUN/deployed-before.json"
)
```

Inspect these private files **before proceeding**: the D1 id in Wrangler output
must equal `RECOVERY_D1_ID` and the approved active Worker binding; deployment
status must show the recorded version at 100%; and the bookmark must be usable
within its retention window. Keep the Worker version and binding frozen for the
maintenance window. Before each HTTP import, the §7.2 gate re-reads deployment
status and the recorded version metadata; it requires exactly one version at
100% and that version's `CUSTOMER_DB` D1 id and CPU limit to match the receipt.
If either query fails, the deployment is split, required metadata is missing, or
any value differs, the gate stops before HTTP; obtain fresh approval and a new
preflight receipt.
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is
always on for the current D1 backend (7 days Free / 30 days Paid); do not infer
the current plan or backend from this repo. If a usable bookmark cannot be
captured, stop and obtain a different approved backup/undo plan. Time Travel
restores the **whole database in place**, cancels in-flight queries and can undo
unrelated writes; it is not a table-scoped rollback. The SQL-export alternative
is described in [D1-BACKUP-RESTORE-RUNBOOK.md](D1-BACKUP-RESTORE-RUNBOOK.md).

### 7.2 Download, gate and import each approved table in FK order

Use authorized `SOURCE=remote` reads in §4 against the approved source bucket.
For each affected table, substitute its name for `customer` in the CSV key,
destination filename and manifest entry: `address.csv` or `container.csv` as
needed. Keep the same sidecar and verify **every** selected CSV before the first
write. Recover parents before children: **customer → address → container**;
unchanged parents must already exist. A same-date manifest is not proof of a
consistent chain. Confirm compatible parent ids against the approved target or
in a separately approved, privately isolated rehearsal; never use the public
fixture Worker for real PII.

The HTTP imports cap **each body at 50 MiB** (`SNAPSHOT_IMPORT_MAX_BYTES`); archive
writers have no equivalent cap. A small body can still exceed the deployed
Worker's internal-service subrequest limit. Before the first deployed write, export:

- `RECOVERY_TABLES`: approved space-separated table names in FK order, for example
  `customer address container`.
- `RECOVERY_WORKERS_PLAN`: exactly `free` or `paid`, **confirmed for the approved
  target**, not inferred from local Wrangler or the source bucket.
- `RECOVERY_WORKERS_SUBREQUEST_LIMIT`: the effective per-invocation internal-service
  limit for that deployed Worker, confirmed from its current plan and configuration.
  Workers Free allows 1,000 requests to Cloudflare internal services (separate from
  its 50 external-subrequest limit); Workers Paid uses the configured limit (10,000
  by default, up to 10 million). The D1 limits page still shows a legacy
  1,000-Paid/50-Free row that points to Workers subrequest limits; reconcile it
  against the current linked Workers limits, the active Worker and actual target.
  If any applicable D1 or Worker limit is unclear or lower, **STOP** until resolved;
  never assume a larger limit. This repository's current `wrangler.toml` does not
  set `limits.subrequests`, which does not prove what is deployed.
- `RECOVERY_D1_BUDGET`: the incident-approved positive integer internal-service
  subrequest budget per import. It must leave at least 10% headroom (minimum one
  call) below the verified effective limit; the gate also reserves calls for
  shared-route overhead. No limit increase, plan upgrade, or new spend is implied.
- `RECOVERY_WORKERS_CPU_LIMIT_MS`: the positive effective CPU-time limit in
  milliseconds for the confirmed active Worker version. The repository config's
  `cpu_ms = 300_000` is not proof of the deployed setting; unknown means **STOP**.

Cloudflare defines a subrequest as a Worker request to a Cloudflare service,
including D1. `D1Database.batch()` sends multiple SQL statements inside one call,
so this gate counts each importer `db.batch()` call once, not each SQL statement
as a separate Worker subrequest. It adds one successful-auth Durable Object call
and, for address/container, one possible foreign-key diagnostic D1 call. Each
table's HTTP import is a separate Worker invocation. This model is valid only for
the exact verified route/auth code and importer; include any other service calls
in that deployed path, or stop if the path has changed. The import code does not
make external fetches; if that changes, budget the separate external limit too.

Before the first deployed write, also verify privately that the complete selected
imports fit the remaining D1 read/write allocation and storage capacity for this
account/database, including write amplification from indexes and account usage
outside this Worker. Use current D1 Metrics/Row Metrics and the account's plan and
billing budget; stop if remaining quota/capacity is unknown, insufficient, or
would exceed the approved no-new-spend budget. Confirm the deployed CPU limit and
that a same-size successful run or approved non-production rehearsal demonstrates
sufficient runtime margin. The snapshot cron and other D1 writers must remain
quiesced. This offline gate cannot prove daily/monthly quota, storage, runtime
success, or parent FK compatibility. Passing it is necessary, not a promise of
runtime success.

Run the all-files preflight before **any table write**. It uses the existing
stream-sync parsers with `dryRun: true`, `requireDataRows: true` and a throwing D1
stub, so malformed/missing id headers and zero importable rows fail without D1
access. It does not count physical newlines or use the non-streaming CSV parser:
quoted multiline fields follow the actual import dialect. Stop on an oversized,
over-budget or unimportable archive and obtain an approved alternative; do not
begin a partial chain or improvise CSV splitting during an incident.

**When a table cannot fit the HTTP budget:** do not raise the budget, upgrade the plan,
or split the CSV ad hoc. Obtain fresh incident approval for one of these usable
alternatives, then execute it under the same maintenance window, binding freeze, manifest
gate and FK order: (a) the §6 programmatic restore via a staging-validated, separately
deployed restore entry point (it does not consume the per-invocation HTTP-import
subrequest budget the same way; verify its own budget before use); (b) a direct D1 SQL
restore via privileged `wrangler d1 execute` with FK-ordered SQL derived from the verified
CSV (bypasses the Worker HTTP limit; subject to D1 SQL/API limits, verify privately);
(c) whole-database Time Travel or SQL-export restore per `D1-BACKUP-RESTORE-RUNBOOK.md`
(whole-database impact, separately approved); or (d) a revised selection that skips the
over-budget table with explicit child-dependency confirmation, followed by a rerun of this
all-files gate. Unlike `.../sync`, `.../import` requires data rows (`requireDataRows: true`),
validates controls before binding, and never reconciles/deletes; it upserts
import-compatible business cells but cannot restore every archive.

**Legitimate empty archives:** header-only/blank/zero-valid-row files stop the
whole selection before even the customer import. They cannot clear a table:
imports are upserts, not deletions. If an empty table should remain unchanged,
the incident owner must explicitly revise the approved selection to skip it and
confirm child dependencies; then rerun the all-files gate. Never auto-skip, post an
empty CSV, or infer permission to delete rows from an empty archive.

```bash
(
set -euo pipefail
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
source "$RUN/deployed-context.bash"
[ "$BUCKET" = "$SOURCE_BUCKET" ] || { printf 'STOP: source bucket mismatch\n' >&2; exit 1; }
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, relative } from 'node:path';
import { build } from 'esbuild';  // lockfile's installed Wrangler dependency; no download
try {
  const { ROOT, RUN, DATE, BUCKET, RECOVERY_BASE, RECOVERY_TABLES,
    RECOVERY_ENV: environment, D1_NAME: d1Name, RECOVERY_D1_ID: d1Id,
    RECOVERY_WORKER_VERSION_ID: workerVersionId,
    RECOVERY_WORKERS_PLAN: plan, RECOVERY_WORKERS_SUBREQUEST_LIMIT: limitText,
    RECOVERY_WORKERS_CPU_LIMIT_MS: cpuLimitText,
    RECOVERY_D1_BUDGET: budgetText } = process.env;
  // Invalidate any old gate receipt before checking a revised selection.
  writeFileSync(`${RUN}/approved-recovery-tables.json`, 'null');
  const platformMax = plan === 'free' ? 1000 : plan === 'paid' ? 10_000_000 : 0;
  const workerLimit = Number(limitText);
  const cpuLimit = Number(cpuLimitText);
  const budget = Number(budgetText);
  const expectedD1Name = environment === 'default' ? 'routeware-customer-snapshot' :
    environment === 'test' ? 'routeware-customer-snapshot-test' : null;
  const headroom = Math.max(1, Math.ceil(workerLimit * 0.1));
  if (!expectedD1Name || d1Name !== expectedD1Name || !d1Id || !workerVersionId ||
      !/^[1-9]\d*$/.test(cpuLimitText ?? '') || !Number.isSafeInteger(cpuLimit) ||
      !platformMax || !/^[1-9]\d*$/.test(limitText ?? '') ||
      !Number.isSafeInteger(workerLimit) || workerLimit > platformMax ||
      !/^[1-9]\d*$/.test(budgetText ?? '') || !Number.isSafeInteger(budget) ||
      budget > workerLimit - headroom) throw new Error();
  const base = new URL(RECOVERY_BASE);
  if (base.protocol !== 'https:' || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash) throw new Error();
  const order = ['customer', 'address', 'container'];
  const tables = RECOVERY_TABLES?.trim().split(/\s+/);
  if (!tables?.length || tables.some((t, i) => !order.includes(t) ||
      (i > 0 && order.indexOf(t) <= order.indexOf(tables[i - 1])))) throw new Error();
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Bundle committed parsers, not sibling working-tree edits. No DB/HTTP is used.
  const { outputFiles } = await build({
    stdin: { contents: 'export * from "./src/lib/snapshot/streamSync.ts"; export * from "./src/lib/snapshot/tableSql.ts";', resolveDir: ROOT },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
    plugins: [{ name: 'committed-source', setup(b) {
      b.onLoad({ filter: /\.ts$/ }, ({ path }) => ({
        contents: execFileSync('git', ['-C', ROOT, 'show', `${head}:${relative(ROOT, path)}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
        loader: 'ts', resolveDir: dirname(path)
      }));
    }}]
  });
  const source = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
  const specs = {
    customer: [source.syncCustomerSnapshotFromStream, source.STREAM_BATCH_CUST, source.CUST_R_PER_STMT],
    address: [source.syncAddressSnapshotFromStream, source.STREAM_BATCH_ADDR, source.ADDR_R_PER_STMT],
    container: [source.syncContainerSnapshotFromStream, source.STREAM_BATCH_CONT, source.CONT_R_PER_STMT]
  };
  if (source.STREAM_BATCH_CUST !== 80 || source.STREAM_BATCH_ADDR !== 80 ||
      source.STREAM_BATCH_CONT !== 40 || source.CUST_R_PER_STMT !== 7 ||
      source.ADDR_R_PER_STMT !== 6 || source.CONT_R_PER_STMT !== 3 ||
      source.SNAPSHOT_IMPORT_MAX_BYTES !== 50 * 1024 * 1024) {
    throw new Error();  // a source change needs a freshly reviewed budget model
  }
  const noD1 = new Proxy({}, { get() { throw new Error('D1 forbidden in preflight'); } });
  const manifest = JSON.parse(readFileSync(`${RUN}/manifest.json`, 'utf8'));
  if (manifest?.version !== 1 || manifest.date !== DATE) throw new Error();
  const files = {};
  for (const table of tables) {
    const entry = manifest.files?.[`${table}.csv`];
    const csv = readFileSync(`${RUN}/${table}.csv`);
    const sha256 = createHash('sha256').update(csv).digest('hex');
    if (!Number.isInteger(entry?.bytes) || entry.bytes !== csv.length || csv.length === 0 ||
        csv.length > source.SNAPSHOT_IMPORT_MAX_BYTES ||
        entry.key !== `snapshots/${DATE}/${table}.csv` || entry.sha256 !== sha256) throw new Error();
    const [parse, batchRows, sqlRows] = specs[table];
    const { rowCount } = await parse(noD1, new Response(csv).body, undefined, {
      dryRun: true, requireDataRows: true, maxBytes: source.SNAPSHOT_IMPORT_MAX_BYTES,
      rejectControlCharacters: true
    });
    if (!Number.isSafeInteger(rowCount) || rowCount <= 0) throw new Error();
    const batchCalls = Math.ceil(rowCount / batchRows);
    // Informational only: SQL statements are not individual Worker subrequests.
    const sqlStatements = Math.floor(rowCount / batchRows) * Math.ceil(batchRows / sqlRows) +
      Math.ceil((rowCount % batchRows) / sqlRows);
    // One auth-throttle Durable Object call; children may make one FK diagnostic D1 call.
    const upperBound = batchCalls + (table === 'customer' ? 1 : 2);
    if (upperBound > budget) throw new Error();
    files[table] = { bytes: csv.length, sha256, rowCount, batchCalls, sqlStatements, upperBound };
  }
  writeFileSync(`${RUN}/approved-recovery-tables.json`, JSON.stringify({
    version: 1, head, date: DATE, environment, d1Name, d1Id,
    workerVersionId, workerCpuLimitMs: cpuLimit, bucket: BUCKET,
    base: RECOVERY_BASE, plan, workerSubrequestLimit: workerLimit, budget,
    tables, files
  }));
  console.log('PASS: every selected archive is importable and within the approved invocation budget');
} catch {
  console.error('STOP: all-files integrity, order, size, parser or invocation-budget preflight failed');
  process.exit(1);  // never print downloaded content or parser errors
}
JS
)
```

The private gate receipt binds the committed parser SHA, target environment, D1
name/id, active Worker version and CPU limit, target origin, bucket, date,
confirmed plan and effective Worker subrequest limit, approved budget, ordered
selection, and each file's bytes/digest, accepted-row count and call calculation.
It is a snapshot, not a live Cloudflare lock: freeze deployments and binding
edits for the maintenance window. Before each POST, the import command fetches
fresh deployment status and metadata for the approved version and stops unless
the version, `CUSTOMER_DB` binding, and CPU limit still match. Customer/address streams flush
every 80 accepted rows; containers every 40. SQL packs at most 7/6/3 rows
respectively, restarting at each flush (`streamSync.ts`, `tableSql.ts`, `upsert.ts`).
The gate counts one subrequest for each `db.batch()` call, plus one
successful-auth Durable Object call and, for child tables, one possible
FK-diagnostic D1 call. SQL statement count is recorded for inspection only. The
approved budget must also leave at least 10% of the verified internal-service
limit unused. Quota, storage, billing and CPU-margin checks remain explicit
operator prerequisites; a receipt does not imply they passed.

For example, 40,001 container rows require 1,001 `db.batch()` calls and a bound
of 1,003 including route overhead. This fits a 9,000-call budget when the verified
Paid default is 10,000, but stops if the deployed limit is 1,000. The recorded
2026-09-27 cron evidence reports 109,894 customer rows, 111,620 address rows and
44,279 container rows touched; the source batch sizes imply 1,374, 1,396 and 1,107
`db.batch()` calls respectively. That history supports the call-based model but
does not prove the current target's plan/config or the selected archive's size;
confirm both before relying on it ([cron evidence](TOG-8387-cron-drill-schedule.md)).
Do not edit the receipt. A failed preflight invalidates any earlier receipt.

Row counts follow importer behavior: invalid-id/blank rows are skipped and
duplicate ids count repeatedly. A positive parser count is **not** proof that all
CSV rows were valid, ids are distinct or parents exist; reconcile distinct ids,
skips and FK compatibility privately before proceeding.

For each table in that order, export `RECOVERY_TABLE` as exactly `customer`,
`address` or `container` in terminal B and run this block. It rechecks **all
selected files** against the receipt immediately before each import and requires
its result to match the preflight's accepted-row count. If files, target, source
SHA or approval change, stop and rerun the all-files gate; never reuse a stale
receipt. Only the secret already injected into the operator's environment is
used; it never appears in process arguments or output.

```bash
(
set +x
set -euo pipefail
umask 077
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
source "$RUN/deployed-context.bash"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
try {
  const { ROOT, RUN, DATE, RECOVERY_BASE, RECOVERY_TABLE: table, BUCKET, SOURCE_BUCKET,
    RECOVERY_ENV: environment, D1_NAME: d1Name, RECOVERY_D1_ID: d1Id,
    RECOVERY_WORKER_VERSION_ID: workerVersionId,
    RECOVERY_WORKERS_PLAN: plan, RECOVERY_WORKERS_SUBREQUEST_LIMIT: limitText,
    RECOVERY_WORKERS_CPU_LIMIT_MS: cpuLimitText,
    RECOVERY_D1_BUDGET: budgetText, CUSTOMER_SNAPSHOT_SYNC_SECRET: secret } = process.env;
  const approval = JSON.parse(readFileSync(`${RUN}/approved-recovery-tables.json`, 'utf8'));
  const order = ['customer', 'address', 'container'];
  const tables = approval?.tables;
  const platformMax = plan === 'free' ? 1000 : plan === 'paid' ? 10_000_000 : 0;
  const workerLimit = Number(limitText);
  const cpuLimit = Number(cpuLimitText);
  const budget = Number(budgetText);
  const expectedD1Name = environment === 'default' ? 'routeware-customer-snapshot' :
    environment === 'test' ? 'routeware-customer-snapshot-test' : null;
  const headroom = Math.max(1, Math.ceil(workerLimit * 0.1));
  if (!order.includes(table) || !secret || BUCKET !== SOURCE_BUCKET ||
      !expectedD1Name || d1Name !== expectedD1Name || !d1Id || !workerVersionId ||
      !/^[1-9]\d*$/.test(cpuLimitText ?? '') || !Number.isSafeInteger(cpuLimit) ||
      approval?.version !== 1 || approval.date !== DATE ||
      approval.environment !== environment || approval.d1Name !== d1Name ||
      approval.d1Id !== d1Id || approval.workerVersionId !== workerVersionId ||
      approval.workerCpuLimitMs !== cpuLimit || approval.bucket !== BUCKET ||
      approval.base !== RECOVERY_BASE || approval.plan !== plan ||
      approval.workerSubrequestLimit !== workerLimit || approval.budget !== budget ||
      !platformMax || !/^[1-9]\d*$/.test(limitText ?? '') ||
      !Number.isSafeInteger(workerLimit) || workerLimit > platformMax ||
      !/^[1-9]\d*$/.test(budgetText ?? '') || !Number.isSafeInteger(budget) ||
      budget > workerLimit - headroom ||
      !Array.isArray(tables) || !tables.length || !tables.includes(table) ||
      tables.some((t, i) => !order.includes(t) ||
        (i > 0 && order.indexOf(t) <= order.indexOf(tables[i - 1]))) ||
      approval.head !== execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) {
    throw new Error();
  }
  const base = new URL(RECOVERY_BASE);
  if (base.protocol !== 'https:' || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash) throw new Error();
  const manifest = JSON.parse(readFileSync(`${RUN}/manifest.json`, 'utf8'));
  if (manifest?.version !== 1 || manifest.date !== DATE) throw new Error();
  let csv;
  // Recheck ALL selected bytes, not only this table: later files must remain gated.
  for (const selected of tables) {
    const approved = approval.files?.[selected];
    const entry = manifest.files?.[`${selected}.csv`];
    const bytes = readFileSync(`${RUN}/${selected}.csv`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!Number.isSafeInteger(approved?.rowCount) || approved.rowCount <= 0 ||
        !Number.isSafeInteger(approved.upperBound) || approved.upperBound > approval.budget ||
        approved.upperBound <= 0 || approved.bytes !== bytes.length || approved.sha256 !== sha256 ||
        bytes.length === 0 || bytes.length > 50 * 1024 * 1024 ||
        entry?.key !== `snapshots/${DATE}/${selected}.csv` ||
        entry.bytes !== bytes.length || entry.sha256 !== sha256) throw new Error();
    if (selected === table) csv = bytes;
  }
  // Re-read live deployment/version metadata after local checks and immediately before the POST.
  const environmentFlags = environment === 'test' ? ['--env', 'test'] : [];
  const wranglerJson = (args) => JSON.parse(execFileSync('npx', [
    '--no-install', 'wrangler', ...args, ...environmentFlags, '--json'
  ], { cwd: ROOT, encoding: 'utf8' }));
  const activeDeployment = wranglerJson(['deployments', 'status']);
  const activeVersions = activeDeployment?.versions;
  const activeVersion = Array.isArray(activeVersions) && activeVersions.length === 1
    ? activeVersions[0] : null;
  const deployedVersion = wranglerJson(['versions', 'view', workerVersionId]);
  const targetBindings = deployedVersion.resources?.bindings?.filter(
    (binding) => binding?.name === 'CUSTOMER_DB'
  );
  if (!activeVersion || activeVersion.version_id !== workerVersionId ||
      activeVersion.percentage !== 100 || deployedVersion.id !== workerVersionId ||
      !Array.isArray(targetBindings) || targetBindings.length !== 1 ||
      targetBindings[0].type !== 'd1' ||
      (targetBindings[0].database_id ?? targetBindings[0].id) !== d1Id ||
      deployedVersion.resources?.limits?.cpu_ms !== cpuLimit) throw new Error();

  const response = await fetch(new URL(`/api/v1/${table}-snapshot/import`, base), {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'text/csv' }, body: csv
  });
  if (!response.ok) throw new Error();
  const result = await response.json();
  if (result.rowCount !== approval.files[table].rowCount ||
      result.upserted !== result.rowCount || result.deleted !== 0) throw new Error();
  writeFileSync(`${RUN}/deployed-${table}-import.json`, JSON.stringify({
    rowCount: result.rowCount, upserted: result.upserted, deleted: result.deleted
  }));
  console.log(`Import acknowledged for ${table}; D1 count/value verification still required`);
} catch {
  console.error('STOP: incident recovery gate or import failed; inspect privately, no blind retry');
  process.exit(1);
}
JS
)
```

On any failure, stop the chain. A failed/partial import may already have written
batches; do not blindly re-run it or automatically roll back. Keep the maintenance
window open while the incident owner chooses the approved undo or repair.

### 7.3 Verify deployed D1 and conclude the incident

```bash
(
set -euo pipefail
source "${RECOVERY_CONTEXT:?use the context created in section 2}"
source "$RUN/deployed-context.bash"
npx wrangler d1 execute "$D1_NAME" "${DEPLOYED_FLAGS[@]}" --remote --json --command \
  'SELECT COUNT(*) AS customers FROM customer_snapshot;
   SELECT COUNT(*) AS addresses FROM address_snapshot;
   SELECT COUNT(*) AS containers FROM container_snapshot;
   SELECT COUNT(*) AS orphan_addresses FROM address_snapshot a
     LEFT JOIN customer_snapshot c ON c.customer_id = a.customer_id WHERE c.customer_id IS NULL;
   SELECT COUNT(*) AS orphan_containers FROM container_snapshot t
     LEFT JOIN address_snapshot a ON a.pickup_address_id = t.pickup_address_id WHERE a.pickup_address_id IS NULL;' \
  > "$RUN/deployed-after.json"
)
```

Compare per-table import counts to CSV row counts as in §5; compare D1 counts to
the approved empty-table/union expectations and both orphan counts to zero.
Privately query sampled primary keys with `d1 execute --remote --command SELECT…`
and compare their values to the verified CSV; unaffected tables must match their
pre-recovery state. A 200 or import acknowledgment alone is not incident closure.
Re-apply customer erasures after any restore: an archive taken before a customer
erasure re-inserts the erased row, so track erased `customerId` values out of band
(the API keeps no suppression list) and re-`DELETE` each one after the restore
(see `docs/R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched-tog-18933`).
Use `--fail-with-body` on any manual `curl` re-checks so a row-numbered problem response
is retained; the `&&` chain below stops after a failed request without exiting the
interactive shell, and no chain step is retried after an error.

Only after this evidence passes may the operator restore normal writers under
the approved maintenance plan. For an authorized undo, obtain explicit approval
for the whole-D1 impact, then use `wrangler d1 time-travel restore <D1_NAME>
--bookmark=<saved-pre-recovery-bookmark>` with the **same config/environment flags**
from §7.1 (Time Travel does not use `--local`/`--remote`). Reverify counts, values
and orphans after undo. Do not execute a Time Travel restore during a drill.

**Verification limits:** the deployed recovery steps were checked against source
and Wrangler's CLI, not executed against a remote resource. No live target,
current plan, retention window, secret availability or production recovery is
claimed verified here.

## 8. Evidence, cleanup and undo

Acceptance: reviewer follows §§2–5 on the **exact proposed head SHA**, recovers
2 synthetic customers from local R2 to the new local D1, reconciles the import
and D1 counts, verifies both values and confirms other tables stay empty. Record
Wrangler version, head SHA, digest, counts and result. No remote credential,
production read/write or upstream request is needed for this drill.

Historical baseline: the 2026-09-28 `test/r2SnapshotRestore.test.ts` drill used
isolated test D1/R2 bindings, restored two synthetic rows per table in FK order
and compared pre/post values. It is not proof of current live bucket availability
or current-head acceptance; the manual drill above is independently repeatable.
The control-boundary regression is pinned by `test/snapshotRestoreControlBoundary.test.ts`:
HTTP import stays strict for control-bearing business cells while the in-code sync path
preserves them.

Stop terminal A with Ctrl-C **before** removing state. Verify its port is closed
(and stop only leftover processes belonging to this scratch run). In terminal B,
read the exact `RUN` from the private context file in a subshell; the interactive
shell did not inherit the recovery blocks' variables. Inspect that `RUN` before
deleting it; remove only this run-owned directory and its own `RECOVERY_CONTEXT`
file according to the data handling policy. Never delete the source archive or shared `.wrangler/state`.
Downloaded CSVs and scratch D1 can contain PII: do not commit, upload or retain
them as issue evidence. Undo for this drill is stopping the local Worker and
discarding its new scratch state; there is no production change to roll back.

## Official command references

- [R2 object GET/PUT and lifecycle list](https://developers.cloudflare.com/workers/wrangler/commands/r2/)
- [D1 execute and migrations commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Workers subrequest limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
- [Workers subrequest limit changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)
- [Wrangler `limits.subrequests` and `limits.cpu_ms` configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)
- [Worker deployments status and versions commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deployments-list)
- [D1 `batch()` API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [D1 platform limits (confirm current Worker-linked limit)](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing, usage and row/storage metrics](https://developers.cloudflare.com/workers/platform/pricing/#d1)
- [Workers CPU-time limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
- [esbuild's installed JavaScript build API](https://esbuild.github.io/api/#build)
- [Local data: use the same persistence directory for every command](https://developers.cloudflare.com/workers/local-development/local-data/)
- [Wrangler dev](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
