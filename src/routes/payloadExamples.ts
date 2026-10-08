import type { CustomerBundle, AddressBundle, ContainerBundle } from "../lib/dataEntityRead";
import {
  CUSTOMER_SNAPSHOT_EXPORT,
  ADDRESS_SNAPSHOT_EXPORT,
  CONTAINER_SNAPSHOT_EXPORT,
  encodeSnapshotRow,
  snapshotExportHeaderLine
} from "../lib/snapshot/export";
import type { SnapshotExportSpec } from "../lib/snapshot/export";

/** Synthetic documentation fixtures only; never harvested tenant records. */
export const customerRowExample = {
  customer_id: 345734,
  customer_type_id: 1,
  company_name: "ExampleCo",
  first_name: "Jane",
  middle_initial: null,
  last_name: "Doe",
  name_suffix: null,
  customer_number: "C-1001",
  sub_customer_number: null,
  phone1: "555-0100",
  phone2: null,
  comments: null,
  enabled: 1,
  synced_at: "2026-01-01T00:00:00.000Z"
};

export const addressRowExample = {
  pickup_address_id: 10,
  customer_id: 345734,
  route_id: 1,
  address: "1 Main St",
  city: "Example City",
  state: "TX",
  zip: "76541",
  franchise_id: "1",
  comments: null,
  extras_allowed: 0,
  enabled: 1,
  driver_note: null,
  latitude: null,
  longitude: null,
  last_audit_date: null,
  synced_at: "2026-01-01T00:00:00.000Z"
};

export const containerRowExample = {
  container_id: 100,
  pickup_address_id: 10,
  container_type_id: 1,
  serial_number: "C-100-A",
  rfid: null,
  oncall: 0,
  event_code: null,
  gps_locked: 0,
  latitude: null,
  longitude: null,
  enabled: 1,
  location_address: "1 Main St",
  city: "Example City",
  state: "TX",
  zip: "76541",
  container_note: null,
  ud_cost_share_ud: null,
  ud_enclosure_doors_ud: null,
  ud_last_compactor_inspection_ud: null,
  ud_last_enclosure_inspection_ud: null,
  ud_material_stream_ud: null,
  color: "Blue",
  service_code_type: null,
  service_code_input: null,
  service_code: null,
  service_date: null,
  route_ids: null,
  frequency_ids: null,
  synced_at: "2026-01-01T00:00:00.000Z"
};

export const customerBundleExample: CustomerBundle = {
  customer: customerRowExample,
  addresses: [{ ...addressRowExample, containers: [containerRowExample] }]
};
export const addressBundleExample: AddressBundle = {
  address: addressRowExample,
  customer: customerRowExample,
  containers: [containerRowExample]
};
export const containerBundleExample: ContainerBundle = {
  container: containerRowExample,
  address: addressRowExample,
  customer: customerRowExample
};

/** Use the production export encoding and LF separators, not the import subset. */
function exportExample(spec: SnapshotExportSpec, row: Record<string, unknown>): string {
  return snapshotExportHeaderLine(spec) + "\n" + encodeSnapshotRow(spec, row) + "\n";
}

export const customerExportExample = exportExample(CUSTOMER_SNAPSHOT_EXPORT, customerRowExample);
export const addressExportExample = exportExample(ADDRESS_SNAPSHOT_EXPORT, addressRowExample);
export const containerExportExample = exportExample(CONTAINER_SNAPSHOT_EXPORT, containerRowExample);
