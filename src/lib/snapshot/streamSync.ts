import { parseAddressSnapshotRow } from "../csvAddressSnapshot";
import type { AddressSnapshotRow } from "../csvAddressSnapshot";
import { parseContainerSnapshotRow } from "../csvContainerSnapshot";
import type { ContainerSnapshotRow } from "../csvContainerSnapshot";
import { parseCustomerSnapshotRow } from "../csvCustomerSnapshot";
import type { CustomerSnapshotRow } from "../csvCustomerSnapshot";
import { mapCsvHeaders } from "../csvParse";
import { stringToUint8Stream, streamCsvLines } from "../csvStream";
import type { SnapshotSyncCounts, StreamSyncOptions } from "./upsert";
import {
  reconcileDeleteStale,
  upsertAddressSnapshotRows,
  upsertContainerSnapshotRows,
  upsertCustomerSnapshotRows
} from "./upsert";

export const STREAM_BATCH_CUST = 80;
export const STREAM_BATCH_ADDR = 80;
export const STREAM_BATCH_CONT = 40;

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
