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
import { archiveReportCsvToR2AfterD1 } from "./r2SnapshotArchive";
import { forwardToUpstream } from "./upstreamForward";

/**
 * Foreign keys (`address.customer_id`, `container.pickup_address_id`) are
 * declared in the schema but D1 does not enforce them (no `PRAGMA foreign_keys`),
 * and a streamed sync spans many `db.batch` calls rather than one transaction —
 * so integrity relies on import order (customer → address → container) plus the
 * reconcile step below, not on the database. A report `sync` (not `import`)
 * deletes rows not seen in the current run so upstream deletions are reflected;
 * it is skipped when a run yields zero data rows to avoid wiping a table on a
 * bad/empty export.
 */

/** D1 allows at most 100 bound parameters per query (see D1 platform limits). */
const D1_MAX_BINDS = 100;

/** Delete rows whose `synced_at` predates this run (i.e. not present upstream anymore). */
async function reconcileDeleteStale(
  db: D1Database,
  table: "customer_snapshot" | "address_snapshot" | "container_snapshot",
  syncedAt: string
): Promise<number> {
  const res = await db
    .prepare(`DELETE FROM ${table} WHERE synced_at < ?`)
    .bind(syncedAt)
    .run();
  return res.meta.changes ?? 0;
}

export type SnapshotSyncCounts = {
  upserted: number;
  rowCount: number;
  deleted: number;
};

export type StreamSyncOptions = {
  /** Delete rows not seen in this run (report sync). Off for partial imports. */
  reconcile?: boolean;
};

const CUST_NCOLS = 14;
const CUST_R_PER_STMT = Math.min(7, Math.floor(D1_MAX_BINDS / CUST_NCOLS));
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
  synced_at = excluded.synced_at`;

const ADDR_NCOLS = 16;
const ADDR_R_PER_STMT = Math.min(6, Math.floor(D1_MAX_BINDS / ADDR_NCOLS));
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
  synced_at = excluded.synced_at`;

const CONT_NCOLS = 29;
const CONT_R_PER_STMT = Math.min(3, Math.floor(D1_MAX_BINDS / CONT_NCOLS));
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
  synced_at = excluded.synced_at`;

function multiValueTuples(rowCount: number, nCols: number): string {
  const row = `(${Array(nCols).fill("?").join(", ")})`;
  return Array.from({ length: rowCount }, () => row).join(", ");
}

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

function customerMultiInsertSql(nRows: number): string {
  return `INSERT INTO customer_snapshot (${CUST_HEADER}) VALUES ${multiValueTuples(
    nRows,
    CUST_NCOLS
  )} ${CUST_ON}`;
}

function addressMultiInsertSql(nRows: number): string {
  return `INSERT INTO address_snapshot (${ADDR_HEADER}) VALUES ${multiValueTuples(
    nRows,
    ADDR_NCOLS
  )} ${ADDR_ON}`;
}

function containerMultiInsertSql(nRows: number): string {
  return `INSERT INTO container_snapshot (${CONT_HEADER}) VALUES ${multiValueTuples(
    nRows,
    CONT_NCOLS
  )} ${CONT_ON}`;
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
    const stmts: D1PreparedStatement[] = [];
    for (let j = 0; j < chunk.length; j += CUST_R_PER_STMT) {
      const n = Math.min(CUST_R_PER_STMT, chunk.length - j);
      const slice = chunk.slice(j, j + n);
      const flat = slice.flatMap((r) => customerBindings(r, syncedAt));
      stmts.push(db.prepare(customerMultiInsertSql(n)).bind(...flat));
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(
        `D1 customer_snapshot batch at row offset ${i} (${chunk.length} rows, ${stmts.length} SQL ops): ${m}`,
        { cause: e }
      );
    }
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
    const stmts: D1PreparedStatement[] = [];
    for (let j = 0; j < chunk.length; j += ADDR_R_PER_STMT) {
      const n = Math.min(ADDR_R_PER_STMT, chunk.length - j);
      const slice = chunk.slice(j, j + n);
      const flat = slice.flatMap((r) => addressBindings(r, syncedAt));
      stmts.push(db.prepare(addressMultiInsertSql(n)).bind(...flat));
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(
        `D1 address_snapshot batch at row offset ${i} (${chunk.length} rows, ${stmts.length} SQL ops): ${m}`,
        { cause: e }
      );
    }
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
    const stmts: D1PreparedStatement[] = [];
    for (let j = 0; j < chunk.length; j += CONT_R_PER_STMT) {
      const n = Math.min(CONT_R_PER_STMT, chunk.length - j);
      const slice = chunk.slice(j, j + n);
      const flat = slice.flatMap((r) => containerBindings(r, syncedAt));
      stmts.push(db.prepare(containerMultiInsertSql(n)).bind(...flat));
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(
        `D1 container_snapshot batch at row offset ${i} (${chunk.length} rows, ${stmts.length} SQL ops): ${m}`,
        { cause: e }
      );
    }
    upserted += chunk.length;
  }
  return { upserted };
}

const STREAM_BATCH_CUST = 80;
const STREAM_BATCH_ADDR = 80;
const STREAM_BATCH_CONT = 40;

/**
 * Stream CSV from a download / upload body. Peak memory: decode buffer + one D1 batch.
 */
export async function syncCustomerSnapshotFromStream(
  db: D1Database,
  body: ReadableStream<Uint8Array>,
  batchSize = STREAM_BATCH_CUST,
  options: StreamSyncOptions = {}
): Promise<SnapshotSyncCounts> {
  const syncedAt = new Date().toISOString();
  let lineNo = 0;
  let cols: Record<string, number> | null = null;
  const batch: CustomerSnapshotRow[] = [];
  let dataRows = 0;
  let upserted = 0;

  for await (const line of streamCsvLines(body)) {
    if (lineNo++ === 0) {
      const head = line.trimStart().toLowerCase();
      if (!head.startsWith("customerid")) {
        throw new Error(
          "Customer report is not valid CSV (missing CustomerID header). Check CUSTOMER_REPORT_EXPORT_PATH or query-id pipeline."
        );
      }
      cols = mapCsvHeaders(line);
      continue;
    }
    if (!cols) {
      continue;
    }
    const r = parseCustomerSnapshotRow(cols, line);
    if (r) {
      dataRows += 1;
      batch.push(r);
      if (batch.length >= batchSize) {
        const { upserted: n } = await upsertCustomerSnapshotRows(
          db,
          batch,
          batchSize,
          syncedAt
        );
        upserted += n;
        batch.length = 0;
      }
    }
  }
  if (batch.length) {
    const { upserted: n } = await upsertCustomerSnapshotRows(
      db,
      batch,
      batchSize,
      syncedAt
    );
    upserted += n;
  }
  if (lineNo === 0) {
    return { upserted: 0, rowCount: 0, deleted: 0 };
  }
  const deleted =
    options.reconcile && cols && dataRows > 0
      ? await reconcileDeleteStale(db, "customer_snapshot", syncedAt)
      : 0;
  return { upserted, rowCount: dataRows, deleted };
}

export async function syncAddressSnapshotFromStream(
  db: D1Database,
  body: ReadableStream<Uint8Array>,
  batchSize = STREAM_BATCH_ADDR,
  options: StreamSyncOptions = {}
): Promise<SnapshotSyncCounts> {
  const syncedAt = new Date().toISOString();
  let lineNo = 0;
  let cols: Record<string, number> | null = null;
  const batch: AddressSnapshotRow[] = [];
  let dataRows = 0;
  let upserted = 0;

  for await (const line of streamCsvLines(body)) {
    if (lineNo++ === 0) {
      const head = line.trimStart().toLowerCase();
      if (!head.startsWith("pickupaddressid")) {
        throw new Error(
          "Address report is not valid CSV (missing PickupAddressID header). Check PATH or query-id config."
        );
      }
      cols = mapCsvHeaders(line);
      continue;
    }
    if (!cols) {
      continue;
    }
    const r = parseAddressSnapshotRow(cols, line);
    if (r) {
      dataRows += 1;
      batch.push(r);
      if (batch.length >= batchSize) {
        const { upserted: n } = await upsertAddressSnapshotRows(
          db,
          batch,
          batchSize,
          syncedAt
        );
        upserted += n;
        batch.length = 0;
      }
    }
  }
  if (batch.length) {
    const { upserted: n } = await upsertAddressSnapshotRows(
      db,
      batch,
      batchSize,
      syncedAt
    );
    upserted += n;
  }
  if (lineNo === 0) {
    return { upserted: 0, rowCount: 0, deleted: 0 };
  }
  const deleted =
    options.reconcile && cols && dataRows > 0
      ? await reconcileDeleteStale(db, "address_snapshot", syncedAt)
      : 0;
  return { upserted, rowCount: dataRows, deleted };
}

export async function syncContainerSnapshotFromStream(
  db: D1Database,
  body: ReadableStream<Uint8Array>,
  batchSize = STREAM_BATCH_CONT,
  options: StreamSyncOptions = {}
): Promise<SnapshotSyncCounts> {
  const syncedAt = new Date().toISOString();
  let lineNo = 0;
  let cols: Record<string, number> | null = null;
  const batch: ContainerSnapshotRow[] = [];
  let dataRows = 0;
  let upserted = 0;

  for await (const line of streamCsvLines(body)) {
    if (lineNo++ === 0) {
      const head = line.trimStart().toLowerCase();
      if (!head.startsWith("containerid")) {
        throw new Error(
          "Container report is not valid CSV (missing ContainerID header). Check PATH or query-id config."
        );
      }
      cols = mapCsvHeaders(line);
      continue;
    }
    if (!cols) {
      continue;
    }
    const r = parseContainerSnapshotRow(cols, line);
    if (r) {
      dataRows += 1;
      batch.push(r);
      if (batch.length >= batchSize) {
        const { upserted: n } = await upsertContainerSnapshotRows(
          db,
          batch,
          batchSize,
          syncedAt
        );
        upserted += n;
        batch.length = 0;
      }
    }
  }
  if (batch.length) {
    const { upserted: n } = await upsertContainerSnapshotRows(
      db,
      batch,
      batchSize,
      syncedAt
    );
    upserted += n;
  }
  if (lineNo === 0) {
    return { upserted: 0, rowCount: 0, deleted: 0 };
  }
  const deleted =
    options.reconcile && cols && dataRows > 0
      ? await reconcileDeleteStale(db, "container_snapshot", syncedAt)
      : 0;
  return { upserted, rowCount: dataRows, deleted };
}

export async function syncCustomerSnapshotFromCsvText(
  db: D1Database,
  csvText: string
): Promise<{ upserted: number; rowCount: number }> {
  return syncCustomerSnapshotFromStream(db, stringToUint8Stream(csvText));
}

export async function syncAddressSnapshotFromCsvText(
  db: D1Database,
  csvText: string
): Promise<{ upserted: number; rowCount: number }> {
  return syncAddressSnapshotFromStream(db, stringToUint8Stream(csvText));
}

export async function syncContainerSnapshotFromCsvText(
  db: D1Database,
  csvText: string
): Promise<{ upserted: number; rowCount: number }> {
  return syncContainerSnapshotFromStream(db, stringToUint8Stream(csvText));
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
): Promise<SnapshotSyncCounts | null> {
  const path = env.CUSTOMER_REPORT_EXPORT_PATH?.trim();
  const queryId = env.CUSTOMER_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log("CUSTOMER_REPORT_EXPORT_PATH and CUSTOMER_REPORT_QUERY_ID unset; skip customer sync");
    return null;
  }
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  if (!resp.body) {
    throw new Error("Report response has no body");
  }
  return archiveReportCsvToR2AfterD1(env, "customer", resp.body, (s) =>
    syncCustomerSnapshotFromStream(env.CUSTOMER_DB, s, STREAM_BATCH_CUST, {
      reconcile: true
    })
  );
}

export async function runAddressSnapshotSync(
  env: Env
): Promise<SnapshotSyncCounts | null> {
  const path = env.ADDRESS_REPORT_EXPORT_PATH?.trim();
  const queryId = env.ADDRESS_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log("ADDRESS_REPORT_EXPORT_PATH and ADDRESS_REPORT_QUERY_ID unset; skip address sync");
    return null;
  }
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  if (!resp.body) {
    throw new Error("Report response has no body");
  }
  return archiveReportCsvToR2AfterD1(env, "address", resp.body, (s) =>
    syncAddressSnapshotFromStream(env.CUSTOMER_DB, s, STREAM_BATCH_ADDR, {
      reconcile: true
    })
  );
}

export async function runContainerSnapshotSync(
  env: Env
): Promise<SnapshotSyncCounts | null> {
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
  if (!resp.body) {
    throw new Error("Report response has no body");
  }
  return archiveReportCsvToR2AfterD1(env, "container", resp.body, (s) =>
    syncContainerSnapshotFromStream(env.CUSTOMER_DB, s, STREAM_BATCH_CONT, {
      reconcile: true
    })
  );
}

function rethrowWithSnapshotContext(step: string, err: unknown): never {
  const m = err instanceof Error ? err.message : String(err);
  throw new Error(`[${step}] ${m}`, { cause: err });
}

/**
 * Which snapshot steps should run, mirroring the guards in
 * `runDataSnapshotSync` (address only if customer is configured, etc.).
 */
export function getDataSnapshotPlan(env: Env): {
  runCustomer: boolean;
  runAddress: boolean;
  runContainer: boolean;
} {
  const cPath = env.CUSTOMER_REPORT_EXPORT_PATH?.trim();
  const cQ = env.CUSTOMER_REPORT_QUERY_ID?.trim();
  const aPath = env.ADDRESS_REPORT_EXPORT_PATH?.trim();
  const aQ = env.ADDRESS_REPORT_QUERY_ID?.trim();
  const tPath = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
  const tQ = env.CONTAINER_REPORT_QUERY_ID?.trim();
  const hasC = Boolean(cPath || cQ);
  const hasA = Boolean(aPath || aQ);
  const hasT = Boolean(tPath || tQ);
  return {
    runCustomer: hasC,
    runAddress: hasA && hasC,
    runContainer: hasT && hasC && hasA
  };
}

type PerTableJson = { upserted: number; rowCount: number; skipped?: boolean };

function syncJsonToResult(j: PerTableJson): SnapshotTableResult {
  if (j.skipped) {
    return null;
  }
  return { upserted: j.upserted, rowCount: j.rowCount };
}

/**
 * Runs the three sync routes via **separate** `fetch` subrequests to this
 * Worker's public URL. Each subrequest is a new Worker **invocation**, so D1's
 * per-invocation limit (~1000 operations) is applied per table, not as one pool
 * for the whole combined job.
 */
export async function runDataSnapshotSyncChainedHttp(
  publicBaseUrl: string,
  env: Env
): Promise<DataSnapshotResult> {
  const bearer = env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim();
  if (!bearer) {
    throw new Error("CUSTOMER_SNAPSHOT_SYNC_SECRET is not set");
  }
  const base = publicBaseUrl.replace(/\/$/, "");
  const h = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json"
  } as const;
  const plan = getDataSnapshotPlan(env);
  const out: DataSnapshotResult = {
    customer: null,
    address: null,
    container: null
  };

  async function post(
    path: string,
    step: string
  ): Promise<PerTableJson> {
    const u = `${base}${path}`;
    const resp = await fetch(u, { method: "POST", headers: h });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `[chained ${step}] POST ${path} → ${resp.status}: ${text.slice(0, 1200)}`
      );
    }
    return JSON.parse(text) as PerTableJson;
  }

  if (plan.runCustomer) {
    out.customer = syncJsonToResult(
      await post("/api/v1/customer-snapshot/sync", "customer")
    );
  } else {
    console.log("No customer path or query ID; not syncing customers");
  }
  if (plan.runAddress) {
    out.address = syncJsonToResult(
      await post("/api/v1/address-snapshot/sync", "address")
    );
  } else {
    if (env.ADDRESS_REPORT_EXPORT_PATH?.trim() || env.ADDRESS_REPORT_QUERY_ID?.trim()) {
      console.log(
        "Address is configured but customer is not — skip address (FK to customer). Set customer first."
      );
    } else {
      console.log("No address path or query ID; not syncing addresses");
    }
  }
  if (plan.runContainer) {
    out.container = syncJsonToResult(
      await post("/api/v1/container-snapshot/sync", "container")
    );
  } else {
    const tP = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
    const tQ = env.CONTAINER_REPORT_QUERY_ID?.trim();
    if (tP || tQ) {
      console.log(
        "Container is configured but customer and/or address is not — skip container (FKs). Set all three."
      );
    } else {
      console.log("No container path or query ID; not syncing containers");
    }
  }
  return out;
}

/**
 * Runs each configured export in one Worker **invocation** (sequential in-process).
 * Large imports can hit D1’s per-invocation query cap; use
 * {@link runDataSnapshotSyncChainedHttp} for `POST /data-snapshot/sync` instead.
 */
export async function runDataSnapshotSync(env: Env): Promise<DataSnapshotResult> {
  const plan = getDataSnapshotPlan(env);
  const out: DataSnapshotResult = {
    customer: null,
    address: null,
    container: null
  };
  if (plan.runCustomer) {
    try {
      out.customer = await runCustomerSnapshotSync(env);
    } catch (e) {
      rethrowWithSnapshotContext("customer snapshot", e);
    }
  } else {
    console.log("No customer path or query ID; not syncing customers");
  }
  if (plan.runAddress) {
    try {
      out.address = await runAddressSnapshotSync(env);
    } catch (e) {
      rethrowWithSnapshotContext("address snapshot", e);
    }
  } else {
    if (env.ADDRESS_REPORT_EXPORT_PATH?.trim() || env.ADDRESS_REPORT_QUERY_ID?.trim()) {
      console.log(
        "Address is configured but customer is not — skip address (FK to customer). Set customer first."
      );
    } else {
      console.log("No address path or query ID; not syncing addresses");
    }
  }
  if (plan.runContainer) {
    try {
      out.container = await runContainerSnapshotSync(env);
    } catch (e) {
      rethrowWithSnapshotContext("container snapshot", e);
    }
  } else {
    const tP = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
    const tQ = env.CONTAINER_REPORT_QUERY_ID?.trim();
    if (tP || tQ) {
      console.log(
        "Container is configured but customer and/or address is not — skip container (FKs). Set all three."
      );
    } else {
      console.log("No container path or query ID; not syncing containers");
    }
  }
  return out;
}
