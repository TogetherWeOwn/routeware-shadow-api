# Routeware CSV snapshots (D1)

Routeware **Customer / Address / Container** custom report exports are cached in a single D1 database (`CUSTOMER_DB`) so the Worker can query them without replaying the SPA.

## Data model (foreign keys)

- `customer_snapshot` — **primary key** `customer_id` (Routeware `CustomerID`)
- `address_snapshot` — **primary key** `pickup_address_id` (Routeware `PickupAddressID`); **FK** `customer_id` → `customer_snapshot`
- `container_snapshot` — **primary key** `container_id` (Routeware `ContainerID`); **FK** `pickup_address_id` → `address_snapshot`

**Import / sync order:** load customers, then addresses, then containers. The combined job (`POST /api/v1/data-snapshot/sync` or the daily cron) only runs the address step when the customer *export is configured* (static path or query id), and the container step only when both customer and address are configured.

**Foreign keys and reconciliation:** the FK columns are declared and D1 **enforces** them unconditionally in every transaction/batch — an orphan row is rejected (import/sync answers 400 `bad-request` naming the dangling key), so import order is enforced, not just convention. A streamed sync spans many batches rather than one transaction, so integrity relies on the import order above plus reconciliation as well as the database. A report **`sync`** (not `import`) deletes rows not present in the current run (`deleted` count in the response) so upstream deletions propagate; reconciliation is skipped when a run yields zero data rows, so a bad/empty export never wipes a table. **`import`** is treated as possibly-partial and never deletes.

## Detail-full write-through identity contract

Post-save refreshes validate the complete raw `GetCustomerDetailFull` graph before
mapping or the first D1 write/reconciliation. This JSON boundary is separate from
CSV import and public query-ID parsing; read-only mapping and non-identity fields
retain their tolerant conversions.

- Customer/address/container primary IDs and supplied ownership IDs must be
  positive safe integer numbers or nonempty ASCII digit-only decimal strings
  (`1` through `9007199254740991`, leading zeros allowed). Prefixes, fractions,
  exponent/hex strings, whitespace, signs, nonpositive/unsafe values, nulls and
  non-scalars are refused. JSON numeric values are checked as parsed numbers;
  their original lexical spelling is not available after JSON parsing.
- Recognized pairs are `CustomerID` / `customerID`, `PickupAddressID` /
  `pickupAddressID`, and `ContainerID` / `containerID` where applicable. Every
  supplied spelling must be valid and normalize to the same ID; a malformed or
  conflicting alias cannot be shadowed by a valid one.
- Customer and address ownership must match the requested customer. Address IDs
  and container IDs must each be unique throughout the graph, including
  numeric/string equivalents. An explicit container parent must match its
  **enclosing address**, not merely another address in the graph. Only an absent
  parent ID inherits its enclosing address.
- `currentCustomer` must be an object and `data` an array of address objects.
  Supplied `Containers` must be arrays of container objects; null/nonarray
  collections and malformed members never prove deletion. Absent `Containers`
  retains the existing empty-child behavior. Valid empty arrays retain deletion
  semantics.

Refusal performs no upserts, stale-child deletes or graph cache publication;
seeded rows and `synced_at` remain untouched. Identity refusal diagnostics name
only fixed field/graph kinds and the fixed next action `skipping D1 refresh`,
never raw graph values; the established `missing currentCustomer` diagnostic is
retained. Save handlers expose only the fixed code/error kind, not exception
text. A confirmed upstream save remains successful; the data-tier response
reports `localSync: { "done": false, "code": "sync_failed" }` and retains existing
best-effort single-entity cache eviction. **Do not retry the save** to repair a
local refresh failure, or claim that the upstream operation was rolled back.
Size/D1/cache budgets, fresh-plus-deleted IDs and erasure suppression are unchanged.

Run `npm run test:detail-full` for the parameterized synthetic-graph acceptance
suite plus reconciliation regressions (local test D1 only, no credentials or live
requests). The full `npm test` entry point includes these tests too.

## Detail-full container source availability

`GetCustomerDetailFull` does not supply `ud_cost_share_ud`,
`ud_enclosure_doors_ud`, `ud_last_compactor_inspection_ud`,
`ud_last_enclosure_inspection_ud`, `ud_material_stream_ud`, `service_code_type`,
`service_code_input` or `service_date`. Its mapping keeps those eight values null
for new containers. On existing containers, only the detail-full upsert omits
those UPDATE assignments, retaining the currently stored values atomically,
including a report update committed before that write. Supported detail-full
fields still replace stored values, including explicit nulls. The existing
`stored.synced_at <= incoming.synced_at` guard applies to the whole update;
batching, reconciliation and cache invalidation are unchanged.

CSV/report imports and ordinary upserts remain authoritative for all columns:
non-null replacements and deliberate blank/null clearing still apply. Flat and
hydrated reads expose the same stored report-only metadata after save refreshes.
This prevents future loss; it **does not repair already-cleared values**.
Recovery requires an authoritative report through the existing authorized import
or sync workflow. Do not infer missing metadata, replay saves as a repair, or
backfill from unrelated fields. No migration or new access is required.

Local synthetic regression (real test D1, no external requests or credentials):
`npx vitest run test/detailFullReportMetadata.acceptance.test.ts --maxWorkers=2`.

## Environment

| Variable | Role |
|----------|------|
| `CUSTOMER_REPORT_EXPORT_PATH` | URL path to the Customer Details CSV (on `TARGET_ORIGIN`) — optional if you use `CUSTOMER_REPORT_QUERY_ID` |
| `ADDRESS_REPORT_EXPORT_PATH` | URL path to the Address Details CSV |
| `CONTAINER_REPORT_EXPORT_PATH` | URL path to the Container Details CSV |
| `CUSTOMER_REPORT_QUERY_ID` | Routeware **numeric** `queryID` for the Customer custom report (e.g. `23`). If set, it **takes precedence** over `CUSTOMER_REPORT_EXPORT_PATH` for that table. |
| `ADDRESS_REPORT_QUERY_ID` | Same (e.g. `24`) |
| `CONTAINER_REPORT_QUERY_ID` | Same (e.g. `25`) |
| `REPORT_QUERY_START_DATE` / `REPORT_QUERY_END_DATE` | Passed to `QueryExecuteDownload` as `startDate` / `endDate` (`yyyy-MM-dd`). Use `1900-01-01` when the modal has **no** date pickers (the WebRW script defaults to that). For reports with Kendo date pickers, set these to the same range you would choose in the UI. |
| `CUSTOMER_SNAPSHOT_SYNC_SECRET` | Bearer for `.../import`, `.../sync`, and `data-snapshot/sync` |
| `SHADOW_API_PUBLIC_BASE` | Optional. Your Worker’s public origin (e.g. `https://name.workers.dev`, no path). **Required** for the **daily cron** to use chained per-table syncs and avoid D1’s per-invocation limit. `POST /data-snapshot/sync` from a client does **not** use this (it uses the request URL host). |
| `CHAINED_SYNC_TIMEOUT_MS` | Optional finite positive per-table header+body deadline for chained sync (default `180000`ms; absent/invalid → default). Summary JSON is additionally limited to 65,536 actual bytes inclusive. Failure never automatically retries a POST; inspect the affected table before resubmitting. See [boundary guidance and focused check](docs/CRON-SYNC-ALARM-RUNBOOK.md#41-chained-response-boundary). |
| `SNAPSHOTS_R2_ENABLED` | Set to `"false"` to disable uploading snapshot CSVs to R2. Default is on when the R2 binding is configured. |
| R2 `SNAPSHOTS` | Binding to an R2 bucket. After successful D1 sync, the **same** CSV bytes are archived at a new <code>snapshot-history/<i>UTC-date</i>/<i>timestamp-UUID</i>/{customer\|address\|container}.csv</code> key with a per-run integrity manifest. The last fully published run is referenced by <code>snapshot-latest/<i>table</i>.json</code>. The existing <code>snapshots/<i>UTC-date</i>/<i>table</i>.csv</code> keys remain mutable daily aliases for read/restore compatibility. See [history and proposed retention policy](docs/R2-RETENTION.md); no deletion rule is enabled by the writer. |
| `LOGIN_USERNAME` / `LOGIN_PASSWORD` | **Required in production** for any flow that fetches from Routeware with a **browser** session: report `QueryExecuteDownload` / `*_REPORT_EXPORT_PATH` sync, etc. In **deployed** Workers, use `wrangler secret put LOGIN_USERNAME` and `wrangler secret put LOGIN_PASSWORD` (`.dev.vars` is not uploaded with deploy). The Worker’s Browser Rendering login must set cookies `.WebRW`, `RCCApi`, and `RCCApiRefresh` on the Routeware host. If sync fails with *Authentication failed: RouteWare session cookies missing…*, the login did not complete — verify credentials, MFA, or whether the WebRW login page markup still matches the selectors in `src/lib/browserAuth.ts`. |

### Query-id mode (Killeen WebRW — client `requestID`)

The modal’s script does **`lastRequestID = crypto.randomUUID()`** and loads the iframe to  
`GET .../QueryExecuteDownload?requestID=<that-uuid>&queryID=<n>&startDate=...&endDate=...`.  
There is **no** separate `QueryExecute` POST: the one-time id is created in the browser. The Worker does the same with `crypto.randomUUID()` and a single download `GET` (same session cookies as other shadow calls). The UI also polls `QueryRequestIsComplete` every 2.5s for the loading indicator; the CSV is read from the **download** response body once the server finishes streaming.

### What to put in each `*_REPORT_EXPORT_PATH`

The Worker does `new URL(path, TARGET_ORIGIN)` and `GET`s that with your Routeware session cookies. You must store the **request that actually returns the CSV** (not the report UI page), usually:

- **Best:** path + query only, e.g. `/WebRW/Reports/SomeHandler?reportKey=...&export=1` (exact string depends on your recording).
- **Also valid:** a full `https://killeen.routeware.com/...` URL; if the host matches `TARGET_ORIGIN`, a path like `/WebRW/...?...` is enough.

**How to get the value after a recording**

1. **Chrome / Edge DevTools** → **Network** → run the export again (or use your last session) → find the request whose **Response** `Content-Type` is `text/csv` (or the file that downloads). Copy **Request URL** → for `wrangler.toml`, use only `pathname + ? + search` (or the full URL if you prefer). Assign that to the matching var (Customer, Address, or Container report).
2. **Harvest file** — if your run captured a `text/csv` response, use the `pathWithQuery` from that line. **Note:** Killeen’s UI often uses **query ids** and a **client** `requestID` (see [REPORT_CSV_HARVEST.md](tools/api-discovery/out/REPORT_CSV_HARVEST.md)). Map `queryID` values to report names in **Reports → Queries** (example: Customer `23`, Address `24`, Container `25`) and use `*_REPORT_QUERY_ID` when you are not using a stable static path.

**`npx wrangler types`:** Regenerates `worker-configuration.d.ts` from `wrangler.toml`. Run it once after you **add/rename** bindings or env keys in TOML (not strictly required if you only **paste new strings** into existing `*_REPORT_EXPORT_PATH` lines, but it is quick and safe).

## Recording the download flow (get real URLs for the path vars)

From the repository root:

```bash
npm run discovery:record
```

Optional: regenerate discovery artifacts (helps scan for new paths in docs):

```bash
npm run discovery:process
```

## Checklist: wire paths, database, and daily job

1. **Wire exports** — either paste the three `*_REPORT_EXPORT_PATH` values, **or** set the three `*_REPORT_QUERY_ID` values (and shared `REPORT_QUERY_*` keys) in `wrangler.toml` under `[vars]` (or in the Cloudflare dashboard under **Variables** for production).
2. **Set a sync secret** — in TOML `CUSTOMER_SNAPSHOT_SYNC_SECRET` for local dev, or for production `npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET` (and avoid committing real secrets in git).
3. **D1** — if you have not already: `npx wrangler d1 create routeware-customer-snapshot`, copy the printed **database_id** into `[[d1_databases]]` in `wrangler.toml` (replace the all-zero placeholder), then run `npx wrangler types`.
4. **Apply migrations** (after `database_id` is real):
   ```bash
   npx wrangler d1 migrations apply routeware-customer-snapshot --local
   npx wrangler d1 migrations apply routeware-customer-snapshot --remote
   ```
5. **Test locally** — `npx wrangler dev` (with `.dev.vars` containing `LOGIN_USERNAME` / `LOGIN_PASSWORD`), then call:
   `POST /api/v1/data-snapshot/sync` with header `Authorization: Bearer <your secret>`. The cron (`0 7 * * *` UTC) will run the same `runDataSnapshotSync` logic on the deployed worker.
6. **Deploy** — `npx wrangler deploy` after vars/secrets and D1 are set in the Cloudflare dashboard (or in TOML for non-secrets).

**API and documentation are already in this repo** — the address and container routes and OpenAPI entries live in `src/app.ts`. After `wrangler dev` or deploy, open **`/docs`** (Scalar) or **`/openapi.json`** on your worker URL; tags include `address-snapshot`, `container-snapshot`, and `data-snapshot`.

## Migrations (local and remote D1)

After creating a real D1 in your account and putting its `database_id` in `wrangler.toml` (replacing the placeholder), apply:

```bash
npx wrangler d1 migrations apply routeware-customer-snapshot --local
npx wrangler d1 migrations apply routeware-customer-snapshot --remote
```

## Readiness: cron staleness

Every scheduled run (`src/scheduled.ts`, `0 7 * * *` UTC) upserts one row per
table into `cron_sync_state` (`migrations/d1/0004_cron_sync_state.sql`) before
emitting its `data-snapshot-sync` log line, and `GET /api/v1/readiness`
reports it back as an advisory `cron` check: `lastRunAt` (newest row),
per-table `outcome` (`success` / `skipped` / `failed`) with counts and
timestamps, and `stale` (true when no row exists or the newest row is older
than 48h — one missed daily firing tolerated, two page). Only
outcome/mode/counts/timestamps are stored — never row data or error text, so
no PII by column construction (CONVENTIONS.md §5).

Advisory means advisory: `cron.ok` mirrors `stale` but never flips the
overall readiness status, so a never-yet-run staging Worker still deploys —
the cron's own `success`/`failed` log line remains the alarm source (see
`docs/CRON-SYNC-ALARM-RUNBOOK.md`). Reviewer check: fire a local scheduled
run (`curl http://localhost:8787/__scheduled` under `wrangler dev
--test-scheduled`), then read readiness and confirm the fresh timestamp.

```bash
npx wrangler d1 execute routeware-customer-snapshot --remote --json \
  --command "SELECT table_name, outcome, ran_at FROM cron_sync_state"
```

## Archive integrity manifest and verify

Each successful archive also upserts one entry per CSV into a sidecar
`snapshots/<UTC-date>.manifest.json` — a sibling of the date's CSV "directory",
carrying `{ version, date, files: { "<table>.csv": { key, sha256, bytes } } }`
(`src/lib/r2SnapshotArchive.ts`). The writer emits hashes and keys, never row
data; never print an unvalidated downloaded manifest. A failed CSV put writes
no entry. A corrupt existing sidecar is replaced (warned), potentially omitting
other tables; explicit expectations are needed to detect that coverage gap.

Check full-chain identity and byte coverage without credentials (local Miniflare
R2 under an approved `--persist-to` directory):

```bash
npm run verify:r2-manifest -- --date=2026-09-28 --persist-to=<dir> --expect=customer,address,container --json
```

Without `--expect`, success is **listed-only (partial)**, not proof that all tables
exist. The verifier validates the requested date and exact daily keys before CSV
reads. Add `--dry-run` for a zero-execution plan. Remote execution is read-only but
requires already-authorized `CLOUDFLARE_API_TOKEN` environment injection; use
`--remote` instead of `--persist-to`, never a token flag. No new grant is implied.

Exit 0 = verified coverage or valid dry-run; 1 = verification/credential failure;
2 = invalid flags. JSON has a bounded versioned schema, stable codes/IDs and next
actions. See [verifier contract and recovery guidance](docs/R2-MANIFEST-VERIFY.md).
Run `npm run check:r2-manifest` for pure and hermetic fake-reader acceptance tests
(no Wrangler/R2 access); the wrapper suite also runs in `npm run test:probe`.

## Dry-run sync and import

Add `?dryRun=true` to a snapshot `POST` route to run the CSV parse/validation path and
see the counts that would apply without changing the stored snapshot. This option is
available on the per-table `/api/v1/{customer,address,container}-snapshot/sync` and
`/import` routes, and on `/api/v1/data-snapshot/sync`. The combined route forwards the
flag to each configured per-table sync. It still follows the normal configuration and
customer → address → container dependency guards.

Dry-run is not offline: sync still fetches the configured report from Routeware and
may use the Worker’s Routeware browser session. It can read D1 to count stale rows,
but writes no D1 rows, performs no reconciliation deletes, and creates no R2 archive.
Import validates the supplied CSV and writes no D1 rows. Because a dry
run does not apply hypothetical parent rows, it skips foreign-key validation; a CSV
with a dangling address/container reference can pass dry-run validation and still fail
when imported for real. Dry-run also does not prove that a real write will succeed.

Only the exact values `true` and `false` are accepted. Only `?dryRun=true` enables
dry-run; omitting the parameter or passing `?dryRun=false` runs normally and can write
D1 (and, for sync, archive to R2). Other values return 400 rather than silently
selecting either mode. Treat the negative value as a real-write control, not a preview.

For example, this customer sync fetches the configured Routeware report but does not
change D1 or R2:

```sh
curl -i -X POST \
  -H 'Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>' \
  'https://<worker-host>/api/v1/customer-snapshot/sync?dryRun=true'
```

With two valid CSV rows and one stale customer row, a per-table response is:

```json
{"upserted":2,"rowCount":2,"deleted":1}
```

The counts describe the would-be effects; the stale row remains in D1, the two rows
are not written, and no archive key is created. A combined dry-run returns per-table
`{ "upserted", "rowCount" }` counts (no `deleted` field), or `null` for a skipped
table; on a table failure the route returns an error and later tables do not run.
On a successful response, `null` means that table was skipped.

### Partial progress on combined-sync failure

Add `?partialProgress=true` to `POST /api/v1/data-snapshot/sync` to learn which
tables completed when a table step fails: instead of the generic 500 `internal`
problem+json, the route answers HTTP 500 `application/json`
`{customer, address, container, failure}`, where each table is the completed
`{upserted, rowCount}` or `null` (failed, unattempted, or skipped) and `failure`
is the fixed `{table, code}` plus the numeric `status` only for
`ChainedHttpError`. `code` is one of the six runbook §4.1 classifications —
never upstream text — and no `deleted`, `r2`, or row data travels. Only the
exact string `true` opts in (`false`/absent keeps the generic shapes
byte-for-byte; anything else is a 400 before any table runs), and success is
identical with or without the flag. The flag is consumed by the combined route
only and is never forwarded to the per-table subrequests; it composes with
`?dryRun=true` (dry-run is still forwarded to every table).

Recovery: a 500 with the partial body names exactly one failed table; tables
before it either completed (their counts are final for this attempt) or were
skipped (`null`), while the failed table and later tables are `null`.
A generic 500 problem+json — the
default shape, or any unknown cause — carries no per-table outcome: treat
completed tables as unknown, not empty. Partial counts do not authorize blind
POST retries and do not prove a full consistent sync; inspect the failed
table per `docs/CRON-SYNC-ALARM-RUNBOOK.md` §4 before resubmitting. The
mounted OpenAPI 500 description states the same rule beside the
`DataSnapshotSyncPartialProgress` examples.

## Strict identities on operator CSV imports

The three `POST /api/v1/{customer,address,container}-snapshot/import` routes,
including `?dryRun=true`, require each identity header exactly once after
case/BOM/whitespace normalization and CSV quote handling:

| Import | Required identity headers | Error field identifiers |
| --- | --- | --- |
| Customer | `CustomerID` | `customer_id` |
| Address | `PickupAddressID`, `CustomerID` | `pickup_address_id`, `customer_id` |
| Container | `ContainerID`, `PickupAddressID` | `container_id`, `pickup_address_id` |

The existing first-column requirement remains: `CustomerID`, `PickupAddressID`
or `ContainerID`, respectively. Duplicate normalized identity headers are
ambiguous even if their cells agree; unrelated duplicate columns are unchanged.
Optional columns may still be omitted and blank records are still skipped.

Required primary and relationship cells must contain **only ASCII decimal digits**
after the existing spreadsheet-marker decoding and whitespace trimming, with a
numeric value from **1 through 9007199254740991**. Leading zeroes are allowed.
Missing cells, `123junk`, signs, fractions (even `123.0`), exponent/hex spellings,
non-ASCII digits, zero, negatives and unsafe integers are rejected, not rounded,
truncated or silently skipped. Optional non-identity numbers/defaults and upstream
report-sync parsing stay tolerant. Export/import round trips remain supported for
import-compatible cells. Dry-run validates the same headers and identity syntax
but still skips parent-existence checks and performs no writes.

For a synthetic address example, `PickupAddressID,CustomerID` followed by
`42,123junk` returns 400 `application/problem+json`, not a write referencing
customer 123. Its value-free detail identifies `address_snapshot`, row 2 and
`customer_id`, with a fixed correction/retry action. Correct the relationship
cell to the intended whole-decimal parent id and import that customer first.
See [identity problems](docs/PROBLEMS.md#snapshot-import-identities-bad-request).

**Streaming is not whole-upload rollback.** Identity headers are checked before
any data batch, and each nonblank record is validated before entering a batch.
An identity error in the first batch writes nothing. A later error discards the
pending batch and remaining records, but earlier flushed valid batches may already
be committed (current defaults: 80 customer/address rows, 40 container rows).
The rejected record is never written; imports never reconcile/delete existing
rows, and a thrown parse error cannot reach end-of-import reconciliation. A 400
does not mean that the entire upload left D1 unchanged. Fix the file before retrying.

Credential-free focused regression (synthetic fixtures and disposable local D1):

```sh
npx vitest run test/snapshotImportIdentity.acceptance.test.ts test/snapshotImportEdges.test.ts test/snapshotImportForeignKey.test.ts test/snapshotDryRun.test.ts
```

## API quick reference (OpenAPI tags: `customer-snapshot`, `address-snapshot`, `container-snapshot`, `data-snapshot`)

All `.../import` and `.../sync` and `data-snapshot/sync` routes use **`Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`**.

| Method | Path | Purpose |
|--------|------|--------|
| GET | `/api/v1/customer-snapshot` | List rows: query `customerId`, exact `customerNumber` / `subCustomerNumber`, `q`, stored-phone substring `phone`, [stored-comment substring `comments`](docs/CONSUMER-QUICKSTART.md#stored-customer-comment-fragment), mirrored-child `hasAddresses=true\|false\|any` (default `any`), stored-phone presence `hasPhone1` / `hasPhone2` (`true\|false\|any`, default `any`), `enabled`, `fields`, `includeTotal`, `countOnly`, `limit`, `offset`, `cursor` (seek pagination, see `nextCursor`), `order=asc\|desc` (default `asc`); [synthetic account lookup recipe](docs/CONSUMER-QUICKSTART.md#exact-external-account-lookup), [synthetic phone fragment recipe](docs/CONSUMER-QUICKSTART.md#stored-phone-fragment-lookup) |
| GET | `/api/v1/customer-snapshot/{customerId}` | One customer row |
| GET | `/api/v1/customer-snapshot/changes` | Incremental feed: rows with `synced_at > since` in `(synced_at, customer_id)` order; omit `since` for the first page, `limit` 1..500. A bare `since` replays every later run whole; to page a chunked delta, pass the previous page's `nextCursor` back as `since` + `since_id` (the composite pair resumes at the boundary timestamp without skipping same-timestamp rows). Optional inclusive `until` bounds the window (`synced_at <= until`, same UTC Z millisecond contract; normalized `since` must not exceed it); omit it for the unbounded tail. Optional strict `fields` selects customer columns plus always-present `customer_id` without changing the cursor |
| GET | `/api/v1/customer-snapshot/export` | Download the snapshot as CSV (`Content-Disposition: attachment; filename="customer-snapshot.csv"`), streamed in keyset pages |
| POST | `/api/v1/customer-snapshot/sync` | Fetch customer CSV (path or `CUSTOMER_REPORT_QUERY_ID` pipeline) and upsert |
| POST | `/api/v1/customer-snapshot/import` | Body = raw customer CSV; `Content-Type: text/csv` or `application/octet-stream` (a missing or other media type gets 415) |
| GET | `/api/v1/address-snapshot` | List rows: `customerId`, `pickupAddressId`, exact `routeId` / `franchiseId` / stored `zip` / `city` / `state` (AND intersection), `q`, literal stored `driverNote` substring ([synthetic recipe](docs/CONSUMER-QUICKSTART.md#stored-address-driver-note)), `enabled`, stored `extrasAllowed` (AND intersection; [synthetic selector recipe](docs/CONSUMER-QUICKSTART.md#address-stored-extras-allowed-selector)), mirrored-child `hasContainers=true\|false\|any` (default `any`), exact stored `lastAuditDate` / `hasLastAuditDate=true\|false\|any` ([synthetic audit-cohort recipe](docs/CONSUMER-QUICKSTART.md#stored-address-last-audit-date)), `limit`, `offset`, `cursor` (seek pagination, see `nextCursor`), `order=asc\|desc` (default `asc`), `fields`, `includeTotal`, `countOnly`; [synthetic present/absent recipe](docs/CONSUMER-QUICKSTART.md#address-container-presence) |
| GET | `/api/v1/address-snapshot/{pickupAddressId}` | One address row |
| GET | `/api/v1/address-snapshot/export` | Download the snapshot as CSV (`Content-Disposition: attachment; filename="address-snapshot.csv"`), streamed in keyset pages |
| POST | `/api/v1/address-snapshot/sync` | Fetch address CSV (path or `ADDRESS_REPORT_QUERY_ID`) and upsert |
| POST | `/api/v1/address-snapshot/import` | Body = raw address CSV; `Content-Type: text/csv` or `application/octet-stream` (a missing or other media type gets 415) |
| GET | `/api/v1/container-snapshot` | List rows: `customerId` (join), `pickupAddressId`, `containerId`, stored `containerTypeId` ([type-filter recipe](docs/CONSUMER-QUICKSTART.md#stored-container-type-filter)), `ids`, exact `serialNumber` / `rfid` / `materialStream` / `color` / `eventCode` / `hasEventCode=true\|false\|any` ([event-code recipe](docs/CONSUMER-QUICKSTART.md#stored-container-event-code-cohorts)) / stored container `zip` / `locationAddress` (1..200 code points) / `state` (1..100 code points), parent address `parentRouteId` / `parentFranchiseId` / `parentEnabled=true\|false\|any` ([parent-cohort recipe](docs/CONSUMER-QUICKSTART.md#container-parent-service-site-cohorts)), `q` (literal substring on location/serial/city/zip, not state), `enabled`, `limit`, `offset`, `cursor` (seek pagination, see `nextCursor`), `upperId`, `order=asc\|desc` (default `asc`), `fields`, `includeTotal`, `countOnly`; [stored-locality recipe](docs/CONSUMER-QUICKSTART.md#stored-container-locality), [exact installation recipe](docs/CONSUMER-QUICKSTART.md#exact-stored-container-installation) |
| GET | `/api/v1/container-snapshot/{containerId}` | One container row |
| GET | `/api/v1/container-snapshot/export` | Download the snapshot as CSV (`Content-Disposition: attachment; filename="container-snapshot.csv"`), streamed in keyset pages |
| POST | `/api/v1/container-snapshot/sync` | Fetch container CSV (path or `CONTAINER_REPORT_QUERY_ID`) and upsert |
| POST | `/api/v1/container-snapshot/import` | Body = raw container CSV; `Content-Type: text/csv` or `application/octet-stream` (a missing or other media type gets 415) |
| POST | `/api/v1/data-snapshot/sync` | Run customer → address → container in one call (per path vars and guards) |
| DELETE | `/api/v1/customer-snapshot/{customerId}` | Erase one customer row (see scope below) |

### Count without row payloads

The three ordinary lists accept exact `countOnly=true|false` (default false).
True returns `{rows:[],total:N,nextCursor:null}`, no next Link, exactly one
COUNT and zero page/payload SELECTs. Counts reuse all existing filters, IDs,
direction-dependent exclusive cursor and inclusive upperId. They are
cursor-relative query-time counts, unaffected by limit/offset; an empty cohort
returns 0. No snapshot isolation, count cache or no-scan guarantee is implied.
False/omission preserves normal pages; `includeTotal=false` instead fetches
rows without a count. Do not combine it with countOnly=true: omit
includeTotal=false or set countOnly=false and retry the value-free 400.
All known parameters still validate. Existing read tokens, no-store and
exact-envelope ETag/304 apply; even a 304 executes a fresh COUNT.
No upstream, R2 or writes. Other read routes do not gain the mode.
[Mode comparison](docs/SNAPSHOT-LIST-QUERY-POLICY.md#count-only-inspection),
[synthetic recipe](docs/CONSUMER-QUICKSTART.md#count-before-fetching-payloads);
focused check: `npm run check:snapshot-count-only` (local test D1 only).

### Customer mirrored-address presence

On the ordinary customer list only, `hasAddresses=true|false|any` selects
customers with/without at least one stored address; any/omission is unchanged.
Disabled addresses count, customer `enabled` is independent, and no child rows
are expanded. No mirrored address is not proof of no upstream site and never
authorizes deletion, reconciliation or sync. Send one supported value or omit
it and retry invalid/empty/repeated selectors. The local-read GET composes
with all existing filters/paging/fields/conditional reads; true/false stay in
relative next Links and count-free mode runs zero COUNTs. No isolation promise.
Run `npm run check:customer-address-presence` for synthetic local-D1 contract
and existing-child-index EXPLAIN checks, not production performance evidence.
CLI `--dry-run` is N/A. See the
[present/absent recipe](docs/CONSUMER-QUICKSTART.md#customer-address-presence).

### Customer stored-phone presence

On the ordinary customer list only, `hasPhone1=true|false|any` and
`hasPhone2=true|false|any` select rows by stored `phone1`/`phone2` text:
`true` keeps stored-present slots (`IS NOT NULL AND <> ''`), `false` the
exact null-or-empty complement; any/omission adds no predicate. Both flags
AND-compose with each other and every existing selector, so both `false`
finds customers with no stored phone text in either slot. Whitespace-only
stored text counts as present. Stored presence is not a valid number,
preferred channel, contact consent, deliverability or reachability, and
never authorizes outreach. Send each key once or omit it and retry
invalid/blank/repeated/case-variant selectors (value-free 400 after auth,
before D1). Effective values stay in relative next Links; count-free mode
runs zero COUNTs. Presence-only selections may scan; no phone index exists
and none is added. Run `npm run check:customer-phone-presence` for
synthetic local-D1 contract coverage, not production performance evidence.
CLI `--dry-run` is N/A. See the
[neither-slot count recipe](docs/CONSUMER-QUICKSTART.md#customer-stored-phone-presence).

### Ordinary list direction

`order=desc` starts at the highest primary ID and continues strictly below
`cursor`; omitted order or exact `order=asc` keeps ascending seek. ID order
is not chronological recency. Keep `order` with `nextCursor`; changing direction
starts a new traversal. Cursor overrides offset. Filters, container/address
joins, sparse `fields` and count-free `includeTotal=false` still compose.
Counted totals remain cursor-relative. A full terminal page returns its last
ID; the following empty page returns `nextCursor: null`, as do partial pages.
No lookahead, extra count, index or concurrent-write snapshot guarantee is added.

Use exactly one lowercase `asc` or `desc` (or omit for `asc`); invalid/repeated
values return the fixed value-free 400 after auth and before D1. See
[synthetic examples](docs/CONSUMER-QUICKSTART.md#highest-primary-ids-first) and
[query policy](docs/SNAPSHOT-LIST-QUERY-POLICY.md#primary-id-direction-order).
Run `npm run check:snapshot-order` for credential-free synthetic local D1
coverage with unexpected outbound fetch denied.

### Customer changes cursor

`GET /api/v1/customer-snapshot/changes` is an **upsert feed**, not deletion CDC
or a point-in-time snapshot. It reads only local D1. Omit `since` (or send it
empty) **without** `since_id` for the initial page. A bare `since` returns only
strictly later timestamps, so it replays later sync runs whole, not the
remaining rows of the boundary run.

Timestamp comparison uses canonical UTC milliseconds: seconds-only and
one-, two- or three-fraction-digit timestamps are normalized before SQL.
For example, `2026-09-01T00:00:00.1Z`, `.10Z` and `.100Z` describe the same
boundary. More than three fraction digits is a 400 even if the extra digits
are zero; no rounding or truncation. Offsets, local datetimes and date-only
inputs are not accepted in place of the existing UTC `Z` datetime format.

Resume a page with **both** fields from `nextCursor`. `since_id` requires a
nonempty valid `since` and must be an exact unpadded ASCII decimal integer
from `0` through `9007199254740991`; `0` remains the boundary sentinel.
Whitespace, signs, prefixes, exponents, decimal points and repeated cursor
keys are invalid. The value-free anchored 400 names only fields; see
[query policy](docs/SNAPSHOT-LIST-QUERY-POLICY.md#customer-changes-cursor-validation).

Optional `fields=company_name` returns only `customer_id` and `company_name`;
omit `fields` for all customer columns. Selection uses the shared strict
customer allowlist: unknown/empty/duplicate names or repeated keys fail
before D1 with value-free guidance. Membership, order, page-length `total`
and composite `nextCursor` are computed from full rows before projection,
even if `synced_at` is not selected. Keep `fields` on continuation requests.
See the [synthetic two-page example](docs/SNAPSHOT-LIST-QUERY-POLICY.md#sparse-fieldsets-fields).

Synthetic example: rows `(8402, 2026-09-01T00:00:00.100Z)` and
`(8407, 2026-09-01T00:00:00.100Z)` share a timestamp. A `limit=1` page ending
at `8402` returns:

```json
{"nextCursor":{"since":"2026-09-01T00:00:00.100Z","since_id":8402}}
```

The same full page advertises this optional response header:

```text
Link: </api/v1/customer-snapshot/changes?since=2026-09-01T00%3A00%3A00.100Z&since_id=8402&limit=1>; rel="next"
```

Prefer following that server-supplied relative target over reconstructing the
pair. The next request's query is
`since=2026-09-01T00%3A00%3A00.100Z&since_id=8402&limit=1`; it includes
`8407` instead of skipping the millisecond tie. Order stays
`(synced_at, customer_id)`, page limit stays `1..500` (default `50`), and
`total` counts only the returned rows. Every full page emits a cursor,
including the final full page; continue until `nextCursor` is `null`.
Cursor timestamps are always emitted with three fraction digits.

Link appears exactly when the composite cursor is non-null. It replaces
`since` and `since_id` together and retains the validated effective limit,
the normalized `until` and the validated `fields` selector, so sparse
bounded traversal keeps sparse bounded pages; the fixed path/allowlist
excludes unknown keys, request origins, forwarded hosts and credentials.
Optional `until` is an inclusive `synced_at` upper bound with the same UTC Z
millisecond contract as `since` (empty, repeated, offset and overprecise
values are 400s; normalized `since` must not exceed it), conjoined as a
bound predicate with the unchanged lower/composite predicate; omit it for
the unbounded tail with previous JSON/SQL bytes. Optional `fields` projects
stored customer columns (always retaining `customer_id`) after page
membership, order, `total` and the composite cursor are computed from full
rows. A full terminal page may link to an empty page; short/empty/error
pages have no next link, and omission means stop. The single SELECT gains no
COUNT or lookahead. Auth, read-token access, no-store, request ID and
existing CORS exposure (including Link) stay intact. Mounted OpenAPI
declares the optional header. See the
[safe synthetic client recipe](docs/CONSUMER-QUICKSTART.md#2c-follow-the-composite-next-link)
for same-origin/fixed-path checks, manual redirects and non-2xx refusal
before parsing JSON, and the
[bounded two-page recipe](docs/CONSUMER-QUICKSTART.md#bounded-changes-window-until).
No completeness or snapshot-isolation promise is added: overwrites can move
rows outside the window and bulk imports advance timestamps.

Hermetic regression checks (no running Worker needed):

```bash
npm run check:customer-changes-cursor
npx vitest run test/customerChangesFields.acceptance.test.ts test/sparseFieldsets.acceptance.test.ts test/openapiContract.test.ts --maxWorkers=2
npm run check:customer-changes-next-links
npm run check:customer-changes-until
```

This uses synthetic local D1 rows only; no credentials, upstream requests,
production replay or deployment.

### Customer-row erasure scope

`DELETE /api/v1/customer-snapshot/{customerId}` is local cache suppression,
not upstream Routeware erasure. It writes an id-only D1 tombstone and deletes
the D1 `customer_snapshot` row in one batch, then evicts the data-entity cache
entry. If address children prevent the delete, the FK refusal rolls back both
writes; an absent customer still returns 404. A D1 tombstone suppresses the
customer on later sync, proxy-save refresh, and CSV/archive import. Suppressed
address writes for that customer are skipped and recorded as id-only lineage
so their container writes are skipped too; other customers keep fail-closed
foreign keys. Tombstones
have no automatic expiry and remain until explicitly removed; retain them while
upstream or any archive/backup can return that customer. It does not remove R2
history CSVs, daily aliases, latest pointers, or the archived-CSV readback, and
it does not touch upstream Routeware. A D1 Time Travel/backup restore from
before the erasure can restore the row and lose the tombstone/triggers; verify the
schema, reconcile tombstones from the operator's out-of-band erased-customer
list (the same list previously used to re-DELETE after restore — e.g., the
erasure ticket or incident log), then delete any re-restored rows in FK order
per the backfill SQL (a re-applied marker over existing rows freezes them
without removing them), and re-apply suppression before serving
recovered data, so verify suppression after database recovery. Customers erased
before the suppression migration have no tombstone; backfill them with
privileged `wrangler d1 execute` (see
`docs/R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched`).
Time Travel can restore data for up to 30 days (7 days on the Workers Free
plan). This route removes only the `customer_snapshot` row:
the customer's `address_snapshot` and `container_snapshot` rows are not
removed by this route. Deleting a customer that still has address rows
fails closed with 400 (never an orphan, never a cascade). There is no
address or container DELETE route — "delete the addresses first" means
removing them through upstream-driven reconciliation or through direct
privileged `wrangler d1 execute` deletes in container → address →
customer FK order, then retrying the customer delete.
See `docs/PROBLEMS.md#bad-request`.

### Spreadsheet-safe snapshot CSV exports

Open these downloads as **comma-delimited CSV with double-quote text
delimiters**. Other delimiter guesses (such as semicolon or tab) are not a
supported spreadsheet-safety boundary; select comma explicitly when importing.

All three `/export` downloads write a cell whose first non-space character is
`=`, `+`, `-`, `@`, an apostrophe, a full-width operator, or a tab, CR or LF with
one extra leading apostrophe inside a double-quoted CSV field. Plain numbers such
as `-74.0060` are not prefixed. Double quotes are doubled per RFC 4180. An original
apostrophe-leading cell receives one more apostrophe, so `=1+1` and the literal
`'=1+1` cannot collide. Cells that contain a semicolon or a tab are quoted too, so a
spreadsheet that guesses a different delimiter keeps them in one cell.

Exports insert `_shadow_csv_encoding` before the final `synced_at`, with the value
`1` on every row. Re-importing a row that carries that marker removes exactly one
leading apostrophe before the existing import normalization. Unmarked Routeware CSV
and other marker values are not decoded. Machine consumers must honor the marker
rather than treat spreadsheet-escaped values as raw business data.

Size: the marker adds 21 header bytes and 2 bytes per row. An escaped cell adds one
apostrophe, and two quote bytes when it was not already quoted; a cell that contains
a semicolon or tab adds two quote bytes. The export
has no byte-size cap (query-budget admission is described below), but a direct HTTP re-import is limited to the unchanged
**52,428,800-byte (50 MiB)** body limit and returns 413 above it. An export within
that margin of the limit can therefore fail re-import even though it was admissible
before this encoding. No automated split-and-import path exists yet.

The archived-CSV readback (`GET /api/v1/snapshots/{table}/{date}`) serves the export's
encoding so an operator comparison works. Records are split as the importer
splits them, and blank data records are dropped as its row parsers drop them. Each cell is trimmed as the importer's
`cell()` trims it and then escaped with the export's helper, and `_shadow_csv_encoding`
with value `1` follows the archived header and every row. Rows end in LF. The readback
keeps the archived spelling of each trimmed value, while the export writes the stored D1 value,
so a typed column such as a number or a boolean can be spelled differently; `synced_at`
exists only in the export. `Content-Length` and the ETag (a quoted FNV-1a 64 content
hash) describe the served bytes, and `If-None-Match` with the current tag returns 304.
An archive replaced while it is being read returns 409 `conflict`; one deleted
meanwhile returns 404.

Decision: the readback's served bytes change; the stored archive objects
and the sync input do not. Rejected: serving the raw bytes and asking operators not to
open them in a spreadsheet, which leaves formula cells evaluable; and writing a second
escaped object at archive time, which doubles R2 storage and adds a transform to the
sync path's memory peak. `restoreSnapshotCsvFromR2` reads the stored object directly
and is unaffected. A readback can be larger than the archive, by the marker and escape
bytes, so a direct HTTP re-import of a readback near the 50 MiB limit can return 413,
as an export can.

This follows [OWASP CSV Injection guidance](https://owasp.org/www-community/attacks/CSV_Injection)
for text-cell escaping. It is not a promise of safety or losslessness after a
spreadsheet saves, converts, or reopens the CSV: spreadsheet programs can strip
escaping or alter values. Keep the original download for programmatic re-import.

Re-importing a download is upsert-only and does not prune. Keep a re-import window
away from 07:00 UTC, and avoid Routeware saves and `POST /api/v1/data/customer`,
`/address` or `/container` writes for the affected customers until the import is
verified. The scheduled sync (`crons` in `wrangler.toml`, `0 7 * * *` UTC) and those
writes reconcile rows to the upstream report and can delete rows it does not report.

### CSV export page sizing

The three `GET ...-snapshot/export` routes default to **1000 rows per D1 read**.
Set the optional plain-text **`SNAPSHOT_EXPORT_PAGE_SIZE`** Worker variable to
change that limit for all three tables, for example:

```toml
[vars]
SNAPSHOT_EXPORT_PAGE_SIZE = "50"
```

Merge this entry into the existing `[vars]` block, not a second block. For a named
Wrangler environment, put it in that environment's `[env.<name>.vars]` block:
[variables are not inherited](https://developers.cloudflare.com/workers/configuration/environment-variables/#environment-variables-via-wrangler).
Quote the value: the binding is read as text, so an unquoted TOML number is
ignored and the default applies. Only decimal integer strings **1–5000**
are accepted; surrounding whitespace is trimmed. Missing, blank, fractional,
signed, non-decimal or out-of-range values fall back to **1000** (no error and
no unbounded query; a present but invalid value logs a warning). Remove the variable to restore the default. It does not
change list pagination, sync/upsert batch sizes, CSV bytes, ETags, `304` replies,
ordering, quoting, filenames or authorization.

- **Memory:** lower the size for wide text-heavy rows. Each read remains
  `LIMIT`-bounded and the stream queues at most one page ahead of the consumer;
  it never accumulates the full export. The cap bounds rows, not bytes: row width
  and concurrent requests still matter under the
  [128 MB per-isolate limit](https://developers.cloudflare.com/workers/platform/limits/#memory).
  At 4 KB rows, a 1000-row default page is about 4 MB of CSV text and the 5000-row
  maximum about 20 MB. Each page is held as row objects, a joined string and an
  encoded chunk at once, so peak memory is a multiple of that size plus row-object
  overhead; keep overrides for wide tables near the default.
- **Query budget:** the pure cost formula (`src/lib/snapshot/exportBudget.ts`)
  for a `200` download is `2 * (ceil(N / pageSize) + 1)`: ETag and body passes,
  each including the terminal empty-page read, even for exact page multiples.
  An empty table costs two reads. The existing
  [D1 per-invocation contract](https://developers.cloudflare.com/d1/platform/limits/)
  is **1000 Paid / 50 Free**; this deployment targets Paid, not Free. We reserve
  **50 queries of safety headroom** within the 1000 limit, leaving a fixed
  **950-query export allowance** (no platform-limit increase). Thus the largest
  admitted table is `(floor(950 / 2) - 1) * pageSize`, or **474,000 rows at the
  default**. A conditional `304` still uses only one pass, but admission reserves
  a full `200` before checking `If-None-Match`.
- **Pre-body refusal:** the ETag prepass itself stops within **475 D1 reads**;
  an oversized export returns **503 `application/problem+json`** with type
  [`snapshot-export-query-budget`](docs/PROBLEMS.md#snapshot-export-query-budget),
  a fixed detail pointing here, no CSV disposition or ETag, and no body pass.
  The read cap also bounds work if concurrent changes yield short nonempty pages.
  For a synthetic **388,735-row** table, the 1000 default costs **390 reads per
  pass (780 both)** and fits; 500 costs **779 per pass (1,558 both)** and is
  refused before CSV starts. At page size 50 it would need **7,776 per pass**:
  use 50 only for smaller tables/test fixtures, not that full-size example.
- **Remedy:** review the existing `SNAPSHOT_EXPORT_PAGE_SIZE` Worker binding;
  larger pages reduce reads at a memory cost, within the supported **1–5000**
  range. Choose against the largest/widest table since the setting applies to
  all three. It is not a client query parameter. Retrying unchanged sizing
  cannot fix this refusal; if the maximum still cannot fit, this endpoint
  cannot provide that full CSV within its contract. No new mutation or flag is
  introduced. The guard does **not** provide transactional consistency across
  passes or eliminate unpredictable mid-stream faults: concurrent growth and
  later D1 failures can still error an admitted stream. D1 exceptions retain
  their existing handling, not the budget diagnostic.

Focused admission check (synthetic fixtures only, also discovered by `npm test`):

```sh
npm test -- test/snapshotExportBudget.test.ts
```

This pins empty tables, exact page multiples, both sides of the boundary, capped
prepass work, no CSV stream on predictable refusal, all three routes, unchanged
admissible bytes/ETags/304, and controlled D1 failures. No live tenant or remote
Wrangler command is needed.

Encoding/page-size regression:

```sh
npm test -- test/snapshotCsvExport.test.ts test/snapshotExportRoundTrip.test.ts test/shadowSyncExportRoundTrip.test.ts
```

The suite compares complete export bytes and ETags at 50 and the 1000 default on
every table, answers `304` at 50 for the default tag, compares the real local D1
customer export at both sizes, checks the 200 read formula against the D1 budget at
the measured row counts (real call counts are pinned at small row counts), and drains a lazy wide-row fixture without collecting
the whole body to pin backpressure/page bounds. No live production export is needed
to verify the setting.

### D1: “Too many API requests by single Worker invocation”

Cloudflare D1 allows **about 1000 SQL operations per Worker invocation** (see [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). This project uses **multi-row `INSERT` statements** (up to the 100 bound-parameter cap) to pack many CSV rows per statement.

`POST /api/v1/data-snapshot/sync` **chains** three internal `POST` calls to `/api/v1/customer-snapshot/sync`, `.../address-.../sync`, and `.../container-.../sync`, so each table runs in a **separate** Worker invocation and gets its own ~1000-op budget. (A single in-process run would still pool all three tables into one budget.)

**Cron / scheduled sync:** set **`SHADOW_API_PUBLIC_BASE`** in `wrangler.toml` to this Worker’s public origin (e.g. `https://routeware-shadow-api.5150.workers.dev`, no path). The job then uses the same chained mode. If it is empty, the cron falls back to one invocation and may hit the limit on large exports.

If a **single** table still exceeds ~1000 operations, run that table’s sync in multiple passes or ask Cloudflare for a limit increase.

### Sync batch sizing vs the D1 budget

Measured 2026-09-27 (`SELECT COUNT(*)` only, no PII): customer **109,894**, address **111,620**, container **388,735** rows. Under the per-`db.batch()`-call counting model (one call = 1 op + 1 reconcile `DELETE` per non-empty sync), the committed chunk sizes (`STREAM_BATCH_CUST/ADDR = 80`, `STREAM_BATCH_CONT = 40` in `src/lib/snapshot/streamSync.ts`) cost **1,375 / 1,397 / 9,720 ops** per table — every table exceeds its own 1000-op chained budget, and a pooled single invocation totals 12,492 ops. Safe per-table (chained) sizes at these counts: **customer 120** (917 ops, margin 83), **address 120** (932 ops, margin 68), **container 400** (973 ops, margin 27). Even at safe sizes the three tables pooled in one invocation total 2,822 ops, so chained mode stays required; growing the batch further buys fewer calls but packs more statements per call (the 100-bind / 100 KB per-statement caps still bind inside each call, pinned by `test/snapshotUpsert.test.ts`).

Rerun 2026-09-29 on current main: numbers unchanged — committed sizes still cost 1,375 / 1,397 / 9,720 ops; safe sizes 120/120/400 with margins 83/68/27 confirmed. Intervening sync fixes (#71 quoted-header guards, #84 import 400/413 rejects, #89 child-reconcile timestamps, #109 R2-after-D1) touch parsing/validation/ordering, not the batch-counting model, so the recommendation stands.

Reproduce: `node scripts/check-sync-batch-budget.mjs` (measures the committed constants; exit 0 always — `OVER` is a finding, not a gate failure). Try candidates without editing source, e.g. `node scripts/check-sync-batch-budget.mjs --batch-customer=120 --batch-address=120 --batch-container=400`, or re-run against fresh counts with `--customer-rows=N --address-rows=N --container-rows=N`. Unit pins: `test/syncBatchBudget.test.ts`.

### 503 / `exceededMemory` (rare)

Workers cap **memory** per isolate (~128 MB). Sync and import now **stream** the CSV and upsert in batches (no full-file `string` for report downloads), which is what you need for very large container exports. If you still see `exceededMemory`, run the three `POST` sync routes as **separate** requests in order, or lower batch pressure by splitting work across times.

**Aggregate reads and Routeware writes (OpenAPI tag `data-entity`):** same bearer. **GET** `/api/v1/data/customer?id=…` (or `customerId=…`), `/api/v1/data/address?id=…` (pickup address id), `/api/v1/data/container?id=…` — D1 cache with `ETag` / `If-None-Match` and Workers `Cache` API, invalidated on successful **POST** to the same path. **POST** forwards to Routeware `SaveCustomerLongForm`, `SaveAddressForm`, or `SaveContainerForm` and returns ids + sync outcome only (`ok`, `routewareStatus`, resolved ids, `upstreamBytes`, `localSync` with fixed `code` outcomes — never submitted fields or the upstream body), then refreshes D1 from `GetCustomerDetailFull` for the affected customer. Create: customer with `CustomerID=0` (or omit); address with `PickupAddressID=0` + `CustomerID`; container with `ContainerID=0` + `PickupAddressID` (and `CustomerID` if you want local sync when D1 is empty).

Interactive docs: `GET /docs` (Scalar). Machine-readable: `GET /openapi.json`.

Regenerate types after `wrangler.toml` structural changes: `npx wrangler types`.
