# Changelog

Per-release notes for consumer-visible changes. `package.json#version` is
the single source of truth — see `docs/VERSIONING.md` for the bump policy.

## [Unreleased]

- TOG-21964: Customer snapshot DELETE records a D1 suppression marker atomically
  with the row deletion. The additive suppression migration prevents later
  customer upserts from re-inserting a marked row; FK-blocked deletes roll back
  the marker too. This is local suppression, not upstream or R2 erasure. A
  whole-database restore can rewind markers and triggers; recovery must verify
  both and re-apply suppression before serving traffic. Application rollback
  retains the suppression schema and recorded markers. No live migration,
  deployment, archive deletion, or automatic marker expiry is included.

- TOG-18119: A request waiting on a concurrent Routeware session refresh no
  longer succeeds with the failed holder's expired cookie. After an explicit
  failed release, one queued waiter may take over with a single bounded fresh
  login inside a 60-second window; remaining waiters fail fast with the
  existing 502 instead of waiting out the budget, and a hung holder still
  sees zero takeovers.
- TOG-19015: The static-path report-fetch throw (`Report fetch failed: …`)
  is status-only again — upstream `statusText` (upstream-controlled free text
  that reaches the cron `error` log field via the `[step]` wrap) is no longer
  interpolated, matching the query-id door. No other `src/` throw embeds
  `statusText`; the `statusText` uses in `src/lib/cors.ts` and
  `src/lib/upstreamForward.ts` only preserve it on forwarded responses, never
  in thrown or logged messages.

- TOG-18933: `DELETE /api/v1/customer-snapshot/{customerId}` and its docs
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

- TOG-9231: Snapshot CSV exports (`customer-snapshot`, `address-snapshot`,
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

- TOG-5832: R2 report archives now keep timestamp-and-UUID history CSVs with
  per-run integrity manifests; `snapshot-latest/<table>.json` points to the
  last fully published history object. Archive outcome `key` names history.
  Existing date-based CSV aliases, read/restore routes and daily manifests
  are preserved; a failed alias write is still a `failed` archive. The
  retention document proposes 30-day history expiry; this change enables no
  deletion or production lifecycle rule.

- TOG-8894: Customer, address and container `/export` CSV escape formula-leading
  cells (`=`, `+`, `-`, `@` and their full-width or whitespace-hidden forms) with
  an apostrophe inside RFC 4180 quoting; plain numbers such as `-74.0060` are
  unchanged. Cells containing `;` or a tab are now quoted as well. Each export gains
  a `_shadow_csv_encoding` column before `synced_at` whose value is `1`; re-import
  removes the apostrophe only from marked rows, and unmarked uploads are untouched.
  A marked export is larger (21 header bytes, 2 bytes per row, plus escape and quote
  bytes), so an export within that margin of the unchanged 50 MiB import cap can
  now return 413 on direct re-import. The archived-CSV readback is re-encoded the
  same way (TOG-18829). See CUSTOMER_SNAPSHOT.md.

- TOG-18829: `GET /api/v1/snapshots/{table}/{date}` serves each archived Routeware CSV
  with the export's spreadsheet escaping and `_shadow_csv_encoding` marker (value `1`,
  after the archived columns on every row and in the header; LF row endings), so
  opening a readback in a spreadsheet cannot evaluate an upstream formula. Blank data
  records are dropped and cells trimmed as the importer's row parsers read them. Stored R2 objects
  and the sync input are unchanged. `Content-Length` and the quoted FNV-1a 64 ETag
  describe the served bytes; `If-None-Match` returns 304; a replacement during the
    download returns 409 `conflict`, and a deletion returns 404. A readback can be larger
  than the archive, so a direct re-import near the 50 MiB limit can return 413. See
  CUSTOMER_SNAPSHOT.md.

- TOG-7595: A snapshot import body whose first header cell is wrong gets a
  400 bad-request that names the column the header row must start with
  (CustomerID, PickupAddressID or ContainerID) instead of the generic
  not-valid-CSV text. Status is unchanged.

- TOG-9219: Snapshot import routes (`customer-snapshot`, `address-snapshot`, `container-snapshot` `/import`) return 415 `application/problem+json` (`unsupported-media-type`) unless `Content-Type` is `text/csv` or `application/octet-stream` (case-insensitive, parameters allowed). Clients that sent CSV with no or another Content-Type must send `text/csv` or `application/octet-stream`. The 415 is returned before the body is read or D1 is written, and never echoes submitted bytes.

- TOG-8375: Throttle 429s include `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix seconds), and CORS
  exposes them to browser clients. Active blocks survive failure-window rollover;
  each further failed check during a block restarts its 60-second timer.

- TOG-8895: Snapshot CSV imports reject NUL/control characters and lone CR
  cell content before D1 binding, with a PII-free row-numbered 400. Upstream
  report sync parsing stays permissive; earlier valid import batches may remain.

- TOG-6516: Keep the Routeware-tier customer, address, and container save forms'
  modal token fetch and save POST on the same upstream session. Refresh before
  token preparation and re-prepare the original form once after a login rejection;
  do not replay timed-out saves or upstream 401/429 responses.

- TOG-18135: Buffered upstream read/save, token-modal, and login bodies now
  have a separate `UPSTREAM_TIMEOUT_MS` deadline after headers arrive.
  Timeouts abort/cancel pending reads without replaying saves. Continuously
  ready body chunks yield to timer tasks so they cannot starve the deadline;
  successful passthrough bodies and long-running report CSV streams remain unchanged.

- TOG-6517: Customer, address and container snapshot list `q` parameters now
  reject more than 100 Unicode code points with value-free 400 problem+json
  before D1 access. Accepted searches are not truncated; validation applies
  before whitespace trimming, with the same limit published in OpenAPI.

- TOG-7577: Client-facing retry passthroughs replace upstream HTTP 400–599
  bodies, headers and status text with fixed `upstream-error` problem+json,
  preserving the HTTP status and containing possible customer/session data.
  Successful responses, login retry and internal data-save envelopes are unchanged.

- TOG-9232: Readiness D1/R2 and advisory cron observations use a 20-second
  in-memory cache per Worker isolate; concurrent probes share two D1 queries.
  Authentication, report configuration, and the 200/503 payload are unchanged.

- TOG-5814: `GET /api/v1/data-snapshot/orphans` orphan reconciliation report —
  defensive audit for legacy or out-of-band rows, not normal streamed syncs:
  D1 enforces the snapshot FK chain on writes and parent deletes. Returns
  `orphanAddresses` (address rows with no customer) and `orphanContainers`
  (container rows with no pickup address), each as a count plus ordered id
  sample from one read-only transaction (`sampleLimit` 1–500; invalid values
  return 400 `application/problem+json`). Snapshot-secret auth, read-only.
- TOG-6537: HTTP login fails fast with 503 `misconfigured` when the runtime
  lacks `Headers.getSetCookie`, instead of silently collecting an empty cookie
  jar (which flipped `auto` mode to Browser Rendering or hard-outaged `http`
  mode).
- TOG-8877: `GET /api/v1/customer-snapshot/changes` incremental-sync feed —
  rows with `synced_at > since` in `(synced_at, customer_id)` keyset order. A
  bare `since` replays every later run whole; chunked deltas page with the
  composite `since` + `since_id` cursor pair (served by the
  `idx_customer_snapshot_synced_at` index), so same-timestamp rows past a page
  boundary are never skipped.
- TOG-8372: OpenAPI now includes synthetic request and response examples for
  snapshot, data-entity, and general Routeware operations. Proxy bodies remain
  unvalidated and existing runtime schemas are unchanged.

## [1.0.0] - 2026-09-27

Initial release of the Routeware Shadow API (Cloudflare Worker): shadow
health, Routeware account/customer/report proxies, customer/address/container
snapshots with sync and import, data-entity reads and writes, and the
versioned OpenAPI document at `GET /openapi.json`.

- TOG-5840: `openapi.json` `info.version` is now wired to
  `package.json#version` (via `src/lib/version.ts`) instead of a hardcoded
  `1.0.0`, so consumers can tell releases apart. Added
  `docs/VERSIONING.md` (bump policy) and this changelog.
