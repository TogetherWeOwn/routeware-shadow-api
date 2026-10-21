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
| `/api/v1/customer-snapshot` | `customerId`, `q`, `enabled`, `limit`, `offset`, `cursor`, `includeTotal` | Ignore |
| `/api/v1/address-snapshot` | `customerId`, `pickupAddressId`, `q`, `enabled`, `limit`, `offset`, `cursor`, `includeTotal` | Ignore |
| `/api/v1/container-snapshot` | `customerId`, `pickupAddressId`, `containerId`, `q`, `enabled`, `limit`, `offset`, `cursor`, `includeTotal` | Ignore |
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
