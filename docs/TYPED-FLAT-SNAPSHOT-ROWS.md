# Typed flat snapshot rows

The six flat snapshot reads publish storage-faithful row types in
`/openapi.json`, so agents and generated clients stop guessing field types
from an untyped property bag:

| Read | List 200 | By-ID 200 |
| --- | --- | --- |
| `GET /api/v1/customer-snapshot{,/{customerId}}` | `CustomerSnapshotList` | `CustomerSnapshotRow` |
| `GET /api/v1/address-snapshot{,/{pickupAddressId}}` | `AddressSnapshotList` | `AddressSnapshotRow` |
| `GET /api/v1/container-snapshot{,/{containerId}}` | `ContainerSnapshotList` | `ContainerSnapshotRow` |

Each list envelope is `{rows, total, nextCursor}` with all three keys always
present (see below); each `rows.items` and each by-ID 200 resolves through a
`$ref` to its resource's row schema. The row property sets equal the sparse
fieldset registry (`SNAPSHOT_FIELDSETS` in `src/lib/sparseFieldsets.ts`),
which is also the `?fields=` allowlist — one authority for selectable fields
and declared properties.

## Reading the types

- **Integers are stored integers.** Primary keys, the required foreign keys
  (`address.customer_id`, `container.pickup_address_id`), the nullable type
  codes (`customer_type_id`, `route_id`, `container_type_id`) and the stored
  flags (`enabled`, `extras_allowed`, `oncall`, `gps_locked`) are all
  `integer`. Flags arrive as `0`/`1` numbers, never JSON booleans.
- **Everything else is stored text**, including `latitude`/`longitude`,
  `last_audit_date`, `service_date`, the `route_ids`/`frequency_ids` lists,
  the `ud_*` inspection fields and `synced_at`. These carry no `format`,
  `pattern`, `enum` or range facets: coordinates are decimal strings (not
  numbers), dates are date spellings (not timestamps), and the id lists are
  comma-delimited strings (not arrays). Parse them defensively.
- **Only the identity is required.** Full rows carry every column; a sparse
  `?fields=a,b` row carries exactly the identity plus `a` and `b`. Every
  non-identity property is optional with accurate nullability when present:
  nullable columns stay present as `null` on full rows, never omitted.
- **`total: null` means deliberately not computed**, not zero: see
  [the query policy](SNAPSHOT-LIST-QUERY-POLICY.md) for the `includeTotal=false`
  contract. **`nextCursor`** is the last row's primary key when the page contains
  `limit` rows, including a terminal full page; following that cursor returns
  an empty page. It is `null` when fewer than `limit` rows are returned.

Nothing else is promised: no positivity, enum, timestamp-format or
safe-integer guarantees beyond the storage types above. The declarations are
docs-only — served bytes, `SELECT` lists, projection, conditional and auth
behavior are byte-identical before and after.

## Scope

Flat reads only. Hydrated `/data` bundles, the customer changes feed (whose
composite cursor keeps its own schema), sync/save outcomes, exports and
error-policy work are unchanged; see the [consumer
quickstart](CONSUMER-QUICKSTART.md) for those flows.

## Focused check

Run `npm run check:typed-flat-snapshot-rows` for the mounted-contract
acceptance plus the envelope/example oracles, with synthetic fixtures on real
local D1 and forbidden outbound fetch. Pinned by
`test/typedFlatSnapshotRows.acceptance.test.ts`.
