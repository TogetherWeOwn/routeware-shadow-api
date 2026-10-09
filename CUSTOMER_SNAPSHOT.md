# Routeware CSV snapshots (D1)

Routeware **Customer / Address / Container** custom report exports are cached in a single D1 database (`CUSTOMER_DB`) so the Worker can query them without replaying the SPA.

## Data model (foreign keys)

- `customer_snapshot` — **primary key** `customer_id` (Routeware `CustomerID`)
- `address_snapshot` — **primary key** `pickup_address_id` (Routeware `PickupAddressID`); **FK** `customer_id` → `customer_snapshot`
- `container_snapshot` — **primary key** `container_id` (Routeware `ContainerID`); **FK** `pickup_address_id` → `address_snapshot`

**Import / sync order:** load customers, then addresses, then containers. The combined job (`POST /api/v1/data-snapshot/sync` or the daily cron) only runs the address step when the customer *export is configured* (static path or query id), and the container step only when both customer and address are configured.

**Foreign keys and reconciliation:** the FK columns are declared and D1 **enforces** them unconditionally in every transaction/batch — an orphan row is rejected (import/sync answers 400 `bad-request` naming the dangling key), so import order is enforced, not just convention. A streamed sync spans many batches rather than one transaction, so integrity relies on the import order above plus reconciliation as well as the database. A report **`sync`** (not `import`) deletes rows not present in the current run (`deleted` count in the response) so upstream deletions propagate; reconciliation is skipped when a run yields zero data rows, so a bad/empty export never wipes a table. **`import`** is treated as possibly-partial and never deletes.

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
(`src/lib/r2SnapshotArchive.ts`). Hashes and keys only, never row data, so the
manifest is safe to log and print. A failed CSV put writes no entry; a corrupt
existing sidecar is replaced (warned), and verify then reports the other tables
as missing, loudly.

Check one date's archive without credentials (local Miniflare R2 under a
`--persist-to` dir) or read-only against remote (needs `CLOUDFLARE_API_TOKEN` in
the environment, never a flag):

```bash
npm run verify:r2-manifest -- --date=2026-09-28 --persist-to=<dir>
```

Exit 0 when every entry verifies; exit 1 on any mismatch, missing object, or
unreadable manifest; exit 2 on flag/usage errors. A tampered CSV fails by name
with both hashes, e.g. `FAIL customer.csv (snapshots/2026-09-28/customer.csv):
sha256 mismatch (manifest <old>, r2 <new>; ...)`. Reviewer acceptance path —
fixture, verify PASS, tamper one byte, verify FAIL — is worked end to end in
the header comment of `scripts/verify-r2-manifest.mjs`; pure compare logic
lives in `scripts/lib/r2ManifestVerify.mjs` (unit-tested, no Wrangler needed).

## API quick reference (OpenAPI tags: `customer-snapshot`, `address-snapshot`, `container-snapshot`, `data-snapshot`)

All `.../import` and `.../sync` and `data-snapshot/sync` routes use **`Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`**.

| Method | Path | Purpose |
|--------|------|--------|
| GET | `/api/v1/customer-snapshot` | List rows: query `customerId`, `q`, `enabled`, `limit`, `offset`, `cursor` (seek pagination, see `nextCursor`) |
| GET | `/api/v1/customer-snapshot/{customerId}` | One customer row |
| GET | `/api/v1/customer-snapshot/changes` | Incremental feed: rows with `synced_at > since` in `(synced_at, customer_id)` order; omit `since` for the first page, `limit` 1..500. A bare `since` replays every later run whole; to page a chunked delta, pass the previous page's `nextCursor` back as `since` + `since_id` (the composite pair resumes at the boundary timestamp without skipping same-timestamp rows) |
| GET | `/api/v1/customer-snapshot/export` | Download the snapshot as CSV (`Content-Disposition: attachment; filename="customer-snapshot.csv"`), streamed in keyset pages |
| POST | `/api/v1/customer-snapshot/sync` | Fetch customer CSV (path or `CUSTOMER_REPORT_QUERY_ID` pipeline) and upsert |
| POST | `/api/v1/customer-snapshot/import` | Body = raw customer CSV; `Content-Type: text/csv` or `application/octet-stream` (a missing or other media type gets 415) |
| GET | `/api/v1/address-snapshot` | List rows: `customerId`, `pickupAddressId`, `q`, `enabled`, `limit`, `offset`, `cursor` (seek pagination, see `nextCursor`) |
| GET | `/api/v1/address-snapshot/{pickupAddressId}` | One address row |
| GET | `/api/v1/address-snapshot/export` | Download the snapshot as CSV (`Content-Disposition: attachment; filename="address-snapshot.csv"`), streamed in keyset pages |
| POST | `/api/v1/address-snapshot/sync` | Fetch address CSV (path or `ADDRESS_REPORT_QUERY_ID`) and upsert |
| POST | `/api/v1/address-snapshot/import` | Body = raw address CSV; `Content-Type: text/csv` or `application/octet-stream` (a missing or other media type gets 415) |
| GET | `/api/v1/container-snapshot` | List rows: `customerId` (join), `pickupAddressId`, `containerId`, `q`, `enabled`, `limit`, `offset`, `cursor` (seek pagination, see `nextCursor`) |
| GET | `/api/v1/container-snapshot/{containerId}` | One container row |
| GET | `/api/v1/container-snapshot/export` | Download the snapshot as CSV (`Content-Disposition: attachment; filename="container-snapshot.csv"`), streamed in keyset pages |
| POST | `/api/v1/container-snapshot/sync` | Fetch container CSV (path or `CONTAINER_REPORT_QUERY_ID`) and upsert |
| POST | `/api/v1/container-snapshot/import` | Body = raw container CSV; `Content-Type: text/csv` or `application/octet-stream` (a missing or other media type gets 415) |
| POST | `/api/v1/data-snapshot/sync` | Run customer → address → container in one call (per path vars and guards) |

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
itself is not capped, but a direct HTTP re-import is limited to the unchanged
**52,428,800-byte (50 MiB)** body limit and returns 413 above it. An export within
that margin of the limit can therefore fail re-import even though it was admissible
before this encoding. No automated split-and-import path exists yet.

The archived-CSV readback (`GET /api/v1/snapshots/{table}/{date}`) serves the export's
encoding so an operator comparison works (TOG-18829). Records are split, and blank
records dropped, as the importer reads them. Each cell is trimmed as the importer's
`cell()` trims it and then escaped with the export's helper, and `_shadow_csv_encoding`
with value `1` follows the archived header and every row. Rows end in LF. The readback
keeps the upstream spelling of each value, while the export writes the stored D1 value,
so a typed column such as a number or a boolean can be spelled differently; `synced_at`
exists only in the export. `Content-Length` and the ETag (a quoted FNV-1a 64 content
hash) describe the served bytes, and `If-None-Match` with the current tag returns 304.
An archive replaced while it is being read returns 409 `conflict`; one deleted
meanwhile returns 404.

Decision (TOG-18829): the readback's served bytes change; the stored archive objects
and the sync input do not. Rejected: serving the raw bytes and asking operators not to
open them in a spreadsheet, which leaves formula cells evaluable; and writing a second
escaped object at archive time, which doubles R2 storage and adds a transform to the
sync path's memory peak. `restoreSnapshotCsvFromR2` reads the stored object directly
and is unaffected. A readback is larger than the archive by the marker and escape
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
- **Query budget:** the streamed body of `N` rows uses `ceil(N / pageSize) + 1`
  D1 reads (including the final empty read). Every export also runs a content-hash
  ETag prepass (TOG-8879) over the same pages before the body, so a `200` download
  costs **twice** that number and a conditional `304` costs one pass. Leave room for
  other queries/subrequests under
  [D1's per-invocation limits](https://developers.cloudflare.com/d1/platform/limits/)
  (**1000 Paid / 50 Free**). Smaller pages can exhaust this budget even though
  memory remains bounded. At the measured 388,735 container rows (see
  § batch sizing), the 1000 default needs **390 reads per pass (780 for both
  passes)**, inside the cap with headroom to about 499,000 rows; 500 would need
  **779 per pass (1,558 both)** and the body would truncate mid-stream after the
  200 is sent, while 50 needs **7,776 per pass**: use 50 only for smaller
  tables/test fixtures, not that full production table. Larger pages reduce reads
  at a memory cost; choose against the largest/widest table since this variable
  applies to all three.

Acceptance/regression:

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

### Sync batch sizing vs the D1 budget (TOG-6293)

Measured 2026-09-27 (`SELECT COUNT(*)` only, no PII): customer **109,894**, address **111,620**, container **388,735** rows. Under the per-`db.batch()`-call counting model (one call = 1 op + 1 reconcile `DELETE` per non-empty sync), the committed chunk sizes (`STREAM_BATCH_CUST/ADDR = 80`, `STREAM_BATCH_CONT = 40` in `src/lib/snapshot/streamSync.ts`) cost **1,375 / 1,397 / 9,720 ops** per table — every table exceeds its own 1000-op chained budget, and a pooled single invocation totals 12,492 ops. Safe per-table (chained) sizes at these counts: **customer 120** (917 ops, margin 83), **address 120** (932 ops, margin 68), **container 400** (973 ops, margin 27). Even at safe sizes the three tables pooled in one invocation total 2,822 ops, so chained mode stays required; growing the batch further buys fewer calls but packs more statements per call (the 100-bind / 100 KB per-statement caps still bind inside each call, pinned by `test/snapshotUpsert.test.ts`).

Rerun 2026-09-29 (TOG-8380) on current main: numbers unchanged — committed sizes still cost 1,375 / 1,397 / 9,720 ops; safe sizes 120/120/400 with margins 83/68/27 confirmed. Intervening sync fixes (#71 quoted-header guards, #84 import 400/413 rejects, #89 child-reconcile timestamps, #109 R2-after-D1) touch parsing/validation/ordering, not the batch-counting model, so the recommendation stands.

Reproduce: `node scripts/check-sync-batch-budget.mjs` (measures the committed constants; exit 0 always — `OVER` is a finding, not a gate failure). Try candidates without editing source, e.g. `node scripts/check-sync-batch-budget.mjs --batch-customer=120 --batch-address=120 --batch-container=400`, or re-run against fresh counts with `--customer-rows=N --address-rows=N --container-rows=N`. Unit pins: `test/syncBatchBudget.test.ts`.

### 503 / `exceededMemory` (rare)

Workers cap **memory** per isolate (~128 MB). Sync and import now **stream** the CSV and upsert in batches (no full-file `string` for report downloads), which is what you need for very large container exports. If you still see `exceededMemory`, run the three `POST` sync routes as **separate** requests in order, or lower batch pressure by splitting work across times.

**Aggregate reads and Routeware writes (OpenAPI tag `data-entity`):** same bearer. **GET** `/api/v1/data/customer?id=…` (or `customerId=…`), `/api/v1/data/address?id=…` (pickup address id), `/api/v1/data/container?id=…` — D1 cache with `ETag` / `If-None-Match` and Workers `Cache` API, invalidated on successful **POST** to the same path. **POST** forwards to Routeware `SaveCustomerLongForm`, `SaveAddressForm`, or `SaveContainerForm` and returns ids + sync outcome only (`ok`, `routewareStatus`, resolved ids, `upstreamBytes`, `localSync` with fixed `code` outcomes — never submitted fields or the upstream body; TOG-6535), then refreshes D1 from `GetCustomerDetailFull` for the affected customer. Create: customer with `CustomerID=0` (or omit); address with `PickupAddressID=0` + `CustomerID`; container with `ContainerID=0` + `PickupAddressID` (and `CustomerID` if you want local sync when D1 is empty).

Interactive docs: `GET /docs` (Scalar). Machine-readable: `GET /openapi.json`.

Regenerate types after `wrangler.toml` structural changes: `npx wrangler types`.
