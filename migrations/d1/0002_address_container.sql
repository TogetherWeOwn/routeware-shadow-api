-- Address / Container custom report CSVs (see CUSTOMER_SNAPSHOT.md). FK chain: customer -> address -> container.

CREATE TABLE address_snapshot (
  pickup_address_id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  route_id INTEGER,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  franchise_id TEXT,
  comments TEXT,
  extras_allowed INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  driver_note TEXT,
  latitude TEXT,
  longitude TEXT,
  last_audit_date TEXT,
  synced_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customer_snapshot (customer_id)
);

CREATE INDEX idx_address_snapshot_customer_id ON address_snapshot (customer_id);
CREATE INDEX idx_address_snapshot_zip ON address_snapshot (zip);

CREATE TABLE container_snapshot (
  container_id INTEGER PRIMARY KEY,
  pickup_address_id INTEGER NOT NULL,
  container_type_id INTEGER,
  serial_number TEXT,
  rfid TEXT,
  oncall INTEGER NOT NULL DEFAULT 0,
  event_code TEXT,
  gps_locked INTEGER NOT NULL DEFAULT 0,
  latitude TEXT,
  longitude TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  location_address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  container_note TEXT,
  ud_cost_share_ud TEXT,
  ud_enclosure_doors_ud TEXT,
  ud_last_compactor_inspection_ud TEXT,
  ud_last_enclosure_inspection_ud TEXT,
  ud_material_stream_ud TEXT,
  color TEXT,
  service_code_type TEXT,
  service_code_input TEXT,
  service_code TEXT,
  service_date TEXT,
  route_ids TEXT,
  frequency_ids TEXT,
  synced_at TEXT NOT NULL,
  FOREIGN KEY (pickup_address_id) REFERENCES address_snapshot (pickup_address_id)
);

CREATE INDEX idx_container_snapshot_pickup_address_id ON container_snapshot (pickup_address_id);
