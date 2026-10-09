#!/usr/bin/env node
/**
 * Split-and-import for oversized snapshot CSV exports (TOG-18867): the one
 * supported entry point for round-tripping a marked export larger than the
 * 50 MiB HTTP import cap.
 *
 * Why a CLI and not a route: the server import cap is a security boundary
 * (CISO first — never raised here), and one giant server-side import would
 * blow the ~1000-op D1 per-invocation budget on the 388k-row container
 * table. The CLI keeps every request under the existing cap and every chunk
 * its own Worker invocation, adding no new network attack surface.
 *
 * Usage:
 *   node scripts/split-and-import-snapshot.mjs --table=container --file=./container-snapshot.csv --base-url=https://<worker>.workers.dev [--dry-run]
 *   node scripts/split-and-import-snapshot.mjs --table=customer --file=./customer-snapshot.csv --base-url=http://localhost:8787 --token-env=CUSTOMER_SNAPSHOT_SYNC_SECRET
 *
 * Required: --table=customer|address|container, --file=<marked export CSV>,
 * --base-url=<Worker origin>. Optional: --token-env=NAME, --max-bytes=N,
 * --max-rows=N (both default to the canonical budgets parsed out of
 * `src/lib/snapshot/exportImportBatches.ts`), --timeout-ms=N (default 60000),
 * --dry-run (split, validate, and print the part plan without uploading).
 *
 * Token resolution (never printed, never committed): --token-env value, then
 * $CUSTOMER_SNAPSHOT_SYNC_SECRET, then that key in `.dev.vars` beside
 * wrangler.toml. Only the sync secret authorizes imports — the app token and
 * the read-only token 401, and this script does not try them.
 *
 * Flow: stream the file into bounded part files in a temp dir (never the
 * whole export in memory), validate ALL parts (byte size, row count, header
 * identity) before uploading ANY, then POST parts sequentially in order to
 * the matching `...-snapshot/import` route. Import customers before
 * addresses before containers so foreign keys resolve. Upserts only — never
 * deletes, never reconciliation: rows absent from later parts remain, and a
 * late failure has no deletion rollback. On failure the temp dir is kept and
 * its path printed for investigation; on success it is removed.
 *
 * Exit 0 on success (prints a JSON summary: parts, bytes, rows, upserted —
 * counts only, never cell content). Exit 2 on usage/config errors. Exit 1
 * when a part import fails (names the part index and HTTP status only).
 */
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath } from "node:url";
import {
  BATCH_BYTES_FALLBACK,
  BATCH_ROWS_FALLBACK,
  CsvRecordSplitter,
  IMPORT_CAP_FALLBACK,
  TABLE_IMPORT_PATHS,
  UsageError,
  assertBudgets,
  importPartsInOrder,
  parseArgs,
  parseBudgetConstants,
  resolveToken,
} from "./lib/snapshotSplitImport.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

function usage() {
  return [
    "Usage: node scripts/split-and-import-snapshot.mjs --table=customer|address|container --file=<csv> --base-url=<origin> [--dry-run]",
    "",
    "  --table=NAME    customer, address, or container (imported in that FK order across runs)",
    "  --file=PATH     marked snapshot export CSV (with _shadow_csv_encoding column)",
    "  --base-url=URL  Worker origin, e.g. https://routeware-shadow-api.<account>.workers.dev",
    "  --token-env=NAME  Env var holding CUSTOMER_SNAPSHOT_SYNC_SECRET (default: that exact var, else .dev.vars)",
    "  --max-bytes=N   Per-part byte budget, default from src/lib/snapshot/exportImportBatches.ts (never above the import cap)",
    "  --max-rows=N    Per-part row budget, default from the same source (never above 500)",
    "  --timeout-ms=N  Per-part POST timeout in ms (default 60000)",
    "  --dry-run       Split, validate, print the part plan, upload nothing",
    "",
    "Token is never printed. Imports are upsert-only: no deletes, no reconciliation, no all-or-nothing restore.",
  ].join("\n");
}

function readSource(rel) {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function readDevVars() {
  try {
    return readFileSync(path.join(root, ".dev.vars"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Phase 1: stream the export into bounded part files. Peak memory is one
 * part (<= maxBytes) plus stream buffers — never the whole export. Returns
 * part metadata in order. Throws content-free RangeErrors on oversized
 * headers / indivisible records (same strings as the server helper).
 */
async function prepareParts(file, maxBytes, maxRows, importCap, dir) {
  assertBudgets(maxBytes, maxRows, importCap);
  const splitter = new CsvRecordSplitter();
  let header = null;
  let headerBytes = 0;
  let pending = "";
  let pendingBytes = 0;
  let pendingRows = 0;
  const parts = [];

  const ingest = async (record) => {
    if (header === null) {
      header = `${record}\n`;
      headerBytes = Buffer.byteLength(header, "utf8");
      if (headerBytes >= maxBytes) {
        throw new RangeError("Snapshot CSV header exceeds the batch byte limit");
      }
      pendingBytes = headerBytes;
      return;
    }
    const row = `${record}\n`;
    const rowBytes = Buffer.byteLength(row, "utf8");
    if (headerBytes + rowBytes > maxBytes) {
      throw new RangeError("Snapshot CSV record exceeds the batch byte limit");
    }
    if (pendingRows === maxRows || pendingBytes + rowBytes > maxBytes) {
      await writePart(parts.length);
    }
    pending += row;
    pendingBytes += rowBytes;
    pendingRows += 1;
  };

  const writePart = async (index) => {
    const out = path.join(dir, `part-${String(index).padStart(4, "0")}.csv`);
    writeFileSync(out, header + pending, "utf8");
    const bytes = statSync(out).size;
    parts.push({ index, file: out, bytes, rows: pendingRows });
    pending = "";
    pendingBytes = headerBytes;
    pendingRows = 0;
  };

  const stream = createReadStream(file, "utf8");
  try {
    for await (const chunk of stream) {
      for (const record of splitter.push(chunk)) await ingest(record);
    }
  } catch (e) {
    stream.destroy();
    throw e;
  }
  for (const record of splitter.finish()) await ingest(record);
  if (header === null) return { header: null, parts }; // Empty input: no parts.
  if (pendingRows > 0) await writePart(parts.length);
  return { header, parts };
}

/**
 * Phase 2 (validation): re-read every part file and confirm byte size, row
 * count, row budget, and header identity before ANY upload. Reads stream
 * from disk; only counts and the header line are compared, cell content is
 * never logged.
 */
async function validateParts(parts, header, maxBytes, maxRows) {
  if (parts.length === 0) throw new RangeError("Snapshot import contained no data rows.");
  for (const part of parts) {
    const text = readFileSync(part.file, "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes !== part.bytes || bytes > maxBytes) {
      throw new Error(`Part ${part.index + 1} failed validation (byte size).`);
    }
    // Logical records, not physical lines: quoted cells may embed newlines.
    const splitter = new CsvRecordSplitter();
    const records = [...splitter.push(text), ...splitter.finish()];
    if (records.length < 1 || `${records[0]}\n` !== header) {
      throw new Error(`Part ${part.index + 1} failed validation (header).`);
    }
    const rows = records.length - 1;
    if (rows !== part.rows || rows === 0 || rows > maxRows) {
      throw new Error(`Part ${part.index + 1} failed validation (row count).`);
    }
  }
}

async function postPart(baseUrl, importPath, token, timeoutMs, text, index, total) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${importPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/csv",
        "content-length": String(Buffer.byteLength(text, "utf8")),
      },
      body: text,
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.json();
    console.log(
      `part ${index + 1}/${total}: bytes=${Buffer.byteLength(text, "utf8")} rows=${body.rowCount} upserted=${body.upserted}`
    );
    return body;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`HTTP timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(argv.slice(2));
  } catch (e) {
    console.error(e instanceof UsageError ? e.message : String(e));
    console.error(`\n${usage()}`);
    exit(2);
  }
  if (args.help) {
    console.log(usage());
    exit(0);
  }

  const batchesSource = readSource("src/lib/snapshot/exportImportBatches.ts");
  const streamSyncSource = readSource("src/lib/snapshot/streamSync.ts");
  let budgets = { batchBytes: BATCH_BYTES_FALLBACK, batchRows: BATCH_ROWS_FALLBACK, importCap: IMPORT_CAP_FALLBACK };
  try {
    if (batchesSource && streamSyncSource) budgets = parseBudgetConstants(batchesSource, streamSyncSource);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    exit(2);
  }
  const maxBytes = args.maxBytes ?? budgets.batchBytes;
  const maxRows = args.maxRows ?? budgets.batchRows;
  try {
    assertBudgets(maxBytes, maxRows, budgets.importCap);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    exit(2);
  }

  let stat = null;
  try {
    stat = statSync(args.file);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    console.error(`--file is not a readable file: ${args.file}`);
    exit(2);
  }

  const token = resolveToken(env, readDevVars(), args.tokenEnv);
  if (!token && !args.dryRun) {
    console.error(
      "No import token: set CUSTOMER_SNAPSHOT_SYNC_SECRET (or --token-env=NAME), or add it to .dev.vars for local dev."
    );
    exit(2);
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "snapshot-import-"));
  let header;
  let parts;
  try {
    ({ header, parts } = await prepareParts(args.file, maxBytes, maxRows, budgets.importCap, dir));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    console.error(`Split failed: ${e instanceof Error ? e.message : String(e)}`);
    exit(2);
  }
  if (header === null || parts.length === 0) {
    rmSync(dir, { recursive: true, force: true });
    console.error("Split failed: Snapshot import contained no data rows.");
    exit(2);
  }
  try {
    await validateParts(parts, header, maxBytes, maxRows);
  } catch (e) {
    console.error(`Validation failed, uploading nothing. Parts kept at ${dir}`);
    console.error(e instanceof Error ? e.message : String(e));
    exit(1);
  }

  const totalBytes = parts.reduce((n, p) => n + p.bytes, 0);
  const totalRows = parts.reduce((n, p) => n + p.rows, 0);
  if (args.dryRun) {
    for (const p of parts) console.log(`part ${p.index + 1}/${parts.length}: bytes=${p.bytes} rows=${p.rows} file=${p.file}`);
    console.log(`dry-run: ${parts.length} parts, ${totalBytes} bytes, ${totalRows} rows. Uploaded nothing; parts kept at ${dir}`);
    exit(0);
  }

  const importPath = TABLE_IMPORT_PATHS[args.table];
  try {
    const texts = parts.map((p) => readFileSync(p.file, "utf8"));
    const summary = await importPartsInOrder(
      texts,
      (text, index) => postPart(args.baseUrl, importPath, token, args.timeoutMs, text, index, texts.length)
    );
    rmSync(dir, { recursive: true, force: true });
    console.log(
      JSON.stringify({ table: args.table, parts: summary.parts, bytes: summary.bytes, rows: summary.rows, upserted: summary.upserted })
    );
    exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    console.error(`Parts kept at ${dir} for investigation; imports are upsert-only, so re-running after a fix resumes without deletes.`);
    exit(1);
  }
}

await main();
