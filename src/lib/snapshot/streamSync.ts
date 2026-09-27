import { parseAddressSnapshotRow } from "../csvAddressSnapshot";
import type { AddressSnapshotRow } from "../csvAddressSnapshot";
import { parseContainerSnapshotRow } from "../csvContainerSnapshot";
import type { ContainerSnapshotRow } from "../csvContainerSnapshot";
import { parseCustomerSnapshotRow } from "../csvCustomerSnapshot";
import type { CustomerSnapshotRow } from "../csvCustomerSnapshot";
import { mapCsvHeaders, normHeader, parseCsvLine } from "../csvParse";
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
 * Cap on `...-snapshot/import` request bodies (TOG-6279). The report `sync`
 * path is uncapped — upstream export size is the operator's own config — and
 * both paths stream, so neither buffers the whole file either way.
 */
export const SNAPSHOT_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The first line of an import body is not the expected CSV header (an HTML
 * login page served with HTTP 200 after a lapsed session, or a CSV for the
 * wrong table), or the body yielded zero data rows. The `...-snapshot/import`
 * routes map it to 400 problem+json; the report `sync` path never throws it
 * (it returns all-zero counts and skips reconciliation instead). Never
 * carries the submitted bytes, so the error body cannot leak PII.
 */
export class InvalidSnapshotCsvError extends Error {}

/** Body exceeded `options.maxBytes`. The import routes map it to 413. */
export class SnapshotTooLargeError extends Error {}

/**
 * Cap a request body at `maxBytes` cumulative bytes without buffering the
 * file: the first chunk past the cap errors the stream with
 * `SnapshotTooLargeError`. `streamCsvLines` wraps read failures with the
 * original as `cause`, so import routes detect both the direct and the
 * wrapped shape via `isSnapshotTooLarge`.
 */
function withByteCap(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(
            new SnapshotTooLargeError(
              `Snapshot import body exceeds the ${maxBytes} byte limit.`
            )
          );
          return;
        }
        controller.enqueue(chunk);
      }
    })
  );
}

/** True for a direct throw or one wrapped by `streamCsvLines`' read guard. */
export function isSnapshotTooLarge(e: unknown): boolean {
  return (
    e instanceof SnapshotTooLargeError ||
    (e instanceof Error && e.cause instanceof SnapshotTooLargeError)
  );
}

/**
 * TOG-6541: read the expected header off the *parsed* first cell, not the raw
 * line. Real exports quote headers (`"CustomerID",...`) and `parseCsvLine`
 * strips those quotes; the old raw `line.startsWith(...)` rejected a valid
 * quoted export while the row parser below would have accepted it. Carried
 * forward from `main` so this slice's pick does not revert that fix.
 */
function firstHeaderCell(line: string): string {
  return normHeader(parseCsvLine(line)[0] ?? "");
}

/** CSV lines, optionally enforcing a cumulative byte cap without buffering. */
function cappedLines(
  body: ReadableStream<Uint8Array>,
  maxBytes?: number
): AsyncGenerator<string, void, undefined> {
  return streamCsvLines(
    maxBytes === undefined ? body : withByteCap(body, maxBytes)
  );
}

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

  for await (const line of cappedLines(body, options.maxBytes)) {
    if (lineNo++ === 0) {
      if (firstHeaderCell(line) !== "customerid") {
        throw new InvalidSnapshotCsvError(
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
    if (options.requireDataRows) {
      throw new InvalidSnapshotCsvError(
        "Customer import contained no data rows."
      );
    }
    return { upserted: 0, rowCount: 0, deleted: 0 };
  }
  if (options.requireDataRows && dataRows === 0) {
    throw new InvalidSnapshotCsvError(
      "Customer import contained no data rows."
    );
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

  for await (const line of cappedLines(body, options.maxBytes)) {
    if (lineNo++ === 0) {
      if (firstHeaderCell(line) !== "pickupaddressid") {
        throw new InvalidSnapshotCsvError(
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
    if (options.requireDataRows) {
      throw new InvalidSnapshotCsvError(
        "Address import contained no data rows."
      );
    }
    return { upserted: 0, rowCount: 0, deleted: 0 };
  }
  if (options.requireDataRows && dataRows === 0) {
    throw new InvalidSnapshotCsvError(
      "Address import contained no data rows."
    );
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

  for await (const line of cappedLines(body, options.maxBytes)) {
    if (lineNo++ === 0) {
      if (firstHeaderCell(line) !== "containerid") {
        throw new InvalidSnapshotCsvError(
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
    if (options.requireDataRows) {
      throw new InvalidSnapshotCsvError(
        "Container import contained no data rows."
      );
    }
    return { upserted: 0, rowCount: 0, deleted: 0 };
  }
  if (options.requireDataRows && dataRows === 0) {
    throw new InvalidSnapshotCsvError(
      "Container import contained no data rows."
    );
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
