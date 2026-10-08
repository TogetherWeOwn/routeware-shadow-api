import { streamCsvLines } from "../csvStream";
import { SNAPSHOT_IMPORT_MAX_BYTES } from "./streamSync";

/** Smaller than the HTTP cap, with at most 500 data rows per invocation. */
export const SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES = 5 * 1024 * 1024;
export const SNAPSHOT_EXPORT_IMPORT_BATCH_ROWS = 500;

/**
 * Split original UTF-8 exports into bounded import bodies. Repeat the complete
 * header (including encoding metadata); do not decode or re-escape cells.
 * streamCsvLines keeps RFC 4180 quoted multiline records intact. Only outer
 * record separators become LF; cell content and the synced_at trailer survive.
 *
 * This is a local preparation helper, not an import or a validator. Persist and
 * validate ALL parts before uploading any. A late error can follow yielded
 * parts. Imports upsert, never prune, and are not an all-or-nothing restore.
 */
export async function* batchSnapshotExportCsv(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES,
  maxRows: number = SNAPSHOT_EXPORT_IMPORT_BATCH_ROWS
): AsyncGenerator<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SNAPSHOT_IMPORT_MAX_BYTES) {
    throw new RangeError("Snapshot CSV batch byte limit must be within the import cap");
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > SNAPSHOT_EXPORT_IMPORT_BATCH_ROWS) {
    throw new RangeError("Snapshot CSV batch row limit must be between 1 and 500");
  }
  const encoder = new TextEncoder();
  let header: string | undefined;
  let headerBytes = 0;
  let bytes = 0;
  let rows: string[] = [];
  for await (const line of streamCsvLines(stream)) {
    if (header === undefined) {
      header = `${line}\n`;
      headerBytes = encoder.encode(header).byteLength;
      if (headerBytes >= maxBytes) {
        throw new RangeError("Snapshot CSV header exceeds the batch byte limit");
      }
      bytes = headerBytes;
      continue;
    }
    const row = `${line}\n`;
    const rowBytes = encoder.encode(row).byteLength;
    if (headerBytes + rowBytes > maxBytes) {
      throw new RangeError("Snapshot CSV record exceeds the batch byte limit");
    }
    if (rows.length === maxRows || bytes + rowBytes > maxBytes) {
      yield header + rows.join("");
      rows = [];
      bytes = headerBytes;
    }
    rows.push(row);
    bytes += rowBytes;
  }
  // No header-only request: HTTP imports require at least one data row.
  if (rows.length > 0) yield header + rows.join("");
}
