# Changelog

Per-release notes for consumer-visible changes. `package.json#version` is
the single source of truth — see `docs/VERSIONING.md` for the bump policy.

## [Unreleased]

- #379: Customer changes feed accepts an optional `until` inclusive upper
  bound (`synced_at <= until`) for finite caller-chosen time windows. Both
  endpoints share one lossless UTC `Z`/millisecond contract: seconds or 1–3
  fraction digits normalize before comparison, while empty, repeated,
  calendar-invalid, offset and overprecise bounds — plus normalized `since`
  past `until` — fail with the existing value-free 400 before D1, after
  read-role authentication. `since == until` stays valid for composite
  resume; legacy empty-`since` semantics, ordering, limits, page-length
  totals, maybe-more cursors and cursor-before-projection derivation are
  unchanged, as are omitted-bound SQL/binds/JSON/Link bytes. Follow-next
  Links retain the normalized bound; unknown keys stay ignored. Current-row
  upserts only: overwrites can move rows outside the window and bulk imports
  advance timestamps, with no delete events, versions, isolation or
  completeness promise. No index or migration. See the synthetic bounded
  two-page recipe and focused check in `docs/CONSUMER-QUICKSTART.md` and
  `docs/SNAPSHOT-LIST-QUERY-POLICY.md`.
- #350: Three ordinary snapshot lists (`GET
  /api/v1/customer|address|container-snapshot`) accept an optional `upperId=`
  caller-held inclusive ceiling: only rows whose resource primary key is at or
  below the cap are listed and counted. The caller retains the cap unchanged
  across pages, so higher-ID arrivals cannot extend the traversal; an ascending
  cursor at or above the cap yields an empty page with cursor-relative totals.
  Descending traversals retain the same inclusive cap while seeking lower IDs.
  The cap composes with all filters, `q`, `enabled`, `fields=`, offset/cursor
  and `includeTotal=false`, is preserved verbatim in `Link` next targets, needs
  no migration or index, and omission preserves existing behavior with no `MAX`
  query. Values are one canonical unpadded ASCII decimal integer from `1` to
  `9007199254740991`; anything else is a value-free 400 before D1, after
  read-role authentication. Numeric IDs are not timestamps: inserts below the
  ceiling, updates and deletions remain visible, with no snapshot isolation,
  exact-once or watermark promises. Synthetic resume example:
  `docs/SNAPSHOT-LIST-QUERY-POLICY.md`; focused check:
  `npm run check:snapshot-upper-id`.
- #361: Exact external account lookup on the existing customer snapshot list: optional
  `customerNumber` and `subCustomerNumber` use bound, case-sensitive equality and
  AND-compose with existing filters. Opaque strings preserve zeros and nonblank
  whitespace; invalid or repeated values fail before D1. Duplicate business
  numbers return all matches, and next-page Links retain both selectors. No new
  index, uniqueness assumption, upstream call or count-free COUNT query. See
  `docs/CONSUMER-QUICKSTART.md` for the synthetic lookup-to-next-page recipe.
- #351: Hydrated single-ID
  `GET /api/v1/data/customer|address|container` accepts optional per-type
  `fields[customer]`, `fields[address]` and `fields[container]` selectors from
  the shared snapshot allowlists, projecting the listed type everywhere it
  appears — root and nested relations — while omitted types stay full and
  every projected object retains its primary ID. Flat `fields=` keeps its
  root-only meaning and composes with non-root typed keys; flat plus
  `fields[<root>]` together, unknown `fields[TYPE]` keys and malformed
  selectors are value-free 400s before cache/D1 access, with existing auth
  precedence. Projected ETags hash served bytes per typed combination with
  empty-body 304s, never reusing full-only validators or overwriting the
  canonical full cache. Composes with the #339 batch `ids` contract (batch
  entries stay full; `ids` plus any field selector is a 400); no
  nested-path selectors, SQL optimization or TTL changes. Synthetic examples
  and validator guidance: `docs/CONSUMER-QUICKSTART.md` and
  `docs/ENTITY-DATA-CACHE.md`.
- #339: `GET /api/v1/data/customer|address|container` accept one comma-separated
  `ids` list of 1 to 50 canonical positive decimal safe-integer IDs for
  single-round-trip detail hydration. Every entry is validated before any read;
  any malformed or empty entry, mixing `ids` with `id`/alias, or more than 50
  ids fails the whole request with the fixed value-free 400 and zero
  handler/cache/D1 work. The 200 body is `{entries}` in request order — found
  entries carry the single-GET bundle, missing ids are exactly
  `{id, found: false}` — sent `no-store` with no ETag. Single-id behavior, auth
  ordering and single-GET ETag/304 are unchanged. `ids` is a declared key under
  the #357 strict-query guard. Documented in
  `docs/CONSUMER-QUICKSTART.md` and `docs/PROBLEMS.md`; pinned by
  `test/batchHydratedReadIds.acceptance.test.ts`.
- #358: New `GET /api/v1/snapshots/{table}` lists newest-first archived dates
  for `customer|address|container` from the per-day manifest sidecars, each
  entry carrying `{date, bytes, sha256}` (hashes/sizes only, never row data).
  Strict `limit` 1..366 (default 30) over a 366-manifest scan budget, with
  `truncated: true` when the budget exhausts; zero archives is HTTP 200 with
  an empty list, never 404. Same sync-secret gate and 401 precedence as the
  date route, fixed 503 when SNAPSHOTS is unbound, sanitized fixed 500s on R2
  or manifest failures, and content-hash ETags with empty-body 304s. No
  lifecycle, CSV, binding or auth changes. Recipe: `docs/CONSUMER-QUICKSTART.md` §3b.

- #360: Entity-save outcomes: served OpenAPI now types the customer/address/container
  save envelopes and shared done-discriminated `localSync` with fixed failure
  codes. Synthetic examples distinguish refreshed graphs, accepted writes with
  failed/skipped refresh, upstream rejection even on HTTP 200, and the existing
  validation-only dry-run envelope. Exact 400/401/502/503 and default error
  responses distinguish forwarded JSON outcomes from local problem+json
  failures. Read `dryRun`, `ok` and `localSync` separately;
  never blindly replay ambiguous creates. Runtime
  payloads/statuses, forwarding, auth and cache behavior are unchanged.
  See `docs/CONSUMER-QUICKSTART.md` for recovery guidance and the hermetic
  schema-vs-runtime check.

- #363: Container snapshot lists accept optional `serialNumber` and `rfid` exact,
  case-sensitive filters (1..100 Unicode code points). Opaque values retain
  leading zeros and nonblank whitespace; invalid/repeated selectors return
  value-free 400s before D1. Filters compose with AND, preserve duplicate matches
  and travel in encoded next-page links. Existing count-free, sparse and
  conditional reads are preserved. Local read-only D1 only; no schema/index,
  upstream or auth changes. Synthetic lookup recipe and focused check:
  `docs/SNAPSHOT-LIST-QUERY-POLICY.md`.

- #357: Hydrated single-ID `GET /api/v1/data/customer|address|container` now
  rejects unknown query keys with a value-free 400 before cache/D1 work.
  Allowed keys are `id`, the route alias and `fields`; the guidance is fixed
  and never echoes submitted keys or values. Sync-secret 401 precedence,
  repeated-key/invalid-value validator 400s, ETags, cache behavior and the
  list routes are unchanged. Typo-to-retry example:
  `docs/SNAPSHOT-LIST-QUERY-POLICY.md`.

- #362: `GET /api/v1/address-snapshot` accepts exact `routeId` and opaque,
  case-sensitive `franchiseId` scopes, intersected by AND with existing filters.
  Route zero is literal; franchise leading zeros and nonblank whitespace are
  significant (1..100 Unicode code points). Invalid/repeated scopes reject
  before D1 with value-free guidance. Next links preserve encoded scopes;
  pagination, projection, count-free and conditional reads remain compatible.
  No new endpoint, index, migration, access or write behavior. Synthetic recipe:
  `npm run check:address-scope` and `docs/CONSUMER-QUICKSTART.md`.

- Follow-up to #343: Customer changes-feed GET now returns optional `Link: <relative-target>; rel="next"`
  exactly when its composite `nextCursor` is non-null. The fixed-path target
  replaces `since` and `since_id` together and retains the validated effective
  limit, without reflecting unknown keys, origins or credentials. JSON bytes,
  SQL/binds and query counts are unchanged; a full terminal page can link to
  an empty page. Existing CORS exposure includes Link; mounted OpenAPI and
  the consumer quickstart document the contract and safe synthetic traversal.
  Check: `npm run check:customer-changes-next-links`.

- #356: `POST /api/v1/data/address` and `POST /api/v1/data/container`
  creates (posted id 0/absent, upstream ok) now answer HTTP 201 with the
  resolved `pickupAddressId` / `containerId`: upstream
  `data.PickupAddressID` / `data.ContainerID` first, else the singleton
  post-refresh D1 id (address ids for the owning customer, container ids
  for the owning address). Without an upstream id, the id stays `null` when
  that diff is empty, ambiguous (0 or 2+ new ids), or unavailable (unknown
  owner or failed baseline/refresh). Updates keep echoing the posted id with
  200; failed saves, customer saves and `localSync` codes are unchanged.
  There is deliberately no `Location` header: the by-id snapshot URL may
  not exist locally when the refresh fails. OpenAPI documents the 201/200
  split with resolved-id examples; dry-run saves echo posted ids, live
  creates resolve or return `null`, and live updates echo case-exact posted
  ids. See `docs/CONSUMER-QUICKSTART.md`.
- #354: `GET /api/v1/snapshots/{table}/latest` streams the newest R2-archived
  snapshot CSV for one table without naming its date, resolving the existing
  `snapshot-latest/{table}.json` pointer the sync leg republishes after every
  archive. Same sync-secret gate and 401 precedence, same spreadsheet-safe
  re-encode (byte-identical to the explicit-date download, same content-hash
  ETag with empty-body 304s, `{table}-latest.csv` filename). A missing pointer
  or CSV is a fixed table-only 404; an unreadable pointer is a fixed sanitized
  500. The `{date}` route is unchanged. See `docs/CONSUMER-QUICKSTART.md` and
  `docs/R2-RETENTION.md`.
- #352: `GET /api/v1/customer|address|container-snapshot` accepts an optional
  `ids` selector restricting the page to 1–50 distinct canonical ASCII
  positive safe-integer primary IDs (unpadded digits through
  `9007199254740991`; no whitespace, signs, fractions, exponents, empty
  segments, duplicates or repeated keys). One shared parser validates all
  three lists; each selected ID travels as a bound `IN` placeholder on the
  page and COUNT statements with identical predicates and binds.
  Selection AND-composes with singular/relationship filters, `enabled`, `q`,
  `fields`, `includeTotal` and cursor/offset paging; result order and the
  `{rows, total, nextCursor}` envelope are unchanged, missing IDs simply do
  not match, and `includeTotal=false` still issues zero COUNTs. Invalid
  selectors are value-free 400s before any D1 work with existing auth
  precedence. Requests that previously carried an ignored `ids` on these
  three lists now filter by it; by-id reads, CSV exports and the changes
  feed still ignore `ids`. Next-page `Link` targets retain the canonical
  selection as a single `ids` key. Synthetic examples and the focused command:
  `docs/SNAPSHOT-LIST-QUERY-POLICY.md`.
  Hydrated and CSV conditional reads now split validator lists only outside
  quoted tags, preventing false 304s for a different tag containing the current
  hash or `*` between commas. Bare tags and lowercase weak prefixes remain
  supported on those legacy reads; strict snapshot-list syntax is unchanged.

- #364: Customer changes feed accepts optional strict `fields` from the shared customer
  allowlist, always retaining `customer_id`. Only response-row keys shrink:
  page membership, order, page-length `total` and composite `nextCursor` remain
  unchanged even when `synced_at` is omitted. Invalid selectors fail before D1
  with value-free guidance; absent fields preserves full rows. The shared OpenAPI
  `x-snapshot-fieldset` catalog also applies to this feed. The composite
  follow-next Link retains the validated selector so sparse traversal keeps
  sparse pages; an omitted selector keeps the three-key target. See the synthetic
  two-page example and focused check in `docs/SNAPSHOT-LIST-QUERY-POLICY.md`.

- #353: The seven mutating snapshot POSTs (combined sync, three per-table
  syncs, three imports) now reject any query key outside their declared set
  (`dryRun` everywhere, plus `partialProgress` on the combined route) with a
  fixed value-free 400 before any D1, R2 or upstream work. A mistyped
  `?dryrun=true` fails loudly instead of running a real mutation. Sync-secret
  401 precedence is preserved; invalid values and repeated known keys keep
  their existing validator 400s. GET lists keep ignoring unknown names. See
  `docs/SNAPSHOT-LIST-QUERY-POLICY.md` and `docs/PROBLEMS.md#bad-request`.

- #355: `POST /api/v1/data/customer|address|container` accept `?dryRun=true`
  to validate a save — form fields plus session health — without persisting
  anything: no upstream POST, no D1 write, no cache invalidation, no login. A
  dry-pass answers HTTP 200 with `dryRun: true`, `routewareStatus: null`,
  `upstreamBytes: 0`, posted ids only and `localSync.not_attempted`;
  validation failures return the identical 400/502 shapes as live. Without a
  usable session the dry-run fails closed with 503 `failed-precondition`.
  Only `dryRun` is an allowed query key (anything else is a value-free 400
  after authentication);
  an omitted flag or `?dryRun=false` writes exactly as before. Recipe:
  `docs/CONSUMER-QUICKSTART.md`; problem pointers: `docs/PROBLEMS.md`.

- #349: Every save-path error line in the customer, address and container
  flows now carries the once-per-request `requestId` adopted from inbound
  `X-Request-Id` or minted as a UUID (#338): data-tier local-sync and
  fallback-eviction failures, routeware refresh and invalidation failures,
  and save token-preparation failures. One header value joins a save attempt
  to its server-side failure lines and outcome code. Route-level response
  bodies are unchanged (header correlation only); valid saves emit no new
  lines. See `docs/LOGGING.md`.

- Follow-up to #333 and #342: mounted OpenAPI `fields` string schemas on the
  six flat snapshot list/by-id reads and three hydrated single-ID reads now
  publish `x-snapshot-fieldset` v1: registry-derived selectable names, mandatory
  identity, delimiter and strict parser rules. Agents can choose valid selectors
  without reading records or making invalid trial requests. Projection, omission
  and auth behavior are unchanged; unsupported routes gain no parameter.
  See `docs/CONSUMER-QUICKSTART.md` and the credential-free
  `npm run check:snapshot-fieldset-discovery` check.

- #348: A rejected Workers `Cache.match` lookup in the shared entity-read
  cache helper now counts as one miss and continues through the existing D1
  bundle/ETag path, so customer, address and container reads keep their
  normal 200, empty-body conditional 304 and 404 contract during a cache
  outage instead of failing as 500s. Each rejected lookup emits one bounded
  `cache.entityData` warn diagnostic (entity kind and error classification
  only) alongside the usual count-only miss event. No TTL/policy change, no
  retry, no stale or remote fallback; cache population stays best-effort and
  delete/graph invalidation failures stay loud. Troubleshooting:
  `docs/ENTITY-DATA-CACHE.md` and `docs/LOGGING.md`.

- #345: Post-deploy probe adds composable `--json` (schema version 1, fixed check IDs,
  bounded allowlisted diagnostics) and effect-free `--dry-run` plans. Authenticated
  plan checks stay unresolved; valid plans are not health evidence. Only explicit
  boolean `checks.cron.stale` is fresh/stale; malformed present cron fails closed,
  while absent legacy cron remains advisory. No raw body/error/cron metadata is
  printed. Redirects are refused and no retries are added. Output is bounded,
  not response-body buffering. Existing scheduled-target and missing-token gates
  remain. See `docs/SCHEDULED-PROBE.md` for hermetic agent checks and limits.
- #344: Snapshot customer, address and container lists accept exact `order=asc|desc`
  (default `asc`). `desc` starts at the highest primary ID and seeks below
  `cursor`; IDs do not promise chronological recency. Direction composes with
  filters, `fields`, `includeTotal=false`, cursor-over-offset precedence and
  follow-next targets. Keep order with the cursor; changing direction starts
  a new traversal.
  No endpoint or migration added. Check: `npm run check:snapshot-order`.

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
