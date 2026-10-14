-- Keep an id-only erasure marker outside the customer FK graph. A marker must
-- survive deletion of its customer row so later imports/syncs cannot restore it.
CREATE TABLE customer_snapshot_erasure (
  customer_id INTEGER PRIMARY KEY,
  erased_at TEXT NOT NULL
);

-- The triggers are the write boundary for every customer upsert path, including
-- cron sync, proxy-save refresh, and CSV/R2 archive imports.
CREATE TRIGGER suppress_erased_customer_insert
BEFORE INSERT ON customer_snapshot
WHEN EXISTS (
  SELECT 1 FROM customer_snapshot_erasure
  WHERE customer_id = NEW.customer_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER suppress_erased_customer_update
BEFORE UPDATE ON customer_snapshot
WHEN EXISTS (
  SELECT 1 FROM customer_snapshot_erasure
  WHERE customer_id = OLD.customer_id OR customer_id = NEW.customer_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;
