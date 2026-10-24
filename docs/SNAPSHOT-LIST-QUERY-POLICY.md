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
| `/api/v1/customer-snapshot` | `customerId`, `q`, `enabled`, `limit`, `offset`, `cursor`, `includeTotal`, `fields` | Ignore |
| `/api/v1/address-snapshot` | `customerId`, `pickupAddressId`, `q`, `enabled`, `limit`, `offset`, `cursor`, `includeTotal`, `fields` | Ignore |
| `/api/v1/container-snapshot` | `customerId`, `pickupAddressId`, `containerId`, `serialNumber`, `rfid`, `q`, `enabled`, `limit`, `offset`, `cursor`, `includeTotal`, `fields` | Ignore |
| `/api/v1/customer-snapshot/changes` | `since`, `since_id`, `limit` | Ignore |

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

## Sparse fieldsets (`fields=`)

The three ordinary lists and their by-id reads accept an optional
`fields=` comma-separated selector that trims each response object to
exactly the requested stored columns plus the resource id. The id is
always present even when omitted from the selector; naming it explicitly
is not a duplicate. Lists keep the `{rows, total, nextCursor}` envelope —
only each row's keys shrink — and `fields=` composes with filters,
pagination and `includeTotal=false` without changing matches, counts or
cursors. The selectable set is an explicit per-resource allowlist in
`src/lib/sparseFieldsets.ts` (the route's `SELECT` columns, nothing else);
hydrated `/api/v1/data/*` reads, CSV exports and the changes feed ignore
`fields=` as an unknown name.

The selector is strict: exact column names, no spaces, no empty segments,
no duplicates, and a single `fields` key. Anything else is the existing
value-free anchored 400 before any D1 work. Synthetic example:

```text
GET /api/v1/customer-snapshot?fields=company_name,phone1&limit=1

{"rows":[{"customer_id":9101,"company_name":"synthetic-fields-co-9101","phone1":"555-9101"}],"total":1,"nextCursor":null}
```

Run `npx vitest run test/sparseFieldsets.acceptance.test.ts` for the
focused valid-selection, rejection, pagination-composition and ETag
regressions. No live replay.

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
