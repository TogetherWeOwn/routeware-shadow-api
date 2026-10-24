# Changelog

Per-release notes for consumer-visible changes. `package.json#version` is
the single source of truth — see `docs/VERSIONING.md` for the bump policy.

## [Unreleased]

- #350: Three ordinary snapshot lists (`GET
  /api/v1/customer|address|container-snapshot`) accept an optional `upperId=`
  caller-held inclusive ceiling: only rows whose resource primary key is at or
  below the cap are listed and counted. The caller retains the cap unchanged
  across pages, so higher-ID arrivals cannot extend the traversal; a cursor at
  or above the cap yields an empty page with existing cursor-relative totals.
  The cap composes with all filters, `q`, `enabled`, `fields=`, offset/cursor
  and `includeTotal=false`, is preserved verbatim in `Link` next targets, needs
  no migration or index, and omission preserves existing behavior with no `MAX`
  query. Values are one canonical unpadded ASCII decimal integer from `1` to
  `9007199254740991`; anything else is a value-free 400 before D1, after
  read-role authentication. Numeric IDs are not timestamps: inserts below the
  ceiling, updates and deletions remain visible, with no snapshot isolation,
  exact-once or watermark promises. Synthetic resume example:
  `docs/SNAPSHOT-LIST-QUERY-POLICY.md`; focused check:
  `npm run check:snapshot-upper-id`. Update Zod from 4.3.6 to 4.6.7 to fix
  GHSA-mrhx-c7xc-m3w5 (oversized constrained-collection memory exhaustion)
  without changing the dependency audit gate or its allowlist.

- #345: Post-deploy probe adds composable `--json` (schema version 1, fixed check IDs,
  bounded allowlisted diagnostics) and effect-free `--dry-run` plans. Authenticated
  plan checks stay unresolved; valid plans are not health evidence. Only explicit
  boolean `checks.cron.stale` is fresh/stale; malformed present cron fails closed,
  while absent legacy cron remains advisory. No raw body/error/cron metadata is
  printed. Redirects are refused and no retries are added. Output is bounded,
  not response-body buffering. Existing scheduled-target and missing-token gates
  remain. See `docs/SCHEDULED-PROBE.md` for hermetic agent checks and limits.

- #347: Conditional snapshot JSON reads: customer, address and container lists return
  quoted SHA-256 ETags for the final projected JSON envelope and an empty 304
  when `If-None-Match` matches. Malformed validators are misses; authentication,
  query validation and D1 work remain unchanged. Bandwidth savings only, with
  unchanged `no-store` and no shared response cache or persisted validators.
  See `docs/CONSUMER-QUICKSTART.md` for the synthetic regression recipe.

- #343: Snapshot customer/address/container lists now return optional
  `Link: <relative-target>; rel="next"` when `nextCursor` is non-null. Targets
  preserve allowlisted filters, explicit fields, effective limit and
  `includeTotal=false`, replacing cursor and dropping offset. No JSON or SQL
  changes; a full terminal page may link to an empty page. CORS exposes Link;
  OpenAPI and the same-origin follow-next quickstart document it.

- #342: Hydrated single-ID `GET /api/v1/data/customer|address|container` accepts
  strict `fields=` selectors from the shared snapshot allowlists. Only the
  requested `.customer`, `.address` or `.container` root is projected, always
  retaining its primary ID; related bundle data is unchanged. Omitted fields
  preserves full-read behavior. Invalid selectors are value-free 400s before
  cache/D1 access, with existing auth precedence. Projected ETags hash served
  bytes and support empty-body 304s without reusing full-only validators or
  overwriting the canonical full cache. No batch IDs, nested selectors, SQL
  optimization or TTL changes. Synthetic examples and validator guidance:
  `docs/CONSUMER-QUICKSTART.md` and `docs/ENTITY-DATA-CACHE.md`.

- #338: Every `/api/v1` response echoes `X-Request-Id`, adopting inbound IDs of
  1–128 RFC 7230 token characters or minting a UUID for missing/invalid values
  without rejecting the request. Gate, notFound and onError problem bodies and
  onError logs carry the same `requestId`; route-level problem bodies are
  unchanged. CORS allows and exposes the header for retry correlation, not
  idempotency. IDs are not propagated upstream. See `docs/CONSUMER-QUICKSTART.md`
  and `docs/LOGGING.md`.

- #334: `POST /api/v1/data-snapshot/sync` accepts `?partialProgress=true` to
  opt into sanitized partial progress on a table-step failure: HTTP 500
  `application/json` `{customer, address, container, failure}` with per-table
  `{upserted, rowCount}` (completed) or `null` and fixed `{table, code}` plus
  the numeric `status` only for `ChainedHttpError`. `code` is one of the six
  runbook §4.1 classifications, never upstream text; no `deleted`, `r2`, or
  row data travels. Absent or `false` keeps the generic shapes byte-for-byte;
  any other value is a value-free 400 before any table runs. Success is
  identical with or without the flag. See `CUSTOMER_SNAPSHOT.md`.

- #337: Auth-throttle 429s now carry standard `RateLimit`
  (`"auth-burst";r=0;t=<retryAfterSec>`) and `RateLimit-Policy`
  (`"auth-burst";q=19;w=60`) fields alongside the byte-identical `Retry-After` /
  `X-RateLimit-*` headers, and the upstream-timeout backstop 502 carries a fixed
  `Retry-After: 5`. CORS exposes the new fields. No other status gains `Retry-After`.

- Consumer quickstart now documents the customer `changes` feed
  (`GET /api/v1/customer-snapshot/changes`: composite `since` + `since_id`
  cursor, lossless millisecond precision, upserts-only boundary) and the R2
  snapshot archive readback (`GET /api/v1/snapshots/{table}/{date}`:
  sync-secret gate, 404-vs-absent, ETag/304), plus address/container by-id
  reads. A new `test/consumerQuickstartCoverage.test.ts` ratchet fails when a
  registry GET is neither referenced in `docs/CONSUMER-QUICKSTART.md` nor
  named in its reasoned allowlist (routeware passthroughs, orphan audit).
  No Worker behavior change.

## [1.0.0] - 2026-10-22

Initial release of the Routeware Shadow API (Cloudflare Worker): shadow
health, Routeware account/customer/report proxies, customer/address/container
snapshots with sync and import, data-entity reads and writes, and the
versioned OpenAPI document at `GET /openapi.json`.

- `openapi.json` `info.version` is now wired to
  `package.json#version` (via `src/lib/version.ts`) instead of a hardcoded
  `1.0.0`, so consumers can tell releases apart. Added
  `docs/VERSIONING.md` (bump policy) and this changelog.

- #333: the customer/address/container snapshot lists and by-id reads accept
  an optional `fields=` sparse-fieldset selector. Response objects contain
  exactly the requested allowlisted columns plus the resource id, which is
  always present even when omitted. Unknown, empty and duplicate names are a
  value-free 400 before any D1 work. Auth ordering, ETags, pagination
  envelopes and the hydrated/export/changes reads are unchanged. Documented
  in `docs/SNAPSHOT-LIST-QUERY-POLICY.md`; pinned by
  `test/sparseFieldsets.acceptance.test.ts`.
- #326: Readiness now bounds concurrent D1 ping and advisory cron response waits at
  15 seconds, while retaining its non-sliding 20-second single-flight cache.
  Timed-out pings return degraded HTTP 503; cron timeouts remain advisory.
  Failed/timed-out observations return fixed `code` and `next_action` fields
  instead of raw dependency exception text. Timeout does not cancel underlying
  D1 work; late completion cannot replace a newer cached observation. See
  `docs/READINESS-CACHE.md` for recovery guidance and the local acceptance check.
- Local harvest validation and aggregation now share a fail-closed NDJSON record
  contract. Invalid records and read failures stop processing without replacing
  existing outputs; missing and empty harvests retain their distinct behavior.
  Both commands provide bounded `--json` diagnostics and `--help`; aggregation
  adds a read-only `--dry-run`. Synthetic contract checks run in discovery/probe.
- #324: Hydrated `GET /api/v1/data/customer|address|container` reads now require
  canonical positive decimal safe-integer IDs (`1`–`9007199254740991`) for
  both `id` and the existing `customerId` / `pickupAddressId` / `containerId`
  aliases. Empty or whitespace text, leading zeros, signs, fractions,
  exponents, hex, nonpositive and unsafe IDs return anchored 400 problems
  before handler/cache/D1 access instead of being numerically coerced.
  Every supplied spelling is validated, including an unused alias; when both
  are valid, `id` still wins even if their values differ. Valid unknown IDs
  remain 404; hydrated rows, ETags, auth ordering and save handlers are unchanged.
- #321: the customer/address/container snapshot lists accept
  `includeTotal=false` to skip the `COUNT(*)` query and answer
  `total: null` (deliberately not computed, not zero) with the same
  rows, `nextCursor` and page SQL. The default response is unchanged;
  any other value is a value-free 400 before D1 access. Documented in
  `docs/SNAPSHOT-LIST-QUERY-POLICY.md` and
  `docs/CONSUMER-QUICKSTART.md`; pinned by
  `test/snapshotCountFreePagination.test.ts`.
- #323: Customer, address and container operator CSV imports, including dry runs,
  now require unambiguous identity headers and positive safe whole-decimal
  primary/relationship identities. Invalid identities return a value-free 400
  with table, row, field and correction/retry guidance. Earlier flushed valid
  batches may remain; the rejected batch is not written. Upstream report
  parsing and optional non-identity numbers are unchanged.
- #327: Detail-full write-through refreshes now refuse malformed/conflicting identity
  aliases, duplicate children and wrong enclosing parents before any D1 mutation
  or graph cache publication. Confirmed upstream saves remain successful with
  the existing `localSync.code=sync_failed` on refresh refusal; read-only mapping
  stays tolerant. Run `npm run test:detail-full` for hermetic acceptance checks.

- #328: Fixed customer changes feed pagination to normalize equivalent UTC timestamps
  with up to 3 fractional-second digits to milliseconds, reject timestamps with
  more than 3 digits or calendar-invalid dates and unsafe or noncanonical decimal `since_id` values, and
  require a valid `since` when `since_id` is supplied; tuple-based paging is
  preserved. The focused local check is `npm run check:customer-changes-cursor`.
- Daily R2 verification now binds real calendar dates and exact object keys,
  rejects empty/ambiguous comparisons and supports explicit `--expect` table
  coverage. Default success is labeled listed-only (partial), never a full-chain
  claim. `--json` provides bounded versioned findings/actions; `--dry-run` plans
  without children, object reads or artifacts. Remote credential fences and archive
  writes are unchanged. Run `npm run check:r2-manifest` for hermetic acceptance.
- #325: Chained snapshot sync now bounds each table's full header+body observation
  to one `CHAINED_SYNC_TIMEOUT_MS` deadline (180s default) and 65,536 actual
  UTF-8 bytes inclusive. Error bodies are cancelled without draining or waiting
  for cancellation. Failures never replay a POST, stop later tables and retain
  completed-table counts. Cron records carry fixed refusal kinds and
  `next_action: inspect_table_sync_before_resubmitting`; optional `deleted`
  is validated without coercion and R2 wire metadata excludes keys, arbitrary
  properties and free text while retaining archive status/fixed stage reasons.
  Combined HTTP success counts/null, dry runs and correlation IDs are unchanged.
- Discovery curl examples are inert by default: choose a stable method/path
  identity to execute a single local-only GET. Non-GET material is commented
  documentation; truncated previews are replaced by complete repository examples
  or marked unavailable. Complete body whitespace is preserved. Generator and
  shell plans (`--dry-run`, `--json`) do not modify artifacts or use the network;
  selected GETs have bounded timeouts, HTTP-error exits and no retries.
- `npm run db:seed` now rejects empty, repeated or unsafe local persist targets,
  unknown arguments and remote requests before executing anything. `--dry-run`
  reports deterministic local fixture intent without subprocesses or state changes;
  composable `--json` emits one versioned plan/result with stable operation/check
  IDs, stage/count fields and fixed, sanitized errors with correction actions.
  No-flag local execution and idempotent fixture ordering are unchanged.
- #319: CSV snapshot exports now refuse predictable D1 query-budget exhaustion with
  503 `application/problem+json` (`snapshot-export-query-budget`) before CSV
  starts. The ETag prepass is bounded; both passes and their terminal empty
  reads must fit a 950-query allowance within the existing 1000-query Paid
  contract, reserving 50 queries of safety headroom. Review the existing
  `SNAPSHOT_EXPORT_PAGE_SIZE` guidance rather than retrying unchanged sizing.
  Admissible CSV bytes, ETags and 304 responses stay unchanged; unpredictable
  D1 faults and concurrent changes remain outside this admission guarantee.
- #318: Every mounted API operation now has a stable `operationId`, `x-access`
  bearer-role classification and `x-effect` data-effect classification. The
  mounted OpenAPI document includes an `x-agent-metadata` legend; privileged
  GETs are explicitly sync-secret-only and upstream POST reads are not
  advertised as writes. Authorization behavior and the docs-enabled gate
  are unchanged. Run `npm run check:openapi-agent-metadata` without credentials
  to check completeness against the mounted router and existing auth gates.

- The supported Node runtime moves from 22 (Maintenance LTS, security
  fixes until 2027-04-30) to 24 (Active LTS until 2026-10-20, maintenance
  until 2028-04-30): `.nvmrc` is `24`, `engines.node` is `>=24`, and
  every CI workflow (including the deploy job that runs `wrangler deploy`)
  sets up Node 24.
- #283: the `DELETE /api/v1/customer-snapshot/{customerId}` OpenAPI
  description (served at `/openapi.json` and `/docs`) and the docs now
  link the current `docs/R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched`
  anchor; the previous fragment no longer resolves to a section.
- Every `/api/v1/*` response with no handler-set `Cache-Control`
  now leaves with `Cache-Control: no-store` (stamped in `withCors` after the
  handler runs), so authenticated snapshot, export, health, readiness, gate
  401/429 and `notFound`/`onError` responses are never stored by a browser
  private cache. Handler-set values are preserved: data-entity reads keep
  `private, max-age=60` with their `ETag`, contained upstream errors keep
  `no-store`. Successful client-facing proxy responses replace upstream cache
  directives with `no-store`, including the sessionless login-page proxy.
  Preflight, `/openapi.json` and `/docs` are unchanged. Pinned in
  `test/cacheControlNoStore.test.ts`; policy recorded in
  `docs/cors-security-headers-audit.md`.
- The supported Node runtime moves from 20 (end of life
  2026-04-30, no more security fixes) to 22 (Maintenance LTS, security
  fixes until 2027-04-30): `.nvmrc` is `22`, `engines.node` is `>=22`, and
  every CI workflow (including the deploy job that runs `wrangler deploy`)
  sets up Node 22. `npm run check:ci-workflow` now fails when any workflow
  `node-version` or `engines.node` drifts from the `.nvmrc` major, or an
  `actions/setup-node` step pins neither; a `.nvmrc`-only change runs the
  full CI so that check sees it.
- Every successful per-customer detail-full D1 refresh now emits
  one `info` log line (`route: sync.detailFull`) with the customer id,
  address/container counts, computed D1 ops vs the 900-op budget, and cache
  invalidations vs the 950-invalidation cap, so operators can see budget
  headroom. Over-budget graphs still skip the D1 refresh fail-closed with no
  line emitted.
- Every `data-snapshot-sync` scheduled log line now carries a
  `runId` per-run correlation id: one `crypto.randomUUID()` minted at
  `scheduled()` entry, spread via the shared log base onto the
  success/failed/skipped-overlap/fallback-warning/persistence-failure lines
  and threaded through `SnapshotSyncRunOptions` into the orchestration skip
  lines and the R2-archive lines. On the chained path the id rides to each
  per-table sub-invocation on the `x-run-id` header (UUID-validated at the
  per-table routes; malformed values are dropped, never fail a sync), so one
  run's records correlate across invocations. Stable within a run, distinct
  across runs; a bare UUID, PII-free by construction. See
  `docs/CRON-SYNC-ALARM-RUNBOOK.md` §0 for the updated example shape.
- The per-customer detail-full D1 refresh no longer skips a graph
  for having more than 5,000 addresses or 40,000 containers. It skips only
  when the graph needs more than 900 D1 operations or more than 950 cache
  invalidations (one `caches.default.delete` per graph id: a single full-graph
  pass) in one request — the Cache API shares the Workers subrequest quota
  and caps at 1,000 calls per request, so the old caps would have admitted
  graphs that exhaust the quota mid-request. A retry pass is never reserved up
  front; the invalidation retry is best-effort from the calls left under the
  limit. Both budgets are checked before the first write so D1 is left
  untouched. The 8 MiB response cap still applies, and graphs within both
  budgets now refresh D1 in full.
  The three `POST /api/v1/data/*` handlers also harden their post-save cache
  eviction: an eviction failure after a successful upstream save is logged
  server-side and keeps the fixed `sync_failed` / `unknown_customer_id`
  outcome instead of rejecting the handler, and every posted id is attempted
  even when an earlier eviction throws.
- Customer snapshot DELETE records a D1 suppression marker atomically
  with the row deletion. The additive suppression migration prevents later
  customer upserts from re-inserting a marked row; FK-blocked deletes roll back
  the marker too. Suppressed address writes for a marked customer are skipped
  and recorded as id-only lineage so their container writes are skipped as
  well; other customers keep fail-closed foreign keys. Container suppression
  keys on that lineage alone, so an erased customer's containers cannot replay
  after a live-to-erased re-home, while an address re-homed to a live customer
  flows again once its stale lineage is cleared. A suppressed re-home into an
  erased customer also removes that address's existing containers at once, so
  the stale parent reconciles away on the next sync instead of failing the
  address-stage delete with a foreign-key error on every tick. Customers erased before this
  migration have no marker; backfill the marker plus FK-order row deletes with
  privileged `wrangler d1 execute` (a marker over re-inserted rows freezes them
  without removing them) and manage markers only via privileged SQL (see
  `docs/R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched`).
  This is local suppression, not upstream or R2 erasure. A
  whole-database restore can rewind markers and triggers; recovery must verify
  both and re-apply suppression before serving traffic. Application rollback
  retains the suppression schema and recorded markers. No live migration,
  deployment, archive deletion, or automatic marker expiry is included.

- A request waiting on a concurrent Routeware session refresh no
  longer succeeds with the failed holder's expired cookie. After an explicit
  failed release, one queued waiter may take over with a single bounded fresh
  login inside a 60-second window; remaining waiters fail fast with the
  existing 502 instead of waiting out the budget, and a hung holder still
  sees zero takeovers.
- The static-path report-fetch throw (`Report fetch failed: …`)
  is status-only again — upstream `statusText` (upstream-controlled free text
  that reaches the cron `error` log field via the `[step]` wrap) is no longer
  interpolated, matching the query-id door. No other `src/` throw embeds
  `statusText`; the `statusText` uses in `src/lib/cors.ts` and
  `src/lib/upstreamForward.ts` only preserve it on forwarded responses, never
  in thrown or logged messages.

- `DELETE /api/v1/customer-snapshot/{customerId}` and its docs
  (`docs/PROBLEMS.md`, `CUSTOMER_SNAPSHOT.md`, `docs/R2-RETENTION.md`) now
  state the erasure scope explicitly: removed = the D1 `customer_snapshot`
  row plus the data-entity cache entry; not removed = R2 history CSVs, daily
  aliases, latest pointers and the archived-CSV readback, and upstream
  Routeware; the row returns on the next sync while upstream still holds it;
  restores/imports of pre-erasure archives re-insert the row, D1 Time Travel
  keeps it recoverable, and only the `customer_snapshot` row goes (no
  address/container DELETE route — see `docs/R2-RESTORE-RUNBOOK.md` §§3/6 for
  the re-apply-erasures step). Pinned in `test/customerErasureScope.test.ts`.
  No behavior change.

- Snapshot CSV exports (`customer-snapshot`, `address-snapshot`,
  `container-snapshot` `/export`) read **1000 rows per D1 query** by default
  (was 500), and the optional plain-text `SNAPSHOT_EXPORT_PAGE_SIZE` Worker
  variable sets the rows per read for all three tables. Decimal integers 1–5000
  apply after surrounding whitespace is trimmed; any other set value (including an
  unquoted TOML number, which the runtime does not deliver as text) keeps 1000 and
  logs a warning; an unset variable keeps 1000 silently. Export bytes, ETags and `304` replies
  are unchanged at every page size. At the measured 388,735 container rows a
  full 200 download now costs 780 reads against the D1 1000-per-invocation cap
  (at 500 it needed 1,558 and the body truncated mid-stream); smaller pages can
  still exceed the budget on large tables even though memory stays bounded.

- R2 report archives now keep timestamp-and-UUID history CSVs with
  per-run integrity manifests; `snapshot-latest/<table>.json` points to the
  last fully published history object. Archive outcome `key` names history.
  Existing date-based CSV aliases, read/restore routes and daily manifests
  are preserved; a failed alias write is still a `failed` archive. The
  retention document proposes 30-day history expiry; this change enables no
  deletion or production lifecycle rule.

- Customer, address and container `/export` CSV escape formula-leading
  cells (`=`, `+`, `-`, `@` and their full-width or whitespace-hidden forms) with
  an apostrophe inside RFC 4180 quoting; plain numbers such as `-74.0060` are
  unchanged. Cells containing `;` or a tab are now quoted as well. Each export gains
  a `_shadow_csv_encoding` column before `synced_at` whose value is `1`; re-import
  removes the apostrophe only from marked rows, and unmarked uploads are untouched.
  A marked export is larger (21 header bytes, 2 bytes per row, plus escape and quote
  bytes), so an export within that margin of the unchanged 50 MiB import cap can
  now return 413 on direct re-import. The archived-CSV readback is re-encoded the
  same way. See CUSTOMER_SNAPSHOT.md.

- `GET /api/v1/snapshots/{table}/{date}` serves each archived Routeware CSV
  with the export's spreadsheet escaping and `_shadow_csv_encoding` marker (value `1`,
  after the archived columns on every row and in the header; LF row endings), so
  opening a readback in a spreadsheet cannot evaluate an upstream formula. Blank data
  records are dropped and cells trimmed as the importer's row parsers read them. Stored R2 objects
  and the sync input are unchanged. `Content-Length` and the quoted FNV-1a 64 ETag
  describe the served bytes; `If-None-Match` returns 304; a replacement during the
    download returns 409 `conflict`, and a deletion returns 404. A readback can be larger
  than the archive, so a direct re-import near the 50 MiB limit can return 413. See
  CUSTOMER_SNAPSHOT.md.

- A snapshot import body whose first header cell is wrong gets a
  400 bad-request that names the column the header row must start with
  (CustomerID, PickupAddressID or ContainerID) instead of the generic
  not-valid-CSV text. Status is unchanged.

- Snapshot import routes (`customer-snapshot`, `address-snapshot`, `container-snapshot` `/import`) return 415 `application/problem+json` (`unsupported-media-type`) unless `Content-Type` is `text/csv` or `application/octet-stream` (case-insensitive, parameters allowed). Clients that sent CSV with no or another Content-Type must send `text/csv` or `application/octet-stream`. The 415 is returned before the body is read or D1 is written, and never echoes submitted bytes.

- Throttle 429s include `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix seconds), and CORS
  exposes them to browser clients. Active blocks survive failure-window rollover;
  each further failed check during a block restarts its 60-second timer.

- Snapshot CSV imports reject NUL/control characters and lone CR
  cell content before D1 binding, with a PII-free row-numbered 400. Upstream
  report sync parsing stays permissive; earlier valid import batches may remain.

- Keep the Routeware-tier customer, address, and container save forms'
  modal token fetch and save POST on the same upstream session. Refresh before
  token preparation and re-prepare the original form once after a login rejection;
  do not replay timed-out saves or upstream 401/429 responses.

- Buffered upstream read/save, token-modal, and login bodies now
  have a separate `UPSTREAM_TIMEOUT_MS` deadline after headers arrive.
  Timeouts abort/cancel pending reads without replaying saves. Continuously
  ready body chunks yield to timer tasks so they cannot starve the deadline;
  successful passthrough bodies and long-running report CSV streams remain unchanged.

- Customer, address and container snapshot list `q` parameters now
  reject more than 100 Unicode code points with value-free 400 problem+json
  before D1 access. Accepted searches are not truncated; validation applies
  before whitespace trimming, with the same limit published in OpenAPI.

- Client-facing retry passthroughs replace upstream HTTP 400–599
  bodies, headers and status text with fixed `upstream-error` problem+json,
  preserving the HTTP status and containing possible customer/session data.
  Successful responses, login retry and internal data-save envelopes are unchanged.

- Readiness D1/R2 and advisory cron observations use a 20-second
  in-memory cache per Worker isolate; concurrent probes share two D1 queries.
  Authentication, report configuration, and the 200/503 payload are unchanged.

- `GET /api/v1/data-snapshot/orphans` orphan reconciliation report —
  defensive audit for legacy or out-of-band rows, not normal streamed syncs:
  D1 enforces the snapshot FK chain on writes and parent deletes. Returns
  `orphanAddresses` (address rows with no customer) and `orphanContainers`
  (container rows with no pickup address), each as a count plus ordered id
  sample from one read-only transaction (`sampleLimit` 1–500; invalid values
  return 400 `application/problem+json`). Snapshot-secret auth, read-only.
- HTTP login fails fast with 503 `misconfigured` when the runtime
  lacks `Headers.getSetCookie`, instead of silently collecting an empty cookie
  jar (which flipped `auto` mode to Browser Rendering or hard-outaged `http`
  mode).
- `GET /api/v1/customer-snapshot/changes` incremental-sync feed —
  rows with `synced_at > since` in `(synced_at, customer_id)` keyset order. A
  bare `since` replays every later run whole; chunked deltas page with the
  composite `since` + `since_id` cursor pair (served by the
  `idx_customer_snapshot_synced_at` index), so same-timestamp rows past a page
  boundary are never skipped.
- OpenAPI now includes synthetic request and response examples for
  snapshot, data-entity, and general Routeware operations. Proxy bodies remain
  unvalidated and existing runtime schemas are unchanged.
