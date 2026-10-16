-- Narrowly scoped descendant-write suppression for erased customers
-- (TOG-21964, CEO scoped_skip). A suppressed customer row would otherwise
-- leave its upstream-retained addresses dangling on the customer foreign key,
-- aborting the whole sync/restore with SnapshotForeignKeyError.
--
-- The lineage table records only integer keys of suppressed address writes so
-- a later container write can resolve its erased customer without a parent
-- address row (suppressed addresses are never inserted). It carries no PII
-- beyond the keys already in customer_snapshot_erasure, and rows cascade away
-- when their erasure marker is removed.
--
-- Container suppression keys on lineage alone, never on current address
-- ownership: an ownership check passes an erased customer's containers through
-- after a live-to-erased re-home (the skipped address write records lineage,
-- but the address row still sits under the live owner). A suppressed re-home
-- into an erased customer additionally deletes that address's containers at
-- once: the row stays under its previous owner and is never restamped, so its
-- children would make the address-stage reconcile fail its FK delete and abort
-- every later tick. Removing the erased-attributed children now leaves a
-- childless stale parent the next reconciling sync deletes normally. The AFTER
-- INSERT / AFTER UPDATE cleanup triggers below delete the lineage row whenever
-- an address write lands under a live customer, so a stale mapping can never
-- suppress the new owner's containers after an erased-to-live re-home.
--
-- The address UPDATE trigger keys on the NEW owner only, matching the INSERT
-- trigger: a write that stays under an erased customer is ignored and
-- re-records lineage, while an erased-to-live re-home flows instead of
-- freezing under the erased id. The container UPDATE trigger additionally keys
-- on OLD lineage so a direct-SQL move off a suppressed address cannot launder
-- the row under a live one.

CREATE TABLE customer_snapshot_erasure_address (
  pickup_address_id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  erased_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customer_snapshot_erasure (customer_id) ON DELETE CASCADE
);

-- The triggers stay the write boundary for every address/container upsert path
-- (cron sync, proxy-save refresh, CSV/R2 archive imports), matching the
-- customer triggers in 0006. Recording lineage inside the address trigger keeps
-- suppression and lineage atomic for direct-SQL writers too: statements before
-- RAISE(IGNORE) persist while the suppressed row is skipped.
CREATE TRIGGER suppress_erased_address_insert
BEFORE INSERT ON address_snapshot
WHEN EXISTS (
  SELECT 1 FROM customer_snapshot_erasure
  WHERE customer_id = NEW.customer_id
)
BEGIN
  -- An insert (or app upsert) of an existing row under another owner is a
  -- re-home into an erased customer. BEFORE INSERT triggers fire before SQLite
  -- resolves the ON CONFLICT clause, so the app upsert path reaches this
  -- trigger first and this DELETE clears the live address's containers so the
  -- reconcile survives. Genuinely new addresses match no row and this is a
  -- no-op for them.
  DELETE FROM container_snapshot
    WHERE pickup_address_id = NEW.pickup_address_id
      AND EXISTS (
        SELECT 1 FROM address_snapshot
        WHERE pickup_address_id = NEW.pickup_address_id
          AND customer_id != NEW.customer_id
      );
  INSERT INTO customer_snapshot_erasure_address (pickup_address_id, customer_id, erased_at)
    SELECT NEW.pickup_address_id, NEW.customer_id, erased_at FROM customer_snapshot_erasure
    WHERE customer_id = NEW.customer_id
    ON CONFLICT(pickup_address_id) DO UPDATE SET customer_id = excluded.customer_id, erased_at = excluded.erased_at;
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER suppress_erased_address_update
BEFORE UPDATE ON address_snapshot
WHEN EXISTS (
  SELECT 1 FROM customer_snapshot_erasure
  WHERE customer_id = NEW.customer_id
)
BEGIN
  -- A suppressed re-home keeps the row under its previous owner without ever
  -- restamping it. Same-owner plain updates keep their children (the guard
  -- below is false for them); an owner change removes the erased-attributed
  -- children so the stale parent reconciles away instead of FK-aborting the
  -- address stage on every later tick.
  DELETE FROM container_snapshot
    WHERE pickup_address_id = NEW.pickup_address_id
      AND EXISTS (
        SELECT 1 FROM address_snapshot
        WHERE pickup_address_id = NEW.pickup_address_id
          AND customer_id != NEW.customer_id
      );
  INSERT INTO customer_snapshot_erasure_address (pickup_address_id, customer_id, erased_at)
    SELECT NEW.pickup_address_id, NEW.customer_id, erased_at FROM customer_snapshot_erasure
    WHERE customer_id = NEW.customer_id
    ON CONFLICT(pickup_address_id) DO UPDATE SET customer_id = excluded.customer_id, erased_at = excluded.erased_at;
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER suppress_erased_container_insert
BEFORE INSERT ON container_snapshot
WHEN EXISTS (
  SELECT 1 FROM customer_snapshot_erasure_address
  WHERE pickup_address_id = NEW.pickup_address_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER suppress_erased_container_update
BEFORE UPDATE ON container_snapshot
WHEN EXISTS (
  SELECT 1 FROM customer_snapshot_erasure_address
  WHERE pickup_address_id = NEW.pickup_address_id
) OR EXISTS (
  SELECT 1 FROM customer_snapshot_erasure_address
  WHERE pickup_address_id = OLD.pickup_address_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- A re-homed address must not keep suppressing its new owner's containers.
-- Container suppression keys on lineage alone, so these cleanup triggers
-- remove the stale row whenever an address write lands under a live customer;
-- without them the old mapping would suppress the new owner's containers.
CREATE TRIGGER clear_stale_erasure_lineage_on_address_insert
AFTER INSERT ON address_snapshot
WHEN NOT EXISTS (
  SELECT 1 FROM customer_snapshot_erasure WHERE customer_id = NEW.customer_id
)
BEGIN
  DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = NEW.pickup_address_id;
END;

CREATE TRIGGER clear_stale_erasure_lineage_on_address_update
AFTER UPDATE ON address_snapshot
WHEN NOT EXISTS (
  SELECT 1 FROM customer_snapshot_erasure WHERE customer_id = NEW.customer_id
)
BEGIN
  DELETE FROM customer_snapshot_erasure_address WHERE pickup_address_id = NEW.pickup_address_id;
END;
