# R2 snapshot restore runbook — recover D1 from the CSV archive

**Scope:** manual archive recovery to a **new, isolated local D1**. No deploy,
remote D1 write, upstream sync, or production drill is part of this procedure.
Run from the repository root with Node >=20, Python 3, curl and the lockfile's
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

Dates are UTC. The manifest is **outside** the date directory. Its shape is
`{version:1,date:"YYYY-MM-DD",files:{"customer.csv":{key,sha256,bytes},...}}`.
An entry describes the exact CSV bytes, not parsed rows or a D1 SQL dump; it
contains no D1 schema or row count. See `src/lib/r2SnapshotArchive.ts`.

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

In Paperclip use the run-owned scratch directory. Outside Paperclip, set
`PAPERCLIP_RUN_SCRATCH_DIR` to an approved private scratch parent first. Keep the
same exported `RUN` in both terminals. Do **not** erase `.wrangler/state`, point
at an existing dev server, or substitute the repository's production config.

```bash
set -euo pipefail
umask 077
export ROOT="$PWD"
RUN="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:?set a private scratch parent}/r2-recovery.XXXXXX")"
[ -n "$RUN" ] && [ -d "$RUN" ] || { printf 'STOP: scratch creation failed\n' >&2; exit 1; }
export RUN
export DATE=2026-09-28  # choose the archive's UTC date before downloading
export BUCKET=routeware-csv-snapshots
export PORT=8797       # use a free local port; do not reuse another Worker's URL
export WRANGLER_SEND_METRICS=false

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
```

The generated config has a dummy D1 id, public **synthetic** local-only bearer
values, no report query ids, no cron, no live R2 binding and no real credentials.
It loads no repository `.dev.vars`. Every D1 command below uses that config and
`--local --persist-to "$RUN/state"`. No Cloudflare account provisioning is needed.

## 3. Credential-free reviewer fixture (skip for an authorized real archive)

This is the complete one-table acceptance drill: seed synthetic CSV + sidecar
into **local** R2, then recover them using the same Wrangler download leg as §4.
It neither reads nor writes a remote bucket. Never manufacture a replacement
manifest for a real archive that is missing one.

```bash
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
export SOURCE=local
```

## 4. Download and verify the exact files that will be imported

For the §3 fixture, leave `SOURCE=local`. For a real recovery set `SOURCE=remote`
**only with authorized read access to the selected source bucket/date**. Remote
R2 GETs require the normal Wrangler authorization; never paste credentials into
this doc, commands, or evidence. Do not use a production archive for the reviewer
drill. Local R2 objects are not visible remotely and vice versa.

```bash
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
```

**Stop before any import** on a missing CSV/manifest, parse error, missing entry,
wrong date/key, hash mismatch or size mismatch. Archives predating manifest
support cannot pass this gate; choose a known-good manifested archive or
escalate the recovery gap. Do not print CSV bodies/headers as an existence check.
Leave verified downloads unchanged; re-run the gate if you replace a file.

On main, the optional whole-date audit verifies every manifest entry in the
**selected** local bucket and persistence directory:

```bash
node scripts/verify-r2-manifest.mjs --date="$DATE" --bucket="$BUCKET" \
  --persist-to "$RUN/state"
```

For an authorized remote audit, replace `--persist-to "$RUN/state"` with
`--remote`. This script specifically requires `CLOUDFLARE_API_TOKEN` already
available in the environment; Wrangler OAuth alone does not satisfy its gate.
Never pass the token as a flag or print it. The audit re-downloads objects and
is not a substitute for verifying the **specific downloaded bytes** imported here.

## 5. Recover the customer table into scratch D1

Terminal A: from the same repository root, export the **exact** `RUN` and `PORT`
from terminal B, then run the following in the foreground. No `--remote`, `-e test`
or repository config. If startup fails, stop; do not import through an older
server already answering that port.

```bash
export WRANGLER_SEND_METRICS=false
CLOUDFLARE_INCLUDE_PROCESS_ENV=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  npx wrangler dev --local --config "$RUN/wrangler.toml" \
  --persist-to "$RUN/state" --ip 127.0.0.1 --port "$PORT"
```

The command-local overrides disable process-env and `.env` secret loading even
if inherited settings enable them. Otherwise an ambient sync secret can override
the synthetic binding (or expose unrelated process credentials to the Worker).
The new config has no `secrets.required`, and its directory has no `.dev.vars`.
See [Wrangler's local environment controls](https://developers.cloudflare.com/workers/local-development/environment-variables/#controlling-env-handling).

Wait for `Ready on http://127.0.0.1:<PORT>`. Terminal B:

```bash
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
```

For the synthetic fixture, additionally verify values, not just counts:

```bash
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
```

For a real archive, compare sampled ids/values to its CSV **privately** instead of
using the synthetic assertion. Only post counts, digests and the reviewed SHA.
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

## 7. Evidence, cleanup and undo

Acceptance: reviewer follows §§2–5 on the **exact proposed head SHA**, recovers
2 synthetic customers from local R2 to the new local D1, reconciles the import
and D1 counts, verifies both values and confirms other tables stay empty. Record
Wrangler version, head SHA, digest, counts and result. No remote credential,
production read/write or upstream request is needed for this drill.

Historical baseline: the 2026-09-28 `test/r2SnapshotRestore.test.ts` drill used
isolated test D1/R2 bindings, restored two synthetic rows per table in FK order
and compared pre/post values. It is not proof of current live bucket availability
or current-head acceptance; the manual drill above is independently repeatable.

Stop terminal A with Ctrl-C **before** removing state. Verify its port is closed
(and stop only leftover processes belonging to this scratch run). Inspect `RUN`
before deleting it; remove only this run-owned directory according to the data
handling policy. Never delete the source archive or shared `.wrangler/state`.
Downloaded CSVs and scratch D1 can contain PII: do not commit, upload or retain
them as issue evidence. Undo for this drill is stopping the local Worker and
discarding its new scratch state; there is no production change to roll back.

## Official command references

- [R2 object GET/PUT and lifecycle list](https://developers.cloudflare.com/workers/wrangler/commands/r2/)
- [D1 execute and migrations commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Local data: use the same persistence directory for every command](https://developers.cloudflare.com/workers/local-development/local-data/)
- [Wrangler dev](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
