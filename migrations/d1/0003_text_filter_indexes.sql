-- Covering indexes for the container/address free-text list filters.
--
-- The list routes filter with `instr(lower(coalesce(col, '')), lower(?)) > 0`
-- (substring, case-insensitive). SQLite cannot seek a B-tree for a substring
-- predicate, so a bare expression index on the text column leaves the plan at
-- SCAN (verified with EXPLAIN QUERY PLAN on a seeded DB: the expression index
-- is only ever "USING COVERING INDEX" for a full scan, never SEARCH).
--
-- What DOES move the plan is the `enabled = ?` equality these filters compose
-- with (`enabled=true` / `enabled=false`; `enabled=any` adds no predicate).
-- The composite indexes below turn the `enabled + q` SELECT and COUNT shapes
-- from SCAN into SEARCH on the `enabled` prefix (COUNT is covering), and they
-- serve the `enabled`-alone shape too. The `q`-alone shape (`enabled=any`)
-- honestly still scans: no B-tree can serve a mid-string substring match.
-- That boundary is pinned in `test/snapshotTextFilterIndexes.test.ts`.
--
-- D1-compatible: plain `CREATE INDEX` with a deterministic expression
-- (`lower(coalesce(...))`), matching the exact expression text in the route
-- WHERE clauses. No FTS5 virtual table: that would require sync triggers and
-- a query rewrite, out of scope for this card.

CREATE INDEX idx_address_snapshot_enabled_address_lower ON address_snapshot (enabled, lower(coalesce(address, '')));
CREATE INDEX idx_container_snapshot_enabled_location_lower ON container_snapshot (enabled, lower(coalesce(location_address, '')));
CREATE INDEX idx_container_snapshot_enabled_serial_lower ON container_snapshot (enabled, lower(coalesce(serial_number, '')));
