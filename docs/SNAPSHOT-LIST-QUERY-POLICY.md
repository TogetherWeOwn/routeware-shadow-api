# Snapshot/data list query policy

## Unknown parameter names: documented ignore

The JSON snapshot list routes below **ignore unknown query parameter names**.
They validate only the named keys in their allowlists. For example,
`GET /api/v1/customer-snapshot?bogus_param=1` returns the same 200 JSON rows,
count and pagination cursor as the request without that parameter; the extra
name does not become a SQL filter or bind. This preserves the existing
`z.object(...)` query-schema behavior, rather than changing API compatibility.

| GET route | Recognized query keys | Unknown-name policy |
| --- | --- | --- |
| `/api/v1/customer-snapshot` | `customerId`, `ids`, `q`, `enabled`, `limit`, `offset`, `cursor`, `order`, `includeTotal`, `fields` | Ignore |
| `/api/v1/address-snapshot` | `customerId`, `pickupAddressId`, `ids`, `routeId`, `franchiseId`, `q`, `enabled`, `limit`, `offset`, `cursor`, `order`, `includeTotal`, `fields` | Ignore |
| `/api/v1/container-snapshot` | `customerId`, `pickupAddressId`, `containerId`, `ids`, `serialNumber`, `rfid`, `q`, `enabled`, `limit`, `offset`, `cursor`, `order`, `includeTotal`, `fields` | Ignore |
| `/api/v1/customer-snapshot/changes` | `since`, `since_id`, `limit`, `fields` | Ignore |

The changes feed is available only on revisions that register it. Its policy
is tested whenever present; the other three list routes are mandatory.

The three ordinary lists also accept `includeTotal=true|false` (default
`true`). With `includeTotal=false` the handler skips the `COUNT(*)` statement
entirely and answers `total: null` — null means the count was deliberately
not computed, not that the result set is empty. Rows, `nextCursor`, filters,
joins, ordering and limits are identical to the default page; only the count
query and the `total` value change. Any other `includeTotal` value (including
a repeated key) is a value-free 400 before any D1 access. Pinned by
`test/snapshotCountFreePagination.test.ts`.

**Ignoring a name is not ignoring an invalid value.** A known key such as
`limit=501` still returns 400 `application/problem+json` identifying `limit`,
before any D1 query. A typo such as `custmer_id` is ignored, so clients must use
the exact documented query names; this API does not detect those typos.

## Address route and franchise scopes

Only the address list recognizes `routeId` and `franchiseId`. Each is optional
and must appear once. `routeId` is an exact unpadded ASCII decimal safe integer
from `0` through `9007199254740991`; zero matches literal stored zero, never
an all-routes sentinel. `franchiseId` is an opaque case-sensitive exact string
of 1..100 Unicode code points. Leading zeros and nonblank whitespace remain
significant; blank/whitespace-only values are invalid. Repeated keys (including
percent-encoded aliases), invalid formats and overlength strings fail through
the existing value-free 400 hook after authentication and before D1.

Bound `route_id = ?` and `franchise_id = ?` predicates intersect by AND with
each other and with `customerId`, `pickupAddressId`, `q` and `enabled`. Nulls
do not match supplied scopes. No deduplication, joins, indexes or migrations
are added. Omitted scopes leave the old behavior intact. Valid no-match is
200 empty; fields only project the matched rows. Offset/seek ordering and
cursor-relative totals are unchanged; count-free mode still executes one
SELECT and no COUNT. Conditional ETags still describe the served envelope.

Next links retain the validated scopes using URLSearchParams encoding,
including opaque punctuation/whitespace; do not reconstruct or log scope
values while following them. Unrelated unknown keys keep list-ignore policy.
See the [synthetic scoped-page recipe](CONSUMER-QUICKSTART.md#address-route-and-franchise-scopes),
[fixed correction guidance](PROBLEMS.md#bad-request) and
[local query-plan evidence](SNAPSHOT-FILTER-EXPLAIN-AUDIT.md#address-scope-predicate-audit).
Run `npm run check:address-scope` for the hermetic local-D1 contract and relevant
list/link/conditional regressions; no live credentials or upstream calls.

## Exact container asset lookup

Only the existing container list accepts `serialNumber` and `rfid`. Each is a
single optional, case-sensitive opaque exact string of 1..100 Unicode code
points, not a number or substring. Leading zeros and nonblank whitespace are
preserved; no trimming, case folding or Unicode normalization occurs. Empty,
whitespace-only, repeated and overlength selectors receive a stable value-free
400 before D1: `Invalid request query (serialNumber). See docs/PROBLEMS.md#bad-request.`
(or the fixed `rfid` key). Correct the named selector and retry; do not log asset
identifiers. Quotes, `%` and `_` are literal bound data, never SQL/wildcards.

The selectors compose with AND with one another and every existing filter.
Stored nulls do not match; identifiers need not be unique. Counts and rows use
the same scope; `includeTotal=false` issues zero COUNT statements. Filtering
never changes canonical `container_id`, sparse fields or conditional JSON-read
semantics. Unknown keys remain ignored.

Synthetic fixture recipe (not a production request): seed matching containers
101, 104 and 105 locally, then request:

```text
GET /api/v1/container-snapshot?serialNumber=00123&rfid=RF-0007&fields=rfid&limit=1&includeTotal=false

{"rows":[{"container_id":101,"rfid":"RF-0007"}],"total":null,"nextCursor":101}
Link: </api/v1/container-snapshot?serialNumber=00123&rfid=RF-0007&fields=rfid&limit=1&includeTotal=false&cursor=101>; rel="next"
```

Follow the returned same-origin Link exactly rather than reconstructing it.
Both selectors are URL-encoded independently, including whitespace, quotes,
Unicode and delimiters. The next IDs in this fixture are 104, then 105, then
an empty terminal page; a full last page can still emit a continuation. With
counts enabled, totals remain cursor-relative. For a serial-only lookup omit
`rfid`; do not stop at the first duplicate match.

Run `npm run check:container-identifiers` for synthetic local-D1 lookup,
validation/auth precedence, composition, count, field, conditional-read and
followed-link checks. Network/R2/browser doubles deny unexpected access; a
read-only recorder and before/after fixture/schema comparison prove zero writes.
The suite executes `EXPLAIN QUERY PLAN` on emitted COUNT/row SELECTs with the
qualified customer/address join and bound `c.serial_number = ?` / `c.rfid = ?`
predicates. This demonstrates executable synthetic query shape only, not a
runtime latency improvement. No new indexes, migrations, bindings or upstream
requests are introduced.

## Mutating POST query keys are strict

The seven mutating snapshot POSTs do the opposite of the GET lists above:
any query key outside the route's declared set is a 400
`application/problem+json` before any D1, R2 or upstream work. A mistyped
`?dryrun=true` fails loudly instead of stripping to `{}` and running a real
mutation the caller never intended.

| POST route | Declared query keys | Unknown-name policy |
| --- | --- | --- |
| `/api/v1/data-snapshot/sync` | `dryRun`, `partialProgress` | Reject (400) |
| `/api/v1/customer-snapshot/sync` | `dryRun` | Reject (400) |
| `/api/v1/address-snapshot/sync` | `dryRun` | Reject (400) |
| `/api/v1/container-snapshot/sync` | `dryRun` | Reject (400) |
| `/api/v1/customer-snapshot/import` | `dryRun` | Reject (400) |
| `/api/v1/address-snapshot/import` | `dryRun` | Reject (400) |
| `/api/v1/container-snapshot/import` | `dryRun` | Reject (400) |

One shared guard (`rejectUnknownSnapshotPostQuery` in `src/routes/shared.ts`)
serves all seven routes, immediately after the sync-secret gates and before
any other check. Sync-secret 401 precedence is preserved (an API-token bearer
with a typo'd key keeps the 401), while invalid values such as `?dryRun=maybe`
and repeated known keys keep their existing validator-first 400. The 400
carries fixed allowed-keys guidance and never echoes submitted keys or values:

```text
POST /api/v1/customer-snapshot/import?dryrun=true

{"type":"https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request",
 "title":"Bad Request","status":400,
 "detail":"Unknown query parameter. Allowed query parameters: dryRun. See docs/PROBLEMS.md#bad-request."}
```

Operator recovery is a corrected retry — fix the spelling to the exact
documented key (`partialProgress` exists only on the combined route) and
re-send:

```text
POST /api/v1/customer-snapshot/import?dryRun=true   # dry-run: validates, writes nothing
POST /api/v1/customer-snapshot/import               # no flags: runs for real
```

See [bad-request correction guidance](PROBLEMS.md#bad-request). Pinned by
`test/snapshotPostStrictQuery.acceptance.test.ts`. The GET-list ignore
behavior above and its ratchet stay byte-identical; this policy changes no
list route.

Run the focused hermetic check (synthetic local D1, unexpected outbound fetch
fails, no network):

```bash
npx vitest run test/snapshotPostStrictQuery.acceptance.test.ts \
  test/snapshotListUnknownParams.test.ts test/snapshotDryRun.test.ts \
  test/combinedSyncPartialProgress.acceptance.test.ts test/snapshotAuth.test.ts
```

## Primary-ID direction (`order=`)

The three ordinary lists accept one exact, case-sensitive `order=asc|desc`.
Omitted order and explicit `asc` retain ascending primary-ID order; `desc`
starts at the highest primary ID and seeks strictly below `cursor`. ID order
is not chronological recency. No arbitrary sort column or expression is accepted.
Empty, repeated, whitespace-padded and other values return the existing
value-free 400 after authentication and before any D1 work; correct the key
to one lowercase `asc` or `desc`, or omit it for `asc`.

Keep `order` with `nextCursor`: changing direction starts a new traversal.
Cursor takes precedence over offset in either direction. Filters, joins,
`fields` and `includeTotal=false` compose unchanged. When counted, `total`
is the matching count **after the cursor predicate**, before limit/offset,
not an invariant full-table count. A full page returns its last primary ID
as integer `nextCursor` even when terminal; a subsequent empty page returns
`null`. Partial pages also return `null`. There is no lookahead or extra
COUNT, and no consistency guarantee across concurrent writes. This does not
change the changes feed, by-id reads or CSV exports.

Run `npm run check:snapshot-order` for the focused credential-free regression
using synthetic local D1 fixtures with unexpected outbound fetch denied.
See the [synthetic continuation examples](CONSUMER-QUICKSTART.md#highest-primary-ids-first).

## Sparse fieldsets (`fields=`)

The three ordinary lists, their by-id reads and the customer changes feed
accept an optional `fields=` comma-separated selector that trims each row to
exactly the requested stored columns plus the resource id. Omit `fields`
for full rows. The id is always present even when omitted from the selector;
naming it explicitly is not a duplicate. Lists keep the
`{rows, total, nextCursor}` envelope — only each row's keys shrink — and
`fields=` composes with filters, pagination and ordinary-list
`includeTotal=false` without changing matches, counts or cursors.
The customer changes feed computes membership, order, page-length `total`
and the composite cursor from full rows **before** projection, even when
`fields` omits `synced_at`. This does not add `includeTotal` to changes.
The selectable set is the canonical per-resource allowlist in
`src/lib/sparseFieldsets.ts` (the route's `SELECT` columns, nothing else).
Hydrated `/api/v1/data/*` reads honor flat `fields=` root-only, plus
per-type `fields[customer]` / `fields[address]` / `fields[container]`
selectors that project the listed type everywhere it appears (root and
relations) while omitted types stay full, and reject any other query key
(see below). Flat `fields` plus `fields[<root>]` together, and unknown
`fields[TYPE]` keys, are value-free 400s. CSV exports still ignore `fields=`.

The selector is strict: exact column names, no spaces, no empty segments,
no duplicates, and a single `fields` key. Anything else is the existing
value-free anchored 400 before any D1 work. Synthetic example:

```text
GET /api/v1/customer-snapshot?fields=company_name,phone1&limit=1

{"rows":[{"customer_id":9101,"company_name":"synthetic-fields-co-9101","phone1":"555-9101"}],"total":1,"nextCursor":null}
```

Synthetic two-page customer changes example (three rows share the first
page's boundary timestamp; unselected phone/comments are not returned):

```text
GET /api/v1/customer-snapshot/changes?limit=3&fields=company_name
{"rows":[{"customer_id":8751,"company_name":"Synthetic company 8751"},{"customer_id":8752,"company_name":"Synthetic company 8752"},{"customer_id":8754,"company_name":"Synthetic company 8754"}],"total":3,"nextCursor":{"since":"2026-09-01T00:00:00.000Z","since_id":8754}}

GET /api/v1/customer-snapshot/changes?limit=3&fields=company_name&since=2026-09-01T00%3A00%3A00.000Z&since_id=8754
{"rows":[{"customer_id":8753,"company_name":"Synthetic company 8753"},{"customer_id":8750,"company_name":"Synthetic company 8750"}],"total":2,"nextCursor":null}
```

Keep the selector when following both cursor halves. Full and sparse pages
have the same IDs, total and cursor; no `synced_at` response key is needed
to resume. A full terminal page still emits a maybe-more cursor, so continue
until `nextCursor` is null. The feed remains upserts-only, not deletion CDC
or historical isolation; auth, `no-store` and unrelated unknown-key ignore
behavior are unchanged.

Focused hermetic valid-selection, rejection, auth and cursor regressions:

```sh
npx vitest run test/customerChangesFields.acceptance.test.ts test/sparseFieldsets.acceptance.test.ts test/openapiContract.test.ts --maxWorkers=2
npm run check:customer-changes-cursor
```

No live replay or upstream calls.

## Bounded primary-ID selection (`ids=`)

The three ordinary lists accept an optional `ids=` selector that restricts
the page to a bounded set of primary IDs (`customer_id`,
`pickup_address_id`, `container_id` respectively). A request that previously
carried an ignored `ids` now filters on these three lists only; by-id
reads, CSV exports and the changes feed still ignore `ids` as an unknown
name.

The selector is strict: 1 to 50 distinct canonical ASCII positive
safe-integer decimals (unpadded digits, at most `9007199254740991`),
comma-separated, with no whitespace, signs, fractions, exponents, empty
segments, duplicate IDs or coercion, and a single `ids` key. Anything else
is the existing value-free anchored 400 before any D1 work. Selection
AND-composes with the singular/relationship filters, `enabled`, `q`,
`fields`, `includeTotal` and cursor/offset paging; result order is the
existing primary-key order regardless of selector order, selected IDs with
no row simply do not match, and the `{rows, total, nextCursor}` envelope is
unchanged. Synthetic example:

```text
GET /api/v1/customer-snapshot?ids=9105,9101,9103&limit=2

{"rows":[{"customer_id":9101,...},{"customer_id":9103,...}],"total":3,"nextCursor":9103}
```

The second page replays the selector with the cursor:
`GET /api/v1/customer-snapshot?ids=9105,9101,9103&limit=2&cursor=9103`
returns the remaining row with `total: 3` and `nextCursor: null`.

Run `npx vitest run test/snapshotIdSelection.acceptance.test.ts` for the
focused selection, rejection, pagination-composition and SQL/bind-parity
regressions. No live replay.

## Hydrated entity reads are strict

The three hydrated single-entity GETs do the opposite of the GET lists
above: any query key outside the route's declared set is a 400
`application/problem+json` before any cache or D1 work. A mistyped
`?field=` fails loudly instead of stripping to a full PII bundle the caller
tried to trim.

| GET route | Declared query keys | Unknown-name policy |
| --- | --- | --- |
| `/api/v1/data/customer` | `id`, `customerId`, `ids`, `fields`, `fields[customer]`, `fields[address]`, `fields[container]` | Reject (400) |
| `/api/v1/data/address` | `id`, `pickupAddressId`, `ids`, `fields`, `fields[customer]`, `fields[address]`, `fields[container]` | Reject (400) |
| `/api/v1/data/container` | `id`, `containerId`, `ids`, `fields`, `fields[customer]`, `fields[address]`, `fields[container]` | Reject (400) |

Route validators run before handlers and may return 400 for invalid values
such as `?fields=bogus` or repeated known keys. After validation succeeds,
one shared guard (`rejectUnknownQueryKeys` in `src/routes/shared.ts`, with
`allowed-only` guidance) serves all three routes after the sync-secret gate
and before handler-level ID parsing, cache, or D1 work. The POST saves share
the guard but retain their existing key-name guidance. Sync-secret 401
precedence is preserved (a bad bearer with a typo'd key keeps the 401). The
unknown-key 400 carries fixed allowed-keys guidance and never echoes
submitted keys or values:

```text
GET /api/v1/data/customer?id=94101&field=company_name

{"type":"https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request",
 "title":"Bad Request","status":400,
 "detail":"Invalid request query (fields selectors). Unknown query parameter. Allowed query parameters: id, customerId, ids, fields, fields[customer], fields[address], fields[container]. See docs/PROBLEMS.md#bad-request."}
```

Operator recovery is a corrected retry — fix the spelling to the exact
documented key and re-send:

```text
GET /api/v1/data/customer?id=94101&fields=company_name   # projected root only
GET /api/v1/data/customer?id=94101                       # omitted selector: full bundle
```

See [bad-request correction guidance](PROBLEMS.md#bad-request). Pinned by
`test/hydratedReadStrictQuery.acceptance.test.ts`. The GET-list ignore
behavior above and its ratchet stay byte-identical; this policy changes no
list route.

Run the focused hermetic check (synthetic local D1, unexpected outbound fetch
fails, no network):

```bash
npx vitest run test/hydratedReadStrictQuery.acceptance.test.ts \
  test/hydratedFields.acceptance.test.ts test/hydratedReadIds.acceptance.test.ts \
  test/entityDataCache.test.ts test/snapshotListUnknownParams.test.ts \
  test/snapshotAuth.test.ts test/dataEntityEtagRoundTrip.test.ts
```

## Customer changes cursor validation

`GET /api/v1/customer-snapshot/changes` validates the cursor before D1:

- `since` keeps the UTC `Z` datetime contract. Seconds and 1–3 fraction digits
  normalize to the stored millisecond representation; more than three digits
  is invalid, including trailing zero digits. No rounding, truncation or
  timezone-offset conversion is accepted.
- `since_id` requires nonempty valid `since` and canonical ASCII decimal text:
  `0` or an unpadded positive integer through `9007199254740991`. No signs,
  whitespace, fractions, exponent or prefix coercion. Repeated `since` or
  `since_id` keys are invalid rather than selecting an arbitrary value.
- Omitted/empty `since` without `since_id` retains initial-page behavior.
  Bare `since` is strict-greater-than whole-run replay; both cursor fields
  resume a page in `(synced_at, customer_id)` order without dropping ties.

Invalid known values/pairs return the existing value-free anchored
400 `application/problem+json`, after read-role authentication and before any
D1 work. See [bad-request correction guidance](PROBLEMS.md#bad-request).
Unknown parameter names remain ignored; no ordinary-list policy changes.
The [snapshot guidance](../CUSTOMER_SNAPSHOT.md#customer-changes-cursor)
contains a synthetic tie-resume example and response conventions.

Run `npm run check:customer-changes-cursor` for the focused synthetic-local-D1
precision, pair, multi-page, auth and header regressions. No live replay.

### Composite follow-next links

Every successful changes page with non-null `nextCursor` also advertises
`Link: <relative-target>; rel="next"`. The fixed path is
`/api/v1/customer-snapshot/changes`; `URLSearchParams` encodes the returned
`since` and `since_id` pair, the validated effective `limit` (default 50)
and, when requested, the validated `fields` selector, so sparse traversal
keeps sparse pages. Both cursor halves replace the previous boundary
together, including when starting with bare/omitted `since`. No unknown key,
request origin, forwarded host, credential or arbitrary path is copied.
This feed recognizes optional `fields` (sparse projection after cursor
derivation; omit for full rows) but not `until`, which keeps the existing
unknown-name ignore policy. The ordinary-list helper and its integer cursor
contract are unchanged.

A full terminal page can link to an empty page; short/empty pages have null
cursors and no Link. Error responses have no Link. Omission means stop.
JSON bytes/shape, `(synced_at, customer_id)` membership/order, composite cursor,
`total` (returned page length), SQL/binds and the one-query budget are unchanged.
No COUNT or lookahead is added, and this is not a completeness or snapshot-isolation
promise across concurrent writes. Read-token auth, auth-before-D1, no-store,
request ID and all existing CORS-exposed headers (including Link) are retained.
Mounted OpenAPI declares the optional string header on `listCustomerSnapshotChanges`.

Run `npm run check:customer-changes-next-links` for the focused hermetic D1
traversal, unchanged wire/SQL goldens and executable-doc safety checks. Fixtures
prove zero application writes and fail on any unexpected outbound fetch.
See the [synthetic follow-next recipe](CONSUMER-QUICKSTART.md#2c-follow-the-composite-next-link).
Normal `npm test`/CI runs both the HTTP and published-recipe oracles.

## Coverage boundary and non-list classifications

`test/snapshotListUnknownParams.test.ts` discovers GET routes from the mounted
`app.routes` registry independently of the policy table. It includes every
`/api/v1/` route whose first path segment contains `snapshot`, plus `/api/v1/data`
and all its descendants. `ALL` registrations are included because they can
also serve GET requests. Registration duplicates from validators/handlers are
deduplicated. Parameterized routes are **not** blanket-exempted; middleware in
these namespaces likewise needs an explicit classification rather than an
automatic exemption.

These exact GET routes are explicitly classified as non-list operations:

- `/api/v1/customer-snapshot/:customerId`,
  `/api/v1/address-snapshot/:pickupAddressId`,
  `/api/v1/container-snapshot/:containerId`: one row by primary key.
- `/api/v1/customer-snapshot/export`, `/api/v1/address-snapshot/export`,
  `/api/v1/container-snapshot/export`: full CSV downloads, not paginated JSON lists.
- `/api/v1/data/customer`, `/api/v1/data/address`, `/api/v1/data/container`:
  single-entity aggregate reads selected by id, not collection list endpoints.
- `/api/v1/data-snapshot/orphans`: integrity-audit report with per-edge counts
  and bounded id samples, not a paginated row collection. `sampleLimit` bounds
  diagnostic samples; there is no offset, continuation cursor or page of rows.
- `/api/v1/snapshots/:table/:date`: one archived CSV object, not an archive list.

These classifications **do not declare unknown-key behavior for non-list
operations**. A new GET in the covered namespaces, including a subpath or a
parameterized collection, fails the inventory check until it receives an
explicit list policy and behavioral probe, or a justified exact non-list
classification. If a new list uses a different namespace, extend discovery
alongside its registration. No automatic default policy is assigned.

## Verification

```bash
npm test -- test/snapshotListUnknownParams.test.ts
```

For each registered list, the sweep compares requests with and without
`bogus_param=1`: same status, nonempty synthetic row payload, total, cursor,
and exact recorded D1 SQL/binds. Ordinary lists cover bare requests, filtered
offset pagination, and seek pagination; the changes feed covers bare requests
and its timestamp/id cursor. Invalid-known-key controls ensure the validator
still rejects bad values without D1 work. Outbound fetch throws, and write
recordings must remain empty; no tenant data or live deployment is used.

The inventory's negative controls register additional test-only GET lists at
new snapshot/data roots, subpaths and parameterized paths, plus a GET-capable
`ALL` list, and prove that the same coverage check rejects them. The real app
registry is not mutated.

Sources: [Hono testing with env bindings](https://hono.dev/docs/guides/testing#passing-env-variables),
[Vitest 4 table-driven tests](https://v4.vitest.dev/api/#test-each),
and the existing route schemas in `src/routes/*Snapshot.ts`.
