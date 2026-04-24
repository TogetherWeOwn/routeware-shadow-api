import { establishSessionWithBrowser } from "./browserAuth";
import { parseAddressSnapshotRow } from "./csvAddressSnapshot";
import type { AddressSnapshotRow } from "./csvAddressSnapshot";
import { parseContainerSnapshotRow } from "./csvContainerSnapshot";
import type { ContainerSnapshotRow } from "./csvContainerSnapshot";
import { parseCustomerSnapshotRow } from "./csvCustomerSnapshot";
import type { CustomerSnapshotRow } from "./csvCustomerSnapshot";
import { mapCsvHeaders } from "./csvParse";
import { stringToUint8Stream, streamCsvLines } from "./csvStream";
import { isLoginRedirect } from "./loginRedirect";
import { readSessionState } from "./sessionState";
import { fetchReportCsvByQueryId } from "./routewareQueryReportCsv";
import { forwardToUpstream } from "./upstreamForward";

const CUST_UPSERT = `INSERT INTO customer_snapshot (
  customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
  name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(customer_id) DO UPDATE SET
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
  synced_at = excluded.synced_at`;

const ADDR_UPSERT = `INSERT INTO address_snapshot (
  pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
  extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(pickup_address_id) DO UPDATE SET
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
  synced_at = excluded.synced_at`;

const CONT_UPSERT = `INSERT INTO container_snapshot (
  container_id, pickup_address_id, container_type_id, serial_number, rfid, oncall, event_code,
  gps_locked, latitude, longitude, enabled, location_address, city, state, zip, container_note,
  ud_cost_share_ud, ud_enclosure_doors_ud, ud_last_compactor_inspection_ud, ud_last_enclosure_inspection_ud,
  ud_material_stream_ud, color, service_code_type, service_code_input, service_code, service_date,
  route_ids, frequency_ids, synced_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(container_id) DO UPDATE SET
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
  synced_at = excluded.synced_at`;

function customerBindings(r: CustomerSnapshotRow, syncedAt: string): unknown[] {
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

function addressBindings(r: AddressSnapshotRow, syncedAt: string): unknown[] {
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

function containerBindings(r: ContainerSnapshotRow, syncedAt: string): unknown[] {
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

/** Fetch CSV from Routeware using the DO session (same as shadow API). */
export function createReportRequest(env: Env): Request {
  return new Request("http://internal/report", {
    method: "GET",
    headers: {
      accept: "text/csv,*/*;q=0.8",
      referer: `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/`
    }
  });
}

export async function fetchReportCsvForPath(
  env: Env,
  reportPath: string
): Promise<Response> {
  const url = new URL(reportPath, env.TARGET_ORIGIN);
  const stub = env.AUTH_SESSION.get(env.AUTH_SESSION.idFromName("primary"));
  let session = await readSessionState(stub);
  const req = createReportRequest(env);
  let resp = await forwardToUpstream(req, url, session, null);
  if (resp.status !== 200 || isLoginRedirect(resp)) {
    await establishSessionWithBrowser(env, stub, env.LOGIN_URL);
    session = await readSessionState(stub);
    resp = await forwardToUpstream(req, url, session, null);
  }
  if (!resp.ok) {
    throw new Error(`Report fetch failed: ${resp.status} ${resp.statusText}`);
  }
  return resp;
}

export async function upsertCustomerSnapshotRows(
  db: D1Database,
  rows: CustomerSnapshotRow[],
  batchSize = 80,
  syncedAt = new Date().toISOString()
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const stmts = chunk.map((r) =>
      db.prepare(CUST_UPSERT).bind(...customerBindings(r, syncedAt))
    );
    await db.batch(stmts);
    upserted += chunk.length;
  }
  return { upserted };
}

export async function upsertAddressSnapshotRows(
  db: D1Database,
  rows: AddressSnapshotRow[],
  batchSize = 80,
  syncedAt = new Date().toISOString()
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const stmts = chunk.map((r) =>
      db.prepare(ADDR_UPSERT).bind(...addressBindings(r, syncedAt))
    );
    await db.batch(stmts);
    upserted += chunk.length;
  }
  return { upserted };
}

export async function upsertContainerSnapshotRows(
  db: D1Database,
  rows: ContainerSnapshotRow[],
  batchSize = 50,
  syncedAt = new Date().toISOString()
): Promise<{ upserted: number }> {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const stmts = chunk.map((r) =>
      db.prepare(CONT_UPSERT).bind(...containerBindings(r, syncedAt))
    );
    await db.batch(stmts);
    upserted += chunk.length;
  }
  return { upserted };
}

export async function syncCustomerSnapshotFromCsvText(
  db: D1Database,
  csvText: string
): Promise<{ upserted: number; rowCount: number }> {
  const { rows } = parseCustomerSnapshotCsv(csvText);
  const { upserted } = await upsertCustomerSnapshotRows(db, rows);
  return { upserted, rowCount: rows.length };
}

export async function syncAddressSnapshotFromCsvText(
  db: D1Database,
  csvText: string
): Promise<{ upserted: number; rowCount: number }> {
  const { rows } = parseAddressSnapshotCsv(csvText);
  const { upserted } = await upsertAddressSnapshotRows(db, rows);
  return { upserted, rowCount: rows.length };
}

export async function syncContainerSnapshotFromCsvText(
  db: D1Database,
  csvText: string
): Promise<{ upserted: number; rowCount: number }> {
  const { rows } = parseContainerSnapshotCsv(csvText);
  const { upserted } = await upsertContainerSnapshotRows(db, rows);
  return { upserted, rowCount: rows.length };
}

export type SnapshotTableResult = {
  upserted: number;
  rowCount: number;
} | null;

export type DataSnapshotResult = {
  customer: SnapshotTableResult;
  address: SnapshotTableResult;
  container: SnapshotTableResult;
};

export async function runCustomerSnapshotSync(
  env: Env
): Promise<{
  upserted: number;
  rowCount: number;
} | null> {
  const path = env.CUSTOMER_REPORT_EXPORT_PATH?.trim();
  const queryId = env.CUSTOMER_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log("CUSTOMER_REPORT_EXPORT_PATH and CUSTOMER_REPORT_QUERY_ID unset; skip customer sync");
    return null;
  }
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  const csv = await resp.text();
  const head = csv.slice(0, 80).trimStart();
  if (!head.toLowerCase().startsWith("customerid")) {
    throw new Error(
      "Customer report is not valid CSV (missing CustomerID header). Check CUSTOMER_REPORT_EXPORT_PATH or query-id pipeline."
    );
  }
  return syncCustomerSnapshotFromCsvText(env.CUSTOMER_DB, csv);
}

export async function runAddressSnapshotSync(
  env: Env
): Promise<{
  upserted: number;
  rowCount: number;
} | null> {
  const path = env.ADDRESS_REPORT_EXPORT_PATH?.trim();
  const queryId = env.ADDRESS_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log("ADDRESS_REPORT_EXPORT_PATH and ADDRESS_REPORT_QUERY_ID unset; skip address sync");
    return null;
  }
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  const csv = await resp.text();
  const head = csv.slice(0, 120).trimStart().toLowerCase();
  if (!head.startsWith("pickupaddressid")) {
    throw new Error(
      "Address report is not valid CSV (missing PickupAddressID header). Check PATH or query-id config."
    );
  }
  return syncAddressSnapshotFromCsvText(env.CUSTOMER_DB, csv);
}

export async function runContainerSnapshotSync(
  env: Env
): Promise<{
  upserted: number;
  rowCount: number;
} | null> {
  const path = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
  const queryId = env.CONTAINER_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log(
      "CONTAINER_REPORT_EXPORT_PATH and CONTAINER_REPORT_QUERY_ID unset; skip container sync"
    );
    return null;
  }
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  const csv = await resp.text();
  const head = csv.slice(0, 80).trimStart().toLowerCase();
  if (!head.startsWith("containerid")) {
    throw new Error(
      "Container report is not valid CSV (missing ContainerID header). Check PATH or query-id config."
    );
  }
  return syncContainerSnapshotFromCsvText(env.CUSTOMER_DB, csv);
}

/**
 * Runs each configured export in dependency order. Address sync requires
 * `CUSTOMER_REPORT_EXPORT_PATH` (or `CUSTOMER_REPORT_QUERY_ID`) so `customer_id` foreign keys
 * are populated first; container requires both customer and address in this run to avoid
 * referential errors on empty D1.
 */
export async function runDataSnapshotSync(env: Env): Promise<DataSnapshotResult> {
  const cPath = env.CUSTOMER_REPORT_EXPORT_PATH?.trim();
  const cQ = env.CUSTOMER_REPORT_QUERY_ID?.trim();
  const aPath = env.ADDRESS_REPORT_EXPORT_PATH?.trim();
  const aQ = env.ADDRESS_REPORT_QUERY_ID?.trim();
  const tPath = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
  const tQ = env.CONTAINER_REPORT_QUERY_ID?.trim();
  const out: DataSnapshotResult = {
    customer: null,
    address: null,
    container: null
  };
  if (cPath || cQ) {
    out.customer = await runCustomerSnapshotSync(env);
  } else {
    console.log("No customer path or query ID; not syncing customers");
  }
  if (aPath || aQ) {
    if (!cPath && !cQ) {
      console.log(
        "Address is configured but customer is not — skip address (FK to customer). Set customer first."
      );
    } else {
      out.address = await runAddressSnapshotSync(env);
    }
  } else {
    console.log("No address path or query ID; not syncing addresses");
  }
  if (tPath || tQ) {
    if ((!cPath && !cQ) || (!aPath && !aQ)) {
      console.log(
        "Container is configured but customer and/or address is not — skip container (FKs). Set all three."
      );
    } else {
      out.container = await runContainerSnapshotSync(env);
    }
  } else {
    console.log("No container path or query ID; not syncing containers");
  }
  return out;
}
