import { parseCsvLine } from "../csvParse";
import { streamCsvLines } from "../csvStream";
import {
  CSV_SPREADSHEET_ENCODING,
  CSV_SPREADSHEET_ENCODING_HEADER,
  escapeCsvCell
} from "../csvSpreadsheet";

/**
 * Spreadsheet-safe readback of an archived Routeware CSV (TOG-18829).
 *
 * The stored object stays the raw upstream CSV. Records are split by the
 * importer's quote-aware splitter, every cell goes through the export's
 * `escapeCsvCell`, and the `_shadow_csv_encoding` marker follows the archived
 * header and every row, so a download opened in a spreadsheet cannot evaluate
 * an upstream cell. Rows end in LF, as export rows do.
 *
 * Content-Length and the ETag must describe the served bytes, which the stored
 * object's own ETag does not, so the body is produced in two passes over the
 * object: `measureSpreadsheetSafeCsv` counts and hashes the bytes, then
 * `spreadsheetSafeCsvStream` streams the same bytes. Only one input chunk and
 * one output batch are held at a time.
 */

const OUTPUT_BATCH_CHARS = 64 * 1024;
const utf8 = new TextEncoder();

async function* encodedRows(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, undefined> {
  let headerWidth: number | null = null;
  for await (const line of streamCsvLines(body)) {
    const cells = parseCsvLine(line).map(escapeCsvCell);
    if (headerWidth === null) {
      headerWidth = cells.length;
      cells.push(CSV_SPREADSHEET_ENCODING_HEADER);
    } else {
      while (cells.length < headerWidth) {
        cells.push("");
      }
      cells.splice(headerWidth, 0, CSV_SPREADSHEET_ENCODING);
    }
    yield `${cells.join(",")}\n`;
  }
}

async function* encodedBatches(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array, void, undefined> {
  let batch = "";
  for await (const row of encodedRows(body)) {
    batch += row;
    if (batch.length >= OUTPUT_BATCH_CHARS) {
      yield utf8.encode(batch);
      batch = "";
    }
  }
  if (batch.length > 0) {
    yield utf8.encode(batch);
  }
}

export async function measureSpreadsheetSafeCsv(
  body: ReadableStream<Uint8Array>
): Promise<{ length: number; etag: string }> {
  const hash = createFnv1a64();
  let length = 0;
  for await (const bytes of encodedBatches(body)) {
    length += bytes.byteLength;
    hash.feed(bytes);
  }
  return { length, etag: `"fnv64-${hash.hex()}"` };
}

export function spreadsheetSafeCsvStream(
  body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const batches = encodedBatches(body);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await batches.next();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    async cancel() {
      await batches.return(undefined);
    }
  });
}

/**
 * FNV-1a 64 over 32-bit halves. A `BigInt` multiply per byte would take seconds
 * on a 50 MiB archive; the 64-bit prime is 2^40 + 0x1b3, so each step is two
 * exact double multiplies, reduced modulo 2^32 by `>>> 0`.
 */
function createFnv1a64() {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  return {
    feed(bytes: Uint8Array) {
      for (let i = 0; i < bytes.byteLength; i++) {
        lo = (lo ^ bytes[i]) >>> 0;
        const product = lo * 0x1b3;
        hi = (hi * 0x1b3 + lo * 0x100 + Math.floor(product / 0x100000000)) >>> 0;
        lo = product >>> 0;
      }
    },
    hex(): string {
      return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
    }
  };
}
