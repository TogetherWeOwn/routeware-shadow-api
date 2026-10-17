-- Index serving GET /api/v1/customer-snapshot/changes.
--
-- The feed filters `synced_at > ?` and orders by `(synced_at, customer_id)`
-- (keyset order). The composite index turns that shape from SCAN into SEARCH
-- on the `synced_at` prefix; the `customer_id` second column covers the
-- tiebreak order. D1-compatible: plain CREATE INDEX, no FTS, no triggers.
--
-- `synced_at` is always an ISO-8601 UTC string (`new Date().toISOString()` in
-- `src/lib/snapshot/streamSync.ts`), so lexicographic `>` is chronological.

CREATE INDEX idx_customer_snapshot_synced_at ON customer_snapshot (synced_at, customer_id);
