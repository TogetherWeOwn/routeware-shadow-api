# Consumer quickstart

Read production Routeware data through the shadow API: authenticate, read
snapshots, write through Routeware, and handle the no-DELETE rule. Every
happy-path command below was validated against local dev (`wrangler dev`,
`http://localhost:8787` — replace the origin with your deployment for normal
use). Keep the deliberate error recipes in step 6 local-only.

Operator setup (secrets, D1 migrations, report sync) is out of scope here:
see [`README.md`](../README.md) and [`CUSTOMER_SNAPSHOT.md`](../CUSTOMER_SNAPSHOT.md).
Error catalog: [`PROBLEMS.md`](./PROBLEMS.md).
Full machine-readable spec: `GET /openapi.json` (interactive UI at `/docs`;
both gated by `OPENAPI_DOCS_ENABLED`).

## 0. Check the service is up (no token needed)

`GET /api/v1/health` is the only public route:

```bash
curl http://localhost:8787/api/v1/health
# {"status":"ok","service":"routeware-shadow-api","version":"1.0.0"} — HTTP 200
```

Anything else means the Worker is not running (`npm run dev`).

## 1. Authenticate: bearer roles

Use the least-privileged configured token supplied by your operator. Every
`/api/v1/*` route except the health check needs one
`Authorization: Bearer <token>` header:

| Token | Unlocks |
|---|---|
| `SHADOW_API_READ_TOKEN` (optional read-only role) | Non-privileged **GET** operations only; never POST reads or privileged GETs |
| `SHADOW_API_TOKEN` (general/full) | Snapshot list/by-id reads, all `/api/v1/routeware/*` forwards, health/readiness probes |
| `CUSTOMER_SNAPSHOT_SYNC_SECRET` (privileged) | Everything above, **plus** sync/import, snapshot exports/erasure, orphan checks, archives and all `/api/v1/data/*` reads/writes |

The general token falls back to `CUSTOMER_SNAPSHOT_SYNC_SECRET` when unset;
the sync secret also passes the outer gate when a distinct general token is
configured. A privileged operation checks that **same bearer** at the inner
gate. Distinct general and read tokens 401 there even on GET. Do not send
multiple credentials or interpret OpenAPI security entries as combined roles.

### Discover operations before choosing a tool

The enabled, mounted `/openapi.json` document is the source of truth. Each
`/api/v1` operation has the following compact discovery projection (example:
`GET /api/v1/customer-snapshot`):

```json
{
  "operationId": "listCustomerSnapshot",
  "x-access": "read",
  "x-effect": "local-read"
}
```

`operationId` is a unique, stable lowerCamelCase identifier, explicitly kept
with the route definition (including existing `health` and
`listCustomerSnapshot`). `x-access` describes authorization, **not effects**:

| `x-access` enum | Required bearer |
|---|---|
| `public` | None; only `GET /api/v1/health` (its `security: []` overrides the global bearer requirement) |
| `read` | Read-only token on GET, general/full token, or sync secret |
| `full` | General/full token or sync secret; includes **POST reads** |
| `sync-secret` | Sync secret only, through both gates; includes privileged GETs |

`x-effect` describes intended application-data effects, **not authority,
idempotency, replay safety or a guarantee of refresh success**:

| `x-effect` enum | Data effect |
|---|---|
| `none` | Liveness or unsupported-operation response; no application data access |
| `local-read` | D1/R2/config reads only; no upstream data request |
| `upstream-read` | Routeware read, including POST reads; may establish/renew the upstream session |
| `local-write` | Local D1 mutation without writing Routeware; imports may also archive to R2 |
| `upstream-read-local-sync` | Routeware report read plus local D1 sync and optional R2 archive |
| `upstream-write-local-refresh` | Routeware write plus best-effort D1/cache refresh, not an atomic guarantee; `/data/*` responses report `localSync`, passthrough saves do not |

For example, `POST /api/v1/routeware/customer/customers-read` is
`full` + `upstream-read`, while `GET /api/v1/data/customer` is
`sync-secret` + `local-read`. Method alone predicts neither access nor
effects. These classes exclude incidental auth-throttle bookkeeping and
session maintenance; `upstream-read` does not promise no side effects in the
upstream application (for example starting a report job).

The document root's `x-agent-metadata: {access, effect}` contains a one-line
legend keyed by these exact enum values. Unknown or missing metadata should
stop tool selection, not default to public/read-only access. No role,
credential, endpoint or execution authority is created by these annotations.

Credential-free check (no running Worker, live tenant or `.dev.vars` needed):

```bash
npm run check:openapi-agent-metadata
```

This validates completeness/uniqueness against the **actual mounted router
and document**, plus classification against hermetic authorization probes.
It is also included by the existing `npm test` / `npm run test:coverage`
Vitest discovery; it does not publish a static spec or generate a client.
`OPENAPI_DOCS_ENABLED` still gates `/openapi.json` and `/docs` unchanged.

```bash
export TOKEN=<paste-either-token>
export SYNC=<paste-CUSTOMER_SNAPSHOT_SYNC_SECRET>

# Wrong or missing token → 401 problem+json, never an empty body:
curl -s http://localhost:8787/api/v1/customer-snapshot?limit=1
# {"type":".../PROBLEMS.md#unauthorized","title":"Unauthorized","status":401,...}
```

Too many bad tokens from one IP trips per-IP throttling (HTTP 429 for 60 s);
a valid token always passes and resets the counter. See
[`PROBLEMS.md`](./PROBLEMS.md#rate-limited).

## Exact next-page signal

Opt in with `exactNext=true` on the ordinary customer, address or container
snapshot list to stop at the last nonempty page, even when its size equals
`limit`. Default/`false` keeps the existing full-terminal false positives.
Concurrent inserts/deletes can still change later pages: this is **not snapshot
isolation**, even with `upperId`.

```bash
# Synthetic local fixture with three enabled customer IDs 11, 23, 37.
# TOKEN is your existing local read credential; no production credential needed.
curl -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?enabled=true&fields=customer_id&limit=2&includeTotal=false&exactNext=true"
# {"rows":[{"customer_id":11},{"customer_id":23}],"total":null,"nextCursor":23}
# Follow the relative Link unchanged; total null means deliberately not computed.
curl -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?enabled=true&fields=customer_id&limit=2&includeTotal=false&exactNext=true&cursor=23"
# rows [37], total null, nextCursor null, no Link: stop.
```

The single page SELECT fetches at most `limit+1` (501 max), returns at most
`limit`, and leaves the lookahead row eligible for the next stateless query. The cursor is the
last returned canonical ID even with sparse fields; offset-first, either order,
all filters and `upperId` work unchanged. `includeTotal=false` still skips every
COUNT. No-store and ETag/304 Link parity remain intact. Send exactly one
`exactNext=true` or `false`; invalid/repeated values fail value-free 400 before
D1 after auth. Relative links retain true, never false/default or unknown keys.
`countOnly=true` wins over `exactNext=true`: one COUNT, no page SELECT or
lookahead, empty rows, null cursor and no Link. `strictQuery=true` accepts
`exactNext` and remains enabled in continuation links.
Run `npm run check:snapshot-exact-next` for the credential-free local contract;
see the [query policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-next-page-signal-opt-in).
No staging/production probes or performance claims are part of this recipe.

## 2. First 200: snapshot reads

Snapshots are the daily Routeware CSV reports cached in D1 — the fast path
that never touches upstream. Customer → address → container:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?limit=2"
# HTTP 200 — {"rows":[...],"total":N}

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/address-snapshot?limit=2"

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/container-snapshot?limit=2"
```

List filters: `?q=<substring>` (company/first/last name on customers; stored street/city/zip on addresses;
location/serial/city/zip on containers), `&enabled=true|false|any`
(default `any`), `&limit=1..500` (default 50), `&offset=`. Address lists
also accept `customerId` / `pickupAddressId`, exact `routeId` / `franchiseId`
scopes ([synthetic scoped-page recipe](#address-route-and-franchise-scopes)),
exact stored `zip` / `city` / `state` selectors ([synthetic ZIP-page recipe](#exact-stored-address-zip)),
literal stored `driverNote` substring ([synthetic note recipe](#stored-address-driver-note)),
the stored `extrasAllowed=true|false|any` selector ([synthetic selector recipe](#address-stored-extras-allowed-selector)),
mirrored-child `hasContainers=true|false|any` presence
([synthetic present/absent recipe](#address-container-presence)),
and exact stored `lastAuditDate` / `hasLastAuditDate=true|false|any` audit selection
([synthetic audit-cohort recipe](#stored-address-last-audit-date)). Customer `q` matches any one name column, not an exact identity or cross-column full name
([synthetic name-search recipe](#personal-or-company-name-search)). Every list response includes
`nextCursor` (the last row's primary key on a full page, otherwise `null`);
full terminal pages still return a cursor, followed by an empty page. Pass it
back as `&cursor=` instead of `offset` to page deep result sets by primary-key
seek — `offset` re-scans everything before it, `cursor` does not:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?limit=500&cursor=50000"
# {"rows":[...],"total":...,"nextCursor":50500} — pass 50500 as the next cursor
# Stop on null from a partial page or the empty page after a full terminal page.
```

### Stored address driver note

Use `listAddressSnapshot` with `driverNote` when you know a fragment of the
stored access note. It searches **only `driver_note`**: comments and locality
cannot satisfy it. Use `q` for street/city/ZIP substrings, or `city`/`state`/`zip`
for exact stored locality; combine them with driverNote for an AND intersection.
This finds stored text, not a scheduling/accuracy guarantee or an instruction
execution service. Never log notes, search values or continuation targets.

Send one URL-encoded fragment of at most 100 Unicode code points measured
before trimming. Boundaries are trimmed, blank means omitted, null notes act
as empty; SQLite folds ASCII case only, so non-ASCII case variants remain
distinct. `%`, `_`, quotes and Unicode are literal, never wildcards.
Repeated/overlength keys receive fixed value-free 400 correction before D1,
after auth; see [recovery](PROBLEMS.md#stored-address-driver-note-bad-request).

Synthetic local example: sites 11 and 23 have `driver_note="Use side gate %_雪"`;
a street/comment-only decoy does not match. With sparse fields, note contents
need not be returned:

```text
GET /api/v1/address-snapshot?driverNote=side+gate+%25_%E9%9B%AA&fields=address&limit=1&includeTotal=false
{"rows":[{"pickup_address_id":11,"address":"11 Example St"}],"total":null,"nextCursor":11}
Link: </api/v1/address-snapshot?driverNote=side+gate+%25_%E9%9B%AA&fields=address&limit=1&includeTotal=false&cursor=11>; rel="next"
```

Follow the relative Link unchanged on the same origin: next comes site 23,
then an empty terminal page. Duplicate notes never collapse sites. Explicit
`order=desc`, `upperId`, and other filters survive next Links; offset becomes
seek, and blank driverNote is omitted. COUNT/page share scope; count-free is
zero COUNTs; ETag/304 and no-store remain unchanged. Note-only queries may
scan: no new index or production performance claim. GET is idempotent and
local-read, no upstream/R2/write effects; CLI `--dry-run` is N/A.

Run `npm run check:address-driver-note` for synthetic local-D1 acceptance and
neighboring regressions; no live credentials or network probe is required.
See [full policy](SNAPSHOT-LIST-QUERY-POLICY.md#stored-address-driver-note).

### Stored address last audit date

Use `listAddressSnapshot` with `lastAuditDate` when you know the exact stored
audit text, or `hasLastAuditDate=false` to count sites with a null-or-empty
stored `last_audit_date`, without downloading every row. Both select **only
`last_audit_date`**: street,
comments, city, ZIP, state, driver notes and coordinates cannot satisfy them.
Combine with route/franchise, locality, `enabled`, `driverNote`, child
presence and traversal bounds for an AND intersection. This finds stored
mirror text, not audit compliance, a schedule, overdue status or permission
to act. Never log audit values or continuation targets.

Send one URL-encoded exact string of 1..100 Unicode code points, preserved
verbatim: case, leading zeros and significant whitespace all matter, and the
value is never parsed as a date, ranged or pattern-matched. Null stored text
never matches; an unknown value returns 200 empty. `hasLastAuditDate=true`
keeps stored text that is present (not null, not empty; whitespace-only
counts), `false` keeps exactly the null-or-empty complement, `any` (default)
adds no predicate; an exact value plus `false` matches nothing.
Blank/whitespace-only, overlength, invalid-enum and repeated keys receive
fixed value-free 400 correction before D1, after auth; see
[recovery](PROBLEMS.md#stored-address-last-audit-date-bad-request).

Synthetic local example: sites 11 and 23 carry
`last_audit_date="2026-01-15"`; a street/comment-only decoy does not match.
Count the audit cohort without returning rows:

```text
GET /api/v1/address-snapshot?lastAuditDate=2026-01-15&countOnly=true
{"rows":[],"total":2,"nextCursor":null}
```

Page the cohort with sparse fields; the audit value need not be returned:

```text
GET /api/v1/address-snapshot?lastAuditDate=2026-01-15&fields=address&limit=1&includeTotal=false
{"rows":[{"pickup_address_id":11,"address":"11 Example St"}],"total":null,"nextCursor":11}
Link: </api/v1/address-snapshot?lastAuditDate=2026-01-15&fields=address&limit=1&includeTotal=false&cursor=11>; rel="next"
```

Follow the relative Link unchanged on the same origin: next comes site 23,
then an empty terminal page. Explicit `order=desc`, `upperId`, a filtering
presence and other filters survive next Links; offset becomes seek, and
`any`/omitted presence stays out. COUNT/page share scope; count-free is zero
COUNTs; ETag/304 and no-store remain unchanged. Audit-date-only reads may
scan: no new index, date-range support or production performance/latency
claim. GET is idempotent and local-read, no upstream/R2/write effects; CLI
`--dry-run` is N/A.

Run `npm run check:address-last-audit-date` for synthetic local-D1
acceptance and neighboring regressions; no live credentials or network probe
is required. See [full
policy](SNAPSHOT-LIST-QUERY-POLICY.md#stored-address-last-audit-date).

### Opt-in query typo detection

On the three ordinary flat lists, add `strictQuery=true` to reject unknown
query names instead of silently broadening the selected cohort. Default
omission or `strictQuery=false` still ignores unknown names. First discover
supported query names from that list's mounted OpenAPI operation; sibling
resource selectors are not interchangeable.

Local synthetic fixture only (reuse your configured read token; no live data):

```bash
# HTTP 200: the normal sparse/count-free page, now with typo detection.
curl -sS -D - -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8787/api/v1/customer-snapshot?strictQuery=true&fields=company_name&limit=2&includeTotal=false'
# {"rows":[...],"total":null,"nextCursor":...} — null means deliberately not computed.
# HTTP 400 before any D1 query: deliberate misspelling, not a filter.
curl -sS -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8787/api/v1/customer-snapshot?strictQuery=true&custmerId=101'
```

On 400, use supported names from the mounted OpenAPI operation, remove unknown
keys, or explicitly set `strictQuery=false` if leniency is intentional. Problems
and app logs never echo unknown names or values. Send the control once as exact
`true` or `false`; empty, invalid or repeated values fail even alongside false.
Known invalid controls still fail in either mode, and authentication stays first.
Follow returned relative next Links unchanged against the same origin: they keep
`strictQuery=true` with filters, fields and direction, replacing cursor and
omitting offset; false/default is omitted. A full terminal page may link to an
empty page. Counts, ETags/304, no-store and read-token access are unchanged.
This option is not added to changes, by-ID, hydrated, archive, export or POST
operations. GET is an idempotent local read; CLI `--dry-run` is N/A.

Credential-free verification: `npm run check:snapshot-strict-query`.
See [policy and no-echo problem](SNAPSHOT-LIST-QUERY-POLICY.md#opt-in-typo-detection-strictquery)
and [correction guidance](PROBLEMS.md#opt-in-list-query-keys-bad-request).

### Stored container locality

For synthetic local fixtures, seed enabled containers 10, 20 and 30 with
`zip="02139"`, `city="Cambridge"`, under a parent whose ZIP/city differ.
These filters use the **container's** stored locality, never the parent:

```text
GET /api/v1/container-snapshot?zip=02139&q=Cambridge&fields=city,zip&limit=2&includeTotal=false
{"rows":[{"container_id":10,"city":"Cambridge","zip":"02139"},{"container_id":20,"city":"Cambridge","zip":"02139"}],"total":null,"nextCursor":20}
Link: </api/v1/container-snapshot?zip=02139&q=Cambridge&fields=city%2Czip&limit=2&includeTotal=false&cursor=20>; rel="next"
```

Follow that returned relative Link against the same origin unchanged: the next
page has container 30, a null cursor and no Link. An exactly full terminal page
can instead link to an empty page. Exact `zip` preserves leading zeros, case
and nonblank whitespace; send one URL-encoded value of 1..100 Unicode code
points. `q` trims, treats blank as omitted, and literally searches location,
serial, city OR zip (ASCII case-insensitive, no LIKE wildcards); its raw limit
is also 100 code points. `zip=02139&q=Cambridge` intersects those predicates
with every other scope, rather than expanding to nearby postcodes.

These are idempotent local GETs, not live geolocation or upstream lookups.
CLI `--dry-run` is N/A. Unscoped locality reads scan; there is no dedicated
container ZIP index or production performance claim. Invalid/repeated values
return value-free 400 before D1: correct the named field and retry, never log
raw locality selectors. See [policy and focused check](SNAPSHOT-LIST-QUERY-POLICY.md#stored-container-locality);
run `npm run check:container-locality` using synthetic local D1 only.

Scanning pages without needing an exact count? Pass `includeTotal=false` to
skip the `COUNT(*)` query: the response keeps the same `rows` and
`nextCursor`, but `total` comes back `null` — deliberately not computed, not
zero. Defaults are unchanged: omit the key (or pass `includeTotal=true`) for
today's exact count.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?limit=2&includeTotal=false"
# {"rows":[...],"total":null,"nextCursor":2} — same page, no count query
```

### Count before fetching payloads

To size a mirrored cohort before requesting contact, address or equipment rows,
add `countOnly=true` to any ordinary flat list GET. Synthetic local example
(assume three matching customers above ID 10):

```http
GET /api/v1/customer-snapshot?enabled=true&cursor=10&limit=1&offset=99&countOnly=true
Authorization: Bearer <existing-read-token>

{"rows":[],"total":3,"nextCursor":null}
```

There is no next Link. Exactly one COUNT runs, with zero page/payload SELECTs;
D1 can still scan stored rows. Total retains the existing filters, IDs,
direction-dependent exclusive cursor and inclusive `upperId`. It is a
cursor-relative query-time count, not a traversal total: limit/offset do not
subtract from it. Omit cursor for the whole filtered cohort; keep cursor and
order to count the remaining traversal range. Empty cohorts return zero.
There is no snapshot isolation across requests.

When you need rows instead, remove countOnly (or set `countOnly=false`);
`includeTotal=false` then fetches pages without computing totals. Combining
`countOnly=true` with `includeTotal=false` is a value-free 400 before D1: omit
`includeTotal=false` or set `countOnly=false` and retry. Blank, invalid or
repeated countOnly keys also fail, and every other known parameter still
validates even when no rows are fetched. Existing auth and no-store remain;
ETag/304 hashes the count envelope but still executes a fresh COUNT.

This is local-read only, not an upstream refresh. Run
`npm run check:snapshot-count-only` against synthetic local D1, not live data.
See the [mode comparison and query inventory](SNAPSHOT-LIST-QUERY-POLICY.md#count-only-inspection).

### Exact stored container installation

Resolve equipment by the **container's own** stored `location_address` and
`state` on the existing container list. Supply `locationAddress` (1..200 Unicode
code points) and/or `state` (1..100) once as nonblank case-sensitive opaque exact
strings. Preserve leading zeros, case, punctuation and significant whitespace;
do not normalize postal data. Null never matches and duplicates remain separate
containers. The parent address never substitutes its street or state, even
with `customerId`. Unlike these exact selectors, `q` is a trimmed substring
search of location/serial/city/zip and does **not** search state.

Synthetic local fixture: containers 10, 20 and 30 share `00123 Depot`, `St-01`
under customer 1; their parent has different location/state. A substring-only
`x00123 Depotx`, different-case state and parent-only matches are excluded:

```text
GET /api/v1/container-snapshot?customerId=1&locationAddress=00123+Depot&state=St-01&fields=enabled&upperId=30&limit=2&includeTotal=false
{"rows":[{"container_id":10,"enabled":1},{"container_id":20,"enabled":1}],"total":null,"nextCursor":20}
Link: </api/v1/container-snapshot?customerId=1&locationAddress=00123+Depot&state=St-01&fields=enabled&upperId=30&limit=2&includeTotal=false&cursor=20>; rel="next"
```

Follow that relative Link unchanged against the same origin: the next page has
container 30, `nextCursor:null` and no Link. `order=desc` instead yields 30, 20,
then 10; offset starts also continue by seek. A full terminal page may link to
an empty page. All selectors intersect by AND with `q`, `zip`, identifiers,
IDs, enabled and upperId. Counts are cursor-relative when requested; sparse
fields and conditional ETags/304 work unchanged.

Use `new URLSearchParams({ locationAddress: " O'Ridge 50%_ 雪 ", state: "St-01" })`
to keep reserved characters literal; never concatenate raw data or log query
values. Invalid/repeated/overlength selectors return value-free 400 before D1.
URL-encode one nonblank stored value within the named limit or omit the key,
then retry. These idempotent local GETs do no upstream/R2/write work; CLI
`--dry-run` is N/A. No index/migration, live-location or latency claim: unscoped
location/state equality scans. Run `npm run check:container-exact-location`
with synthetic local D1 only. See the [policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-stored-container-installation).

### Exact stored container city

Select equipment in one stored city with `city` on the existing container
list: one nonblank case-sensitive opaque exact string of 1..100 Unicode code
points. Stored city is mirrored text, not geolocation. Leading zeros, case,
punctuation and significant whitespace are preserved; null never matches and
the parent address city never substitutes, even with `customerId`. Unlike
`city`, `q` is a trimmed ASCII-case-insensitive substring over
location/serial/city/zip, so `q=Killeen` also matches serials, addresses and
zips containing that text — add `city=Killeen` to intersect down to the exact
city cohort.

Synthetic local fixture: containers 10 and 20 store `Killeen` under customer
1; a `xKilleenx` substring row, a lowercase row and parent-only matches are
excluded:

```text
GET /api/v1/container-snapshot?customerId=1&city=Killeen&fields=enabled&limit=1&includeTotal=false
{"rows":[{"container_id":10,"enabled":1}],"total":null,"nextCursor":10}
Link: </api/v1/container-snapshot?customerId=1&city=Killeen&fields=enabled&limit=1&includeTotal=false&cursor=10>; rel="next"
```

Follow that relative Link unchanged against the same origin: the next page has
container 20, `nextCursor:null` and no Link. `city` intersects by AND with
`q`, `state`, `zip`, identifiers, IDs, enabled, parent scopes and upperId;
`order=desc` reverses traversal and offset starts continue by seek. Counts are
cursor-relative when requested; sparse fields and conditional ETags/304 work
unchanged.

Use `new URLSearchParams({ city: " O'Ridge 50%_ 雪 " })` to keep reserved
characters literal; never concatenate raw data or log query values.
Invalid/repeated/overlength selectors return value-free 400 before D1.
URL-encode one nonblank stored value within the limit or omit the key, then
retry. These idempotent local GETs do no upstream/R2/write work; CLI
`--dry-run` is N/A. No index/migration or latency claim: unscoped city
equality scans. Run `npm run check:container-exact-city` with synthetic local
D1 only. See the [policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-stored-container-city).

### Stored customer comment fragment

Use `comments` on `listCustomerSnapshot` to find mirrored notes without
searching company/first/last names (`q`) or stored phone text (`phone`). These selectors
intersect by AND; `comments=handoff&q=North` requires both matches. This GET
uses the existing read-token role and local D1 only; it is idempotent and
`--dry-run` is not applicable.

Send one URL-encoded fragment of at most 100 Unicode code points **before
trimming** boundary whitespace. Blank within the limit means omitted. SQLite
`lower()` folds ASCII A-Z only: non-ASCII case and Unicode composition remain
exact, and quotes, `%` and `_` are literal data, not SQL/wildcards. Stored null
comments never match a nonblank fragment; no stored data is normalized.
Repeated/overlength input returns value-free 400 before D1, after auth; send
one fragment within the limit, or omit comments and retry. Do not log selectors.

**Synthetic local oracle:** customers 11, 23, 37 and 42 contain `handoff` in
their comments (11 uses uppercase). Decoys with the fragment only in their
company or phone fields do not match `comments`.
The following count-free sparse request returns only canonical IDs:

```text
GET /api/v1/customer-snapshot?comments=handoff&fields=customer_id&limit=2&includeTotal=false
200 {"rows":[{"customer_id":11},{"customer_id":23}],"total":null,"nextCursor":23}
Link: </api/v1/customer-snapshot?comments=handoff&fields=customer_id&limit=2&includeTotal=false&cursor=23>; rel="next"
```

Follow that relative Link against the same origin unchanged: the next page
returns 37 and 42 with a Link containing `cursor=42`; follow it to the empty
terminal page with null cursor and no Link. Links retain the validated trimmed
fragment, upperId and direction, never origin/credentials or unknown keys.
Use `order=desc` for descending traversal; an initial offset becomes a seek
cursor in the returned Link. Concurrent writes are not snapshot-isolated.
No dedicated comments index is added; substring-only reads may scan, with no
latency promise. Run `npm run check:customer-comments-search` for the hermetic
local-D1 oracle, including Unicode boundaries, both orders, literal punctuation,
ETags/304, auth/validation zero-work and denied upstream/R2/cache writes.
See the [query inventory](SNAPSHOT-LIST-QUERY-POLICY.md#stored-customer-comment-fragment)
and [fixed error guidance](PROBLEMS.md#stored-customer-comment-fragment-bad-request).

### Exact external account lookup

Resolve an external account reference to canonical `customer_id` values on the
existing `listCustomerSnapshot` operation (read token allowed, local D1 only).
Optional `customerNumber` and `subCustomerNumber` are exact, case-sensitive opaque
strings, not unique keys. Both together mean AND; they also compose with
`customerId`, name-substring `q`, `enabled`, sparse `fields` and pagination.
Leading zeros and supplied nonblank whitespace are significant. Each key must
occur once with 1..100 Unicode code points and not be whitespace-only. Do not
trim, normalize or convert to numbers. Use URLSearchParams (or equivalent URL
encoding) so quotes, `%`, `_`, `+` and `&` remain literal data.

**Synthetic lookup-to-next-page recipe:** the hermetic fixture has two customers,
IDs 1 and 2, with `customer_number` `00042` and `sub_customer_number` `North`.
Request a single ID per page without computing totals:

```text
GET /api/v1/customer-snapshot?customerNumber=00042&subCustomerNumber=North&fields=customer_id&limit=1&includeTotal=false
200 {"rows":[{"customer_id":1}],"total":null,"nextCursor":1}
Link: </api/v1/customer-snapshot?customerNumber=00042&subCustomerNumber=North&fields=customer_id&limit=1&includeTotal=false&cursor=1>; rel="next"
```

Follow that relative Link against the same origin using the follow-next recipe
below. The next page returns ID 2 with `nextCursor: 2` and a Link with `cursor=2`.
Follow it once more: `{"rows":[],"total":null,"nextCursor":null}` with no Link.
A full final page may link to this empty page; stop only when Link is absent.
Do not select an arbitrary first match: business numbers can be duplicated, and
null stored numbers do not match strings. A valid lookup with no matches is
also an HTTP 200 empty collection, not a reason to sync or retry writes.
Omit `includeTotal=false` for the unchanged exact cursor-relative count.

Credential-free verification (no running Worker or live requests):

```bash
npm run check:customer-account-filters
npx vitest run --maxWorkers=2 --disableConsoleIntercept test/customerAccountFilters.acceptance.test.ts -t 'is idempotent, read-only'
```

The second command records bound SELECT shapes and synthetic EXPLAIN plans,
without logging account values; it compares stored rows before/after repeated
reads. The fixture also follows safely encoded Links containing punctuation
and checks zero COUNTs in count-free mode. Current plans scan the synthetic
table; no indexed equality or production latency is claimed. No migrations or
upstream calls are involved. For a 400, correct or omit the named account field
and retry; errors are fixed and value-free even with If-None-Match. See
[correction guidance](PROBLEMS.md#bad-request) and the
[query inventory](SNAPSHOT-LIST-QUERY-POLICY.md#exact-customer-account-numbers).

### Personal or company name search

Find customer rows by personal name without downloading unrelated pages, on
the existing `listCustomerSnapshot` operation (read token allowed, local D1
only). Optional `q` is a literal ASCII case-insensitive substring of at most
100 Unicode code points; SQLite `lower()` folds A-Z only, so non-ASCII case
variants match only on exact case. A row matches when it appears in any one
of `company_name`, `first_name` or `last_name`. Quotes, `%` and `_` are literal
data, never wildcards. There is no full-name, token or fuzzy parsing: a query
spanning first and last name does not match a split row, and a null column
never matches a nonempty `q`. The match AND-composes with every other filter,
and follow-next Links retain `q` verbatim.

Synthetic multi-page recipe, with no running service or real credentials:

```bash
npm run check:customer-name-search
```

The fixture seeds local test D1, then reads
`/api/v1/customer-snapshot?q=needle&enabled=true&fields=first_name&order=asc&limit=2&includeTotal=false`.
Its page IDs are `11,23`, then `42,58`, then the empty terminal page; each
full page returns its last ID as `nextCursor` with a followable Link, and the
empty page carries no Link. `total` is null on every page and each page
executes one SELECT with no COUNT. Other fixtures prove trimmed matching,
blank/omitted-`q` parity, ASCII-only case behavior, literal SQL-shaped text,
100/101-code-point bounds, sparse fields that omit the matched column and
conditional 304s on the final envelope. Synthetic `EXPLAIN QUERY PLAN` still
seeks the customer enabled index for enabled-plus-`q` pages; no new index,
migration or production latency claim is made.

### Stored phone fragment lookup

Resolve which customer owns a phone number from a stored fragment (for
example its last seven digits) on the existing `listCustomerSnapshot`
operation (read token allowed, local D1 only). Optional `phone` is an
ASCII case-insensitive substring over the stored `phone1`/`phone2` text,
matched as stored: SQLite `lower()` folds A-Z only, so non-ASCII case
variants match only on exact case; no normalization, digit-stripping,
trimming or equality fallback.
It AND-composes with `customerId`, customer-name `q`, `enabled`, sparse
`fields` and pagination. Send the key once with 1..100 Unicode code points
and at least one non-whitespace character. Use URLSearchParams (or
equivalent URL encoding) so spaces, quotes, `%`, `_`, `+` and `&` remain
literal data.

**Synthetic lookup-to-next-page recipe:** the hermetic fixture has four
customers whose stored phones contain `5550107`, IDs 11, 23, 37 and 42.
Request two IDs per page without computing totals:

```text
GET /api/v1/customer-snapshot?phone=5550107&fields=phone1&limit=2&includeTotal=false
200 {"rows":[{"customer_id":11,"phone1":"+1 (202) 5550107"},{"customer_id":23,"phone1":null}],"total":null,"nextCursor":23}
Link: </api/v1/customer-snapshot?phone=5550107&fields=phone1&limit=2&includeTotal=false&cursor=23>; rel="next"
```

Follow that relative Link against the same origin using the follow-next recipe
below. The next page returns IDs 37 and 42 with `nextCursor: 42` and a Link
with `cursor=42`. Follow it once more: `{"rows":[],"total":null,"nextCursor":null}`
with no Link. A full final page may link to this empty page; stop only when
Link is absent. Do not stop at the first match: several customers can share
one fragment, and null or empty stored phones never match. A valid lookup
with no matches is also an HTTP 200 empty collection, not a reason to sync
or retry writes. Omit `includeTotal=false` for the unchanged exact
cursor-relative count.

Credential-free verification (no running Worker or live requests):

```bash
npm run check:customer-phone-search
```

The focused command walks encoded continuations to terminal and empty pages,
checks zero COUNTs in count-free mode, replays conditional 304s with the
selector in the URL, and records bound SELECT shapes with synthetic EXPLAIN
plans, without logging phone values; it compares stored rows before/after
repeated reads. Current plans scan the synthetic table; no phone index or
production latency is claimed. No migrations or upstream calls are involved.
For a 400, correct or omit the named phone field and retry; errors are fixed
and value-free even with If-None-Match. See
[correction guidance](PROBLEMS.md#bad-request) and the
[query inventory](SNAPSHOT-LIST-QUERY-POLICY.md#stored-phone-fragment).

### Address route and franchise scopes

Use the existing `listAddressSnapshot` operation to avoid fetching unrelated
addresses. Optional `routeId` and `franchiseId` intersect by AND with one
another and with every old filter. `routeId` must be unpadded ASCII decimal
`0..9007199254740991`; zero is literal stored zero. `franchiseId` is an opaque,
case-sensitive exact string of 1..100 Unicode code points. Preserve leading
zeros and nonblank whitespace; URL-encode it rather than interpolating it
into a URL. Blank/repeated/malformed scopes return the existing value-free
400 before D1 ([correction guidance](PROBLEMS.md#bad-request)); valid no-match
returns 200 empty. Null scope columns never match supplied values.

Synthetic scoped-page recipe, with no running service or real credentials:

```bash
npm run check:address-scope
```

The fixture seeds local test D1, then reads
`/api/v1/address-snapshot?routeId=7&franchiseId=001&fields=enabled&limit=2&includeTotal=false`.
Its first IDs are `20,30`, next IDs `120,130`; it follows the returned Link
unchanged and stops after the final empty page. Every row keeps its address
ID, `total` is null and each page executes one SELECT with no COUNT. The
counted offset/seek cases retain cursor-relative totals and pickup-address-ID
order. Other fixtures prove literal route zero, case/leading-zero distinction,
100 astral code points, nulls, duplicate scope pairs and URL-encoded quotes,
percent, underscore and whitespace. Network-deny and read-only D1/R2 doubles
fail on unexpected side effects. No upstream lookup or write is added.

For a custom synthetic local request, construct the query with
`new URLSearchParams({ routeId: "7", franchiseId: " 雪%_ " })` and use the
[same-origin next-page loop](#follow-the-servers-next-page-target) below.
Scopes, fields and count-free mode round-trip in Link; do not log scope
values or rows. Authentication, no-store, ETags and existing count semantics
remain unchanged. These checks are not deployed performance evidence.

### Stored container-type filter

Use the existing `listContainerSnapshot` operation to fetch one equipment
type without downloading the whole mirrored inventory. Optional
`containerTypeId` is exact equality on the stored snapshot column
`container_type_id` — mirrored CSV state, not a live Routeware lookup —
with no type-name catalog or inference. Send it at most once as one
unpadded ASCII decimal safe integer `0..9007199254740991`; `0` matches
literal stored zero while null stored types never match. The selector
AND-composes with every existing list selector, including parent service-site
scopes, exact equipment labels and installation fields, `upperId`, sparse
`fields` and `includeTotal=false`. It is recognized under `strictQuery=true`
and reused by `countOnly=true` (count only, no page SELECT or next Link).
For row pages, the validated value round-trips in `Link` next targets for
both `asc` and `desc` traversals.

**Synthetic multi-page recipe:** the hermetic fixture holds stored types 0,
5 (twice) and 7 across distinct addresses. Read one row per page:

```text
GET /api/v1/container-snapshot?containerTypeId=5&limit=1
200 {"rows":[{"container_id":9302,...}],"total":2,"nextCursor":9302}
Link: </api/v1/container-snapshot?containerTypeId=5&limit=1&cursor=9302>; rel="next"
```

Follow that relative Link against the same origin: the second page returns
ID 9303 with `total: 1` and `nextCursor: 9303`, whose Link leads to the
terminal empty page (`{"rows":[],"total":0,"nextCursor":null}`, no Link).
A full final page may link to this empty page; stop only when Link is
absent. A valid type with no matches is an HTTP 200 empty collection, not
a reason to sync. Anything but the canonical spelling — empty, padded,
signed, fractional, unsafe, or a repeated key — is the existing value-free
400 before D1 ([correction guidance](PROBLEMS.md#stored-container-type-filter-bad-request));
omit the key to keep today's unfiltered matches.

Credential-free verification (no running Worker or live requests):

```bash
npm run check:container-type-filter
```

The fixture seeds local test D1, traverses real next links in both
directions through the empty tail, and checks zero COUNTs in count-free
mode, sparse fields and conditional ETags without logging submitted
values. No migration, index or upstream call is involved. See the
[type policy](SNAPSHOT-LIST-QUERY-POLICY.md#stored-container-type-filter).

### Address stored extras-allowed selector

Use the existing `listAddressSnapshot` operation to read only sites that
allow (or disallow) extras without transferring every mirrored address.
Optional `extrasAllowed=true|false|any` (default `any`) intersects by AND
with every other filter. `true` matches stored `extras_allowed = 1`, `false`
matches stored `0`, and `any`/omission adds no predicate. The flag is stored
snapshot state from the last sync, not permission to mutate service terms or
proof of current upstream policy. Spelling is exact and case-sensitive, sent
once; malformed, blank or repeated keys return the existing value-free 400
before D1 ([correction guidance](PROBLEMS.md#bad-request)); valid no-match
returns 200 empty.

Synthetic follow-next recipe, with no running service or real credentials:

```bash
npm run check:address-extras-allowed
```

The fixture seeds local test D1, then reads
`/api/v1/address-snapshot?extrasAllowed=true&fields=enabled&limit=2&includeTotal=false`.
Its first IDs are `11,37` with `nextCursor: 37`; it follows the returned
Link unchanged to the final `42` page and stops when no Link is returned.
Every row keeps its address ID, `total` is null and each page executes one
SELECT with no COUNT. Other fixtures prove `any`/omission equivalence,
`false` membership, `customerId`/`pickupAddressId`/`q`/`enabled`
intersections, counted offset/seek with cursor-relative totals, sparse and
conditional reads, strict enum rejection with auth precedence, and `false`
preserved (and `any` omitted) in Link targets. Network-deny and read-only
doubles fail on unexpected side effects. No upstream lookup or write is
added. These checks are not deployed performance evidence.

### Exact stored address ZIP

Use the existing `listAddressSnapshot` operation to read mirrored sites
in one postcode across bounded pages. Follow each returned Link to read every
match. Optional `zip` is an opaque,
case-sensitive exact string of 1..100 Unicode code points over the stored
`zip` column — not a number, prefix or substring. Preserve leading zeros
(`02139` never becomes `2139`) and nonblank whitespace; URL-encode the value
rather than interpolating it into a URL. The selector intersects by AND with
`customerId`, `pickupAddressId`, `routeId`, `franchiseId`, street/locality `q`,
`enabled` and the cursor in both the page and the count. Blank, repeated or
overlength values return the existing value-free 400 before D1
([correction guidance](PROBLEMS.md#bad-request)); a valid ZIP with no matches
returns 200 empty. Stored nulls never match a supplied value.

Synthetic ZIP-page recipe, with no running service or real credentials:

```bash
npm run check:address-zip
```

The fixture seeds local test D1, then reads
`/api/v1/address-snapshot?zip=02139&fields=zip&limit=2&includeTotal=false`.
Its first IDs are `10,20`, next IDs `30,50`, then `120,130`; it follows each
returned Link unchanged and stops after the final empty page. Every row keeps
its address ID with the exact stored ZIP, `total` is null and each page
executes one SELECT with no COUNT. The counted offset/seek cases retain
cursor-relative totals and pickup-address-ID order in both directions. Other
fixtures prove case/leading-zero distinction, padding and embedded whitespace
as data, 100-code-point astral and ASCII boundaries, SQL-looking input that
cannot widen selection, literal `%`/`_`, null exclusion and encoded
Unicode/reserved characters. Network-deny and read-only D1/R2 doubles fail on
unexpected side effects. No upstream lookup or write is added.

For a custom synthetic local request, construct the query with
`new URLSearchParams({ zip: "02139" })` and use the
[same-origin next-page loop](#follow-the-servers-next-page-target) below.
The ZIP, fields and count-free mode round-trip in Link; do not log ZIP values
or rows. Authentication, no-store, ETags and existing count semantics remain
unchanged. These checks are not deployed performance evidence.

### Exact stored street address

Use `listAddressSnapshot` with `streetAddress` to resolve a known stored
street to **all** matching canonical `pickup_address_id` values. Unlike `q`,
this is case-sensitive exact equality on the stored `address` column, never
a city/ZIP or partial-street match. Duplicate streets are not unique sites;
follow every returned relative Link unchanged on the same origin.

Send one opaque string of 1..200 Unicode code points containing a non-whitespace
character. Preserve nonblank whitespace, leading zeros and punctuation. Use
`new URLSearchParams({ streetAddress: "001 Cedar St", fields: "address", limit: "2", includeTotal: "false" })`,
not string interpolation. A synthetic request and first response are:

```text
GET /api/v1/address-snapshot?streetAddress=001+Cedar+St&fields=address&limit=2&includeTotal=false
{"rows":[{"pickup_address_id":10,"address":"001 Cedar St"},{"pickup_address_id":20,"address":"001 Cedar St"}],"total":null,"nextCursor":20}
Link: </api/v1/address-snapshot?streetAddress=001+Cedar+St&fields=address&limit=2&includeTotal=false&cursor=20>; rel="next"
```

Run the credential-free synthetic local-D1 recipe:

```bash
npm run check:address-street-exact
```

The exact-street fixture follows IDs `10,20`, then `30,50`, then `120,130`,
then a terminal empty page. Descending traversal reverses that order. Each
count-free page performs one SELECT and zero COUNTs. Additional cases prove
literal Unicode/quotes/%/_, significant whitespace, duplicate sites, null
exclusion, 200-code-point boundaries, SQL binding, every selector intersection,
offset-to-seek links, `upperId`, sparse fields and representation ETags/304.
Network, R2 and request-boundary writes are denied by the oracle.

Omission preserves existing behavior; a valid nonmatch returns 200 empty.
Empty, whitespace-only, overlength or repeated values fail after auth and
before D1 with a value-free problem: URL-encode one nonblank stored street
value or omit streetAddress and retry. Do not log streets, response rows or
continuation URLs. `q` remains the trimmed ASCII-case-insensitive substring
across street/city/ZIP and intersects by AND when combined with streetAddress.
There is no address normalization, postal verification, geocoding or uniqueness
claim. Equality may scan without a dedicated index. This GET is an idempotent
local read; `--dry-run` is N/A. No deployment, live lookup or adoption is
established by this local check. See the
[query policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-stored-street-address) and
[correction guidance](PROBLEMS.md#exact-stored-street-address-bad-request).

### Exact stored container stream/color labels

Use `listContainerSnapshot` with optional `materialStream` (stored
`ud_material_stream_ud`) and/or `color` (stored `color`) to select a known
inventory label without downloading every container. These are opaque,
case-sensitive exact strings of 1..100 Unicode code points containing a
non-whitespace character, not inferred waste categories or a vocabulary.
Preserve leading zeros, significant whitespace and punctuation. URL-encode
one supported-length nonblank label per key, or omit the selector and retry
if no label scope is intended. Empty, whitespace-only, repeated or overlength
keys fail value-free after authentication and before D1; valid unknown labels
return an empty 200. Null never matches a supplied label.

Agent-runnable synthetic recipe, no service/credentials needed:

```bash
npm run check:container-labels
```

The fixture's `materialStream=001&color=Blue&fields=color&limit=1&includeTotal=false`
request returns ID 101, then 104 and 105 by following the server's same-origin
Link unchanged, then an empty terminal page. Labels AND-intersect with each
other and every existing filter, on both customer-join paths. Significant
whitespace, quotes, `%`, `_` and Unicode survive encoded next links. For a
custom local fixture, use
`new URLSearchParams({ materialStream: "001", color: "Blue" })`; do not
interpolate labels or reconstruct continuation URLs. Sparse `fields` uses
`ud_material_stream_ud` for the stream column, not `materialStream`.

`includeTotal=false` performs zero COUNTs; canonical IDs, `upperId`, ascending
and descending traversal, no-store and representation ETags remain unchanged.
Equality may scan: no index or performance guarantee is added. GET is an
idempotent local-read; CLI `--dry-run` is N/A. The recipe uses synthetic local
D1 and denies unexpected network/R2/browser/writes; it is not deployment,
adoption or performance evidence. See the
[label policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-stored-container-labels) and
[400 recovery](PROBLEMS.md#exact-stored-container-labels-bad-request).

### Container parent service-site cohorts

Use `listContainerSnapshot` with `parentRouteId`, `parentFranchiseId` and/or
`parentEnabled=true|false|any` to retrieve equipment for a known mirrored
service-site cohort without fetching all addresses. These select the parent
address only, never equipment `route_ids`/`frequency_ids` or customer enabled.
Container `enabled` is independent: `parentEnabled=true&enabled=false` means
disabled equipment at enabled sites, not an assignment change.

Send each key once. Route IDs are canonical unpadded ASCII decimals
`0..9007199254740991`, with zero literal. Franchises are case-sensitive opaque
nonblank strings of 1..100 Unicode code points; preserve leading zeros and
significant whitespace. Encode with `new URLSearchParams({ parentRouteId:
"7", parentFranchiseId: "001", parentEnabled: "true" })`. Invalid, blank,
overlength or repeated keys fail value-free before D1 after auth; correct the
named format and retry. Valid no-match is an empty 200.

Run the credential-free synthetic recipe (no server or real records needed):

```bash
npm run check:container-parent-scopes
```

The oracle's `parentRouteId=7&parentFranchiseId=001&parentEnabled=true&fields=enabled&limit=2&includeTotal=false`
request returns containers `[20,30]`, then `[60,160]`, then `[170,210]` and an
empty terminal page. Follow the returned [same-origin Link](#follow-the-servers-next-page-target)
unchanged; validated parent selectors stay encoded, `parentEnabled=any` is
omitted, and neither raw origins nor unknown query keys are copied.

Effective parent scopes share the customerId address join, excluding missing
parents without duplicating siblings. Omission/any alone preserves the old
unjoined list and orphan visibility. All selectors AND-compose with existing
IDs, labels, locality, equipment state and cursor/upper bounds. Sparse fields,
container-ID order, count-free reads and representation ETags/304 stay intact.
The recipe denies outbound fetch/R2/writes and checks both traversal directions.
Equality can scan; no new index, deployment, production latency or assignment
accuracy is claimed. GET is idempotent local-read, CLI dry-run N/A. See the
[query policy](SNAPSHOT-LIST-QUERY-POLICY.md#container-parent-service-site-scopes)
and [400 recovery](PROBLEMS.md#container-parent-service-site-scopes-bad-request).

### Container serial and RFID presence

Use `listContainerSnapshot` with `hasSerialNumber=true|false|any` and/or
`hasRfid=true|false|any` (default `any`) to count tagged versus untagged
equipment without reading every identity value. `true` keeps only rows whose
stored column reads present (`IS NOT NULL AND <> ''`); `false` keeps only
null-or-empty stored text. Nonempty whitespace-only text counts as present.
The two controls AND-compose with each other and with exact `serialNumber`/
`rfid`; an exact value plus its presence=`false` yields an empty 200, while
omission/`any` adds no predicate. Invalid, blank or repeated keys fail
value-free before D1 after auth ([correction
guidance](PROBLEMS.md#container-serial-and-rfid-presence-bad-request)).

Stored identity text is mirrored report data, never a live tag scan,
deployment proof or uniqueness guarantee; missing text includes report gaps,
not only untagged equipment. Unscoped presence reads stay join-free, so
null-parent rows keep their orphan visibility. Presence filters may scan; no
index, migration or performance promise.

Tagged-vs-untagged count-only recipes (synthetic local service, `$TOKEN` only):

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/container-snapshot?hasSerialNumber=true&countOnly=true"
# {"rows":[],"total":8,"nextCursor":null} — tagged-equipment count, no rows

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/container-snapshot?hasSerialNumber=false&countOnly=true"
# {"rows":[],"total":5,"nextCursor":null} — untagged-or-gap count, no rows
```

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/container-snapshot?hasRfid=true&countOnly=true"
# {"rows":[],"total":8,"nextCursor":null} — RFID-present count, no rows

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/container-snapshot?hasRfid=false&countOnly=true"
# {"rows":[],"total":5,"nextCursor":null} — RFID-missing count, no rows
```

Present-first multi-page traversal over the same fixture:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/container-snapshot?hasSerialNumber=true&hasRfid=true&limit=2"
# {"rows":[...],"total":6,"nextCursor":206} — follow the Link target unchanged:
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/container-snapshot?hasSerialNumber=true&hasRfid=true&limit=2&cursor=206"
# {"rows":[...],"total":4,"nextCursor":208} — stop on null nextCursor / no Link
```

The [query-policy inventory](SNAPSHOT-LIST-QUERY-POLICY.md#container-serial-and-rfid-presence)
pins the AND-composition with parent scopes, IDs, material/color, locality,
`q` and equipment state, byte-identical `any`/omitted behavior, count-free
zero-COUNT mode and sparse/conditional reads. Run
`npm run check:container-serial-rfid-presence` for the hermetic local-D1
contract: real D1 fixtures pin NULL/empty/whitespace semantics, exact-plus-
presence intersection and contradiction, both seek directions and Link
round-trips through terminal and empty pages. These checks are not deployed
performance evidence.

### Exact stored address city and state

Use `listAddressSnapshot` with optional `city` and/or `state` to select an
exact stored cohort, not substring false positives. Each selector is a
case-sensitive opaque string of 1..100 Unicode code points containing a
non-whitespace character. Preserve nonblank supplied whitespace, punctuation
and Unicode spelling; do not trim, normalize abbreviations or coerce numbers.
Stored nulls never match supplied strings. Omission keeps current results;
a valid no-match is 200 empty. This is equality, while `q` remains the
street/city/zip substring search and does not search state.

Both selectors AND-compose with each other, `zip`, route/franchise,
customer/primary IDs, `enabled`, `hasContainers`, `q` and cursor/`upperId`
bounds. Counted pages keep cursor-relative totals; `includeTotal=false`
executes one page SELECT and no COUNT. Sparse rows keep their primary ID;
ETags still describe the returned representation. City/state-only equality
may scan without a dedicated index: no latency or index-use promise, no
geographic inference. This GET is idempotent/local-read; CLI `--dry-run` is N/A.

Hermetic synthetic test recipe (no running service or real credentials):

```bash
npm run check:address-city-state
```

For a custom synthetic local service, encode one value per key. This example
keeps the spaces and reserved characters as data; it need not match any row:

```bash
curl --get --include -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "city= 雪'\"%_ /+?&#🚛 " \
  --data-urlencode "state= Ω'\"%_ /+?&#🌿 " \
  --data-urlencode 'fields=city,state' \
  --data-urlencode 'includeTotal=false' --data-urlencode 'limit=1' \
  'http://localhost:8787/api/v1/address-snapshot'
# Follow the returned relative Link target unchanged; it replaces cursor,
# drops offset and retains both encoded selectors. Stop when Link is absent.
```

Use the [same-origin continuation loop](#follow-the-servers-next-page-target),
not a rebuilt URL or an unvalidated foreign target. Do not log selectors,
rows or credentials. Blank, whitespace-only, repeated or overlength values
return the existing value-free 400 before D1 (authentication first): correct
the named field, URL-encode one nonblank value and retry without trimming it.
See [correction guidance](PROBLEMS.md#bad-request) and the
[query policy](SNAPSHOT-LIST-QUERY-POLICY.md#exact-stored-address-city-and-state).
The focused check proves both seek directions, terminal/empty pages, composed
filters, opaque Link traversal, zero-work invalid/auth requests and conditional
reads on real local D1; it is not deployed performance or adoption evidence.

### Customer address presence

Use the existing read-token-compatible `listCustomerSnapshot` operation to
select customers with (`hasAddresses=true`) or without (`hasAddresses=false`)
mirrored service sites, without downloading child rows. `any`/omission keeps
the unfiltered behavior. Every stored address counts, including disabled
children; customer `enabled` stays independent. Send one exact supported
value, or omit the selector and retry a value-free 400. Authentication is
first; malformed/empty/repeated values do no D1 work.

Synthetic local recipe: with customers 11–16, seed an address for 12, three
for 13 (mixed enabled), one disabled-only for 14, and none for 11, 15 or 16.
Use only a local fixture service and its `$TOKEN`, not production data.
The focused suite below creates this fixture automatically in test D1.

```bash
curl -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?hasAddresses=true&limit=1&fields=enabled&includeTotal=false"
# {"rows":[{"customer_id":12,"enabled":1}],"total":null,"nextCursor":12}
# Follow the returned relative Link unchanged on this same localhost origin:
curl -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?hasAddresses=true&fields=enabled&limit=1&includeTotal=false&cursor=12"
# Next: 13, then 14, then an empty terminal page; stop when Link is absent.
```

```bash
curl -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?hasAddresses=false&limit=2"
# {"rows":[...],"total":3,"nextCursor":15} — customer IDs 11,15; Link retains false
# Follow the Link to ID 16; the partial page has nextCursor=null and no Link.
```

No mirrored address is **not proof of no upstream site** and never authorizes
deletion, reconciliation or sync. GET is an idempotent local D1 read, not an
upstream call; CLI `--dry-run` is N/A. Rows stay flat and unique per customer.
The selector composes with existing filters, either paging direction,
`upperId`, sparse fields and representation-correct ETag/304. Counted totals
are cursor-relative; `includeTotal=false` runs zero COUNTs. No snapshot
isolation is promised across concurrent writes.

Run `npm run check:customer-address-presence` for synthetic local-D1 selection,
validation/auth, full Link traversal and conditional-read regressions. The
acceptance suite executes EXPLAIN on both emitted COUNT/page statements and
checks the existing child `idx_address_snapshot_customer_id` SEARCH, for both
true/false. This is local planner evidence only, not a production latency
claim. No migration, new index, deployment or live probe. See the
[query policy](SNAPSHOT-LIST-QUERY-POLICY.md#customer-address-presence) and
[400 correction guidance](PROBLEMS.md#customer-address-presence-bad-request).

### Customer stored-phone presence

Use the existing read-token-compatible `listCustomerSnapshot` operation to
select customers by stored primary/secondary phone text, without downloading
every customer's phone values. Optional `hasPhone1=true|false|any` and
`hasPhone2=true|false|any` (default `any`) test the stored slot as stored:
`true` keeps rows where the slot is present (`IS NOT NULL AND <> ''`),
`false` keeps the exact null-or-empty complement. Both flags AND-compose
with each other and every existing customer selector, so
`hasPhone1=false&hasPhone2=false` finds customers with no stored phone text
in either slot. Whitespace-only stored text counts as present: no trimming,
normalization, digit-stripping or number validation. Stored presence is **not**
a valid number, a preferred channel, contact consent, deliverability or
reachability, and never authorizes outreach or provider lookups. Send each
supported key once as `true`, `false` or `any`, or omit it; invalid, blank,
repeated or case-variant values return the existing value-free 400 before D1
(authentication first).

Synthetic local recipe: with customers 11–16, store `phone1` only for 12 and
14, `phone2` only for 13, both for 15, and neither (null/empty) for 11 and
16. Use only a local fixture service and its `$TOKEN`, not production data.
The focused suite below creates a larger fixture automatically in test D1.

```bash
curl -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?hasPhone1=false&hasPhone2=false&countOnly=true"
# {"rows":[],"total":2,"nextCursor":null} — customers 11 and 16, no row payloads
```

```bash
curl -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?hasPhone1=true&hasPhone2=false&limit=1&fields=enabled&includeTotal=false"
# {"rows":[{"customer_id":12,"enabled":1}],"total":null,"nextCursor":12} — Link retains both flags
# Follow the returned relative Link unchanged on this same localhost origin:
curl -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?hasPhone1=true&hasPhone2=false&fields=enabled&limit=1&includeTotal=false&cursor=12"
# Next: 14, then an empty terminal page; stop when Link is absent.
```

GET is an idempotent local D1 read, not an upstream call; CLI `--dry-run`
is N/A. Counted totals are cursor-relative; `includeTotal=false` runs zero
COUNTs and `countOnly=true` runs the existing COUNT-only path. The selectors
compose with either paging direction, `upperId`, sparse fields and
representation-correct ETag/304. No snapshot isolation is promised across
concurrent writes. Presence-only selections may scan; no phone index exists
and none is added.

Run `npm run check:customer-phone-presence` for synthetic local-D1
selection, validation/auth, full Link traversal and conditional-read
regressions. This is local planner evidence only, not a production latency
claim. No migration, new index, deployment or live probe. See the
[query policy](SNAPSHOT-LIST-QUERY-POLICY.md#customer-stored-phone-presence)
and [400 correction guidance](PROBLEMS.md#bad-request).

### Address container presence

Use the existing `listAddressSnapshot` operation to find mirrored service
sites with (or without) equipment, without downloading child rows. Optional
`hasContainers=true|false|any` (default `any`) selects by stored container
presence: `true` keeps only addresses with at least one stored container
sharing their `pickup_address_id`, `false` keeps only addresses with none.
Presence counts every stored child including disabled containers; address
`enabled` stays independent. Invalid, blank or repeated keys return the
existing value-free 400 before D1 ([correction guidance](PROBLEMS.md#bad-request)).
`false` means no currently mirrored child — not proof the upstream site is
empty, and not authorization to delete or reconcile.

Present-first multi-page recipe (synthetic local service, `$TOKEN` only):

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/address-snapshot?hasContainers=true&limit=1"
# {"rows":[...],"total":3,"nextCursor":12} — follow the Link target unchanged:
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/address-snapshot?hasContainers=true&limit=1&cursor=12"
# {"rows":[...],"total":2,"nextCursor":13} — stop on null nextCursor / no Link
```

Absent-first recipe over the same fixture:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/address-snapshot?hasContainers=false&limit=2"
# {"rows":[...],"total":3,"nextCursor":15} — Link carries hasContainers=false
```

The [query-policy inventory](SNAPSHOT-LIST-QUERY-POLICY.md#address-container-presence)
pins the AND-composition with every other filter, byte-identical `any`/omitted
behavior, count-free zero-COUNT mode and sparse/conditional reads. Run
`npm run check:address-container-presence` for the hermetic local-D1 contract:
real D1 fixtures with zero, one, multiple and disabled-only children prove
exact membership, cursor-relative totals, both seek directions and Link
round-trips through terminal and empty pages. These checks are not deployed
performance evidence.

### Address street or locality search

The existing address-list `q` matches a literal ASCII case-insensitive substring
against street, city **or** postcode: a row matches when **any one** column
contains the trimmed needle. SQLite `lower()` preserves non-ASCII case
distinctions: `q=åbc` does not match `ÅBC`, while `q=Åbc` does.
Empty and whitespace-only `q` behave as omitted;
longer than 100 Unicode code points, or a repeated `q` key, is the existing
value-free 400 before D1 ([correction guidance](PROBLEMS.md#bad-request)).
Quotes, `%`, `_` and Unicode are literal bound data, never wildcards; leading
zeros in postcodes are significant. The grouped OR intersects by AND with
`customerId`, `pickupAddressId`, `routeId`, `franchiseId`, exact `zip`, `enabled` and cursor
predicates, and the trimmed needle round-trips in follow-next `Link` targets.

Locality search is **not** an exact postal or geographic scope filter: a
postcode fragment such as `741` also matches street and city text, and a city
fragment matches anywhere inside the stored city string. For exact membership,
use the exact scopes above rather than `q`.

Synthetic follow-next recipe, with no running service or real credentials:

```bash
npm run check:address-locality
```

The fixture seeds local test D1, then reads
`/api/v1/address-snapshot?q=741&customerId=101&enabled=true&fields=address,city,zip&limit=2`.
Its street, city and postcode legs match IDs `11,23,37,42`; the test follows
the returned Link unchanged through each matching ID once, then stops on the
terminal empty page. Counted pages keep cursor-relative totals; count-free
pages execute one SELECT with no COUNT. Other fixtures prove null/empty
localities, literal punctuation, 100-code-point boundaries, conditional 304s
and auth-before-D1. Network-deny and read-only D1 doubles fail on unexpected
side effects. These checks are not deployed performance evidence.

### Highest primary IDs first

All three ordinary lists accept exact, case-sensitive `order=asc|desc`;
omission and `asc` keep the existing ascending order. `desc` starts at the
highest primary ID, **not necessarily the newest row in time**. Keep direction
and cursor together; changing direction starts a new traversal. Cursor overrides
offset in either direction. With counts enabled, `total` counts matching rows
after the cursor, before limit/offset; with `includeTotal=false`, no COUNT runs.
Follow-next `Link` targets preserve an explicitly requested `order`, so a
`desc` traversal continues downward; omitted `order` keeps the default target.

Synthetic IDs only; illustrative requests for a disposable local fixture:

```text
GET /api/v1/customer-snapshot?order=desc&limit=2&fields=company_name&includeTotal=false
# IDs [91,58], nextCursor 58 for a matching fixture
GET /api/v1/customer-snapshot?order=desc&cursor=58&limit=2&fields=company_name&includeTotal=false
# IDs [42,37], nextCursor 37; total remains null
GET /api/v1/address-snapshot?order=desc&limit=2&offset=2
GET /api/v1/container-snapshot?order=desc&cursor=58&limit=2&customerId=11
```

Empty/repeated/other `order` values return a value-free 400 before D1
(after auth); send one lowercase `asc` or `desc`, or omit it for `asc`.
Full pages return their last integer ID even when terminal; stop on `null`
from a partial or subsequent empty page. Concurrent writes are not a stable
snapshot guarantee. Changes feeds, by-id reads and exports are unchanged.
See [query policy](SNAPSHOT-LIST-QUERY-POLICY.md#primary-id-direction-order).
The focused check needs no credentials, running Worker or live tenant:

```bash
npm run check:snapshot-order
```

### Conditional JSON page reads (bandwidth only)

The three ordinary snapshot list GETs return an `ETag`: quoted SHA-256 of
exactly the served UTF-8 JSON envelope, **after** field projection, including
`rows`, `total` and `nextCursor`. An authorized agent can send that quoted
value in `If-None-Match`. An unchanged representation returns **304 with no
body** and the same ETag; a nonmatch returns the current **200 JSON** and its
ETag. Weak tags (`W/"…"`), comma-separated tag lists and standalone `*` work;
unquoted hashes, lowercase `w/` prefixes and other malformed lists do not
match. A quoted `"*"` is an ordinary opaque tag, not a wildcard.

This saves **response bytes only, not D1 queries**: authentication, query
validation and the usual D1 work still run on every request (two statements
for counted pages, one with `includeTotal=false`). Auth/validation/D1 errors
cannot turn into 304. `Cache-Control: no-store` is unchanged; this is **not a
cache hit**, shared-cache permission or a TTL change. No response cache or
persisted validator is added. CORS still exposes ETag and request IDs.
Changing a selected value, total or nextCursor changes the tag; changing
only selected-out values does not. Different requests serving identical
bytes may share a tag. Changes, CSV and hydrated-read contracts are
unchanged.

Synthetic, credential-free recipe (no running Worker or live tenant):

```bash
npx vitest run --maxWorkers=2 test/snapshotListConditional.acceptance.test.ts
```

The hermetic fixture calls the real app with local test D1 and makes any
outbound fetch fail. For each resource it requests a projected page, computes
the expected SHA-256 from the first 200's actual bytes, repeats the request
with that ETag and checks a genuinely empty 304, then changes a selected
synthetic value and checks a fresh 200. It also asserts identical executed
SQL/binds on the 200/304 pair and preserved no-store/CORS/request-ID headers.
These are synthetic regression results, not deployed performance measurements.

### Conditional flat by-ID reads (bandwidth only)

The three flat snapshot by-ID GETs (`/api/v1/customer|address|container-snapshot/{id}`)
return the same quoted SHA-256 `ETag` over exactly the served UTF-8 JSON row,
after `fields` projection. Send it back as `If-None-Match` for a bodyless 304;
weak tags, tag lists and standalone `*` match, malformed validators do not.
Auth, id/`fields` validation and the single D1 lookup still run first — a
missing row stays 404 even for `*`, and a 304 performs the same single read
as its 200. `Cache-Control: no-store` is unchanged; this is a
bandwidth-only optimization, not a cache hit or a measured performance gain.

Synthetic, credential-free recipe (no running Worker or live tenant):

```bash
npx vitest run test/snapshotByIdConditional.acceptance.test.ts
```

The hermetic fixture covers all three resources against local test D1 with
outbound fetch disabled: 200 to empty 304 to changed-row 200, sparse
selected-out stability, the quoted-token grammar, error precedence
(401/400/404/500 before any 304), and the mounted OpenAPI 304 declarations.

### Follow the server's next-page target

The three ordinary snapshot lists also return `Link: <relative-target>; rel="next"`
exactly when `nextCursor` is non-null. Follow it rather than rebuilding the
query: the target retains recognized filters, explicit `fields`, the effective
limit and `includeTotal=false`, replaces the cursor, and drops `offset` even
when you started with one. Unknown keys and request origins are never copied.
CORS exposes `Link` alongside the existing exposed headers.

**Omission means stop.** A full terminal page can link to an empty page; there
is no lookahead query. JSON, count semantics (including cursor-relative totals)
and query counts are unchanged. This is not a consistency guarantee during
concurrent writes. The customer `changes` feed uses its own composite-cursor
[follow-next contract](#2c-follow-the-composite-next-link).

Node 24 recipe (local synthetic origin, `$TOKEN` from step 1; log counts, not
rows or credentials). Resolve the relative target against the current page,
refuse foreign origins before sending authorization, and reject redirects:

```javascript
const start = new URL("http://localhost:8787/api/v1/customer-snapshot?limit=2&includeTotal=false");
let url = start;
for (;;) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TOKEN}` }, redirect: "error"
  });
  if (!res.ok) throw new Error(`Snapshot read failed: ${res.status}`);
  const page = await res.json();
  console.log({ rows: page.rows.length, total: page.total });
  const link = res.headers.get("Link");
  if (link === null) break;
  const match = /^<([^>]+)>; rel="next"$/.exec(link);
  if (!match) throw new Error("Untrusted next Link");
  const next = new URL(match[1], url);
  if (next.origin !== start.origin || next.username || next.password)
    throw new Error("Untrusted next-link origin");
  url = next;
}
```

The executable-doc check runs this exact recipe with synthetic responses and
no network or real credentials (also included in `npm test`):

```bash
node --test test/snapshotNextLinksRecipe.acceptance.test.mjs
npx vitest run test/snapshotNextLinks.acceptance.test.ts
```

Single rows (same 404 `not-found` shape when the id is not in D1):

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/customer-snapshot/42
# HTTP 200 row, or 404 {"type":"...#not-found",...} when that id is not in D1

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/address-snapshot/10
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/container-snapshot/100
```

Empty `rows` with HTTP 200 means auth works but no snapshot has been synced
yet — ask the operator to run `POST /api/v1/data-snapshot/sync` (or the daily
cron), not a bug in your call.

### Discover legal sparse-field selections

Each supported operation's actual `fields` query parameter has
`schema["x-snapshot-fieldset"]`. This **vendor extension**, not a standard
OpenAPI keyword or an enum of whole comma-separated selectors, defines v1:

| Key | Contract |
|---|---|
| `schemaVersion` | Integer `1`; stop selection for an unsupported version. |
| `resource` | `customer`, `address` or `container`, for this operation only. |
| `selectableFields` | Ordered array of all legal exact field names, including the primary identity. Generated from the same registry as validation, not record values. |
| `alwaysIncludedFields` | Array containing the resource's primary identity, even when not selected. |
| `delimiter` | `","`, also used by the parser. |
| `rules` | `{caseSensitive: true, whitespace: "reject", emptySegments: "reject", duplicates: "reject", unknownNames: "reject", repeatedKeys: "reject"}`. |

Use names exactly as advertised: no case folding, whitespace trimming, empty
selector/segment, duplicate name or repeated `fields` key. Unadvertised names
(including names exclusive to another resource) are invalid. An explicitly
selected identity is legal once and returned once, not treated as a duplicate
of the always-included identity. Invalid selectors yield the value-free 400
before D1 work described in the [existing query policy](SNAPSHOT-LIST-QUERY-POLICY.md#sparse-fieldsets-fields).

Use `fields` only where the operation declares it. The six flat snapshot
list/by-id reads project **each row** or the response object, retaining the
primary identity without changing `total`, `nextCursor` or the envelope.
The existing single-ID `GET /api/v1/data/customer`, `GET /api/v1/data/address`
and `GET /api/v1/data/container` reads also declare `fields`: only the matching
`.customer`, `.address` or `.container` root is projected, leaving related bundle
data unchanged. Those hydrated reads still require the sync secret; their
existing ETag and cache behavior is unchanged. The customer changes feed,
`GET /api/v1/customer-snapshot/changes`, declares the same customer catalog and
projects each row only after computing its page-length `total` and composite
`nextCursor`; keep the same selector when following the cursor. Omitting `fields`
preserves the full response. Exports, other changes feeds and batch paths do not
support `fields`.
Inspect each operation's actual parameter and route description; the catalog
does not grant authority. Operation IDs and access/effect metadata are unchanged.

Given JSON saved from the existing enabled `/openapi.json` response as
`openapi.json`, this offline example selects synthetic field names without
reading records, trying invalid requests or invoking a data route:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const doc = JSON.parse(readFileSync(0, "utf8"));
const op = doc.paths["/api/v1/customer-snapshot"].get;
const p = op.parameters.find(p => p.in === "query" && p.name === "fields");
const f = p?.schema?.["x-snapshot-fieldset"];
if (f?.schemaVersion !== 1 || f.resource !== "customer") throw Error("Unsupported catalog");
const wanted = ["company_name", "phone1"];
if (!wanted.every(n => f.selectableFields.includes(n))) throw Error("Unavailable selection");
const query = new URLSearchParams({ fields: wanted.join(f.delimiter) });
console.log(JSON.stringify({ query: query.toString(), alwaysIncludedFields: f.alwaysIncludedFields }));
' < openapi.json
```

Discovery itself needs no bearer, data bindings or upstream work;
`OPENAPI_DOCS_ENABLED` still gates the document. Data reads still require the
bearer from step 1. No separately published static spec is required. Run the
credential-free, synthetic, network-denying discovery oracle plus existing
projection/OpenAPI checks with `npm run check:snapshot-fieldset-discovery`.

#### Typed hydrated-fieldset discovery

On each of the three hydrated GETs above, all three `fields[customer]`,
`fields[address]` and `fields[container]` parameters publish the same v1
`x-snapshot-fieldset` shape for their own type. Selectable names and mandatory
identities come from the same registry as validation, never from record values.
Typed selectors project **every object of that type**, including nested relations;
flat `fields` projects only the route root. Omitted types stay full.

Each hydrated `fields`/`fields[type]` string schema also declares this adjacent,
operation-local `x-snapshot-fieldset-mode` v1 extension:

| Key | Contract |
|---|---|
| `schemaVersion` | Integer `1`; stop selection for an unsupported version. |
| `rootResource` | This route's `customer`, `address` or `container` root. |
| `projectionScope` | `root` for flat `fields`, `type` for a typed selector. |
| `omittedTypes` | `full`: unselected types retain their full representation. |
| `singleIdOnly` | `true`; no batch projection is advertised. |
| `conflictsWith` | Sorted query names: always `ids`, plus the same-root typed selector for `fields`, or `fields` for the typed root. |
| `composesWith` | Sorted other field-selector names that may accompany this selector. Distinct typed selectors compose; flat fields composes with non-root types. |

This guidance is not a new runtime mode, endpoint or global capability registry.
`ids` rejects **all** fieldsets; unsupported operations advertise no typed
selectors or mode extension. Unknown typed-selector keys are rejected without
echoing submitted names or values; correction guidance names supported keys only.
Mixed invalid IDs preserve existing validation and auth ordering.
Auth precedence, full/projected bytes, canonical full-cache contents and
representation-specific ETags are unchanged. Batch entries still stay full.

This offline, synthetic recipe composes two legal typed selectors from a saved
`openapi.json` (no record request or credential access):

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const doc = JSON.parse(readFileSync(0, "utf8"));
const op = doc.paths["/api/v1/data/customer"].get;
const selections = [["fields[address]", "address", ["city", "address"]], ["fields[container]", "container", ["serial_number"]]];
const query = new URLSearchParams({ id: "42" });
const selected = selections.map(([name]) => name);
const identities = {};
for (const [name, type, wanted] of selections) {
  const p = op.parameters.find(p => p.in === "query" && p.name === name);
  const f = p?.schema?.["x-snapshot-fieldset"], m = p?.schema?.["x-snapshot-fieldset-mode"];
  if (f?.schemaVersion !== 1 || f.resource !== type) throw Error("Unsupported catalog");
  if (m?.schemaVersion !== 1 || m.rootResource !== "customer" || m.projectionScope !== "type" || !m.singleIdOnly || m.omittedTypes !== "full") throw Error("Unsupported mode");
  if (selected.some(k => m.conflictsWith.includes(k) || (k !== name && !m.composesWith.includes(k)))) throw Error("Incompatible selectors");
  if (!wanted.every(n => f.selectableFields.includes(n))) throw Error("Unavailable selection");
  query.set(name, wanted.join(f.delimiter));
  identities[name] = f.alwaysIncludedFields;
}
console.log(JSON.stringify({ query: query.toString(), identities }));
' < openapi.json
```

Run `npm run check:hydrated-fieldset-discovery` for mounted catalogs, legal-mode
request parity, synthetic examples, strict rejection/auth/no-work controls and
full/projected/cache/ETag preservation. GET remains idempotent; `--dry-run` is
not applicable. Discovery and source checks are not deployment or adoption proof.

## 2a. Upstream customer pagination: `skip`/`take` or `start`/`limit`

`POST /api/v1/routeware/customer/customers-read` is an **upstream read**, not
one of the D1 snapshot lists above. Use either bearer token from step 1 and
`Content-Type: application/json`. A successful read also needs a working
Routeware session on the Worker (operator-configured login credentials).

These two requests ask for the same window: skip zero customers, take two.
The Worker maps `skip` → `start` and `take` → `limit` before forwarding:

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"skip":0,"take":2}' \
  http://localhost:8787/api/v1/routeware/customer/customers-read
# Upstream body: {"start":0,"limit":2}
# Typical success: {"success":true,"total":N,"data":[...]}
# HTTP 200

curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"start":0,"limit":2}' \
  http://localhost:8787/api/v1/routeware/customer/customers-read
# Same upstream window; success body comes from Routeware unchanged.
# HTTP 200
```

The response is not the snapshot `{rows,total,nextCursor}` envelope; row
contents and totals depend on upstream data. There is no Worker-generated
cursor or page number. `page`, `filter`, `sort`, and `group` are left untouched.
These examples were checked against a local Worker with a mocked upstream,
not the live tenant.

**Precedence is per key:** an explicit `start` wins over `skip`, and an
explicit `limit` wins over `take`. Valid aliases are removed, so upstream
receives only one spelling of each window component:

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"skip":200,"take":100,"start":0,"limit":2}' \
  http://localhost:8787/api/v1/routeware/customer/customers-read
# Upstream body: {"start":0,"limit":2}, not the 200/100 window.
# HTTP 200 on a successful upstream read.
```

Aliases must be JSON numbers that are nonnegative integers; `take: 0` maps
faithfully to `limit: 0`. If either present alias is invalid (e.g. `"take":"2"`,
`"skip":-1`, or `"take":1.5`), **no translation happens**: the entire original
body is forwarded unchanged. Non-object or non-JSON bodies also pass through.
This mapper is not a validator: invalid pagination does **not** guarantee a
local 400. An upstream 400 keeps its status; do not rely on its original
error body. An HTML error page — or a JSON body with `success: false` — on
an upstream HTTP 200 instead becomes a 502 `bad-gateway` problem.

For a guaranteed **local 400** example, use the neighboring read route with
an invalid `customerID`. This rejects before any upstream call, independently
of the pagination rules:

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/routeware/customer/load-long-modal?customerID=abc"
# application/problem+json:
# {"type":".../PROBLEMS.md#bad-request","title":"Bad Request","status":400,
#  "detail":"Query `customerID` is required and must be a positive integer. See docs/PROBLEMS.md#bad-request.",
#  "instance":"/api/v1/routeware/customer/load-long-modal"}
# HTTP 400
```

## 2b. Incremental sync: the customer `changes` feed

`GET /api/v1/customer-snapshot/changes` replays only rows touched after your
cursor — the incremental counterpart to the full list in step 2. Omit the
cursor initially. Optional `fields=company_name` keeps `customer_id` and the
selected column; omit `fields` for full rows. Cursors are unchanged:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot/changes?limit=2&fields=company_name"
# {"rows":[...],"total":2,"nextCursor":{"since":"2026-09-01T00:00:00.000Z","since_id":7101}}
```

Resume chunked deltas with the whole pair: pass the previous page's
`nextCursor` back as `since` + `since_id`. A bare `since` replays every later
run whole (strict `>`); a mid-run resume needs the tiebreak, because every
upserted row in one sync run shares that run's stamp:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot/changes?since=2026-09-01T00:00:00.000Z&since_id=7101&limit=2&fields=company_name"
```

`since` is UTC `Z` with seconds or 1–3 fractional digits, compared at
lossless millisecond precision — more than 3 digits is a 400, never rounded.
`since_id` is exact unpadded decimal (`0`–`9007199254740991`) and needs a
valid `since`. The feed surfaces upserts only: reconciled-away or erased rows
never appear as tombstones, so re-list to detect disappearance.

## 2c. Follow the composite next link

Prefer the server's `Link: <relative-target>; rel="next"` to rebuilding the
pair from JSON. It appears exactly when `nextCursor` is non-null, replaces
both cursor halves and retains the effective limit (1..500, default 50),
the normalized `until` and the validated `fields` selector, so sparse
bounded traversal keeps sparse bounded pages.
The target is always `/api/v1/customer-snapshot/changes` with URL-encoded
`since`, `since_id`, `limit` and, when requested, `until`/`fields`: unknown keys,
origins and credentials are never echoed. This feed recognizes optional
`fields` (sparse stored-column projection after cursor derivation; omit for
full rows) and optional `until` (inclusive upper bound; omit for the
unbounded tail). Other unknown keys remain ignored.

Omission means stop. A full terminal page may link to an empty page; short,
empty and error pages have no next link. JSON bytes/shape, row ordering,
`total` (returned page length), cursor and the single SELECT stay unchanged:
no COUNT or lookahead is added. This is not a completeness or snapshot-isolation
promise across concurrent writes. Read-token auth, no-store, request ID and
existing CORS exposure (including Link) are unchanged.

Node 24 recipe for a **disposable synthetic local fixture**; it is not a live
probe. Supply the local test bearer as `$TOKEN`. Resolve emitted URLs unchanged,
check same origin, fixed path and absence of URL credentials **before** sending
authorization, and use manual redirects. Reject non-2xx before parsing JSON;
log counts only, never records or credentials:

```javascript
const start = new URL("http://localhost:8787/api/v1/customer-snapshot/changes?limit=2");
let url = start;
for (;;) {
  if (url.origin !== start.origin || url.pathname !== start.pathname || url.username || url.password)
    throw new Error("Untrusted next-link origin, path or credentials");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TOKEN}` }, redirect: "manual"
  });
  if (!res.ok) throw new Error(`Changes read failed: ${res.status}`);
  const page = await res.json();
  console.log({ rows: page.rows.length, total: page.total });
  const link = res.headers.get("Link");
  if (link === null) break;
  const match = /^<([^>]+)>; rel="next"$/.exec(link);
  if (!match) throw new Error("Untrusted next Link");
  url = new URL(match[1], url);
}
```

Focused command (no Worker, credentials or network needed):

```bash
npm run check:customer-changes-next-links
# Or run the oracles separately:
npx vitest run test/customerChangesNextLinks.acceptance.test.ts --maxWorkers=2
node --test test/customerChangesNextLinksRecipe.acceptance.test.mjs
```

The HTTP oracle seeds real hermetic D1 with timestamp ties/multiple runs,
follows Link unchanged, pins JSON bytes/SQL/binds/query counts, proves zero
application writes and fails on unexpected outbound fetch. The recipe oracle
executes this exact block with synthetic responses and no real network. Both
run in normal `npm test`/CI. These are source regressions, not installed or
production verification.

### Bounded changes window (until)

Pass `until` for a finite caller-chosen window: only rows with
`synced_at <= until` qualify, using the same UTC `Z` millisecond contract as
`since` (seconds or 1–3 fraction digits; empty, repeated, offset and
overprecise values are 400s, and normalized `since` must not exceed `until`).
The Link retains the normalized bound, so rows synced after the first page
cannot extend the traversal. Disposable synthetic local fixture, not a live
probe:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot/changes?until=2026-09-01T00:00:00.5Z&limit=2"
# {"rows":[...2 rows at/below 00:00:00.500Z...],"total":2,
#  "nextCursor":{"since":"2026-09-01T00:00:00.100Z","since_id":8402}}
# Link: </api/v1/customer-snapshot/changes?since=2026-09-01T00%3A00%3A00.100Z&since_id=8402&limit=2&until=2026-09-01T00%3A00%3A00.500Z>; rel="next"
```

Follow the Link target unchanged for page two; the terminal page carries no
Link:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot/changes?since=2026-09-01T00:00:00.100Z&since_id=8402&limit=2&until=2026-09-01T00:00:00.500Z"
# {"rows":[...remaining rows at/below the bound...],"total":1,"nextCursor":null}
```

Equal endpoints stay valid: bare `since == until` yields no rows at that
instant, while the composite pair resumes the remaining same-stamp rows.
This is still current-row upserts only — overwrites can move rows outside
the window and bulk imports advance timestamps — with no delete events,
historical versions, snapshot isolation or completeness promise. Focused
command (no Worker, credentials or network needed):

```bash
npm run check:customer-changes-until
```

### Typed changes rows

Delta rows are typed in `/openapi.json` (`CustomerSnapshotChangesRow`): every
stored customer column with storage-faithful integer/text/null types.
`customer_id` and `synced_at` are always required (replay/cursor identity);
every other column is optional with nullability exactly as stored. This
describes full rows: sparse `fields=` pages carry only the resource id plus
the selector (`synced_at` omitted unless selected), so validate sparse pages
against the projection. Flags stay integers (`enabled` is `0`/`1`,
never boolean); text carries no format/enum/minimum promises. `total` is the
returned page length (never a COUNT); `nextCursor` is the composite resume
pair, or `null` at the tail. Focused check:
`npm run check:customer-changes-delta`.

## 3. Nested reads: `/api/v1/data/*` (sync secret only)

One call returns the customer + addresses + containers graph from D1, with
`ETag` / `If-None-Match` caching (revalidates return `304`):

```bash
curl -i -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/customer?id=42"
# HTTP 200 + ETag header; repeat with -H "If-None-Match: <etag>" → 304

curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/address?id=10"    # by pickup_address_id

curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/container?id=100" # by container_id
```

Unknown valid ids return 404 `not-found` ("import/sync first"). Passing the general
token here returns 401 even though it works for step 2 — that is the inner
privileged gate, not a bad token.

All three reads use the same ID contract. Supply `id` or the existing alias:
`customerId` for customer, `pickupAddressId` for address, `containerId` for
container. Each supplied value must be canonical positive decimal text
(`^[1-9][0-9]*$`) in the safe-integer range `1`–`9007199254740991`.
Both valid spellings may be supplied with different values: **`id` wins**.
A malformed unused alias still returns 400, not a cached row or 304.

This deliberately tightens numeric coercion: empty/whitespace, leading zeros,
signs, fractions (even `42.0`), exponents, hex, nonpositive and unsafe values
are rejected before handler/cache/D1 access. Do not normalize malformed caller
text into a different row ID. Rejections use the anchored 400
`application/problem+json` envelope with fixed field-only detail and no input
values; see [bad-request guidance](PROBLEMS.md#bad-request).

### Typed single-or-batch hydrated responses

The served `/openapi.json` describes each 200 as an explicit single-or-batch
composition: `HydratedCustomerBundle` / `HydratedCustomerBatch`,
`HydratedAddressBundle` / `HydratedAddressBatch`, or
`HydratedContainerBundle` / `HydratedContainerBatch`. Generated agent clients
should select the batch branch by its `entries` envelope, not treat it as a
single bundle or untyped data. Full and projected single examples and mixed
found/missing and all-missing batch examples are mounted on each operation.
This is a declaration correction, not a new runtime response format.

For detail hydration, all three reads also accept one comma-separated `ids`
list of 1 to 50 canonical ids instead of N sequential GETs. Every entry uses
the same canonical contract; any malformed or empty entry, mixing `ids` with
`id`/alias, or more than 50 ids fails the whole request 400 before any read.
The 200 body is `{entries}` in request order, **preserving duplicates**.
A found entry requires numeric `id`, `found: true` and the resource key
(`customer`, `address` or `container`) containing its full hydrated bundle,
not just a root row. Missing entries are exactly `{id, found: false}` without
any payload; even an all-missing batch returns 200, not a whole-request 404.
Required bundle/relationship keys remain present: empty children are `[]`,
and missing/racing parents on address/container reads are `null`. Stored D1
flags remain numeric and text/null values are not coerced. Batch rows are
full; `ids` plus any `fields` or `fields[type]` is a value-free 400.

Only single-ID reads use ETag/conditional bodyless 304 and return 404 for a
missing root. Batches are always `no-store`, have no ETag, ignore
`If-None-Match` and never return 304. All three GETs are idempotent local reads
with sync-secret-only access; CLI `--dry-run` is not applicable.

Each unique ID, including a miss, is hydrated **once per request**, in
first-occurrence work order, with at most **four simultaneous root hydration
jobs** per request in each of the three batch implementations. A slot covers the complete
bundle's nested reads; it is not released just after the root SELECT. Response
entries still preserve every duplicate and the exact input order. The 50-ID
limit counts supplied entries, not unique IDs; separate requests read again.
On a hydration failure, queued roots stop starting after the failure is observed,
already-started jobs drain, and the whole request returns the existing sanitized
500, never partial entries. There are no retries or background hydration.

Four roots is **not** a cap on total nested D1 queries, graph fanout or response
bytes: distinct high-fanout customers can still read many addresses and container
chunks. Inner chunk sizes are unchanged. This is a source-level load-risk
reduction, not a measured latency or deployed-capacity claim.

```bash
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/customer?ids=42,7,42,9"
# Four request-order entries; IDs 42, 7 and 9 are each hydrated once.
# {"entries":[{"id":42,"found":true,"customer":{...}}, ...]}
```

Credential-free synthetic budget/error/parity regression check (no tenant probes):
`npm run check:hydrated-batch-budget`.

Synthetic consumer examples (the acceptance fixture, not customer records):
`/api/v1/data/customer?id=42` and `?customerId=42` return the same row and ETag;
`?id=42&customerId=2` selects 42; `?id=42&customerId=042` returns 400.
`?ids=42,7` returns two request-order entries; `?ids=42,042`,
`?ids=42&id=7` and 51 ids return 400.
Run the credential-free, network-denying local check instead of querying a tenant:

```bash
npx vitest run test/hydratedReadIds.acceptance.test.ts test/batchHydratedReadIds.acceptance.test.ts test/dataRoutes.test.ts
npm run check:typed-hydrated-batch-contracts  # served schemas/examples + synthetic local-D1 responses and malformed-envelope mutations
npm run check:typed-hydrated-bundles         # batch + existing single/projection/auth/cache/OpenAPI regression checks
```

### Root-only sparse fields on hydrated reads

The three **single-ID** reads above accept the same strict `fields` allowlist
as their flat snapshot counterparts. Root means `.customer`, `.address` or
`.container`, not the bundle envelope. Synthetic examples:

```bash
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/customer?id=42&fields=company_name,phone1"
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/address?id=10&fields=city,address"
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/container?id=100&fields=serial_number,location_address"
```

For example, the first request selects only `customer_id`, `company_name`
and `phone1` inside `.customer`. The full `.addresses` array, including all
nested containers, is unchanged. Address/container requests likewise retain
all other bundle members, nulls and ordering. The primary ID is always
included, even for `fields=phone1`; omit `fields` for the existing full response.
This shapes the response, not the D1 queries, and **does not remove PII from
related data** or change authorization.

Use exact stored column names separated by commas, once each in a single
`fields` key. Empty/repeated/duplicate, unknown, cross-resource, dotted,
wildcard and relationship selectors return a fixed value-free 400 before
cache or D1 reads; auth still takes precedence over field validation. See the
[shared fieldset policy](SNAPSHOT-LIST-QUERY-POLICY.md#sparse-fieldsets-fields).
`fields` applies to single-ID reads only: combining `ids` with `fields` is a
fixed value-free 400 (batch hydration is documented above).

ETags hash the **served bundle bytes**, including unchanged related data.
Keep validators per URL and selector: a full-only validator cannot short-cut
a projected response. A matching projected validator returns an empty-body
304. Selected-out root changes can leave that validator unchanged; related
changes still invalidate it after normal cache expiry/invalidation. Warm reads
derive the projection from the canonical full cache without mutating it; cold
reads use ordinary hydration and cache only the full representation. The
existing `private, max-age=60` policy is unchanged; there is no second cache.
See [cache semantics](ENTITY-DATA-CACHE.md#sparse-representations).

Credential-free acceptance check:

```bash
npx vitest run test/hydratedFields.acceptance.test.ts
```

### Per-type sparse fields on hydrated bundles

Each single-ID read above also accepts `fields[customer]`, `fields[address]`
and `fields[container]`, projecting every object of that type — the root and
all nested relations — from the same strict per-type allowlists. Omitted types
stay full; every projected object keeps its primary id. Discover legal per-type
names and combinations from the existing document using
[typed hydrated-fieldset discovery](#typed-hydrated-fieldset-discovery).
Synthetic examples:

```bash
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/customer?id=42&fields[address]=city,address"
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/address?id=10&fields[container]=serial_number"
```

The first request trims each nested address (and nothing else) to
`pickup_address_id`, `city` and `address`; `.customer` and the nested
`containers` arrays are unchanged. Flat `fields` keeps its root-only meaning
and composes with non-root typed keys, but `fields` plus `fields[<root>]`
together is a 400, as are unknown `fields[TYPE]` keys. Strictness, value-free
400s and auth precedence match the flat selector; see the
[shared fieldset policy](SNAPSHOT-LIST-QUERY-POLICY.md#sparse-fieldsets-fields).
Field selectors apply to single-ID reads only: batch `ids` entries stay full,
and `ids` plus any `fields`/`fields[type]` selector is a value-free 400.

ETags keep hashing the **served bundle bytes** per typed combination: a
full-only validator cannot short-cut a projected response, and a matching
projected validator returns an empty-body 304. Keep validators per URL and
selector. See [cache semantics](ENTITY-DATA-CACHE.md#sparse-representations).

Credential-free acceptance check:

```bash
npx vitest run test/hydratedBundleFields.acceptance.test.ts
```

## 3a. Snapshot archives: `GET /api/v1/snapshots/{table}/{date}`

Syncs archive their raw CSV to R2 (`snapshots/YYYY-MM-DD/<table>.csv`, when
the binding is configured). The sync secret streams it back re-encoded for
spreadsheets (formula-leading cells quoted, `_shadow_csv_encoding` appended);
compare the download with a fresh export by business values, not bytes;
swap the date for `latest` to fetch the newest archive without naming its date:

```bash
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/snapshots/customer/2026-01-01" -o customer-2026-01-01.csv
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/snapshots/customer/latest" -o customer-latest.csv
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/customer-snapshot/export" -o customer-fresh.csv
# Same pair for address and container — swap the table name:
# `/api/v1/snapshots/address/2026-01-01`, `/api/v1/address-snapshot/export`,
# `/api/v1/snapshots/container/2026-01-01`, `/api/v1/container-snapshot/export`.
```

The general token 401s here even on GET — the inner privileged gate from
step 3, not a bad token. A well-formed but absent archive is 404 `not-found`
(history is missing, not a bad call). Replays carry a content-hash `ETag`;
send it back for a 304:

```bash
curl -i -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/snapshots/customer/2026-01-01"
# HTTP 200 + ETag header; repeat with -H "If-None-Match: <etag>" → 304
```

## 3b. Snapshot archive dates: `GET /api/v1/snapshots/{table}`

To browse which dates hold an archive instead of guessing dates one 404 at
a time, list them newest-first (same sync-secret gate as §3a):

```bash
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/snapshots/customer?limit=5"
# {"table":"customer","dates":[{"date":"2026-09-27","bytes":1234,"sha256":"<64-hex>"}],"truncated":false}
```

`limit` is 1..366 (default 30); `truncated` means more dates may exist.
Discovery follows up to 20 R2 key-list pages before sorting newest-first, then
reads at most 366 manifests. If the key-list cap is reached, newer dates may
remain outside the discovered keys; `truncated: true` is not proof that the
first returned date is the bucket's newest. Zero archives is 200 with
`"dates": []`, never 404. Entries carry manifest
hashes/sizes only, never row data. Replays carry a content-hash `ETag`;
send it back for a 304, exactly like the §3a download.

## 4. Saves: write through Routeware, then D1 refreshes

Saves go **through** Routeware upstream (they need a live Routeware session
on the Worker) and then refresh the local D1 snapshot. Bodies are
`application/x-www-form-urlencoded`; omit `__RequestVerificationToken` —
the Worker injects it server-side from the Routeware modal HTML.

```bash
# Create customer (CustomerID=0); update by setting CustomerID=<id>
curl -X POST http://localhost:8787/api/v1/data/customer \
  -H "Authorization: Bearer $SYNC" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "CustomerID=0" \
  --data-urlencode "CustomerTypeID=1" \
  --data-urlencode "CompanyName=ExampleCo" \
  --data-urlencode "FirstName=Jane" \
  --data-urlencode "LastName=Doe" \
  --data-urlencode "Enabled=true"
```

Success response contract (ids + outcome only — submitted fields and the
upstream body are never echoed):

```json
{
  "ok": true,
  "routewareStatus": 200,
  "customerId": 42,
  "upstreamBytes": 1234,
  "localSync": { "done": true, "customerId": 42, "addressIds": [], "containerIds": [] }
}
```

Address/container saves work the same way (`PickupAddressID=0` + `CustomerID`
for a new address; `ContainerID=0` + `PickupAddressID` for a new container).
Their JSON envelopes additionally require nullable `pickupAddressId`, and the
container envelope also requires nullable `containerId`. `customerId` is also
nullable when unresolved. Creates answer **HTTP 201** with the resolved id
while updates echo the posted id with 200 (customer saves stay 200 on creates):

```bash
# Create address (PickupAddressID=0); the 201 body carries the created id
curl -X POST http://localhost:8787/api/v1/data/address \
  -H "Authorization: Bearer $SYNC" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "PickupAddressID=0" \
  --data-urlencode "CustomerID=5" \
  --data-urlencode "Address=1 Main St"
# HTTP 201 {"ok":true,"routewareStatus":200,"customerId":5,
#   "pickupAddressId":77,"upstreamBytes":46,
#   "localSync":{"done":true,"customerId":5,"addressIds":[10,77],"containerIds":[100]}}
```

For live creates, the id comes from upstream `data.PickupAddressID` / `data.ContainerID`
first, else the singleton post-refresh D1 id (address ids for the owning
customer, container ids for the owning address). The diff baseline is captured
**before** the upstream POST so a concurrent refresh cannot put this request's
created row into the baseline. Without an upstream id, `null` remains when the
diff is empty or ambiguous (0 or 2+ new ids), the owning graph is unknown, or
the baseline/refresh is unavailable. A failed baseline read disables only
id diffing: the save and normal refresh still run, and an upstream JSON id
still wins. Posted save keys are case-exact (`PickupAddressID`, `ContainerID`);
camelCase keys do not name an update. Upstream JSON ids must be positive safe
integers (numbers or digit-only strings); invalid candidates do not mask valid
fallback fields. There is deliberately no `Location`
header: the by-id snapshot URL may not exist locally when the refresh fails,
and a header that 404s is worse than none. Dry-run saves echo posted ids;
live creates resolve or return `null`, while live updates return the
case-exact posted key.

`routewareStatus` is the original upstream status, not necessarily the wrapper
status (for example, upstream 200 on a create returns wrapper 201 with the
resolved id).

**Read `dryRun`, `ok` and `localSync` separately.** On a live save (no `dryRun`
response flag), `ok=true` means the upstream write was accepted, not that local
data was refreshed. A `dryRun=true` response means validation passed only; no
upstream write or local refresh was attempted. Local refresh and cache
invalidation are best-effort; HTTP 200 does not guarantee a refreshed local graph.
The shared, served OpenAPI `LocalSyncSummary` contract has two exclusive shapes:

| `localSync` | Meaning and recovery |
| --- | --- |
| `{done:true, customerId, addressIds, containerIds}` | Graph refreshed and cache invalidation completed; arrays contain graph IDs, not submitted fields. |
| `{done:false, code:"sync_failed"}` | Write accepted, but refresh or cache invalidation failed; local state may be stale or partially refreshed. Verify local state and arrange graph reconciliation rather than repeating the save. |
| `{done:false, code:"unknown_customer_id"}` | Write accepted, but the owning customer was unresolved, so no graph refresh ran. Resolve the existing upstream identity before reconciling local state. |
| `{done:false, code:"not_attempted"}` | Upstream rejected the live save (`ok=false`), or this was validation-only (`dryRun=true`); no local refresh ran. This is not a write-success claim. |

Never blindly replay or retry creates after an ambiguous response or failed
refresh: the upstream write may already have landed. Verify existing identities
and reconcile local state without repeating the create; these codes do not
provide idempotency or authorize retries. Error codes are fixed strings, never
exception text, upstream HTML, form fields or PII. Inspect `application/json`
examples on each save operation in `/openapi.json` for the four live outcomes,
the validation-only dry-run outcome, and the 201 created-id outcome on address
and container saves. HTTP 200 advertises a union of those strict live and
dry-run schemas (live updates echo the posted id; live creates answer 201);
null upstream status is valid only on dry runs.

Runnable hermetic schema-vs-runtime check (no live provider, credentials or data):

```bash
npx vitest run test/saveOutcomeSchemas.acceptance.test.ts --maxWorkers=2
```

This serves OpenAPI via `app.fetch`, validates all three envelopes and synthetic
outcomes, rejects malformed `localSync`, and checks unchanged forwarding,
authentication, `no-store`, statuses and side effects. It exercises the behavior
present at this implementation head, including the merged dry-run and created-ID
resolution contracts; it does not introduce new save behavior.

On the `/api/v1/routeware/*` passthrough save routes, a silent Routeware-side
failure surfaces as `502` problem+json (Routeware reports failed saves as an
HTML page with HTTP 200 — the Worker converts that, never passes it through
as success); an explicit Routeware 4xx/5xx instead keeps its own status under
the `upstream-error` problem type. On the `/api/v1/data/*` saves above, the same silent upstream
failure instead returns **HTTP 200 with `"ok": false`** (plus the upstream
`routewareStatus` and `upstreamBytes`) — check the `ok` field, not just the
status code. Anti-forgery preparation failures return `502` problem+json,
but a forwarded failure can also return `502` with the ordinary `ok:false`
save envelope. Likewise, HTTP 503 can carry a forwarded live rejection as
JSON or a dry-run session precondition failure as problem+json. The exact
400/401 responses and the default error response also publish both media
schemas: a forwarded rejection is a JSON save outcome, while local validation,
bearer denial, auth throttling (429) and unhandled failures (500) use
problem+json. A problem response alone does not prove whether a write landed.
Inspect the media type and payload, not only the status. See the
[502 recipe](#502-and-other-upstream-failures-distinguish-them-from-client-authentication).

### Dry-run recipe: validate, fix, save

Append `?dryRun=true` to any of the three saves to validate — form fields
plus session health — without risking a non-idempotent create landing
upstream. Nothing is persisted: no upstream POST, no D1 write, no cache
invalidation, no login.

```bash
# 1. Validate (HTTP 200: dryRun: true, routewareStatus: null, upstreamBytes: 0)
curl -X POST "http://localhost:8787/api/v1/data/customer?dryRun=true" \
  -H "Authorization: Bearer $SYNC" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "CustomerID=0" \
  --data-urlencode "CustomerTypeID=1" \
  --data-urlencode "CompanyName=ExampleCo"
# 2. Fix whatever 400/502 the dry-run reports (identical shapes to the live path)
# 3. Save for real: drop the flag — or pass ?dryRun=false — and re-POST the body
```

Without a usable session the dry-run fails closed with 503
`failed-precondition` and never logs in — run a live request first. Only
`dryRun` is an allowed query key; after sync-secret authentication succeeds,
anything else is a value-free 400. Missing or invalid authentication retains
precedence over unknown-key rejection.
`routewareStatus` is unknowable without posting and is never predicted.
Run the hermetic proof: `npm run check:save-dry-run`.

## 5. There is no DELETE: disable instead (HTTP 405)

Routeware WebRW exposes no hard delete, so the API documents that instead of
guessing:

```bash
curl -X DELETE http://localhost:8787/api/v1/routeware/customer \
  -H "Authorization: Bearer $TOKEN"
# HTTP 405 {"type":"...#method-not-allowed","title":"Customer delete not supported",...}
```

Retire a customer by disabling it — resubmit the loaded record with
`Enabled=false`:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/routeware/customer/load-long-modal?customerID=42"
# returns the edit form + required field set; then:

curl -X POST http://localhost:8787/api/v1/routeware/customer/save-long-form \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "CustomerID=42" \
  --data-urlencode "CustomerTypeID=1" \
  --data-urlencode "CompanyName=ExampleCo" \
  --data-urlencode "FirstName=Jane" \
  --data-urlencode "LastName=Doe" \
  --data-urlencode "Enabled=false"
```

## 6. Error-path recipes: 401, 429, 502

**Local-only drills:** the commands in this section must not be pointed at
production or shared staging. Repeated invalid bearer requests can trigger
per-IP authentication throttling. Reproduce upstream errors with the mocked
tests below, not real tenant writes. Do not share tokens, cookies, raw upstream
HTML, or customer data when reporting a failure.

Use `curl -sS -i` to see the HTTP status, headers, and error body together;
`curl` normally exits successfully even for HTTP 401/429/502. The JSON below
is representative: `type` uses the default problem catalog URL, but an
operator can override its base with `PROBLEM_TYPE_BASE`. Match the status and
anchor, not the hostname. See [`PROBLEMS.md`](./PROBLEMS.md).

**Branch on the `type` anchor, not only the status.** A 401 or 429 does not
always come from this Worker's own gate:

| `type` anchor | Source | Next step |
|---|---|---|
| `#unauthorized`, `#rate-limited` | The shadow-API bearer gate or auth throttle | The 401 and 429 recipes below |
| `#upstream-error` | Routeware's own HTTP 400–599, **including 401 and 429**, on a `/api/v1/routeware/*` passthrough route | [Upstream errors keep their status](#upstream-errors-keep-their-status) |
| `#bad-gateway` | An HTML error page behind an upstream HTTP 200, or an upstream timeout | The 502 recipe below |
| No `type`: JSON with `"ok":false` and `routewareStatus` | An ordinary `/api/v1/data/*` save envelope, which can carry Routeware's own status (including 401 or 429) | The `/data/*` row in [Troubleshooting](#troubleshooting) |

### 401: fix the bearer or use the correct gate

With the local Worker running, omit the bearer on a D1-only read:

```bash
curl -sS -i "http://localhost:8787/api/v1/customer-snapshot?limit=1"
# HTTP 401; Content-Type: application/problem+json
```

Expected body (unless this IP is already throttled):

```json
{
  "type": "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.",
  "instance": "/api/v1/customer-snapshot"
}
```

`instance` contains the path, not `?limit=1`. The privileged gate uses the
same envelope but names `<CUSTOMER_SNAPSHOT_SYNC_SECRET>` in `detail`.

**Fix:** retry the same read with the general token already loaded in step 1:

```bash
curl -sS -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?limit=1"
# HTTP 200 once the local D1 migrations are applied; empty rows are OK.
```

If the same token works for that read but returns 401 on `/api/v1/data/*`,
use the privileged `$SYNC` value instead:

```bash
curl -sS -i -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/customer?id=42"
# HTTP 200 for a seeded id, or 404 not-found (auth passed, id is absent).
```

Do not repeatedly guess tokens or automatically escalate every read to the
sync secret. If the correct value still 401s, ask the operator to check the
server-side token configuration; local `.dev.vars` changes need a Worker
restart. This applies only when `type` ends in `#unauthorized`; a 401 ending
in `#upstream-error` is Routeware's response, so changing the bearer will not
help ([see below](#upstream-errors-keep-their-status)). Catalog:
[`unauthorized`](./PROBLEMS.md#unauthorized).

### 429: stop invalid-auth retries

The 20th failed outer-gate check in a fresh 60-second window returns 429.
This bounded **local-only** drill first uses a valid token to attempt a reset
of a synthetic IP bucket, then makes exactly 20 unauthenticated GETs. The
probe must return 200 before proceeding, but 200 proves authentication, not
that storage accepted the reset. The expected threshold assumes a fresh
bucket and healthy throttle storage. `/shadow/health` does not touch upstream.
`CF-Connecting-IP` below selects the local test bucket; Cloudflare supplies
that header on deployed requests. Do not spoof it on a deployed origin or
change the throttle configuration for this drill.

```bash
(
  set -e
  curl -fsS --max-time 2 -o /dev/null -H "Authorization: Bearer $TOKEN" \
    -H "CF-Connecting-IP: 192.0.2.21" \
    "http://localhost:8787/api/v1/shadow/health"
  for attempt in {1..19}; do
    curl -sS --max-time 2 -o /dev/null -H "CF-Connecting-IP: 192.0.2.21" \
      "http://localhost:8787/api/v1/shadow/health"
  done
  curl -sS --max-time 2 -i -H "CF-Connecting-IP: 192.0.2.21" \
    "http://localhost:8787/api/v1/shadow/health"
)
# First 19 failed checks: HTTP 401. Final check: HTTP 429.
# Content-Type: application/problem+json; Retry-After: 60
# X-RateLimit-Limit: 19; X-RateLimit-Remaining: 0
# X-RateLimit-Reset: <absolute Unix time in seconds when the block expires>
# RateLimit: "auth-burst";r=0;t=60; RateLimit-Policy: "auth-burst";q=19;w=60
```

```json
{
  "type": "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#rate-limited",
  "title": "Too Many Requests",
  "status": 429,
  "detail": "Too many failed authentication attempts. Wait and retry. See docs/PROBLEMS.md#rate-limited.",
  "instance": "/api/v1/shadow/health"
}
```

`Retry-After` is a positive integer number of seconds (up to 60 here), not
an HTTP date. The same 429 also carries three `X-RateLimit-*` headers:

- `X-RateLimit-Limit: 19` — the failed auth checks allowed per IP in the
  60-second window; the next (20th) failed check is the first 429.
- `X-RateLimit-Remaining: 0` — no failed checks remain while blocked. It is
  always `0` on this 429; the headers appear only on the 429, not on the
  preceding 401s, so there is no countdown to poll.
- `X-RateLimit-Reset` — the moment the block expires as an absolute Unix
  time in **seconds** (not milliseconds and not a relative delay). It is
  the same expiry `Retry-After` counts down to, in absolute form; prefer
  `Retry-After` for the wait itself, since it needs no clock agreement
  with the server.

The same 429 also carries the standard equivalents (`draft-ietf-httpapi-ratelimit-headers`
shape), computed from the same throttle verdict, so any HTTP client can parse
them without knowing the `X-RateLimit-*` names:

- `RateLimit: "auth-burst";r=0;t=<retryAfterSec>` — quota policy `auth-burst`
  with `r` (remaining: always `0` here, matching `X-RateLimit-Remaining`) and
  `t` (backoff in seconds, matching `Retry-After`).
- `RateLimit-Policy: "auth-burst";q=19;w=60` — the policy itself: `q` (quota:
  19 failed checks allowed per window) and `w` (window: 60 seconds).

CORS exposes `Retry-After`, all three `X-RateLimit-*` headers, and the standard
`RateLimit`/`RateLimit-Policy` fields, so
browser clients can read them cross-origin. **Fix:** stop the invalid-auth
loop and honor the returned delay before another unauthenticated attempt;
repeated failures can renew the
block. If you already have a valid token, it passes the outer gate immediately
and attempts to clear the bucket; a 200 does not confirm the reset:

```bash
curl -sS -i -H "Authorization: Bearer $TOKEN" \
  -H "CF-Connecting-IP: 192.0.2.21" \
  "http://localhost:8787/api/v1/shadow/health"
# HTTP 200, not 429. A later privileged gate can still reject this token.
```

If 429 arrives early, the bucket may not have reset or other local requests
may share it. If the drill remains at 401, counting may have failed open;
authentication still fails closed. Do not disable the gate to make the
example pass. The mocked threshold/recovery tests are the deterministic
alternative:

```bash
npm test -- test/authThrottle.test.ts
```

This recipe applies only when `type` ends in `#rate-limited`; a 429 ending in
`#upstream-error` carries no `Retry-After`, no `X-RateLimit-*` headers, and no
`RateLimit`/`RateLimit-Policy` fields
([see below](#upstream-errors-keep-their-status)). Catalog:
[`rate-limited`](./PROBLEMS.md#rate-limited).

### 502 and other upstream failures: distinguish them from client authentication

An upstream HTTP 200 can still contain an HTML error page. For example,
`GET /api/v1/routeware/reports/query-request-is-complete?requestID=abc-123`
returns the following **only when upstream answers with that failure**, not
because `abc-123` is a magic error trigger:

```json
{
  "type": "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-gateway",
  "title": "Bad Gateway",
  "status": 502,
  "detail": "Upstream read failed: Routeware answered QueryRequestIsComplete with HTTP 200 but the body looks like an HTML error page (silent failure). The poll did not succeed. See docs/PROBLEMS.md#bad-gateway.",
  "instance": "/api/v1/routeware/reports/query-request-is-complete"
}
```

The Worker returns HTTP 502 with `Content-Type: application/problem+json`
and no `Retry-After` for this case. **Copy-paste reproduction:** the existing
fixture supplies fake session state and HTML, so it never calls the tenant:

```bash
npm test -- test/readRoutesSilentFailure.test.ts \
  -t "surfaces an upstream query-request-is-complete HTML-200 error page as 502 problem\+json"
# 1 matching test passes by asserting HTTP 502, not by returning 200.
```

Do not run an upstream-backed curl merely to force a 502: even local
`wrangler dev` forwards to Routeware. For timeout behavior, use the mocked
GET fixture instead:

```bash
npm test -- test/upstreamTimeout.test.ts \
  -t "a hung upstream answers 502 problem\+json with exactly one attempt"
```

A timeout uses the same `bad-gateway` type but the title `Upstream timed out`;
the `detail` names the configured timeout budget. **Not every timeout 502
carries `Retry-After`: the response path matters.**

| Timeout response path | `Retry-After` |
|---|---|
| Direct-forwarder timeout reaching the `app.onError` backstop | Fixed `5` seconds, from `UPSTREAM_TIMEOUT_RETRY_AFTER_SEC` in `src/lib/upstreamTimeout.ts`. |
| Timeout caught by `forwardWithSessionRetry`, on either the first forward or the post-login retry | Absent. This includes `GET /api/v1/routeware/home/index` and the customer, address and container read/save routes that use this helper. |

Both paths return the same problem type, title and body shape; those fields do
not tell clients whether a retry delay is supplied. Check the header itself.
The HTML error page above, concurrent-refresh timeout and login-unavailable
502s also send no `Retry-After`. Auth-throttle 429 responses retain their own
`Retry-After` header.

**Fix:** for a read timeout, honor `Retry-After` when present; if absent, wait
5 seconds as a client-side fallback before retrying once. Do not retry in a
tight loop. If it persists, ask the operator to check Routeware availability,
the session, and the login path. Changing the client bearer or raising the
timeout does not repair an upstream failure. For the HTML error above, have
the operator inspect the upstream session/report request before retrying;
the problem body never includes the raw HTML.

For saves, **do not blindly replay the write**: verify the outcome first.
The `/routeware/*` silent-save failures described in step 4 use 502
`bad-gateway` problem+json, an explicit Routeware 4xx/5xx on those routes keeps
its own status as [`upstream-error`](#upstream-errors-keep-their-status), and
`/data/*` saves can return ordinary JSON with `ok:false` (and a 200 or
upstream error status). Anti-forgery preparation failures use problem+json
separately. Check both HTTP status and the save envelope; not every `/data/*`
502 is an anti-forgery failure. Catalog:
[`bad-gateway`](./PROBLEMS.md#bad-gateway).

### Upstream errors keep their status

When Routeware itself answers a `/api/v1/routeware/*` passthrough route with
HTTP 400–599, the Worker keeps that status (it can be 401, 429, 503 or any
other, not only 502) but replaces the response with a fixed problem body and
`Cache-Control: no-store`. The upstream body and headers are withheld, so
there is **no `Retry-After`** and no upstream error text. Representative
body for an upstream 429:

```json
{
  "type": "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#upstream-error",
  "title": "Upstream request failed",
  "status": 429,
  "detail": "Routeware returned an error. Its response body has been withheld."
}
```

**Fix:** the request already passed this Worker's bearer gate, so do not
change or rotate the bearer, and do not wait for a `Retry-After` header that
will not arrive. Do not loop on retries. For a save, verify the record before
resubmitting (see above), then ask the operator to check Routeware
availability, the session, and the login path. The mocked fixture below
reproduces this without calling the tenant:

```bash
npm test -- test/passthroughLoudFailure.test.ts \
  -t "preserves HTTP 429, not its body"
# 1 matching test passes by asserting HTTP 429 is kept with the upstream-error body.
```

Catalog: [`upstream-error`](./PROBLEMS.md#upstream-error).

## Troubleshooting

| Symptom | Meaning |
|---|---|
| 401 on everything except `/health`, `type` ends `#unauthorized` | Missing/wrong bearer, or no token configured server-side (fails closed). General token on a privileged route also 401s — use the sync secret only for that gate. See [401 recipe](#401-fix-the-bearer-or-use-the-correct-gate). |
| 429, `type` ends `#rate-limited` | Too many failed auth attempts from your IP; stop the bad requests and honor `Retry-After`. See [429 recipe](#429-stop-invalid-auth-retries). |
| 401, 429 or any 400–599 on a `/routeware/*` route, `type` ends `#upstream-error` | Routeware's own error, relayed with its status. Your bearer was accepted; do not change it, and there is no `Retry-After`. For a save, verify the record before resubmitting, then ask the operator. See [upstream errors](#upstream-errors-keep-their-status). |
| 200 with `"rows":[]` | Auth works; D1 has no snapshot data yet (operator runs the sync). |
| 404 `not-found` on `/data/*` | That id is not in D1. |
| 502 `bad-gateway` on a `/routeware/*` save | Routeware rejected the save with an HTTP 200 HTML error page, the upstream timed out, or anti-forgery preparation failed; see the problem+json `detail`. After a timeout the save may have completed, so verify the record before resubmitting. An explicit Routeware 4xx/5xx keeps its own status under `#upstream-error` (row above). |
| `"ok":false` on a `/data/*` save (HTTP 200 or Routeware's status, no `type`) | Same upstream rejection, different envelope — check `routewareStatus` / `upstreamBytes`. If `routewareStatus` is 401 or 429 it is Routeware's own error: do not change the bearer, there is no `Retry-After`, verify the record before resubmitting, then ask the operator. For any other status, also verify the record before resubmitting, fix the form if that is the cause, then retry. |
| 405 on `DELETE` | By design — disable via save (step 5). |

Worker-generated problem responses are `application/problem+json` with a
`type` URL pointing at the [`PROBLEMS.md`](./PROBLEMS.md) section that explains
them. The ordinary `/data/*` save envelope is the exception described above.

### Problem `type` base override

Operators can point snapshot archive problem `type` URLs, including
authentication and request-validation responses, at their own catalog by
setting `PROBLEM_TYPE_BASE` (`wrangler.toml` `[vars]`,
`.dev.vars`, or `wrangler secret put`) to the catalog URL with the trailing
`#` included (e.g.
`https://github.com/<owner>/routeware-shadow-api/blob/main/docs/PROBLEMS.md#`).
The value is used verbatim after trimming; absent, empty or whitespace-only
keeps the default byte-identical. Consumers must match the status and the
documented slug, not a fixed hostname.

This is not a universal route guarantee: `DELETE /api/v1/customer-snapshot/{customerId}`
still uses the default catalog for its non-positive-id 400, absent-row 404 and
referenced-by-addresses 400. Those responses do not indicate stale configuration;
redeploying does not change them. For an **archive** response that unexpectedly
uses the default catalog, confirm the binding in the deployed environment
(`[vars]` vs secret); updating the binding requires redeployment. Archive routes
read the effective base from their request environment.

## Correlate retries with `X-Request-Id`

Send one id per logical attempt and reuse it across that attempt's retries;
every `/api/v1` response echoes it, including 401/429, 404, and 5xx, so the
id joins your retries to the server-side log line. Use 1–128 chars of RFC
7230 token chars (`A–Z a–z 0–9` plus `!#$%&'*+-.^_`|~`); anything else is
ignored and the server mints a UUID instead — the request never fails for a
bad id. The gate/notFound/onError problem bodies also carry it as
`requestId`, and browsers can send and read it (allowed + exposed via CORS).
This is correlation only, not idempotency: reusing an id never dedupes a
save — still verify the record before resubmitting (rows above).

```bash
RID="retry-$(date +%s)-a1"
curl -sS -i -H "Authorization: Bearer $TOKEN" -H "X-Request-Id: $RID" \
  "http://localhost:8787/api/v1/shadow/health" | grep -i "x-request-id"
# X-Request-Id: retry-...-a1 (echoed byte-identical)
```

## Smoke ladder: five copy-paste commands (fresh clone → green)

Run these verbatim after `cp .dev.vars.example .dev.vars` (fill in
`LOGIN_USERNAME` / `LOGIN_PASSWORD` plus one token), `npm run db:migrate:local`,
and `npm run dev`. Every command below was run verbatim against local dev on
current `origin/main` — match the bodies and the `HTTP` footers exactly.

```bash
# 1. Liveness — no token. Proves the Worker is up.
curl -s -w '\nHTTP %{http_code}\n' http://localhost:8787/api/v1/health
# {"status":"ok","service":"routeware-shadow-api","version":"1.0.0"}
# HTTP 200
```

```bash
# 2. The bearer gate is up — no token must fail closed, never 200/empty.
curl -s -w '\nHTTP %{http_code}\n' http://localhost:8787/api/v1/shadow/health
# {"type":".../PROBLEMS.md#unauthorized","title":"Unauthorized","status":401,...}
# HTTP 401
```

```bash
# 3. Load the token from .dev.vars into this shell (never printed).
#    Prefers SHADOW_API_TOKEN, falls back to CUSTOMER_SNAPSHOT_SYNC_SECRET;
#    last non-empty line wins (the example file ships both keys empty).
TOKEN=$(grep -E '^[[:space:]]*(export[[:space:]]+)?SHADOW_API_TOKEN[[:space:]]*=' .dev.vars | cut -d= -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" | grep -v '^$' | tail -1)
[ -n "$TOKEN" ] || TOKEN=$(grep -E '^[[:space:]]*(export[[:space:]]+)?CUSTOMER_SNAPSHOT_SYNC_SECRET[[:space:]]*=' .dev.vars | cut -d= -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" | grep -v '^$' | tail -1)
[ -n "$TOKEN" ] && echo "token loaded (${#TOKEN} chars, value redacted)" || echo "EMPTY: set SHADOW_API_TOKEN in .dev.vars and restart wrangler dev"
# token loaded (N chars, value redacted)
```

```bash
# 4. Versioned shadow probe — authed. Extra "version":"v1" vs rung 1.
curl -s -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/shadow/health
# {"status":"ok","service":"routeware-shadow-api","version":"v1"}
# HTTP 200
```

```bash
# 5. Deep readiness — authed. 200 means D1 answers, R2 is bound (or archiving
#    explicitly disabled), and all three report sources are configured.
#    `checks.cron` is advisory only: on a fresh clone it reports stale with
#    null tables (the daily cron has never run) without flipping the overall
#    status — that is expected, not a failure. (Fresh clones show 200: the
#    [vars] defaults configure all three report query ids.)
#    A 503 with "status":"degraded" is still a *passing probe response* —
#    it names the sick dependency in checks — but stop and fix it, don't
#    roll forward.
curl -s -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/readiness
# {"status":"ok","service":"routeware-shadow-api","checks":{"d1":{"ok":true},"r2":{"ok":true,"bound":true,"enabled":true},"config":{"ok":true,"customer":true,"address":true,"container":true},"cron":{"ok":false,"stale":true,"lastRunAt":null,"tables":{"customer":null,"address":null,"container":null},"detail":"No cron run recorded yet (cron_sync_state is empty or unreadable)."}}}
# HTTP 200
```

Rung-by-rung failures: `curl: (7)` on rung 1 → `npm run dev` is not
listening (see `README.md` quick start); rung 2 returning anything but 401 →
the bearer gate is miswired, file a bug; rung 3 `EMPTY` → fill in a token in
`.dev.vars` and restart `wrangler dev` (it reads the file only at boot);
rungs 4–5 401 → the loaded value does not match the server's (edited
`.dev.vars` without restarting, or wrong shell); rung 5 503 → read
`checks.{d1,r2,config}` for the culprit (`detail` names it, values never
leak) — `checks.cron` staleness alone never 503s, it is advisory.

Readiness waits up to 15 seconds for concurrent D1 ping and cron observations
(`min(DEFAULT_UPSTREAM_TIMEOUT_MS, READINESS_CACHE_TTL_MS)`); a ping timeout
returns 503, while a cron timeout leaves otherwise-healthy readiness at 200.
Results, including failures/timeouts, are cached for 20 seconds from refresh
start; hits never extend expiry. Failed checks add `code` (`d1_ping_timeout`,
`d1_ping_failed`, `cron_state_timeout`, or `cron_state_failed`) and
`next_action: "retry_after_cache_ttl"`. Wait 20 seconds before retrying rather
than spinning on cached failures. Exception messages/stacks are never exposed.
A response timeout does **not** cancel underlying D1 work. See
[the cache and bounded-wait contract](READINESS-CACHE.md) for recovery and the
credential-free focused acceptance command.
