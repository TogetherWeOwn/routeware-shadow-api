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
| `/api/v1/container-snapshot` | `customerId`, `pickupAddressId`, `containerId`, `q`, `enabled`, `limit`, `offset`, `cursor`, `includeTotal`, `fields` | Ignore |
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

## Sparse fieldsets (`fields=`)

The three ordinary lists and their by-id reads accept an optional
`fields=` comma-separated selector that trims each response object to
exactly the requested stored columns plus the resource id. The id is
always present even when omitted from the selector; naming it explicitly
is not a duplicate. Lists keep the `{rows, total, nextCursor}` envelope —
only each row's keys shrink — and `fields=` composes with filters,
pagination and `includeTotal=false` without changing matches, counts or
cursors. The selectable set is an explicit per-resource allowlist in
`src/lib/sparseFieldsets.ts` (the route's `SELECT` columns, nothing else).
Hydrated `/api/v1/data/*` reads accept the same `fields=` selector on their
entity root and reject any other query key (see below); CSV exports and the
changes feed ignore `fields=` as an unknown name.

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

## Hydrated entity reads are strict

The three hydrated single-entity GETs do the opposite of the GET lists
above: any query key outside the route's declared set is a 400
`application/problem+json` before any cache or D1 work. A mistyped
`?field=` fails loudly instead of stripping to a full PII bundle the caller
tried to trim.

| GET route | Declared query keys | Unknown-name policy |
| --- | --- | --- |
| `/api/v1/data/customer` | `id`, `customerId`, `fields` | Reject (400) |
| `/api/v1/data/address` | `id`, `pickupAddressId`, `fields` | Reject (400) |
| `/api/v1/data/container` | `id`, `containerId`, `fields` | Reject (400) |

One shared guard (`rejectUnknownDataEntityQuery` in `src/routes/shared.ts`)
serves all three routes, immediately after the sync-secret gate and before
any other check. Sync-secret 401 precedence is preserved (a bad bearer with
a typo'd key keeps the 401), while invalid values such as `?fields=bogus`
and repeated known keys keep their existing validator-first 400. The 400
carries fixed allowed-keys guidance and never echoes submitted keys or
values:

```text
GET /api/v1/data/customer?id=94101&field=company_name

{"type":"https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request",
 "title":"Bad Request","status":400,
 "detail":"Unknown query parameter. Allowed query parameters: id, customerId, fields. See docs/PROBLEMS.md#bad-request."}
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
