# Problem types

Errors from the Routeware Shadow API use [RFC 7807](https://datatracker.ietf.org/doc/html/rfc7807)
`application/problem+json` bodies. Each `type` is a URL that points to the matching
section below.

| Slug (`type` anchor) | HTTP status | Meaning |
|----------------------|-------------|---------|
| `bad-request` | 400 | <a name="bad-request"></a>The request was malformed — a missing/invalid id, an empty body where one is required, an invalid `fields=` sparse-fieldset selector, an unknown query key on a hydrated entity read, disallowed CSV control characters, a snapshot row with a dangling foreign key, an unknown query key on a mutating snapshot POST, or an unexpected query key on a data-entity save (only `dryRun` is allowed; see below). |
| `unauthorized` | 401 | <a name="unauthorized"></a>Missing or invalid `Authorization: Bearer <token>`. See below. |
| `forbidden` | 404 | <a name="forbidden"></a>A feature is disabled by configuration (e.g. OpenAPI docs when `OPENAPI_DOCS_ENABLED` is not `true`). Returned as 404 to avoid advertising the surface. |
| `not-found` | 404 | <a name="not-found"></a>No matching route, or no snapshot row/graph for the requested id. |
| `method-not-allowed` | 405 | <a name="method-not-allowed"></a>The upstream does not support the HTTP method (e.g. customer hard delete). |
| `rate-limited` | 429 | <a name="rate-limited"></a>Too many failed bearer-auth attempts from one IP. See below. |
| `payload-too-large` | 413 | <a name="payload-too-large"></a>A `...-snapshot/import` body exceeds the size limit. See below. |
| `unsupported-media-type` | 415 | <a name="unsupported-media-type"></a>A snapshot import does not declare a supported CSV media type. See below. |
| `conflict` | 409 | <a name="conflict"></a>The snapshot archive changed while a readback was being read. Retry the download. See below. |
| `misconfigured` | 503 | <a name="misconfigured"></a>A required var/secret or report path is not set on the Worker. |
| `snapshot-export-query-budget` | 503 | The snapshot export cannot fit its reserved D1 query allowance. See the page-sizing remedy below. |
| `failed-precondition` | 503 | <a name="failed-precondition"></a>A save dry-run has no usable Routeware session to validate against, and dry runs never log in. Establish a session with a live request first. See below. |
| `bad-gateway` | 502 | <a name="bad-gateway"></a>The Worker could not complete an upstream step (e.g. anti-forgery token preparation). |
| `upstream-error` | 400–599 (upstream status) | A client-facing retry passthrough received an upstream error; its body and headers are withheld. |
| `internal` | 500 | <a name="internal"></a>An unexpected error. Only a fixed summary is logged (`Unhandled request error`) with the error class as `kind`; the exception text and stack are neither logged nor returned. |

## Exact next-page flag (`bad-request`)

On the three ordinary snapshot list GETs, send `exactNext=true` to opt in or
`exactNext=false` (the default) to keep legacy pagination. Supply the key once,
using those exact case-sensitive strings, with no surrounding whitespace.
Empty, other or repeated values fail with the value-free detail
`Invalid request query (exactNext). See docs/PROBLEMS.md#bad-request.`
after authentication and before any D1 read, including conditional requests.
Correct the named key or omit it, then retry; never put credentials in queries.
See the [query contract](SNAPSHOT-LIST-QUERY-POLICY.md#exact-next-page-signal-opt-in).

## Snapshot count-only (`bad-request`)

On the three ordinary flat snapshot list GETs, send `countOnly` once as exact
lowercase `true` or `false`, or omit it for normal pages. Blank, invalid and
repeated values fail after auth with a value-free 400 before D1. All other
known query parameters still validate; count-only does not forgive invalid
fields/filters even with `If-None-Match: *`.

`countOnly=true&includeTotal=false` is contradictory. **Omit
`includeTotal=false` or set `countOnly=false` and retry.** Responses name
fields, never submitted values; no row-payload query or COUNT runs on rejection.
See the [mode comparison](SNAPSHOT-LIST-QUERY-POLICY.md#count-only-inspection).

## Opt-in list query keys (`bad-request`)

Only the three ordinary flat snapshot lists accept `strictQuery=true|false`
(default false). With `true`, any decoded query name outside the mounted
resource's schema returns 400 after authentication and before D1 or 304.
The problem has only type/title/status/detail, with fixed detail:

```text
Unknown query parameter. Use supported query names from this mounted OpenAPI operation, remove unknown keys, or set strictQuery=false. See docs/PROBLEMS.md#bad-request.
```

Use supported names from that operation's OpenAPI parameters, remove unknown
keys, or deliberately set `strictQuery=false`. Submitted names/values never
appear in this problem or app logs. Empty, invalid or repeated strictQuery
(including encoded duplicates and mixed true/false) instead fails normal
value-free query validation; send one exact lowercase true or false, or omit
it. Known invalid controls remain invalid in either mode. Validated true is
retained in relative continuation Links; false/default is omitted. Other
operations retain their own existing query policies. See the
[local synthetic recipe](CONSUMER-QUICKSTART.md#opt-in-query-typo-detection).

## Hydrated read IDs (`bad-request`)

For `GET /api/v1/data/customer|address|container`, supply `id` or the route's
existing `customerId` / `pickupAddressId` / `containerId` alias. Every supplied
value must be canonical positive decimal text (`^[1-9][0-9]*$`) between `1`
and `9007199254740991`. Correct the source producing whitespace, leading zeros,
signs, fractions, exponent/hex notation or out-of-range values; do not silently
coerce malformed user text into another row's ID. If both spellings are valid,
`id` wins even if they differ; fix or omit a malformed unused alias too.

A 400 names fields, never their submitted values. Legacy missing-ID and
positive-integer detail strings are retained; this section supplies the full
correction policy for those messages and for schema rejections. Rejections
perform no data-handler, cache or D1 work. A valid but unknown ID remains 404.

For batch hydration the same routes accept one comma-separated `ids` list of
1 to 50 canonical ids (`?ids=1,2,3`, never repeated `?ids=` keys and never
mixed with `id`/alias). Any malformed or empty entry, any mixing, or more
than 50 ids fails the whole request with the fixed value-free batch 400
before any read. A batch 200 returns `{entries}` in request order — found
entries carry the single-GET bundle, missing ids are exactly
`{id, found: false}` — with `no-store` and no ETag.
See the [synthetic consumer check](CONSUMER-QUICKSTART.md#3-nested-reads-apiv1data-sync-secret-only)
for local, credential-free acceptance examples.

## Customer account numbers (`bad-request`)

For `GET /api/v1/customer-snapshot`, `customerNumber` and `subCustomerNumber`
are optional exact, case-sensitive strings of 1..100 Unicode code points; each
may appear only once and must not be whitespace-only. Values are never trimmed
or numerically coerced, so nonblank whitespace and leading zeros are preserved.
After authentication, invalid filters return a stable, value-free 400 before
D1 access or conditional 304 success. Correct the named field to a single
nonblank value within the limit, or omit it, then retry.

The existing detail remains fixed, for example:
`Invalid request query (customerNumber). See docs/PROBLEMS.md#bad-request.`
The field can instead be `subCustomerNumber` or multiple invalid fields; no
supplied account value is echoed or logged. A valid lookup with zero matches
is a successful empty collection, not a validation error. See the
[synthetic lookup recipe](CONSUMER-QUICKSTART.md#exact-external-account-lookup).

## Stored customer classification (`bad-request`)

For `GET /api/v1/customer-snapshot`, optional `customerTypeId` is an exact
unpadded ASCII decimal integer from `0` through `9007199254740991`, sent
once. No signs, padding, whitespace, fractions, exponent/hex notation or
unsafe integers. Zero matches literal stored classification `0`, never null
or all rows; stored NULL classifications never match. The value filters the
cached snapshot, not live Routeware state.

Invalid or repeated keys return fixed, value-free 400 guidance before D1:
`Invalid request query (customerTypeId). See docs/PROBLEMS.md#bad-request.`
Correct the named field's format, send it once, then retry; omit it only if
no classification filter is intended. Authentication still precedes
validation. A valid selector with no match returns 200 with an empty list.
See the [classification policy](SNAPSHOT-LIST-QUERY-POLICY.md#stored-classification-filter).

## Stored customer comment fragment (`bad-request`)

For `GET /api/v1/customer-snapshot`, `comments` accepts one fragment of at
most 100 Unicode code points **before trimming** boundary whitespace. Blank
within that limit means omitted, not an error. Repeated or overlength values
return the existing value-free 400 after authentication and before any D1
statement or conditional 304. For this field alone the fixed detail is:

`Invalid request query (comments). Send one comments fragment of at most 100 Unicode code points, or omit comments and retry. See docs/PROBLEMS.md#bad-request.`

No fragment or unrelated unknown key is echoed or logged. A valid unmatched
fragment returns a successful empty collection. SQLite folds only ASCII A-Z;
non-ASCII case differences do not imply missing data. This is literal stored
comment search, not company-name `q` search. See the
[synthetic recipe](CONSUMER-QUICKSTART.md#stored-customer-comment-fragment).

## Stored phone fragment (`bad-request`)

For `GET /api/v1/customer-snapshot`, `phone` is an optional ASCII
case-insensitive substring of 1..100 Unicode code points over the stored
`phone1`/`phone2` text; it may appear only once and must not be blank or
whitespace-only. SQLite `lower()` folds A-Z only, so non-ASCII case variants
match only on exact case. The fragment is never trimmed, normalized or
digit-stripped, so nonblank whitespace and punctuation are significant.
After authentication, invalid
fragments return a stable, value-free 400 before D1 access or conditional
304 success. Correct the named field to a single nonblank value within the
limit, or omit it, then retry.

The existing detail remains fixed, for example:
`Invalid request query (phone). See docs/PROBLEMS.md#bad-request.`
The field can instead be another invalid selector or multiple invalid
fields; no supplied phone value is echoed or logged. A valid lookup with
zero matches is a successful empty collection, not a validation error. See
the [synthetic lookup recipe](CONSUMER-QUICKSTART.md#stored-phone-fragment-lookup).

## Customer address presence (`bad-request`)

For `GET /api/v1/customer-snapshot`, send one `hasAddresses=true`, `false`
or `any` (default), or omit the selector and retry. The enum is exact and
case-sensitive: unknown, empty and repeated values fail after authentication
and before D1 with the existing value-free 400. Detail for this field alone:

`Invalid request query (hasAddresses). Send one hasAddresses=true, false or any, or omit the selector and retry. See docs/PROBLEMS.md#bad-request.`

No supplied value is echoed or logged. Zero matches is a successful empty
collection. Disabled stored addresses count as present; customer `enabled`
is independent. No mirrored child is not proof of no upstream site and never
authorizes deletion, reconciliation or sync. See the
[local present/absent recipe](CONSUMER-QUICKSTART.md#customer-address-presence).

## Address container presence (`bad-request`)

For `GET /api/v1/address-snapshot`, `hasContainers` is an optional exact,
case-sensitive enum: `true`, `false` or `any` (the default when omitted). Any
other spelling — including blank, upper-case, numeric or comma-joined values —
and any repeated key return the existing value-free 400 after authentication
and before D1 access. Correct the field to one exact enum value, or omit it,
then retry.

The existing detail remains fixed:
`Invalid request query (hasContainers). See docs/PROBLEMS.md#bad-request.`
No supplied value is echoed or logged. A valid selection with zero matches is
a successful empty collection, not a validation error, and `false` means no
currently mirrored child — not proof the upstream site is empty. See the
[synthetic present/absent recipe](CONSUMER-QUICKSTART.md#address-container-presence).

## Strict hydrated-read query keys (`bad-request`)

The three hydrated single-entity GETs (`GET /api/v1/data/customer|address|container`)
reject any query key outside their declared set — `id`, the route's alias
(`customerId` / `pickupAddressId` / `containerId`), the optional `fields`
selector, the batch `ids` selector, and the optional typed
`fields[customer]` / `fields[address]` / `fields[container]` selectors — with
a fixed, value-free 400 before any cache or D1 work. A typo such as `?field=`
fails loudly instead of serving the full bundle:

```
Invalid request query (fields selectors). Unknown query parameter. Allowed query parameters: id, customerId, ids, fields, fields[customer], fields[address], fields[container]. See docs/PROBLEMS.md#bad-request.
```

Each route names its own alias. No submitted key or value is echoed.
Sync-secret 401 precedence is preserved; invalid values and repeated known
keys keep their existing validator 400s. Fix the spelling to the exact
documented key and retry. See [query policy](SNAPSHOT-LIST-QUERY-POLICY.md#hydrated-entity-reads-are-strict).
The three ordinary flat snapshot lists ignore unknown names by default and
reject them when `strictQuery=true` (see [Opt-in list query keys](#opt-in-list-query-keys-bad-request)).
Changes-feed and other operations retain their existing query policies;
hydrated entity reads remain strict.

## Customer changes cursor (`bad-request`)

For `GET /api/v1/customer-snapshot/changes`, send a valid UTC `Z` datetime
with at most three fractional-second digits; extra digits are rejected even
when zero. If sending `since_id`, pair it with nonempty valid `since` and
use an unpadded ASCII decimal integer from `0` through `9007199254740991`.
Do not use signs, spaces, exponents, prefixes, fractions or repeated cursor
keys. Omit both cursor fields for the initial page, or replay both fields
from the previous `nextCursor` for tie-safe continuation. See
[query policy](SNAPSHOT-LIST-QUERY-POLICY.md#customer-changes-cursor-validation).

Validation happens before D1 and returns fixed, value-free guidance:
`Invalid request query (since_id). See docs/PROBLEMS.md#bad-request.`
The named field can instead be `since` (or multiple invalid fields); no
submitted timestamp or id is echoed. Authentication still precedes validation.

## Address route and franchise scopes (`bad-request`)

For `GET /api/v1/address-snapshot`, send each optional scope key once:

- `routeId`: exact unpadded ASCII decimal integer `0..9007199254740991`.
  No signs, padding, whitespace, fractions, exponent/hex notation or unsafe
  integers. Zero matches literal stored route `0`, not all routes.
- `franchiseId`: opaque case-sensitive exact string, 1..100 Unicode code
  points, not blank/whitespace-only. Leading zeros and nonblank whitespace
  are significant; do not trim or numerically coerce it. URL-encode it.

Invalid or repeated keys return fixed, value-free 400 guidance before D1:
`Invalid request query (routeId). See docs/PROBLEMS.md#bad-request.`
The field may instead be `franchiseId` (or both). Correct the named field's
format, send it once, then retry; omit it only if no scope is intended.
Authentication still precedes validation. Valid scopes that match no rows
return 200 with an empty list. See the [scope policy](SNAPSHOT-LIST-QUERY-POLICY.md#address-route-and-franchise-scopes).

## Container parent service-site scopes (`bad-request`)

For `GET /api/v1/container-snapshot`, send each optional parent key once:

- `parentRouteId`: canonical unpadded ASCII decimal integer `0..9007199254740991`.
  Zero is literal stored zero; no signs, whitespace, fractions or exponents.
- `parentFranchiseId`: case-sensitive opaque exact string of 1..100 Unicode
  code points containing a non-whitespace character. Preserve leading zeros
  and significant whitespace; URL-encode without trimming or normalization.
- `parentEnabled`: exactly `true`, `false` or `any` (default `any`). This is the
  address state, independent of container `enabled` and customer state.

Blank, repeated, invalid and overlength keys return a value-free 400 before
D1 or conditional 304, after authentication:
`Invalid request query (parentRouteId). See docs/PROBLEMS.md#bad-request.`
The named field can instead be `parentFranchiseId` or `parentEnabled`, or
multiple supported keys. Correct the named format, send it once and retry;
omit only if no such parent scope is intended. Values are never logged or
included in errors. Valid no-match returns 200 empty, not an error. See the
[parent scope policy](SNAPSHOT-LIST-QUERY-POLICY.md#container-parent-service-site-scopes).

## Address stored extras-allowed selector (`bad-request`)

For `GET /api/v1/address-snapshot`, `extrasAllowed` is an optional exact,
case-sensitive enum: `true`, `false` or `any` (default `any`), sent once.
`true` matches stored `extras_allowed = 1`, `false` matches stored `0`, and
`any`/omission adds no predicate. The flag is stored snapshot state, not
permission to mutate service terms or proof of current upstream policy. No
coercion is applied: `1`, `0`, padded or case-mismatched spellings are
invalid, as are blank values and repeated keys.

Invalid or repeated keys return fixed, value-free 400 guidance before D1:
`Invalid request query (extrasAllowed). See docs/PROBLEMS.md#bad-request.`
Correct the value to one exact enum spelling, send it once, then retry; omit
it only if no selector is intended. Authentication still precedes validation.
Valid selectors that match no rows return 200 with an empty list. See the
[selector policy](SNAPSHOT-LIST-QUERY-POLICY.md#address-stored-extras-allowed-selector).

## Exact stored address ZIP (`bad-request`)

For `GET /api/v1/address-snapshot` and `GET /api/v1/container-snapshot`, `zip`
is an optional exact, case-sensitive opaque string of 1..100 Unicode code
points over that resource's own stored `zip` column — not a number, prefix
or substring. Container ZIP never falls back to the parent address. Leading zeros (for example
`02139`) and nonblank whitespace are significant; do not trim, case-fold or
numerically coerce it. Send the key once, URL-encoded.

Invalid or repeated keys return fixed, value-free 400 guidance before D1:
`Invalid request query (zip). See docs/PROBLEMS.md#bad-request.`
Correct the named field's format, send it once, then retry; omit it only if
no ZIP scope is intended. Authentication still precedes validation. A valid
ZIP that matches no rows returns 200 with an empty list. See the
[address ZIP policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-stored-address-zip) and
[container locality policy](SNAPSHOT-LIST-QUERY-POLICY.md#stored-container-locality).

## Exact stored container labels (`bad-request`)

For `GET /api/v1/container-snapshot`, optional `materialStream` and `color`
are case-sensitive opaque exact stored labels: 1..100 Unicode code points
containing a non-whitespace character. `materialStream` selects
`ud_material_stream_ud`; `color` selects `color`. Preserve significant
whitespace, leading zeros and punctuation without trimming or normalization.
No vocabulary or inferred waste category is defined.

Empty, whitespace-only, repeated and overlength keys return the existing
value-free 400 after authentication and before D1:
`Invalid request query (materialStream). See docs/PROBLEMS.md#bad-request.`
(or the fixed `color` key). URL-encode one supported-length nonblank stored
label, or omit the selector if no label scope is intended, then retry. Never
log submitted labels. Valid unknown labels return an empty 200, not an error.
See the [label policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-stored-container-labels).

## Exact stored address city and state (`bad-request`)

For `GET /api/v1/address-snapshot`, send each optional `city` or `state`
key once as a nonblank, case-sensitive exact stored string of 1..100 Unicode
code points. Empty, whitespace-only, repeated (even encoded duplicates)
and overlength values return 400 before D1 or conditional 304; authentication
remains first. Errors name fields, never submitted values:
`Invalid request query (city). See docs/PROBLEMS.md#bad-request.`
The field may instead be `state`, or both. Correct the named field, URL-encode
one nonblank value with `URLSearchParams` or curl `--data-urlencode`, and retry.
Do not trim significant whitespace, normalize Unicode or abbreviations, or
coerce numeric-looking strings. Omit a selector only if no such scope is
intended. Valid no-match returns 200 empty, not an error; stored nulls never
match supplied strings. See the
[city/state policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-stored-address-city-and-state).

## Stored address driver note (`bad-request`)

On `GET /api/v1/address-snapshot`, send one optional `driverNote` string of
at most 100 Unicode code points **before trimming**. Repeated keys (including
encoded aliases) and overlength strings fail before D1 or conditional 304;
authentication stays first. Fixed detail for this field alone:

`Invalid request query (driverNote). Send one driverNote of at most 100 Unicode code points before trimming, or omit it and retry. See docs/PROBLEMS.md#bad-request.`

URL-encode a corrected single value and retry, or omit the selector when no
note filter is intended. Blank/whitespace-only values mean omitted, not an
error. No submitted notes or unknown names are echoed or logged. Matching is
literal, ASCII-case-insensitive and limited to stored `driver_note`, not
address comments or locality. A valid fragment with no matches returns 200
empty. See the [synthetic recipe](CONSUMER-QUICKSTART.md#stored-address-driver-note)
and [query policy](SNAPSHOT-LIST-QUERY-POLICY.md#stored-address-driver-note).

## Exact stored container installation (`bad-request`)

For `GET /api/v1/container-snapshot`, `locationAddress` permits 1..200 Unicode
code points and `state` permits 1..100. Each optional key must occur once and
contain a non-whitespace character. Empty/whitespace-only, repeated (including
encoded duplicates) and overlength values fail after authentication but before
D1 or conditional 304, with the existing value-free problem body. For example:
`Invalid request query (locationAddress). See docs/PROBLEMS.md#bad-request.`
The field may instead be `state`, or both. URL-encode one nonblank stored value
within the named limit or omit the key, then retry. Do not trim significant
whitespace, change case, normalize Unicode/abbreviations or coerce leading zeros.
No submitted value is echoed or logged. Valid no-match returns 200 empty.
These selectors match only the container's own columns, never parent-address
values; stored nulls never match. See the
[exact installation policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-stored-container-installation).

## Snapshot list direction (`bad-request`)

For the three ordinary snapshot lists, send exactly one lowercase
`order=asc` or `order=desc`, or omit `order` for ascending primary-ID order.
Empty, repeated, case-mismatched, padded and other values are invalid.
Keep the same direction when replaying `nextCursor`; changing direction
starts a new traversal. See [query policy](SNAPSHOT-LIST-QUERY-POLICY.md#primary-id-direction-order).

Validation happens after authentication and before D1, with fixed value-free
guidance: `Invalid request query (order). See docs/PROBLEMS.md#bad-request.`
No submitted value is echoed. Route-level problem bodies retain their shape;
correlate the response using the `X-Request-Id` header.

## Sparse fieldsets (`bad-request`)

For the snapshot lists, by-id reads and customer changes feed, `fields=` must be a single
comma-separated list of exact stored column names from the route's
allowlist (`src/lib/sparseFieldsets.ts`): no spaces, no case folding, no
empty segments, no duplicates, no repeated `fields` key. Columns from
another resource are unknown here, not aliases. Send the documented
spelling; the resource id needs no naming since it is always present in
responses. See [query policy](SNAPSHOT-LIST-QUERY-POLICY.md#sparse-fieldsets-fields)
for the contract and a synthetic example.

Validation happens before D1 and returns fixed, value-free guidance:
`Invalid request query (fields). See docs/PROBLEMS.md#bad-request.`
No submitted name is echoed. Authentication still precedes validation.

## Save dry-run query (`bad-request`)

For `POST /api/v1/data/customer|address|container`, `dryRun` is the only
allowed query key, and its value must be exactly `true` or `false`:
`?dryRun=true` validates without writing, `?dryRun=false` (or no query)
runs the live write. Unknown keys, typos (`dryrun`), empty values and
repeated keys are 400s before any session, upstream, D1 or cache work, with
key names (never values) in the detail. An invalid `dryRun` value 400s
before the inner sync-secret gate; an unknown key 401s first for a wrong
bearer. See the [dry-run recipe](CONSUMER-QUICKSTART.md#dry-run-recipe-validate-fix-save).

## CSV control characters (`bad-request`)

All three snapshot `.../import` routes reject NUL, vertical tab, other C0
controls (U+0000–U+001F except tab/LF/CR), DEL/C1 controls (U+007F–U+009F),
and lone CR inside a cell. Headers, unused columns, and whitespace-only
records are checked before trimming or binding any values to D1. The error
names the logical CSV row without echoing submitted values:

```
CSV row 2 contains a disallowed control character.
See docs/PROBLEMS.md#bad-request.
```

The header is row 1; embedded quoted newlines do not advance the row number.
Empty records are skipped by the stream reader, but whitespace-only and
invalid-ID records count. Tabs and quoted LF/CRLF remain supported. CR-only
record separators remain supported; a lone CR **inside a quoted cell** is
rejected, not silently removed. This is the API's import policy, stricter
for cell CR than [RFC 4180 §2](https://datatracker.ietf.org/doc/html/rfc4180#section-2).
Upstream report syncs and the default shared parser retain their permissive
behavior; import routes explicitly enable control rejection.

Fix the named record (remove forbidden controls or replace cell CR with LF)
and retry. No rejected record is written, and import never reconciles/deletes.
Earlier flushed batches of valid rows may remain; the upload is not atomic.

This policy also applies to the API's own exports and raw R2 report archives:
report-origin controls are retained by sync/export, so those CSVs may not be
HTTP-importable. Do not discover compatibility through a partial restore.
For recovery without control sanitization, use the integrity-verified in-code
report restore in [R2 restore runbook §6](R2-RESTORE-RUNBOOK.md#6-readback-route-handoff-and-programmatic-recovery).
Export → HTTP import is lossless only for import-compatible business cells.

## Snapshot import identities (`bad-request`)

Operator `...-snapshot/import` routes (including dry-run) reject missing or
ambiguous normalized identity headers and malformed required primary/relationship
cells with 400 `application/problem+json`. Required columns are customer
`CustomerID`; address `PickupAddressID` + `CustomerID`; container `ContainerID` +
`PickupAddressID`. Header case, BOM, trimming and CSV quoting still work; each
identity column must occur exactly once, even when duplicated cells agree.

Identities must be positive safe integers written entirely as ASCII decimal digits
(value 1 through 9007199254740991). Existing spreadsheet-marker decoding, trimmed
whitespace and leading zeroes are supported. Empty/missing cells, numeric prefixes,
signs, fractions, exponents, hex, non-ASCII digits and unsafe values are invalid.
Optional non-identity numbers/defaults and tolerant upstream report parsing are
unchanged; this is not full-column validation or a different CSV dialect.

For example, synthetic address CSV `PickupAddressID,CustomerID` / `42,123junk`
fails with this fixed detail, never echoing the cell, customer data or a D1 error:

```
Invalid identity in address_snapshot at row 2, field customer_id. Provide each required identity header exactly once and use positive safe whole-decimal integers, then retry. See docs/PROBLEMS.md#bad-request.
```

Table/field identifiers are fixed schema names. Row 1 denotes the header;
subsequent rows count logical CSV records as in the control-character policy
above, not physical newlines inside quoted cells. Correct the named header or
identity cell and retry. A missing database parent is a separate dangling-reference
error below; dry-run still skips parent-existence checks but validates identical
identity syntax with zero writes.

A header or first-batch identity error writes nothing. The pending batch and tail
are not written after a later error, but earlier flushed valid batches may remain
committed (80 customer/address rows or 40 container rows per default batch).
There is **no whole-upload rollback**. The rejected record is never written and
parse failure never triggers end-of-import reconciliation; imports never delete.
See the [strict import contract](../CUSTOMER_SNAPSHOT.md#strict-identities-on-operator-csv-imports)
for the synthetic example and focused hermetic regression command.

## Strict mutating-POST query keys (`bad-request`)

The seven mutating snapshot POSTs (`...-snapshot/sync`,
`...-snapshot/import`, `/api/v1/data-snapshot/sync`) reject any query key
outside their declared set — `dryRun` everywhere, plus `partialProgress` on
the combined route — with a fixed, value-free 400 before any D1, R2 or
upstream work. A typo such as `?dryrun=true` fails loudly instead of running
a real mutation:

```
Unknown query parameter. Allowed query parameters: dryRun. See docs/PROBLEMS.md#bad-request.
```

The combined route names both keys. No submitted key or value is echoed.
Sync-secret 401 precedence is preserved; invalid values and repeated known
keys keep their existing validator 400s. Fix the spelling to the exact
documented key and retry. See [query policy](SNAPSHOT-LIST-QUERY-POLICY.md#mutating-post-query-keys-are-strict).
Ordinary flat snapshot lists ignore unknown names by default, with
`strictQuery=true` for opt-in rejection; changes-feed and other operations
retain their existing query policies. These mutating POSTs are always strict.

## Dangling snapshot references (`bad-request`)

D1 enforces the snapshot FK chain (`address.customer_id` →
`customer_snapshot`, `container.pickup_address_id` → `address_snapshot`), so a
snapshot `.../import` or `.../sync` whose rows reference missing parents is
rejected with 400, never written as orphans:

```
Dangling reference: address_snapshot.customer_id=999 has no row in
customer_snapshot.customer_id (batch at row offset 0). Import customers first.
```

Only the failing batch is lost — earlier batches in the same upload still
land. Fix: import the parents first (customers, then addresses, then
containers). The `detail` lists up to 20 missing integer keys, then `+N more`
— integer keys only, never PII.

## Blocked customer erasure (`bad-request`)

`DELETE /api/v1/customer-snapshot/{customerId}` records an id-only D1
suppression tombstone and deletes one cached customer row (local cache
suppression only — upstream Routeware is untouched; see `method-not-allowed`).
The D1 `customer_snapshot` row and data-entity cache entry are removed; other
edge locations and clients may keep serving the erased PII until the 60 s cache
TTL expires. A D1 tombstone suppresses the customer on later sync, proxy-save
refresh, and CSV/archive import. Suppressed address writes for that customer
are skipped and recorded as id-only lineage so their container writes are
skipped too; other customers keep fail-closed foreign keys. Tombstones have no automatic expiry; retain
them while upstream or any archive/backup can return the customer. It does not
remove R2 history CSVs, daily aliases, latest pointers, or the archived-CSV
readback. D1 Time Travel or a backup restore to a point before the
erasure may restore a customer row and schema without its tombstone/triggers;
verify suppression before serving recovered data, so verify suppression after
database recovery. Customers erased before the suppression migration have no
tombstone; backfill them with privileged `wrangler d1 execute` (see
`docs/R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched`).
Time Travel can restore data for up to 30 days (7 days on the Workers Free
plan). The same FK chain
refuses a delete while address rows still reference the customer, mapped to
400 (never an orphan, never a cascade):

```
Cannot delete customer_id=42: 2 address row(s) still reference it
(pickup_address_id=10, 11). Delete the addresses first.
See docs/PROBLEMS.md#bad-request.
```

Fix: remove the listed addresses, then retry. There is no address or
container DELETE route — "delete the addresses first" means either waiting
for the upstream deletion to reconcile (detail-full sync or report-sync
drops the child rows once upstream stops reporting them) or deleting them
directly with privileged `wrangler d1 execute` in container → address →
customer FK order. This route removes only the `customer_snapshot` row: the
customer's `address_snapshot` and `container_snapshot` rows are not removed
by this route. The `detail` names up to 20 blocking integer keys — integer
keys only, never PII.

## Authentication (`unauthorized`)

All `/api/v1/*` endpoints **except** `GET /api/v1/health` require a bearer token:

```
Authorization: Bearer <SHADOW_API_TOKEN>
```

`SHADOW_API_TOKEN` gates general access. When it is unset, the Worker falls back to
`CUSTOMER_SNAPSHOT_SYNC_SECRET`. The privileged snapshot/data routes
(`.../sync`, `.../import`, `.../export`, `/api/v1/data/*`,
`/api/v1/data-snapshot/sync`, the `DELETE` customer erasure route,
`GET /api/v1/data-snapshot/orphans`, `GET /api/v1/snapshots/:table/:date`
readback) additionally require
`CUSTOMER_SNAPSHOT_SYNC_SECRET` specifically.

### Dual-secret matrix

General `/api/v1/*` routes pass the outer gate with **either** secret:
`isApiAuthorized` (`src/lib/auth.ts`) accepts the bearer when it matches
`apiAccessToken()` — `SHADOW_API_TOKEN` when set, else the sync secret — **or**
`CUSTOMER_SNAPSHOT_SYNC_SECRET` directly. The second disjunct exists so the
chained `/api/v1/data-snapshot/sync` subrequests, which authenticate with
`Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`
(`src/lib/snapshot/orchestration.ts`), pass the outer gate even when a
distinct `SHADOW_API_TOKEN` is configured.

Outer gate by configured secrets (✓ = route reached, ✗ = 401):

| Secrets configured | `Bearer <API>` | `Bearer <SYNC>` | wrong | none |
|---|---|---|---|---|
| both | ✓ | ✓ | ✗ | ✗ |
| API only | ✓ | ✗ | ✗ | ✗ |
| sync only | ✗ | ✓ | ✗ | ✗ |
| neither | ✗ | ✗ | ✗ | ✗ |

When only one secret is set, the other string is simply unconfigured, so
presenting it 401s. When neither is set the Worker fails closed: every
`/api/v1/*` route except `GET /api/v1/health` 401s.

Privileged routes add the inner check `requireSnapshotAuth`
(`src/routes/shared.ts`), which requires the sync secret specifically —
passing the outer gate with the API token is not enough:

| Route class | `Bearer <API>` | `Bearer <SYNC>` | wrong / none |
|---|---|---|---|
| General (all `/api/v1/routeware/*`, snapshot list reads, `GET /api/v1/shadow/health`) | ✓ | ✓ | 401 outer gate |
| Privileged (`.../sync`, `.../import`, `.../export`, `/api/v1/data/*`, `/api/v1/data-snapshot/sync`, `DELETE` erasure, `data-snapshot/orphans`, `snapshots/` readback — 19 routes) | 401 inner check | ✓ | 401 outer gate |
| Public (`GET /api/v1/health`) | n/a | n/a | 200, no token |

Pinned by `test/dualSecretMatrix.test.ts` (outer-gate unit matrix + HTTP
route-class matrix) and `test/snapshotAuth.test.ts` (per-route inner 401
bodies).

### Read-only bearer role

`SHADOW_API_READ_TOKEN` (optional) grants GET-only access to non-privileged
reads. It passes the outer gate on GET requests only: a GET with the read
token returns 200 on a general route, while any non-GET request with it 401s
at the outer gate. Among privileged routes, non-GET requests (sync/import,
POST `/api/v1/data/*`, `DELETE` erasure) 401 at the outer gate, and only
privileged GETs (exports, `/api/v1/data/*` reads, `data-snapshot/orphans`,
`snapshots/` readback) pass that gate to 401 at the inner sync-secret
check — no privileged route accepts the read token. Unset or blank means unconfigured: the role
fails closed. Use a distinct random value — if it ever equals the full token
it inherits full access.

```
npx wrangler secret put SHADOW_API_READ_TOKEN
```

Pinned by `test/readOnlyRole.test.ts` (unit matrix + HTTP acceptance pair +
per-privileged-route sweep + fail-closed contract).

Set these as secrets in production — never in `wrangler.toml` `[vars]`:

```
npx wrangler secret put SHADOW_API_TOKEN
npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET
```

## Brute-force throttling (`rate-limited`)

Failed bearer-auth checks on `/api/v1/*` are counted per client IP in the
`AuthSession` Durable Object. The IP comes from `CF-Connecting-IP` (which
Cloudflare overwrites, so clients cannot spoof it); `X-Forwarded-For` is
honored only when `THROTTLE_TRUST_XFF="true"` (dev/test) — production
XFF-only callers share the `"unknown"` bucket, so a client-controlled XFF
value can neither evade the throttle by rotation nor frame a victim's bucket.
After 19 failed checks inside a 60-second window, the 20th check from that IP
returns `429 Too Many Requests` and starts a 60-second block. Further failed
checks while that block is active also return 429 and restart the 60-second
timer, so continued failures keep `Retry-After` at 60 seconds. Each 429 has a
problem+json body, a `Retry-After` header reporting the remaining block
duration (at most 60 seconds), and `X-RateLimit-Limit` (`19`, the failed checks
allowed per window),
`X-RateLimit-Remaining` (`0`), and `X-RateLimit-Reset` (an absolute Unix
timestamp in seconds; for older Durable Objects that omit the expiry, it is a
conservative estimate derived from `Retry-After`). CORS exposes `Retry-After` and
all three `X-RateLimit-*` headers through `Access-Control-Expose-Headers`. The
block is per-IP, not per-token, so rotating candidate tokens does not evade it.

Only failures count: a valid token always passes and resets the IP's counter,
so legitimate traffic is unaffected. The public `GET /api/v1/health` probe and
CORS preflight never touch the throttle.

Throttle storage errors fail open to the pre-throttle 401 behavior — auth
stays enforced, only the counting degrades. Fail-opens log at most one
structured error event per isolate per 60-second window: `msg` is always
`AUTH THROTTLE FAIL-OPEN`, and a separate fixed-category `reason` field names
the failure class (never IP/token/PII). Operator alarm path — log query +
alert-rule proposal, nothing activated:
`docs/AUTH-THROTTLE-FAIL-OPEN-ALARM-RUNBOOK.md`. Pinned by
`test/authThrottleFailOpenAlarm.test.ts` (line fires exactly once per window
on DO failure) alongside the dedup cases in `test/authThrottle.test.ts`.

A valid-token reset only clears the requester's own IP bucket (the same
`auth-throttle:<ip>` Durable Object key the failures were counted under), so
it cannot be abused to clear an attacker's budget: a reset requires passing
the bearer check, which an attacker without the token cannot do, and a reset
from one IP never touches another IP's counter. Pinned by
`test/throttleResetIsolation.test.ts`.

Shared-NAT note: clients behind one egress IP share a single 19-failure
budget, so a bad actor — or a misconfigured client retrying a stale token —
behind the same NAT can cause `429` responses for other clients' failed
attempts from that IP. This never blocks legitimate traffic: a request with
the valid token always passes, even while its IP is blocked, and clears the
shared counter. Operator remedy: confirm the affected client is sending the
current token (one good request clears the block immediately); otherwise the
block expires 60 seconds after the last failed check. If `429`s recur from one egress
IP, find the client burning the budget and fix its token, or route operator
traffic through a distinct egress IP.

<a name="upstream-error"></a>

## Loud upstream errors (`upstream-error`)

Client-facing routes using `forwardPassthrough` retain upstream HTTP 400–599,
including 401, 429 and 503, but replace the response with local
`application/problem+json` titled "Upstream request failed" and the fixed detail:
"Routeware returned an error. Its response body has been withheld."
The body is never inspected, buffered or logged; upstream headers (including
`Set-Cookie`, `Location` and debug headers) and status text are not relayed.
A fixed local `Cache-Control: no-store` prevents caching the replacement error,
including heuristically cacheable 404/410 statuses, without copying upstream headers.
This contains possible customer/session material in HTML, JSON, text or binary
error pages on both the first forward and the single post-login retry.

The eleven retry passthroughs are home/index, app-settings-get,
query-request-is-complete, customers-read, detail-full, customer-types-read,
add-new-long, load-long-modal and the customer/address/container save routes.
Successful responses and redirects keep their existing contracts; silent
HTML-200 failure guards remain in place. Loud errors do not trigger another
login or retry. Internal `/api/v1/data/*` save consumers continue to use the raw
retry helper and their own sanitized envelope, preserving byte-count diagnostics.
The sessionless login-page probe is a direct forward, not a retry passthrough,
and is outside this control's scope.

Pinned by `test/passthroughLoudFailure.test.ts`, with synthetic customer, phone
and session markers only. This is an intentional compatibility change: clients
must use the HTTP status and local problem fields, not upstream error text or
headers (including upstream `Retry-After`). Worker-generated timeout and
session-refresh problems retain their existing types and details.

## Upstream timeouts (`bad-gateway`, title "Upstream timed out")

Every Routeware fetch runs under a bounded per-attempt budget
(`src/lib/upstreamTimeout.ts`). Before the bound existed, a hung
upstream host held the Worker until the 300s CPU limit mid-sync. Now each
fetch races a timer covering time-to-headers only (the `fetch` promise): the
timer is cleared once headers arrive, so a large report CSV that starts
quickly is never cut off mid-stream. Handlers that must buffer a response
use a **separate total body-read deadline**, starting when consumption begins
(`src/lib/upstreamBody.ts`). That deadline uses `UPSTREAM_TIMEOUT_MS` too
(default 15s; invalid/absent uses the default), not the remainder of the
header budget. Each buffered read can therefore spend one header budget plus
one body budget. Completing headers does not make a never-finishing JSON or
modal body successful.

A timeout of the primary forwarded response fails fast to 502 problem+json
with a fixed PII-free detail (no URL, no body). The body deadline aborts the
original fetch and cancels pending reads; passthrough validation cancels both
clone/tee branches on timeout. Cancellation is not awaited, because an
underlying source can itself hang. The forwarding retry wrapper propagates a
timeout without refreshing the session or replaying the request. A timed-out
save response does not begin its local D1 refresh. Its upstream result is
**unknown**: verify the record before deciding whether to submit again.
A caller abort with the header timer unfired rethrows verbatim, never a 502.

Existing caller policies remain unchanged: with `AUTH_MODE=auto`, an HTTP
login timeout can fall back to Browser Rendering in `establishSession` rather
than immediately returning 502 (`AUTH_MODE=http` propagates it). After a
confirmed successful save, a timeout of the separate detail-full refresh is
caught: the routeware tier retains the successful save response, and the data
tier reports `localSync.code="sync_failed"` while retaining save success.
Neither case replays a timed-out save.

Buffered coverage: customer list/detail/type reads, app settings, report
completion control polls, customer/address/container saves at both routeware
and data tiers, detail-full refresh reads, anti-forgery modals, HTTP login HTML
and init scripts, and interactive login-page sniffing. Successful passthrough
validation preserves the original response bytes and headers.

Intentionally untouched: raw report CSV downloads and CSV-to-D1/R2 consumption
have **no total-body deadline** — a large export that keeps flowing is never
cut off for its size or total time. They do have an **idle (stall) bound**:
every streamed read must yield bytes within `REPORT_STREAM_STALL_TIMEOUT_MS`
(default 30s; absent/invalid falls back to the default); a longer gap with no
bytes cancels the read and fails the sync/readback as a 502 `UpstreamTimeoutError`
before any reconcile or delete, while each completed read resets the window so
slow-but-progressing streams complete. The bound covers the R2 archive drain,
the D1 `streamCsvLines` consumption, and both archive-readback passes.
Operator `...-snapshot/import` uploads stay unbounded (a client disconnect
aborts them). Report-download login sniffing retains its existing unbounded
behavior for nonstandard content types; it explicitly opts out so a legitimate
long CSV served as text/plain is not cut off. The sessionless login-page probe
only forwards a stream and remains header-bounded.

Chained same-Worker sync responses use a different contract: **one per-table
180s deadline** (`CHAINED_SYNC_TIMEOUT_MS`, absent/invalid → default), spanning
headers and body together, with an inclusive **65,536-byte** actual-body cap.
Non-2xx bodies are cancelled, not drained. Timeout, oversize, source-read and
invalid JSON/count metadata refusals use fixed chained error kinds; cron keeps
completed-table counts and the combined HTTP route retains its existing generic
500 `internal` problem by default, with an opt-in `?partialProgress=true`
sanitized per-table envelope (fixed table/code, numeric status only for
`ChainedHttpError`; see [partial progress](../CUSTOMER_SNAPSHOT.md#partial-progress-on-combined-sync-failure)).
No POST retry or redirect
replay occurs. Cancellation is best-effort and never awaited: remote work may
already have completed. Inspect the failed table before resubmitting, as the
fixed cron `next_action` directs. See [the chained response boundary and focused
check](CRON-SYNC-ALARM-RUNBOOK.md#41-chained-response-boundary).

Per-step **header** budgets (single-retry max, so headers cost at most 2x one
attempt; buffered consumers additionally get the body budget described above):

| Step (code) | Header budget / attempt | Worst header time | Retry rule |
|---|---|---|---|
| Interactive forwards (`forwardWithSessionRetry`: API passthrough, modals, saves) | 15s (`DEFAULT_UPSTREAM_TIMEOUT_MS`) | 30s | retried once only for the login redirect / 200-with-login-form; timeouts never retried |
| Sessionless login-page probe (`forwardToUpstream` direct, no retry wrapper) | 15s (default) | 15s | single attempt, no retry |
| HTTP login (`httpAuth.httpLogin`: login-page GET, ext.NET init GET, login POST) | 15s per fetch | 45s for the three fetches | no retry inside; `establishSession` can fall back to Browser Rendering in auto mode |
| Report-CSV downloads (`routewareQueryReportCsv`, `snapshot/reportFetch`) | 60s (`REPORT_UPSTREAM_TIMEOUT_MS`) | 120s | one re-login + retry; timeouts never retried |
| Query-report poll (`pollQueryRequestIsComplete`: 2.5s × 24 attempts ≈ 60s) | ≈60s poll + 60s download | fits in one Worker invocation | poll loop, not a fetch retry |

Per-route wiring map (audit — every Routeware-backed route/handler to
its budget source; all flow through `fetchWithUpstreamTimeout` via
`forwardToUpstream` or `forwardWithSessionRetry`, never a bare `fetch`):

| Public route(s) | Upstream (WebRW) | Path code | Budget / attempt |
|---|---|---|---|
| GET /api/v1/routeware/account/login-page | LOGIN_URL (fixed) | direct `forwardToUpstream` | 15s interactive (`UPSTREAM_TIMEOUT_MS`) |
| GET /api/v1/routeware/home/index | /Home/Index | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/data/app-settings-get | /Data/appSettingsGet | `forwardWithSessionRetry` | 15s interactive |
| GET /api/v1/routeware/reports/query-request-is-complete | /Reports/QueryRequestIsComplete | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/customer/customers-read | /Customer/CustomersRead | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/customer/detail-full | /Customer/GetCustomerDetailFull | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/customer/customer-types-read | /Customer/CustomerTypesRead | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/customer/save-long-form (+ AddNewLong / LoadLongCustomerModal token GET) | /Customer/SaveCustomerLongForm | `forwardWithSessionRetry` + modal via retry or direct (override-honoring) | 15s interactive |
| GET /api/v1/routeware/customer/add-new-long | /Customer/AddNewLong | `forwardWithSessionRetry` | 15s interactive |
| GET /api/v1/routeware/customer/load-long-modal | /Customer/LoadLongCustomerModal | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/address/save-address-form (+ CreateBlankAddress / LoadAddressModal token GET) | /PickupAddress/SaveAddressForm | `forwardWithSessionRetry` + modal via retry or direct | 15s interactive |
| POST /api/v1/routeware/container/save-container-form (+ CreateBlankContainer / LoadContainerModal token GET) | /Container/SaveContainerForm | `forwardWithSessionRetry` + modal via retry or direct | 15s interactive |
| POST /api/v1/data/customer, /data/address, /data/container | Save forwards + GetCustomerDetailFull D1 refresh | `forwardWithSessionRetry` + `fetchGetCustomerDetailFull` (direct, override-honoring) | 15s interactive |
| POST /api/v1/customer-snapshot/sync, /address-snapshot/sync, /container-snapshot/sync, /data-snapshot/sync | report export path or QueryExecuteDownload (+ QueryRequestIsComplete poll) | `fetchReportCsvForPath` / `fetchReportCsvByQueryId` | 60s report (`UPSTREAM_REPORT_TIMEOUT_MS`) |
| (internal) login: login-page GET, Ext.NET init GET, login POST | LOGIN_URL + ext.axd | `httpAuth.httpLogin` direct `fetchWithUpstreamTimeout` | 15s interactive per fetch |
| (internal, NOT Routeware) chained self-fetch to own public URL | own /api/v1/*-snapshot/sync | `snapshot/orchestration.ts` `fetchWithUpstreamTimeout` (`redirect: "manual"`) + `readUpstreamText` (65,536-byte cap) | 180s per table across headers+body (`CHAINED_SYNC_TIMEOUT_MS`), never retried |

Fixes: four direct `forwardToUpstream` callers (login-page probe,
`fetchGetCustomerDetailFull`, customer modal direct path, address/container
modal direct path) passed no `timeoutMs`, silently ignoring
`UPSTREAM_TIMEOUT_MS`. They now pass `readUpstreamTimeoutMs(env)`; report paths
already passed the report budget. Pinned by
`test/upstreamTimeoutRoutes.test.ts` (hung upstream → timely
`UpstreamTimeoutError` on each fixed path + source-wiring assertions).

Why timed-out forwards are never retried: the single retry is reserved for the login
redirect (provably safe — `forwardWithSessionRetry` retries only that), while
retrying a timeout could double-execute a non-idempotent POST. Pinned by
`test/upstreamTimeout.test.ts` (hung upstream → exactly one attempt, then 502)
and `docs/TEST-INVARIANTS.md` § `upstreamTimeout.ts`.

Tuning guidance (all overrides are optional per-deploy bindings — no
`wrangler.toml` change; absent/invalid falls back to the defaults):

- `UPSTREAM_TIMEOUT_MS`: raise if 502s cluster on a slow-but-healthy upstream
  whose time-to-headers p99 approaches 15s; lower to fail faster under load.
  Keep worst case (2x) well under the 300s CPU limit.
- `UPSTREAM_REPORT_TIMEOUT_MS`: raise only if report *headers* are slow — the
  streaming body is not counted, so large-but-fast-starting CSVs need no bump.
- `REPORT_STREAM_STALL_TIMEOUT_MS`: raise if 502s cluster on an upstream that
  legitimately pauses mid-export longer than 30s between bytes; lower to fail
  faster on hung streams. Total export time is never counted — only idle gaps.
- `REPORT_QUERY_POLL_INTERVAL_MS` / `REPORT_QUERY_POLL_MAX_ATTEMPTS`: raise
  max attempts for slow async query builds; note the poll and the download
  share one Worker invocation.

<a name="snapshot-export-query-budget"></a>

## Snapshot export query budget (`snapshot-export-query-budget`)

The three `GET /api/v1/{customer,address,container}-snapshot/export` routes
return 503 `application/problem+json` before constructing a CSV stream when the
bounded ETag prepass cannot establish that a complete download fits the query
allowance. No CSV disposition or ETag is sent, including for conditional requests.
The diagnostic is fixed, without row data, configuration values or D1 error text:

```
Export cannot fit the query budget. Review SNAPSHOT_EXPORT_PAGE_SIZE using CUSTOMER_SNAPSHOT.md#csv-export-page-sizing before downloading again.
```

The pure calculation in `src/lib/snapshot/exportBudget.ts` is
`2 * (ceil(N / pageSize) + 1)`: two passes, each including a terminal empty
read. The existing 1000-query Paid contract has 50 queries of safety headroom,
leaving a 950-query export allowance. The prepass stops within 475 reads rather
than walking an oversized table to completion. For a synthetic 388,735-row table,
1000-row pages cost 780 queries; 500-row pages cost 1,558 and are rejected.

Operator action: review the existing `SNAPSHOT_EXPORT_PAGE_SIZE` binding using
[CUSTOMER_SNAPSHOT.md § CSV export page sizing](../CUSTOMER_SNAPSHOT.md#csv-export-page-sizing).
Use larger pages within the supported 1–5000 range only when row-width memory
allows; the default is 1000. This is not a client query parameter, and retrying
unchanged sizing does not fix the budget refusal. No platform limit is raised.
If even the supported maximum cannot fit, this endpoint cannot supply that full
CSV within the contract. Admission is not transactional consistency: concurrent
table changes or unpredictable D1 failures can still error an admitted stream.
D1 exceptions are not reclassified as this predictable-budget diagnostic.

Hermetic focused check: `npm test -- test/snapshotExportBudget.test.ts`. No live
tenant, production measurement, remote Wrangler command or migration is needed.

## Oversized snapshot import (`payload-too-large`)

`POST /api/v1/{customer,address,container}-snapshot/import` refuses bodies
over `SNAPSHOT_IMPORT_MAX_BYTES` (`src/lib/snapshot/streamSync.ts`) with a
413. A truthful `Content-Length` fails fast before the stream is read; a
missing, non-numeric or understated one falls through to a streaming byte
counter that rejects the same way without buffering the file. The limit
covers operator uploads only — the report `sync` path is uncapped (upstream
export size is the operator's own config) — and a rejected import never
touches D1. Pinned by `test/snapshotImportEdges.test.ts`.

## Unsupported snapshot import media type (`unsupported-media-type`)

`POST /api/v1/{customer,address,container}-snapshot/import` accepts raw CSV
bytes with `Content-Type: text/csv` or `application/octet-stream` (media types
are case-insensitive; parameters such as `charset=utf-8` are allowed). A request
with a body and any other or missing media type returns 415
`application/problem+json` after snapshot authentication, the size check and the
empty-body check, and before the body is read or D1 is changed. A POST with no
body keeps its 400 empty-body response. The response uses a fixed detail and
does not echo submitted bytes. Pinned by `test/snapshotImportEdges.test.ts`.

## Archive replaced during a readback (`conflict`)

`GET /api/v1/snapshots/{table}/{date}` reads the R2 archive twice: once to
measure the re-encoded body's exact length and ETag, then again to stream it,
conditional on the stored ETag. If a sync replaces that date's object between
the two reads, the route returns 409 `application/problem+json` naming the table
and date and streams nothing. Retry the download; the next attempt measures the
current object. The readback never modifies the stored object.

## Query-param allowlist (load-long-modal probe)

`GET /api/v1/routeware/customer/load-long-modal` forwards only `customerID`
upstream to `GET /WebRW/Customer/LoadLongCustomerModal` (same allowlist
pattern as the reports probe above). Unknown params are silently dropped.
Unlike the reports probe, `customerID` is required: a missing, empty, or
non-positive-integer value is a 400 naming the required param, and no upstream
fetch is made.

## Login-page fetch (sessionless probe)

`GET /api/v1/routeware/account/login-page` fetches the fixed `LOGIN_URL` with
no session (`forwardToUpstream(..., null, ...)` in `src/routes/routeware.ts`):
it never calls `readSessionState` or `establishSession`, never reads or writes
the primary `AuthSession` state, sends no `Cookie` upstream, and strips
upstream `Set-Cookie` before responding (`docs/CONVENTIONS.md` § 4), so the
probe can neither leak nor plant the shared Routeware session. Pinned by
`test/loginPageSessionIsolation.test.ts`.

Usage notes:

- The route is bearer-gated like every `/api/v1/*` route except
  `GET /api/v1/health` — it is not a public probe. Unauthenticated calls 401
  at the outer gate and count toward the per-IP `rate-limited` budget above.
- Each authorized call makes exactly one upstream `GET` (no session-retry
  loop), and the client query string is never forwarded — the upstream URL is
  fixed. A valid token clears the caller's own per-IP throttle bucket
  (`auth-throttle:<ip>`), which is separate storage from the primary session
  state this route never touches.

## Query-param allowlist (reports probe)

`GET /api/v1/routeware/reports/query-request-is-complete` forwards only an
explicit allowlist upstream to `GET /WebRW/Reports/QueryRequestIsComplete`:
`requestID` (the one-time report request id the browser generates per
download) and `_` (the SPA's cache-buster timestamp). Any other query param is
silently dropped — never forwarded, never an error — so arbitrary client input
cannot reach Routeware as new query surface. Matching is case-sensitive.
Unknown params therefore need no problem+json `type`: there is no failure to
report.

## Customer delete (`method-not-allowed`)

Routeware WebRW exposes no hard delete for customers, so
`DELETE /api/v1/routeware/customer` always answers `405` with a
`method-not-allowed` problem+json body. This is the one canonical reference
for that limitation: the OpenAPI descriptions in [`src/app.ts`](../src/app.ts)
and [`src/routes/customer.ts`](../src/routes/customer.ts) document the same
disable-via-save pattern.

Retire a customer by disabling it instead — the disable-via-save pattern:

1. `GET /api/v1/routeware/customer/load-long-modal?customerID={id}` loads
   the edit form and the required field set for the customer.
2. `POST /api/v1/routeware/customer/save-long-form` with an
   `application/x-www-form-urlencoded` body, resubmitting the loaded fields
   with `Enabled=false`:

```bash
curl -X POST http://localhost:8787/api/v1/routeware/customer/save-long-form \
  -H "Authorization: Bearer <SHADOW_API_TOKEN>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "CustomerID=42" \
  --data-urlencode "CustomerTypeID=1" \
  --data-urlencode "CompanyName=ExampleCo" \
  --data-urlencode "FirstName=Jane" \
  --data-urlencode "LastName=Doe" \
  --data-urlencode "Enabled=false"
```

Notes:

- The anti-forgery `__RequestVerificationToken` may be omitted — it is
  filled server-side from the Routeware modal HTML (see
  `CUSTOMER_SAVE_AUTO_TOKEN`). Send every other field the loaded record
  requires, not just the five above.
- A failed upstream save surfaces as 502 problem+json, never as a silent
  200. A successful disable also refreshes the customer snapshot/D1 and
  evicts the data-entity cache for the affected id.

Pinned by `test/problemAnchors.test.ts` (the 405 shape) and
`test/routewareSaveStaleCache.test.ts` (the disable flow).

## Session refresh timeouts (`bad-gateway`, title "Session refresh timed out")

Only one login runs at a time per `AuthSession` instance (the refresh lock).
A request that arrives while another request is refreshing waits up to 90s
for the fresh session — the waiter budget is derived from the 120s lock TTL
so it covers a worst-case ~47s browser login; if the holder never
publishes (hung login), the waiter
answers as 502 problem+json — never by forwarding with the expired cookie,
which would surface upstream login HTML as a 200.

## Blocked login page (`bad-gateway`, title "Upstream login unavailable")

The HTTP login GETs the login page (and the Ext.NET init script) for the
anti-forgery token. When upstream answers either GET with a non-200 — a WAF
block or maintenance page (403/500/…) — the login fails fast as 502
problem+json naming the upstream status, with zero Browser Rendering launches:
a blocked page carries no token because there is no form, so falling back to
the browser would burn Browser Rendering budget misdiagnosed as a markup
change. A genuine 200 page with no token keeps the old behavior (treated as a
markup change, browser fallback in auto mode). The 502 detail carries only the
status number — never URL, body, or PII.

## Save dry-run without a session (`failed-precondition`)

A `POST /api/v1/data/*?dryRun=true` with no usable Routeware session fails
closed as 503 `failed-precondition` problem+json: dry runs validate against
the stored session only and never establish one (no login POST, no
`establishSession` call). Run any live request first to establish a session,
then retry the dry-run; an empty body still 400s before the session check.
See the [dry-run recipe](CONSUMER-QUICKSTART.md#dry-run-recipe-validate-fix-save).

## Missing Set-Cookie capability (`misconfigured`, title "Service Unavailable")

The HTTP login merges upstream `Set-Cookie` via `Headers.getSetCookie`. When
the runtime has no `getSetCookie`, the login fails fast as 503
problem+json with a fixed detail — never an empty jar, never a silent flip to
Browser Rendering (`auto` mode) or a bare login failure (`http` mode): there
are no cookies to fall back from, so a browser retry would burn Browser
Rendering budget on a platform gap, not a markup change. The detail carries
only the fixed capability message — never URL, body, cookie, or PII.
