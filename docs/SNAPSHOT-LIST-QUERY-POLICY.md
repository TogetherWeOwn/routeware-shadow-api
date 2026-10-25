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
| `/api/v1/customer-snapshot` | `customerId`, `ids`, `customerNumber`, `subCustomerNumber`, `q`, `phone`, `comments`, `enabled`, `hasAddresses`, `limit`, `offset`, `cursor`, `upperId`, `order`, `includeTotal`, `fields` | Ignore |
| `/api/v1/address-snapshot` | `customerId`, `pickupAddressId`, `ids`, `routeId`, `franchiseId`, `zip`, `city`, `state`, `q`, `enabled`, `hasContainers`, `limit`, `offset`, `cursor`, `upperId`, `order`, `includeTotal`, `fields` | Ignore |
| `/api/v1/container-snapshot` | `customerId`, `pickupAddressId`, `containerId`, `ids`, `serialNumber`, `rfid`, `materialStream`, `color`, `zip`, `q`, `enabled`, `limit`, `offset`, `cursor`, `upperId`, `order`, `includeTotal`, `fields` | Ignore |
| `/api/v1/customer-snapshot/changes` | `since`, `since_id`, `limit`, `fields` | Ignore |

## Customer address presence

Only the ordinary customer list recognizes `hasAddresses=true|false|any`.
`true` keeps customers with at least one stored address sharing their
`customer_id`; `false` keeps those with none. Omission/`any` adds no predicate.
Every stored address counts, including disabled children; customer `enabled`
remains independent. No mirrored address is **not proof of no upstream site**
and never authorizes deletion, reconciliation or a sync.

Send one exact case-sensitive supported value, or omit the selector and retry.
Empty, unknown or repeated values return value-free `application/problem+json`
400 after authentication and before D1, including conditional requests.
The correlated `EXISTS`/`NOT EXISTS` over the existing child `customer_id`
index never joins/expands parents or returns child payloads. It shares the
COUNT/page WHERE and binds, AND-composing with IDs, business numbers, `q`,
`phone`, `enabled`, `upperId`, cursor/offset and either order. Count-free mode
still runs one SELECT and zero COUNTs. Canonical `customer_id`, sparse fields,
cursor-relative totals and exact-representation ETag/304 semantics are unchanged.
Validated true/false travel in relative next Links; any/default and unknown
keys do not. A full terminal page may link to an empty page; concurrent writes
are not snapshot-isolated.

Run `npm run check:customer-address-presence`; the independent
`test/customerAddressPresence.acceptance.test.ts` uses synthetic local D1,
forbids fetch/R2 and verifies complete bidirectional traversal, no duplicate
parents and child-index SEARCH plans for both COUNT and rows. This is local
planner evidence, not a production latency claim. No migration/index change.
GET is an idempotent local-read operation; CLI `--dry-run` is N/A. See the
[local recipe](CONSUMER-QUICKSTART.md#customer-address-presence) and
[correction guidance](PROBLEMS.md#customer-address-presence-bad-request).

## Address container presence

Only the address list recognizes `hasContainers`, an optional mirrored-child
presence selector: `true` keeps only addresses with at least one stored
container row sharing their `pickup_address_id`, `false` keeps only addresses
with none, and `any` (the default when omitted) adds no predicate. Presence is
a correlated `EXISTS` over the child's existing `pickup_address_id` index — no
join, no per-row lookup, no child payload — and counts every stored child
including disabled containers. Address `enabled` stays an independent filter.
`false` means no currently mirrored child: it is not proof the upstream site
is empty, and not authorization to delete or reconcile anything.

The enum is exact and case-sensitive; invalid, blank or repeated keys fail
with the existing value-free 400 after authentication and before D1. The
predicate AND-composes with `customerId`, `pickupAddressId`, `ids`, `routeId`,
`franchiseId`, `q`, `enabled` and the cursor in both COUNT and page SQL, with
unchanged cursor-relative totals, offset/seek behavior, count-free zero-COUNT
mode, sparse fieldsets and conditional reads. Filtering values round-trip in
continuation Links; `any`/omitted leaves continuations unchanged. See the
[synthetic present/absent recipe](CONSUMER-QUICKSTART.md#address-container-presence),
[fixed correction guidance](PROBLEMS.md#bad-request) and
[local query-plan evidence](SNAPSHOT-FILTER-EXPLAIN-AUDIT.md#address-container-presence-predicate-audit).
Pinned by `test/addressContainerPresence.acceptance.test.ts`; run
`npm run check:address-container-presence` for the hermetic local-D1 contract
and relevant list/link/conditional regressions, with no live credentials or
upstream calls.

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

## Exact customer account numbers

Only the ordinary customer list recognizes `customerNumber` and
`subCustomerNumber`. Each is an optional exact, case-sensitive opaque string:
1..100 Unicode code points, including at least one non-whitespace character,
with a single occurrence of the key. Leading zeros and all supplied nonblank
whitespace are preserved. No numeric coercion, case folding, trimming or Unicode
normalization occurs; literal quotes, `%` and `_` are data, not SQL or wildcards.
Empty, whitespace-only, repeated and overlength values return the existing
value-free 400 before D1 or conditional 304 success; authentication remains first.
See [fixed correction guidance](PROBLEMS.md#bad-request).

Both selectors use bound SQL equality, AND-composed with each other and every
existing selector. Stored nulls never match strings. Business numbers are not
unique: all matching customer IDs are returned across pages, and zero matches is
an HTTP 200 empty collection. Sparse fields, offset/keyset conventions,
cursor-relative totals, count-free zero-COUNT behavior, ETags and no-store remain
unchanged. Continuation Links retain both selectors using URLSearchParams
encoding and still replace cursor/drop offset. Unknown unrelated keys remain
ignored. Other lists and the changes feed do not gain these selectors.

Run `npm run check:customer-account-filters` for the focused acceptance and list
regressions, with real local test D1, synthetic fixtures and forbidden outbound
fetch/R2 access. The [consumer recipe](CONSUMER-QUICKSTART.md#exact-external-account-lookup)
walks an exact lookup to its empty terminal page. Synthetic equality-query
`EXPLAIN QUERY PLAN` reports `SCAN customer_snapshot` for both COUNT and page
reads on the 23-row fixture; no account-number index or production latency claim
is made. No new index, migration or binding is introduced.

## Stored customer comment fragment

Only the ordinary customer list recognizes `comments`: a literal substring
of stored `customer_snapshot.comments`. Use `q` for company-name search,
`phone` for stored phone text, and `comments` for mirrored notes; `q` is not
widened. All selectors intersect by AND, including `hasAddresses` and IDs.

Send one fragment of at most 100 Unicode code points **before trimming**
boundary whitespace. A bounded blank fragment is omitted. Repeated keys and
overlength input (even blank or padded input) return value-free
`application/problem+json` 400 after authentication and before any D1 work
or 304. Send one fragment within the limit, or omit comments and retry; see
[fixed correction guidance](PROBLEMS.md#stored-customer-comment-fragment-bad-request).
Never log the fragment, credentials or unrelated unknown query keys.

Both page and COUNT share `instr(lower(coalesce(comments, '')), lower(?)) > 0`
and the same bound fragment. SQLite folds ASCII A-Z only; non-ASCII case,
Unicode composition, quotes, `%` and `_` remain literal. Null comments never
match a nonblank fragment; stored text is not normalized. No dedicated index
or migration is added: substring-only reads may scan, with no latency claim.
Count-free mode still executes zero COUNTs. Canonical IDs, sparse fields,
representation ETags/304 and both pagination directions remain unchanged.
Relative next Links retain only the validated, trimmed fragment, omitting
blank and unrelated unknown keys; cursor replaces offset and preserves upperId.
Concurrent writes are not snapshot-isolated; a full terminal page may link to
an empty page. This GET is idempotent and local-read; `--dry-run` is N/A.

Run `npm run check:customer-comments-search` for the independent synthetic
local-D1 oracle and focused list/auth/discovery regressions. No live token,
upstream request, R2 access or cache write is required. See the
[synthetic lookup recipe](CONSUMER-QUICKSTART.md#stored-customer-comment-fragment).

## Stored phone fragment

Only the ordinary customer list recognizes `phone`. It is an optional
ASCII case-insensitive substring of 1..100 Unicode code points, never blank,
with a single occurrence of the key. The fragment matches stored text as
stored: SQLite `lower()` folds ASCII A-Z only, so non-ASCII case variants
(é vs É) match only on exact case; no normalization, digit-stripping,
trimming or other case folding, so formatting variance across sources is
matched literally. Quotes, `%`, `_` and URL delimiters are data, never SQL or
wildcards. Empty, whitespace-only, repeated and overlength values return the
existing value-free 400 before D1 or conditional 304 success; authentication
remains first. See [fixed correction guidance](PROBLEMS.md#bad-request).

The predicate is one bound value bound twice across both stored columns —
`(instr(lower(coalesce(phone1,'')), lower(?)) > 0 OR
instr(lower(coalesce(phone2,'')), lower(?)) > 0)` — AND-composed with
`customerId`, `q`, `enabled` and every other selector. Stored nulls and empty
strings never match. A row matching both columns is returned once; zero
matches is an HTTP 200 empty collection. Sparse fields, offset/keyset
conventions, cursor-relative totals, count-free zero-COUNT behavior, ETags
and no-store remain unchanged. Continuation Links retain the selector using
URLSearchParams encoding and still replace cursor/drop offset. Unknown
unrelated keys remain ignored. Other lists and the changes feed do not gain
this selector.

Run `npm run check:customer-phone-search` for the focused acceptance and
list regressions, with real local test D1, synthetic fixtures and forbidden
outbound fetch/R2 access. The [consumer recipe](CONSUMER-QUICKSTART.md#stored-phone-fragment-lookup)
walks a fragment lookup to its empty terminal page. Synthetic
`EXPLAIN QUERY PLAN` reports `SCAN customer_snapshot` for the fragment-only
SELECT and COUNT shapes; the same honest substring-scan boundary as `q`-alone
(see [predicate audit](SNAPSHOT-FILTER-EXPLAIN-AUDIT.md#stored-phone-predicate-audit)).
No new index, migration or binding is introduced.

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

## Exact stored address ZIP

On the address list, `zip` is an optional exact,
case-sensitive opaque string of 1..100 Unicode code points over the stored
`zip` column — not a number, prefix or substring. Leading zeros (for example
`02139`) and nonblank whitespace are preserved; no trimming, case folding,
digit coercion or Unicode normalization occurs. Empty, whitespace-only,
repeated (including percent-encoded aliases) and overlength values return the
existing value-free 400 naming `zip` before D1, after authentication. See
[fixed correction guidance](PROBLEMS.md#bad-request).

One bound `zip = ?` equality is applied on the single-table path,
AND-composed with `customerId`, `pickupAddressId`, `routeId`, `franchiseId`,
`q`, `enabled` and the cursor in both the page `SELECT` and the `COUNT`.
Stored nulls never match a supplied value; omission preserves current
behavior. No new index or migration is introduced: the existing
`idx_address_snapshot_zip` is eligible, and local `EXPLAIN QUERY PLAN`
reports `SEARCH ... idx_address_snapshot_zip (zip=?)` for ZIP-only reads —
a local plan observation, not a deployed-plan or latency claim. Substring
postcode semantics belong to the address `q` search below; this selector is
exact equality and composes AND with it.

Next links retain the validated ZIP using URLSearchParams encoding; do not
reconstruct or log ZIP values while following them. Canonical
`pickup_address_id` rows, offset/seek ordering, cursor-relative totals,
count-free zero-COUNT behavior, sparse fields and conditional ETags are
unchanged. Unrelated unknown keys keep list-ignore policy. See the
[synthetic ZIP-page recipe](CONSUMER-QUICKSTART.md#exact-stored-address-zip)
and [local query-plan evidence](SNAPSHOT-FILTER-EXPLAIN-AUDIT.md#exact-stored-address-zip-predicate-audit).
Run `npm run check:address-zip` for the hermetic local-D1 contract and
relevant list/link/conditional/auth/OpenAPI regressions; no live credentials
or upstream calls.

## Exact stored address city and state

Only the address list recognizes `city` and `state`. Each is optional and
independent: one exact, case-sensitive opaque string of 1..100 Unicode code
points with at least one non-whitespace character. Nonblank whitespace,
punctuation and Unicode spelling remain significant; no trimming, numeric
coercion, abbreviation conversion, enum or geographic inference occurs.
Empty, whitespace-only, repeated (including encoded duplicate keys) and
overlength values return the existing value-free 400 after authentication
and before D1 or a conditional 304. URL-encode one nonblank value for each
intended selector and retry; see [correction guidance](PROBLEMS.md#bad-request).

Bound `city = ?` and `state = ?` predicates AND-compose with each other,
`zip`, `routeId`, `franchiseId`, `customerId`, `pickupAddressId`, `ids`, `q`,
`enabled`, `hasContainers` and cursor/`upperId` bounds. Page and COUNT share
the same predicates and binds. Omission changes nothing; stored nulls never
match supplied strings, and valid no-match returns 200 empty. The existing
`q` still searches street/city/zip substrings, not state or exact locality.

City/state-only equality may scan without a dedicated index; no index,
migration or performance claim is added. This GET is idempotent/local-read,
not an upstream lookup or write; CLI `--dry-run` is N/A. Canonical IDs,
sparse fields, offset/seek in either direction, cursor-relative totals,
count-free zero-COUNT mode and representation ETags/304 remain unchanged.
Next Links retain both validated values with URLSearchParams encoding,
including significant whitespace and punctuation, and still replace cursor
and drop offset without copying unknown keys or raw URLs.

Run `npm run check:address-city-state` for the protected real local-D1
acceptance oracle and neighboring contracts. The
[encoded consumer recipe](CONSUMER-QUICKSTART.md#exact-stored-address-city-and-state)
uses synthetic values only, with no live credentials or network probes.

## Address street or locality search

Only the address list searches `q` across three columns. The existing `q` is a
single optional literal substring, trimmed before matching: a row matches when
the street (`address`), `city` or `zip` contains the needle, ASCII
case-insensitively. SQLite `lower()` preserves non-ASCII case distinctions:
`q=åbc` does not match `ÅBC`, while `q=Åbc` does. Empty and whitespace-only `q`
behave exactly as omitted. Raw input over 100 Unicode code points (measured
before trimming) or a repeated `q` key returns the existing value-free 400
after authentication and before D1. Quotes, `%`, `_`, backslashes and Unicode are literal bound
data, never `LIKE` wildcards; postcodes stay opaque text with significant
leading zeros. No state search, full-address parser, numeric conversion,
geocoding or postal/geographic expansion is performed: locality `q` is not an
exact postal or geographic scope filter.

The match is one parenthesized three-column OR, AND-composed with
`customerId`, `pickupAddressId`, `ids`, `routeId`, `franchiseId`, `zip`, `enabled`
and cursor/ceiling predicates by the shared WHERE join. Null and empty
locality columns match nothing on their own legs. One row per
`pickup_address_id`, ordering, offset/seek, cursor-relative counted totals,
count-free zero-COUNT behavior, sparse projection and conditional ETags are
unchanged; omitted `q` preserves old behavior. Continuation Links carry the
trimmed needle with the same encoding as every other preserved selector.

Query count is unchanged (one COUNT plus one SELECT, or one SELECT
count-free). `q` alone still scans — `instr()` substring legs cannot seek a
B-tree — while composed shapes keep their existing index plans
(`test/snapshotTextFilterIndexes.test.ts` pins both). No join, index,
migration or lookahead query is added. See the
[synthetic follow-next recipe](CONSUMER-QUICKSTART.md#address-street-or-locality-search)
and [fixed correction guidance](PROBLEMS.md#bad-request). Run
`npm run check:address-locality` for the hermetic local-D1 contract, the
SQL/bind/EXPLAIN oracles and relevant list/link/validation regressions; no
live credentials, upstream calls or production-performance claims.

## Stored container locality

The existing container list accepts optional `zip`: exact, case-sensitive
opaque equality against **`c.zip`**, never the linked address ZIP. It has the
same 1..100 Unicode-code-point, nonblank, no-normalization contract as address
ZIP above. Leading zeros and supplied nonblank whitespace are significant;
null does not match. Empty/blank/repeated/overlength keys reject value-free
before D1 (after auth); correct `zip`, URL-encode one value and retry.

`q` is a trimmed literal substring across `c.location_address`,
`c.serial_number`, `c.city` OR `c.zip`, in one parenthesized group with four
identical binds. It retains the raw 100-code-point limit, blank-as-omitted and
SQLite ASCII-case semantics; `%`, `_`, quotes and Unicode remain literal.
No state search, parent fallback, full-address concatenation, nearby-postcode
expansion or live geolocation occurs. `zip=02139` is exact while `q=021`
can match a substring in any searched column; they intersect, not substitute.

Both locality predicates AND-compose with customer/address/container/`ids`,
asset identifiers, enabled and cursor/upperId scopes in shared COUNT/page
SQL. Only `customerId` adds the existing parent join. Canonical IDs, sparse
fields, asc/desc offset/seek traversal and final-envelope ETag/304 rereads
remain intact. Count-free reads run one SELECT and zero COUNTs. Next Links
preserve validated exact ZIP and trimmed q (omit blank q), same-origin and
relative; follow them unchanged. Duplicate localities are not collapsed.

No new index or migration: unscoped ZIP and substring locality reads scan;
existing enabled/ID scopes can still support seeks. Synthetic local D1
EXPLAIN oracles prove executable shapes, not production performance.
GET is idempotent/local-read with no upstream/R2 access; CLI `--dry-run` is
not applicable. Run `npm run check:container-locality` for independent fixtures,
auth/validation, SQL/binds/EXPLAIN, links, conditional reads and discovery.
See the [synthetic follow-next recipe](CONSUMER-QUICKSTART.md#stored-container-locality).

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

## Exact stored container labels

Only the existing container list accepts optional `materialStream` and `color`.
`materialStream` binds `c.ud_material_stream_ud = ?`; `color` binds
`c.color = ?`. These are case-sensitive opaque stored labels, not inferred
recycling categories or a defined vocabulary. Each must contain 1..100 Unicode
code points and a non-whitespace character. Leading zeros, significant
whitespace, punctuation and Unicode composition are preserved exactly;
quotes, `%` and `_` are literal data, not SQL or wildcards. Null never matches
a supplied string. Valid unknown labels return an empty 200.

URL-encode one supported-length nonblank stored label per key, or omit the
selector and retry if no label scope is intended. Empty, whitespace-only,
overlength and repeated keys fail with the existing value-free
`application/problem+json` bad-request after authentication and before D1.
See [correction guidance](PROBLEMS.md#exact-stored-container-labels-bad-request).

Both selectors AND-compose with each other and all existing filters on the
joined and unjoined paths. COUNT and page queries share the same bound scope;
duplicates are retained and paginated. `includeTotal=false` executes zero
COUNTs. IDs, sparse projection, `upperId`, asc/desc seeks and representation
ETags retain their existing contracts. Response/`fields` uses the stored name
`ud_material_stream_ud`, not query name `materialStream`.

Synthetic local fixture example (IDs 101, 104, 105 have both labels):

```text
GET /api/v1/container-snapshot?materialStream=001&color=Blue&fields=ud_material_stream_ud,color&limit=1&includeTotal=false

{"rows":[{"container_id":101,"ud_material_stream_ud":"001","color":"Blue"}],"total":null,"nextCursor":101}
Link: </api/v1/container-snapshot?materialStream=001&color=Blue&fields=ud_material_stream_ud%2Ccolor&limit=1&includeTotal=false&cursor=101>; rel="next"
```

Follow the returned same-origin Link unchanged through 104, 105 and the empty
terminal page. Validated selectors round-trip encoded, including reserved
characters and significant whitespace; raw origins, credentials and unknown
keys are never copied. Omission preserves the unfiltered behavior.

Run `npm run check:container-labels` for a hermetic local-D1 recipe including
literal labels, malformed/auth zero-work checks, both join paths, count-free
pagination, sparse fields, ETags and followed links. Equality queries may scan;
no new index/migration or performance claim is made. GET is an idempotent
local-read with no upstream, R2, browser or write work; CLI `--dry-run` is N/A.

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

## Caller-held upper bound (`upperId=`)

The three ordinary lists accept an optional `upperId=` inclusive ceiling:
only rows whose resource primary key (`customer_id`, `pickup_address_id`,
`container_id`) is at or below the cap are listed and counted. The caller
supplies the cap explicitly and retains it unchanged across pages, so
higher-ID arrivals after the first page cannot extend the traversal beyond
its chosen scope. An ascending cursor at or above the cap yields an empty
page, not a validation error; totals keep existing cursor-relative semantics.
With `order=desc`, the same inclusive ceiling applies while the cursor seeks
strictly below its ID: a cursor above the cap may still return capped rows,
and a cursor equal to the cap excludes that ID but can return lower IDs.
Next targets retain both the ceiling and the explicitly supplied direction.

The cap composes with every existing singular/relationship filter, `q`,
`enabled`, sparse `fields=`, offset or cursor pagination and
`includeTotal=false`: the bound `<= ?` predicate is in both the page
`SELECT` and the `COUNT`, with no `MAX` query, migration or index. Unknown
parameter names stay ignored, and omission preserves existing behavior.
When the page is non-terminal, the `Link` next target preserves the same
`upperId=` ceiling verbatim, so following the server's link cannot escape
the chosen scope; an uncapped page's next target carries no `upperId`.

Validation is strict and shared (`src/lib/snapshotUpperId.ts`): one
canonical unpadded ASCII decimal integer from `1` to `9007199254740991` —
no signs, whitespace, fractions, exponents or prefixes, and a single
`upperId` key. Anything else (including an empty value or a repeated key,
even percent-encoded) is the existing value-free 400 naming `upperId`
before any D1 work, after read-role authentication. See
[bad-request correction guidance](PROBLEMS.md#bad-request).

Numeric IDs are not timestamps: inserts below the ceiling remain visible,
and updates and deletions can change later pages, while deleted rows are
omitted from the current snapshot lists. The bound promises neither
snapshot isolation, exact-once delivery nor automatic watermark
discovery. Synthetic resume with an explicitly supplied cap:

```text
GET /api/v1/customer-snapshot?upperId=6&limit=2

{"rows":[{"customer_id":2,...},{"customer_id":4,...}],"total":3,"nextCursor":4}

# customer_id=10 arrives here; the caller resumes with the same cap:

GET /api/v1/customer-snapshot?upperId=6&cursor=4&limit=2

{"rows":[{"customer_id":6,...}],"total":1,"nextCursor":null}
```

Run `npm run check:snapshot-upper-id` for the focused synthetic-local-D1
validation, resume, composition, discovery and header regressions. No live
replay.

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
