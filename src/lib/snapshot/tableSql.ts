import type { AddressSnapshotRow } from "../csvAddressSnapshot";
import type { ContainerSnapshotRow } from "../csvContainerSnapshot";
import type { CustomerSnapshotRow } from "../csvCustomerSnapshot";

/**
 * Per-table INSERT/UPSERT SQL and row bindings for the D1 snapshot tables.
 *
 * Rows per statement are derived from D1's bound-parameter ceiling, so a wider
 * table automatically packs fewer rows per statement.
 */

/**
 * D1 allows at most 100 bound parameters per query (see D1 platform limits).
 * Exported (TOG-6552) so read-path chunking can prove its margin by
 * construction instead of hardcoding a second copy of the cap.
 */
export const D1_MAX_BINDS = 100;

const CUST_NCOLS = 14;
export const CUST_R_PER_STMT = Math.min(7, Math.floor(D1_MAX_BINDS / CUST_NCOLS));
const CUST_HEADER = `customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
  name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at`;
const CUST_ON = `ON CONFLICT(customer_id) DO UPDATE SET
  customer_type_id = excluded.customer_type_id,
  company_name = excluded.company_name,
  first_name = excluded.first_name,
  middle_initial = excluded.middle_initial,
  last_name = excluded.last_name,
  name_suffix = excluded.name_suffix,
  customer_number = excluded.customer_number,
  sub_customer_number = excluded.sub_customer_number,
  phone1 = excluded.phone1,
  phone2 = excluded.phone2,
  comments = excluded.comments,
  enabled = excluded.enabled,
  synced_at = excluded.synced_at
  WHERE customer_snapshot.synced_at <= excluded.synced_at`;

const ADDR_NCOLS = 16;
export const ADDR_R_PER_STMT = Math.min(6, Math.floor(D1_MAX_BINDS / ADDR_NCOLS));
const ADDR_HEADER = `pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
  extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at`;
const ADDR_ON = `ON CONFLICT(pickup_address_id) DO UPDATE SET
  customer_id = excluded.customer_id,
  route_id = excluded.route_id,
  address = excluded.address,
  city = excluded.city,
  state = excluded.state,
  zip = excluded.zip,
  franchise_id = excluded.franchise_id,
  comments = excluded.comments,
  extras_allowed = excluded.extras_allowed,
  enabled = excluded.enabled,
  driver_note = excluded.driver_note,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  last_audit_date = excluded.last_audit_date,
  synced_at = excluded.synced_at
  WHERE address_snapshot.synced_at <= excluded.synced_at`;

const CONT_NCOLS = 29;
export const CONT_R_PER_STMT = Math.min(3, Math.floor(D1_MAX_BINDS / CONT_NCOLS));
const CONT_HEADER = `container_id, pickup_address_id, container_type_id, serial_number, rfid, oncall, event_code,
  gps_locked, latitude, longitude, enabled, location_address, city, state, zip, container_note,
  ud_cost_share_ud, ud_enclosure_doors_ud, ud_last_compactor_inspection_ud, ud_last_enclosure_inspection_ud,
  ud_material_stream_ud, color, service_code_type, service_code_input, service_code, service_date,
  route_ids, frequency_ids, synced_at`;
const CONT_ON = `ON CONFLICT(container_id) DO UPDATE SET
  pickup_address_id = excluded.pickup_address_id,
  container_type_id = excluded.container_type_id,
  serial_number = excluded.serial_number,
  rfid = excluded.rfid,
  oncall = excluded.oncall,
  event_code = excluded.event_code,
  gps_locked = excluded.gps_locked,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  enabled = excluded.enabled,
  location_address = excluded.location_address,
  city = excluded.city,
  state = excluded.state,
  zip = excluded.zip,
  container_note = excluded.container_note,
  ud_cost_share_ud = excluded.ud_cost_share_ud,
  ud_enclosure_doors_ud = excluded.ud_enclosure_doors_ud,
  ud_last_compactor_inspection_ud = excluded.ud_last_compactor_inspection_ud,
  ud_last_enclosure_inspection_ud = excluded.ud_last_enclosure_inspection_ud,
  ud_material_stream_ud = excluded.ud_material_stream_ud,
  color = excluded.color,
  service_code_type = excluded.service_code_type,
  service_code_input = excluded.service_code_input,
  service_code = excluded.service_code,
  service_date = excluded.service_date,
  route_ids = excluded.route_ids,
  frequency_ids = excluded.frequency_ids,
  synced_at = excluded.synced_at
  WHERE container_snapshot.synced_at <= excluded.synced_at`;

function multiValueTuples(rowCount: number, nCols: number): string {
  const row = `(${Array(nCols).fill("?").join(", ")})`;
  return Array.from({ length: rowCount }, () => row).join(", ");
}

export function customerBindings(r: CustomerSnapshotRow, syncedAt: string): unknown[] {
  return [
    r.customerId,
    r.customerTypeId,
    r.companyName,
    r.firstName,
    r.middleInitial,
    r.lastName,
    r.nameSuffix,
    r.customerNumber,
    r.subCustomerNumber,
    r.phone1,
    r.phone2,
    r.comments,
    r.enabled ? 1 : 0,
    syncedAt
  ];
}

export function addressBindings(r: AddressSnapshotRow, syncedAt: string): unknown[] {
  return [
    r.pickupAddressId,
    r.customerId,
    r.routeId,
    r.address,
    r.city,
    r.state,
    r.zip,
    r.franchiseId,
    r.comments,
    r.extrasAllowed ? 1 : 0,
    r.enabled ? 1 : 0,
    r.driverNote,
    r.latitude,
    r.longitude,
    r.lastAuditDate,
    syncedAt
  ];
}

export function containerBindings(r: ContainerSnapshotRow, syncedAt: string): unknown[] {
  return [
    r.containerId,
    r.pickupAddressId,
    r.containerTypeId,
    r.serialNumber,
    r.rfid,
    r.onCall ? 1 : 0,
    r.eventCode,
    r.gpsLocked ? 1 : 0,
    r.latitude,
    r.longitude,
    r.enabled ? 1 : 0,
    r.locationAddress,
    r.city,
    r.state,
    r.zip,
    r.containerNote,
    r.udCostShareUd,
    r.udEnclosureDoorsUd,
    r.udLastCompactorInspectionUd,
    r.udLastEnclosureInspectionUd,
    r.udMaterialStreamUd,
    r.color,
    r.serviceCodeType,
    r.serviceCodeInput,
    r.serviceCode,
    r.serviceDate,
    r.routeIds,
    r.frequencyIds,
    syncedAt
  ];
}

export function customerMultiInsertSql(nRows: number): string {
  return `INSERT INTO customer_snapshot (${CUST_HEADER}) VALUES ${multiValueTuples(
    nRows,
    CUST_NCOLS
  )} ${CUST_ON}`;
}

export function addressMultiInsertSql(nRows: number): string {
  return `INSERT INTO address_snapshot (${ADDR_HEADER}) VALUES ${multiValueTuples(
    nRows,
    ADDR_NCOLS
  )} ${ADDR_ON}`;
}

export function containerMultiInsertSql(nRows: number): string {
  return `INSERT INTO container_snapshot (${CONT_HEADER}) VALUES ${multiValueTuples(
    nRows,
    CONT_NCOLS
  )} ${CONT_ON}`;
}
