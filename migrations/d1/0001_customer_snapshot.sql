-- Routeware "Customer Details Custom" CSV snapshot (see CUSTOMER_SNAPSHOT.md).
CREATE TABLE customer_snapshot (
  customer_id INTEGER PRIMARY KEY,
  customer_type_id INTEGER,
  company_name TEXT,
  first_name TEXT,
  middle_initial TEXT,
  last_name TEXT,
  name_suffix TEXT,
  customer_number TEXT,
  sub_customer_number TEXT,
  phone1 TEXT,
  phone2 TEXT,
  comments TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT NOT NULL
);

CREATE INDEX idx_customer_snapshot_company_lower ON customer_snapshot (lower(company_name));
CREATE INDEX idx_customer_snapshot_enabled ON customer_snapshot (enabled);
