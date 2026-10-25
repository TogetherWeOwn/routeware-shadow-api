# Snapshot list-filter EXPLAIN audit

**Run date:** 2026-10-08  
**Scope:** Current `GET /api/v1/{customer,address,container}-snapshot` list queries, including the ID filters composed with `q` and `enabled`.

## Method

- Ran `EXPLAIN QUERY PLAN` with Node 24.21.0 `node:sqlite` (SQLite 3.53.4), against an in-memory synthetic database with the committed D1 migrations.
- Seeded 609,000 rows: 100,000 customers, 200,000 addresses, and 309,000 containers. `enabled` was 95/5 and the synthetic text needle matched about 1% of rows. No tenant or production data was read.
- Enumerated the current routes' optional ID predicates, `q` absent/present, `enabled=any/true/false`, and both list SELECT and COUNT forms: 24 customer, 48 address, and 96 container variants (168 total). Captured plans before and after migration `0003_text_filter_indexes.sql`.
- The committed regression test uses the local Cloudflare D1 worker pool and pins the new composed address/container ID-filter shapes in `test/snapshotTextFilterIndexes.test.ts`.

Cloudflare recommends prefixing a query with `EXPLAIN QUERY PLAN` to see which indexes it uses ([D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/)). SQLite defines `SEARCH` as visiting a subset of rows and `SCAN` as iterating all rows, including an index-ordered full scan; its plan text is for interactive debugging, not a stable application API ([SQLite EQP](https://www.sqlite.org/eqp.html)).

## Findings

| Query shape | Plan / result after `0003` |
|---|---|
| Customer `customerId + q + enabled` | `SEARCH customer_snapshot USING INTEGER PRIMARY KEY (rowid=?)` |
| Address `customerId + q + enabled` | `SEARCH address_snapshot USING INDEX idx_address_snapshot_customer_id (customer_id=?)` |
| Address `pickupAddressId + q + enabled` | `SEARCH address_snapshot USING INTEGER PRIMARY KEY (rowid=?)` |
| Container `pickupAddressId + q + enabled` | `SEARCH c USING INDEX idx_container_snapshot_pickup_address_id (pickup_address_id=?)` |
| Container `containerId + q + enabled` | `SEARCH c USING INTEGER PRIMARY KEY (rowid=?)` |
| Container `customerId + q + enabled`, after planner statistics are refreshed | `SEARCH a USING COVERING INDEX idx_address_snapshot_customer_id (customer_id=?)` then `SEARCH c USING INDEX idx_container_snapshot_pickup_address_id (pickup_address_id=?)` |

Across all 168 variants, `0001+0002` produced 140 SEARCH and 28 SCAN plan records; after `0003`, 156 SEARCH and 12 SCAN. The 12 remaining SCAN records are the plain-list and `q`-alone SELECT/COUNT variants with `enabled=any`. Those shapes have no selective indexed predicate; `q` uses `instr(lower(coalesce(...)), lower(?))`, a mid-string substring match that the current B-tree indexes cannot seek. Enabled-filtered address/container shapes use the existing `0003` composites; customer enabled filters already use `0001`'s index.

## Planner-statistics caveat

Without statistics, the synthetic 609k-row run chose the container `enabled` composite as the outer loop for `customerId + q + enabled`, then checked the matching address. This is an indexed SEARCH, not a missing-index gap, but it scanned more rows than the customer-first join plan. Warm median local SELECT time was 38.730 ms for `enabled=true` and 9.522 ms for `enabled=false`. After `PRAGMA optimize`, SQLite chose the existing address-customer then container-pickup-address indexes; medians were 0.020 ms and 0.020 ms respectively. These are in-process synthetic measurements, not D1 request latency.

SQLite recommends `PRAGMA optimize` for maintaining planner statistics ([SQLite PRAGMA optimize](https://www.sqlite.org/pragma.html#pragma_optimize)). The rerun used it only against the in-memory database. No production or remote D1 was queried, and no production migration or `PRAGMA` was run. Whether deployed D1 has comparable statistics was not verified here.

## Address scope predicate audit

**Run date:** 2026-10-24. In-memory Node `node:sqlite` SQLite 3.53.4 with all
committed D1 migrations and 15 synthetic addresses (no tenant data). Used the
address route's SELECT column template and COUNT template with bound scope
predicates, `ORDER BY pickup_address_id LIMIT ? OFFSET ?` (or seek without
OFFSET). Both SELECT and COUNT produced these plans:

| WHERE additions after `1 = 1` | Local plan (both statements) |
| --- | --- |
| `route_id = ?` | `SCAN address_snapshot` |
| `franchise_id = ?` | `SCAN address_snapshot` |
| `route_id = ? AND franchise_id = ?` | `SCAN address_snapshot` |
| Both scopes plus `pickup_address_id > ?` | `SEARCH address_snapshot USING INTEGER PRIMARY KEY (rowid>?)` |
| `customer_id = ? AND route_id = ? AND franchise_id = ? AND instr(lower(coalesce(address, '')), lower(?)) > 0 AND enabled = 1` | `SEARCH address_snapshot USING INDEX idx_address_snapshot_customer_id (customer_id=?)` |

Each scope uses an equality placeholder, never interpolation, LIKE, a new
join or a deduplication step. Bind order follows WHERE order, followed by
limit/offset only for SELECT. The executable
`test/addressScopeFilters.acceptance.test.ts` independently records every
actual handler SELECT/bind against real local test D1, runs EXPLAIN on both
statements with an opaque quote/Unicode/percent fixture, and asserts exact
matches, read-only execution and denied network. Run
`npm run check:address-scope` to repeat that bounded check.

Scope-only reads may still scan; this feature bounds returned data, not
query cost. No migration/index, remote D1 probe, latency measurement or
production-performance claim. The small local plan observation does not
predict deployed planner choices or performance.

Addendum 2026-10-24: the table above records the street-only `q` leg the route
emitted on the run date. The street-or-locality change replaces that leg with
a parenthesized three-column `(address OR city OR zip)` predicate carrying
three identical bound needles; the pinned oracle in
`test/snapshotTextFilterIndexes.test.ts` shows the same SEARCH plans for the
composed shapes and the same `q`-alone SCAN. The historical rows are left
intact.

## Exact stored address ZIP predicate audit

**Run date:** 2026-10-24. In-memory Node `node:sqlite` SQLite 3.53.4 with all
committed D1 migrations and 4 synthetic addresses (two sharing `02139`, one
`07001`, one NULL; no tenant data). Used the address route's COUNT template
and full-column SELECT template with the bound `zip = ?` predicate:

| Statement shape | Local plan |
| --- | --- |
| `SELECT COUNT(*) ... WHERE 1 = 1 AND zip = ?` | `SEARCH address_snapshot USING COVERING INDEX idx_address_snapshot_zip (zip=?)` |
| Page SELECT with `zip = ?`, `ORDER BY pickup_address_id LIMIT ? OFFSET ?` | `SEARCH address_snapshot USING INDEX idx_address_snapshot_zip (zip=?)` |
| Page SELECT with `zip = ? AND pickup_address_id > ?` seek | `SEARCH address_snapshot USING INDEX idx_address_snapshot_zip (zip=? AND rowid>?)` |

The predicate is one bound equality placeholder, never interpolation, LIKE,
a new join or a deduplication step. The executable
`test/addressZipFilter.acceptance.test.ts` independently records every actual
handler SELECT/bind against real local test D1, runs EXPLAIN on both
statements with an opaque Unicode/reserved-character fixture, and asserts the
same `SEARCH ... idx_address_snapshot_zip (zip=?)` shape with exact matches,
read-only execution and denied network. Run `npm run check:address-zip` to
repeat that bounded check.

No migration/index, remote D1 probe, latency measurement or
production-performance claim. The small local plan observation does not
predict deployed planner choices or performance.

## Address container-presence predicate audit

**Run date:** 2026-10-24. In-memory Node `node:sqlite` SQLite 3.53.4 with all
committed D1 migrations and 6 synthetic addresses / 5 synthetic containers (no
tenant data). Used the address route's COUNT template and SELECT template with
the new correlated predicates, `ORDER BY pickup_address_id` with
`LIMIT ? OFFSET ?` (or seek without OFFSET). Each row below is the full local
plan for that statement shape:

| Statement shape | Local plan |
| --- | --- |
| `COUNT` with `EXISTS (...)` | `SCAN address_snapshot USING COVERING INDEX idx_address_snapshot_customer_id` then `SEARCH container_snapshot EXISTS USING COVERING INDEX idx_container_snapshot_pickup_address_id (pickup_address_id=?)` |
| `COUNT` with `NOT EXISTS (...)` | `SCAN address_snapshot USING COVERING INDEX idx_address_snapshot_customer_id`, `CORRELATED SCALAR SUBQUERY 1`, then `SEARCH container_snapshot USING COVERING INDEX idx_container_snapshot_pickup_address_id (pickup_address_id=?)` |
| `SELECT` with `EXISTS`/`NOT EXISTS`, offset page | `SCAN address_snapshot`, `CORRELATED SCALAR SUBQUERY 1`, then `SEARCH container_snapshot [EXISTS] USING COVERING INDEX idx_container_snapshot_pickup_address_id (pickup_address_id=?)` |
| `SELECT` with `EXISTS`, keyset seek | `SEARCH address_snapshot USING INTEGER PRIMARY KEY (rowid>?)` then `SEARCH container_snapshot EXISTS USING COVERING INDEX idx_container_snapshot_pickup_address_id (pickup_address_id=?)` |
| `SELECT` with `EXISTS` plus `customer_id = ?`, desc | `SEARCH address_snapshot USING COVERING INDEX idx_address_snapshot_customer_id (customer_id=?)` then `SEARCH container_snapshot EXISTS USING COVERING INDEX idx_container_snapshot_pickup_address_id (pickup_address_id=?)` |

Every shape resolves the correlated child lookup through the existing
`idx_container_snapshot_pickup_address_id`; no plan scans the child table. The
enum becomes a predicate, not a bind: COUNT carries only the filter binds and
SELECT adds just the page window. The executable
`test/addressContainerPresence.acceptance.test.ts` independently records every
actual handler SELECT/bind against real local test D1, runs EXPLAIN on both
statements for both enum values, and asserts exact matches, read-only
execution and denied network. Run `npm run check:address-container-presence`
to repeat that bounded check.

Presence-only reads may still scan the parent; this feature bounds returned
data, not query cost. No migration/index, remote D1 probe, latency measurement
or production-performance claim. The small local plan observation does not
predict deployed planner choices or performance.

## Decision

No missing index was found, so no new index or migration was added. The ID filters compose with existing primary-key/customer/pickup-address indexes; adding another index without a D1-side measured benefit would add write cost without evidence. The `q`-alone full scans are an expected substring-search limitation, not a missing B-tree index. If deployed D1 plans for customer-filtered container lists remain enabled-first, validate its statistics/query insights separately before considering a code or index change.
