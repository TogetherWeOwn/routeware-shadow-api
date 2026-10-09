/**
 * Client-side split-and-import for oversized snapshot CSV exports (TOG-18867).
 *
 * Pure helpers behind `scripts/split-and-import-snapshot.mjs`, the one
 * supported entry point for round-tripping a marked export larger than the
 * 50 MiB HTTP import cap. The server cap is unchanged: this splits the
 * original download into parts of at most 5 MiB / 500 data rows (the same
 * budgets as `src/lib/snapshot/exportImportBatches.ts`) and POSTs each part
 * to the existing `...-snapshot/import` route in order, so every request
 * stays under the cap and every chunk is its own Worker invocation (each
 * with its own D1 per-invocation budget — one giant server-side import would
 * blow the ~1000-op limit on the 388k-row container table).
 *
 * The record splitter below mirrors `streamCsvLines` in
 * `src/lib/csvStream.ts` record-for-record (quote opens only at field start,
 * mid-field `"` is a literal stray, `""` inside quotes is an escape, CR/LF/
 * CRLF terminators, leading BOM preserved (the server decodes with
 * `TextDecoder("utf-8", { ignoreBOM: true })`), zero-length lines dropped), and
 * `chunkRecords` mirrors `batchSnapshotExportCsv` byte-for-byte (complete
 * original header repeated on every part, UTF-8 byte accounting, LF-only
 * record separators). Divergence is pinned by
 * `test/snapshotSplitImport.test.ts`, which feeds identical inputs through
 * both implementations and asserts identical parts.
 *
 * Nothing here touches the network or the filesystem: the CLI wrapper owns
 * file/temp-dir I/O and `fetch`, and tests inject a stub `postPart`. No part
 * content ever lands in an error message (content-free `RangeError`s, same
 * strings as the server helper).
 */

export const TABLE_IMPORT_PATHS = {
  customer: "/api/v1/customer-snapshot/import",
  address: "/api/v1/address-snapshot/import",
  container: "/api/v1/container-snapshot/import",
};

export const SNAPSHOT_TABLES = Object.keys(TABLE_IMPORT_PATHS);

export const IMPORT_CAP_FALLBACK = 50 * 1024 * 1024;
export const BATCH_BYTES_FALLBACK = 5 * 1024 * 1024;
export const BATCH_ROWS_FALLBACK = 500;

/**
 * Read the canonical budgets out of the TypeScript sources so the CLI can
 * never drift from them: `batchBytes`/`batchRows` from
 * `src/lib/snapshot/exportImportBatches.ts`, `importCap` from
 * `src/lib/snapshot/streamSync.ts`. Throws when a constant cannot be found —
 * fail closed rather than split against a guessed budget.
 */
export function parseBudgetConstants(batchesSource, streamSyncSource) {
  const bytes = batchesSource.match(
    /SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/
  );
  const rows = batchesSource.match(/SNAPSHOT_EXPORT_IMPORT_BATCH_ROWS\s*=\s*(\d+)/);
  const cap = streamSyncSource.match(/SNAPSHOT_IMPORT_MAX_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
  if (!bytes || !rows || !cap) {
    throw new Error(
      "Could not parse snapshot batch budgets from source; refusing to split against guessed limits."
    );
  }
  return {
    batchBytes: Number(bytes[1]) * 1024 * 1024,
    batchRows: Number(rows[1]),
    importCap: Number(cap[1]) * 1024 * 1024,
  };
}

export function assertBudgets(maxBytes, maxRows, importCap) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > importCap) {
    throw new RangeError("Snapshot CSV batch byte limit must be within the import cap");
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > BATCH_ROWS_FALLBACK) {
    throw new RangeError("Snapshot CSV batch row limit must be between 1 and 500");
  }
}

// TextEncoder (not Buffer) so this module also imports inside the workerd
// test pool, where the parity test feeds identical inputs through both this
// splitter and `src/lib/snapshot/exportImportBatches.ts`.
const utf8Encoder = new TextEncoder();
const utf8Bytes = (s) => utf8Encoder.encode(s).byteLength;

/**
 * Incremental RFC 4180 record splitter with the exact dialect of
 * `scanForLineBreak` in `src/lib/csvStream.ts`. Feed decoded text chunks in
 * order via `push()`; each call returns the complete logical records (line
 * terminators stripped) that end inside the fed text. Call `finish()` at EOF
 * for the trailing record, if any. State (`inQuotes`, field-start) carries
 * across pushes, so a chunk boundary mid-field behaves exactly as unchunked
 * input.
 */
export class CsvRecordSplitter {
  constructor() {
    this.tail = "";
    this.quoted = false;
    this.fieldStart = true;
  }

  push(chunk) {
    // The tail is always a record prefix (it starts right after a terminator
    // or at the very beginning), so the resume state is the record-start
    // state — unquoted at a field start — exactly as `streamCsvLines`
    // re-enters after each yielded line. Rescanning the tail from its start
    // with that state judges every byte exactly as unchunked input.
    this.quoted = false;
    this.fieldStart = true;
    const text = this.tail + chunk;
    const records = [];
    let start = 0;
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        if (this.quoted) {
          if (i + 1 >= text.length) break; // Half of a straddling `""` pair — wait for more.
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          this.quoted = false;
          this.fieldStart = false;
          i += 1;
          continue;
        }
        if (this.fieldStart) {
          this.quoted = true;
          this.fieldStart = false;
          i += 1;
          continue;
        }
        i += 1; // Literal stray quote mid-field (TOG-8536): no state change.
        continue;
      }
      if (this.quoted) {
        i += 1;
        continue;
      }
      if (ch === "\n") {
        records.push(text.slice(start, i));
        i += 1;
        start = i;
        this.fieldStart = true;
        continue;
      }
      if (ch === "\r") {
        if (i + 1 >= text.length) break; // CR vs CRLF undecided — wait for more.
        records.push(text.slice(start, i));
        i += text[i + 1] === "\n" ? 2 : 1;
        start = i;
        this.fieldStart = true;
        continue;
      }
      if (ch === ",") {
        this.fieldStart = true;
      } else if (ch !== " " && ch !== "\t") {
        this.fieldStart = false;
      }
      i += 1;
    }
    this.tail = text.slice(start);
    // Match `streamCsvLines`: zero-length physical lines are dropped, and the
    // resume state is the state at the first unscanned byte.
    return records.filter((r) => r.length > 0);
  }

  finish() {
    // EOF with an unterminated quote still yields the buffer (many Routeware
    // exports are not strictly well-formed) — same as `streamCsvLines`, which
    // yields the trailing buffer verbatim, dangling bare `\r` included.
    const tail = this.tail;
    this.tail = "";
    return tail.length > 0 ? [tail] : [];
  }
}

/**
 * Pack logical records (first = header) into import bodies of at most
 * `maxBytes` UTF-8 bytes and `maxRows` data rows. Byte-identical to
 * `batchSnapshotExportCsv`: the complete original header (marker column
 * included) is repeated on every part, cells are never decoded or
 * re-escaped, and only record separators become LF. Returns part strings;
 * empty input or header-only input yields no parts (HTTP imports require at
 * least one data row).
 */
export function chunkRecords(
  records,
  maxBytes = BATCH_BYTES_FALLBACK,
  maxRows = BATCH_ROWS_FALLBACK,
  importCap = IMPORT_CAP_FALLBACK
) {
  assertBudgets(maxBytes, maxRows, importCap);
  if (records.length === 0) return [];
  const header = `${records[0]}\n`;
  const headerBytes = utf8Bytes(header);
  if (headerBytes >= maxBytes) {
    throw new RangeError("Snapshot CSV header exceeds the batch byte limit");
  }
  const parts = [];
  let rows = [];
  let bytes = headerBytes;
  for (const record of records.slice(1)) {
    const row = `${record}\n`;
    const rowBytes = utf8Bytes(row);
    if (headerBytes + rowBytes > maxBytes) {
      throw new RangeError("Snapshot CSV record exceeds the batch byte limit");
    }
    if (rows.length === maxRows || bytes + rowBytes > maxBytes) {
      parts.push(header + rows.join(""));
      rows = [];
      bytes = headerBytes;
    }
    rows.push(row);
    bytes += rowBytes;
  }
  if (rows.length > 0) parts.push(header + rows.join(""));
  return parts;
}

/** Convenience for tests and small inputs: split full text, then chunk. */
export function splitTextToParts(
  text,
  maxBytes = BATCH_BYTES_FALLBACK,
  maxRows = BATCH_ROWS_FALLBACK,
  importCap = IMPORT_CAP_FALLBACK
) {
  const splitter = new CsvRecordSplitter();
  const records = [...splitter.push(text), ...splitter.finish()];
  return chunkRecords(records, maxBytes, maxRows, importCap);
}

/**
 * Import parts strictly in order via the injected `postPart(partText, index)`
 * (the CLI passes a `fetch` wrapper; tests pass a stub or the test Worker).
 * Accumulates `{ parts, bytes, rows, upserted, rowCount }`. Stops at the
 * first failure and throws naming the part index and the safe failure reason
 * — never part content. Imports are upsert-only, so a retry after
 * investigating the failure resumes without deletes; there is no
 * all-or-nothing restore.
 */
export async function importPartsInOrder(parts, postPart) {
  let upserted = 0;
  let rowCount = 0;
  let bytes = 0;
  let index = 0;
  for (const part of parts) {
    let result;
    try {
      result = await postPart(part, index);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`Snapshot split-import failed at part ${index + 1} of ${parts.length}: ${reason}`);
    }
    upserted += result.upserted;
    rowCount += result.rowCount;
    bytes += utf8Bytes(part);
    index += 1;
  }
  return { parts: parts.length, bytes, rows: rowCount, upserted, rowCount };
}

export class UsageError extends Error {}

/** Pure argv parser for the CLI; throws `UsageError` on bad input. */
export function parseArgs(argv) {
  const out = {
    table: null,
    file: null,
    baseUrl: null,
    tokenEnv: null,
    maxBytes: null,
    maxRows: null,
    dryRun: false,
    timeoutMs: 60_000,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      return out;
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg.startsWith("--table=")) {
      out.table = arg.slice("--table=".length);
    } else if (arg.startsWith("--file=")) {
      out.file = arg.slice("--file=".length);
    } else if (arg.startsWith("--base-url=")) {
      out.baseUrl = arg.slice("--base-url=".length).replace(/\/+$/, "");
    } else if (arg.startsWith("--token-env=")) {
      out.tokenEnv = arg.slice("--token-env=".length).trim() || null;
    } else if (arg.startsWith("--max-bytes=")) {
      const n = Number(arg.slice("--max-bytes=".length));
      if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--max-bytes must be a positive integer (got ${arg})`);
      out.maxBytes = n;
    } else if (arg.startsWith("--max-rows=")) {
      const n = Number(arg.slice("--max-rows=".length));
      if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--max-rows must be a positive integer (got ${arg})`);
      out.maxRows = n;
    } else if (arg.startsWith("--timeout-ms=")) {
      const n = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--timeout-ms must be a positive number (got ${arg})`);
      out.timeoutMs = Math.floor(n);
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  if (!out.table || !SNAPSHOT_TABLES.includes(out.table)) {
    throw new UsageError(`--table must be one of: ${SNAPSHOT_TABLES.join(", ")}`);
  }
  if (!out.file) throw new UsageError("--file is required (path to the marked export CSV)");
  if (!out.baseUrl) throw new UsageError("--base-url is required (Worker origin, e.g. https://<worker>.workers.dev)");
  if (!/^https?:\/\//.test(out.baseUrl)) throw new UsageError("--base-url must start with http:// or https://");
  return out;
}

/**
 * Resolve the import bearer without ever printing it. Only the snapshot sync
 * secret authorizes imports — never the app token or the read-only token
 * (see `requireSnapshotAuth`). Order: `--token-env` name, then
 * `CUSTOMER_SNAPSHOT_SYNC_SECRET` in the environment, then the same key in
 * `.dev.vars` text (local-dev convenience). Returns `null` when unresolved.
 */
export function resolveToken(env, devVarsText, tokenEnv) {
  const pick = (name) => {
    const v = env[name];
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  if (tokenEnv) return pick(tokenEnv);
  const direct = pick("CUSTOMER_SNAPSHOT_SYNC_SECRET");
  if (direct) return direct;
  if (typeof devVarsText === "string") {
    const m = devVarsText.match(
      /^[ \t]*CUSTOMER_SNAPSHOT_SYNC_SECRET[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|(\S+))[ \t]*$/m
    );
    if (m) return m[1] ?? m[2] ?? m[3] ?? null;
  }
  return null;
}
