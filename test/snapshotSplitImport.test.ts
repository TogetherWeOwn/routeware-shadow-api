import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { parseContainerSnapshotRow } from "../src/lib/csvContainerSnapshot";
import { mapCsvHeaders } from "../src/lib/csvParse";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";
import { CONTAINER_SNAPSHOT_EXPORT, encodeSnapshotRow, snapshotExportHeaderLine } from "../src/lib/snapshot/export";
import { batchSnapshotExportCsv, SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES, SNAPSHOT_EXPORT_IMPORT_BATCH_ROWS } from "../src/lib/snapshot/exportImportBatches";
import { SNAPSHOT_IMPORT_MAX_BYTES } from "../src/lib/snapshot/streamSync";
import { rejectOversizedSnapshotImport } from "../src/routes/snapshotImport";
import {
  BATCH_BYTES_FALLBACK,
  BATCH_ROWS_FALLBACK,
  CsvRecordSplitter,
  IMPORT_CAP_FALLBACK,
  SNAPSHOT_TABLES,
  TABLE_IMPORT_PATHS,
  UsageError,
  chunkRecords,
  importPartsInOrder,
  parseArgs,
  parseBudgetConstants,
  resolveToken,
  splitTextToParts,
} from "../scripts/lib/snapshotSplitImport.mjs";
import { ensureD1TestTables } from "./d1TestMigrations";

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).byteLength;

async function partsFromTs(csv: string, maxBytes?: number, maxRows?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const part of batchSnapshotExportCsv(stringToUint8Stream(csv), maxBytes, maxRows)) out.push(part);
  return out;
}

/** Feed text to the JS splitter in odd-sized pushes to cover chunk boundaries. */
function splitPushed(text: string, sizes: number[]): string[] {
  const splitter = new CsvRecordSplitter();
  const records: string[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const n = sizes[k++ % sizes.length]!;
    records.push(...splitter.push(text.slice(i, i + n)));
    i += n;
  }
  records.push(...splitter.finish());
  return records;
}

describe("CLI/TS parity: identical parts from identical exports", () => {
  const tricky = [
    "=HYPERLINK(\"x\")", // formula + doubled quotes after escaping
    "'=LEAD", // literal leading apostrophe (escaped, then exactly one removed)
    "-5+3",
    "@SUM(A1)",
    "5\" widget", // stray mid-field quote stays literal (TOG-8536)
    "line1\nline2,\"quoted\"", // multiline quoted cell
    "semi;colon\ttab",
    "日本語🎉",
    "  =padded", // whitespace-hidden formula prefix
  ];
  const csvFor = (cells: string[]) => {
    const header = "ID,Note";
    const rows = cells.map((c, i) => `${i},"${c.replace(/"/g, '""')}"`);
    return `${header}\n${rows.join("\n")}\n`;
  };

  it("yields identical parts on formula, stray-quote, multiline, CRLF, CR and unicode input", async () => {
    for (const text of [
      csvFor(tricky),
      csvFor(tricky).replace(/\n/g, "\r\n"),
      csvFor(tricky).replace(/\n/g, "\r"),
      `﻿${csvFor(tricky)}`, // BOM preserved: the server decodes with ignoreBOM:true
      "H\n\n\na\n\nb\n", // zero-length physical lines dropped
      "H\ntrailing", // no trailing newline
      "H\nbare-cr\r", // dangling CR at EOF yields verbatim, like streamCsvLines
    ]) {
      const fromTs = await partsFromTs(text, 64, 2);
      const fromJs = splitTextToParts(text, 64, 2);
      expect(fromJs).toEqual(fromTs);
    }
  });

  it("matches across push boundaries down to single characters", async () => {
    const text = csvFor(tricky).replace(/\n/g, "\r\n");
    const expected = await partsFromTs(text, 64, 2);
    for (const sizes of [[1], [2, 3, 5], [7, 64, 1024]]) {
      const records = splitPushed(text, sizes);
      expect(chunkRecords(records, 64, 2)).toEqual(expected);
    }
  });

  it("matches the marked container encoding byte-for-byte, including exact-fit edges", async () => {
    const spec = CONTAINER_SNAPSHOT_EXPORT;
    const header = snapshotExportHeaderLine(spec);
    const base = { container_id: 1, pickup_address_id: 2, synced_at: "2026-10-09T00:00:00.000Z" };
    const rows = tricky.map((serial_number, i) =>
      encodeSnapshotRow(spec, { ...base, container_id: 954_000 + i, serial_number, container_note: `n${i} 日本語🎉` })
    );
    const csv = [header, ...rows].join("\n") + "\n";
    // 30-column marked rows need a roomier budget than the 2-column cases above.
    expect(await partsFromTs(csv, 4096, 3)).toEqual(splitTextToParts(csv, 4096, 3));
    // UTF-8 exact fit: accepted at the budget, one byte less splits.
    const small = "ID,Name\n1,日本語🎉\n2,x\n";
    const fit = bytes("ID,Name\n1,日本語🎉\n");
    expect(splitTextToParts(small, fit)).toEqual(await partsFromTs(small, fit));
    // One byte less makes the first data row indivisible: both sides throw the same error.
    await expect(partsFromTs(small, fit - 1)).rejects.toThrow("Snapshot CSV record exceeds the batch byte limit");
    expect(() => splitTextToParts(small, fit - 1)).toThrow("Snapshot CSV record exceeds the batch byte limit");
  });

  it("rejects the same invalid budgets with the same content-free messages", async () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity, SNAPSHOT_IMPORT_MAX_BYTES + 1]) {
      await expect(partsFromTs("H\nx\n", limit)).rejects.toThrow("byte limit must");
      expect(() => splitTextToParts("H\nx\n", limit)).toThrow("byte limit must");
    }
    for (const limit of [0, -1, 1.5, NaN, Infinity, 501]) {
      await expect(partsFromTs("H\nx\n", undefined, limit)).rejects.toThrow("row limit must");
      expect(() => splitTextToParts("H\nx\n", undefined, limit)).toThrow("row limit must");
    }
    await expect(partsFromTs("private-header\nx\n", 2)).rejects.toThrow("Snapshot CSV header exceeds the batch byte limit");
    expect(() => splitTextToParts("private-header\nx\n", 2)).toThrow("Snapshot CSV header exceeds the batch byte limit");
    expect(splitTextToParts("", 64)).toEqual([]);
    const headerOnly = "H\n";
    expect(splitTextToParts(headerOnly, 64)).toEqual([]);
    expect(await partsFromTs(headerOnly, 64)).toEqual([]);
  });

  it("parses the canonical budgets and matches the runtime constants", () => {
    // The workerd pool has no host-filesystem access, so the parser is pinned
    // against fixture text in the exact on-disk format while the fallbacks are
    // pinned against the live runtime constants (the CLI parses the real files
    // at startup and fails closed on drift).
    const budgets = parseBudgetConstants(
      "export const SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES = 5 * 1024 * 1024;\nexport const SNAPSHOT_EXPORT_IMPORT_BATCH_ROWS = 500;\n",
      "export const SNAPSHOT_IMPORT_MAX_BYTES = 50 * 1024 * 1024;\n"
    );
    expect(budgets).toEqual({ batchBytes: 5 * 1024 * 1024, batchRows: 500, importCap: 50 * 1024 * 1024 });
    expect(budgets.batchBytes).toBe(SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES);
    expect(budgets.batchRows).toBe(SNAPSHOT_EXPORT_IMPORT_BATCH_ROWS);
    expect(budgets.importCap).toBe(SNAPSHOT_IMPORT_MAX_BYTES);
    expect(budgets.batchBytes).toBe(BATCH_BYTES_FALLBACK);
    expect(budgets.batchRows).toBe(BATCH_ROWS_FALLBACK);
    expect(budgets.importCap).toBe(IMPORT_CAP_FALLBACK);
    expect(() => parseBudgetConstants("nope", "nope")).toThrow("refusing to split");
  });
});

describe("entry-point plumbing", () => {
  it("knows the three import routes and parses CLI args", () => {
    expect(SNAPSHOT_TABLES).toEqual(["customer", "address", "container"]);
    expect(TABLE_IMPORT_PATHS.container).toBe("/api/v1/container-snapshot/import");
    const args = parseArgs(["--table=container", "--file=./c.csv", "--base-url=https://w.example/", "--dry-run"]);
    expect(args).toMatchObject({ table: "container", file: "./c.csv", baseUrl: "https://w.example", dryRun: true });
    expect(() => parseArgs(["--table=container", "--file=./c.csv"])).toThrow(UsageError);
    expect(() => parseArgs(["--table=nope", "--file=./c.csv", "--base-url=http://x"])).toThrow(UsageError);
    expect(() => parseArgs(["--table=container", "--file=./c.csv", "--base-url=http://x", "--bogus"])).toThrow(UsageError);
  });

  it("resolves only the sync secret, never the app or read-only token", () => {
    expect(resolveToken({ CUSTOMER_SNAPSHOT_SYNC_SECRET: "s" }, null, null)).toBe("s");
    expect(resolveToken({ SHADOW_API_TOKEN: "app", SHADOW_API_READ_TOKEN: "ro" }, null, null)).toBeNull();
    expect(resolveToken({}, 'CUSTOMER_SNAPSHOT_SYNC_SECRET="from-dev-vars"\n', null)).toBe("from-dev-vars");
    expect(resolveToken({}, "CUSTOMER_SNAPSHOT_SYNC_SECRET=bare\n", null)).toBe("bare");
    expect(resolveToken({ CUSTOM: "x" }, null, "CUSTOM")).toBe("x");
    expect(resolveToken({}, null, null)).toBeNull();
  });

  it("imports strictly in order, accumulates, and names the failing part without content", async () => {
    const seen: number[] = [];
    const summary = await importPartsInOrder(["p0", "p1", "p2"], async (part, index) => {
      seen.push(index);
      return { upserted: index + 1, rowCount: index + 1 };
    });
    expect(seen).toEqual([0, 1, 2]);
    expect(summary).toMatchObject({ parts: 3, upserted: 6, rowCount: 6 });
    await expect(
      importPartsInOrder(["secret-part-content", "p1"], async (part) => {
        if (part === "p1") throw new Error("HTTP 400");
        return { upserted: 1, rowCount: 1 };
      })
    ).rejects.toThrow("part 2 of 2: HTTP 400");
  });
});

describe("container export over the cap round-trips through the entry point (test D1 only)", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  const spec = CONTAINER_SNAPSHOT_EXPORT;
  const header = snapshotExportHeaderLine(spec);
  const cols = mapCsvHeaders(header);
  const aid = 95_201;
  const firstId = 953_000;
  const syncedAt = "2026-10-09T00:00:00.000Z";
  const specials: Record<number, { serial_number: string; container_note: string }> = {
    0: { serial_number: '=HYPERLINK("https://x.example")', container_note: "formula serial" },
    1: { serial_number: "'=LEAD", container_note: "line1\nline2,\"quoted\"" },
    2: { serial_number: "-5+3", container_note: "unicode 日本語🎉" },
    3: { serial_number: "@SUM(A1)", container_note: "semi;colon\ttab" },
    4: { serial_number: "5\" widget", container_note: "stray quote serial" },
  };
  const line = (first: number, i: number, note: string) =>
    encodeSnapshotRow(spec, {
      container_id: first + i,
      pickup_address_id: aid,
      serial_number: specials[i]?.serial_number ?? `SN-${first + i}`,
      container_note: specials[i]?.container_note ?? note,
      synced_at: syncedAt,
    }) + "\n";

  it("a marked 6,000-row container export exceeds the cap, 413s direct, and splits into admissible parts", async () => {
    // Kept streaming (one line per pull, one part at a time) so the ~52 MB
    // feed never sits in memory whole — the CLI streams from disk the same way.
    const count = 6_000;
    const emptyLine = encodeSnapshotRow(spec, {
      container_id: firstId,
      pickup_address_id: aid,
      container_note: "",
      synced_at: syncedAt,
    });
    // +10 per row keeps the total over the cap with margin: the five short
    // special rows below save ~5×padLen bytes versus a fully padded feed.
    const padLen =
      Math.floor((SNAPSHOT_IMPORT_MAX_BYTES - bytes(`${header}\n`)) / count) - bytes(`${emptyLine}\n`) + 10;
    expect(padLen).toBeGreaterThan(1000);
    let total = bytes(`${header}\n`);
    let next = 0;
    let seen = 0;
    let parts = 0;
    // Header first, then one line per pull — the ~52 MB feed is generated on
    // demand, never concatenated.
    const chained = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(`${header}\n`));
      },
      async pull(c) {
        if (next >= count) {
          c.close();
          return;
        }
        const text = line(firstId, next, "x".repeat(padLen));
        total += bytes(text);
        c.enqueue(encoder.encode(text));
        next++;
      },
    });
    for await (const part of batchSnapshotExportCsv(chained, SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES, SNAPSHOT_EXPORT_IMPORT_BATCH_ROWS)) {
      parts++;
      expect(bytes(part)).toBeLessThanOrEqual(SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES);
      expect(
        rejectOversizedSnapshotImport(
          { url: "https://example.invalid/api/v1/container-snapshot/import", contentLength: String(bytes(part)) },
          SNAPSHOT_IMPORT_MAX_BYTES
        )
      ).toBeNull();
      expect(part.slice(0, header.length)).toBe(header);
      expect(part.split("\n")[0]).toContain("_shadow_csv_encoding");
      // Logical records, not physical lines: special row 1 carries an
      // embedded newline inside quotes.
      let records = 0;
      for await (const line of streamCsvLines(stringToUint8Stream(part))) {
        void line;
        records++;
      }
      expect(records - 1).toBeLessThanOrEqual(SNAPSHOT_EXPORT_IMPORT_BATCH_ROWS);
      seen += records - 1;
    }
    expect(total).toBeGreaterThan(SNAPSHOT_IMPORT_MAX_BYTES);
    // Direct re-import is correctly refused: the cap is unchanged, splitting
    // is the recovery, not a bypass.
    expect(
      rejectOversizedSnapshotImport(
        { url: "https://example.invalid/api/v1/container-snapshot/import", contentLength: String(total) },
        SNAPSHOT_IMPORT_MAX_BYTES
      )?.status
    ).toBe(413);
    expect(parts).toBe(12);
    expect(seen).toBe(count);
  }, 300_000);

  it("re-imports split parts in order with identical decoded values", async () => {
    // Same shipped functions the CLI calls (`splitTextToParts` +
    // `importPartsInOrder`), at reduced scale with tight budgets forcing many
    // parts; the >cap scale above differs only in numbers.
    const count = 600;
    const note = "y".repeat(200);
    const csv = `${header}\n` + Array.from({ length: count }, (_, i) => line(firstId, i, note)).join("");
    const fromTs = await partsFromTs(csv, 8192, 50);
    const fromJs = splitTextToParts(csv, 8192, 50);
    expect(fromJs).toEqual(fromTs);
    expect(fromJs.length).toBeGreaterThan(5);

    // FK parents: one customer + one address for every container row.
    const db = (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
    await db
      .prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (95100, 'Split Parent', 1, '2026-10-09T00:00:00.000Z')")
      .run();
    await db
      .prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (95201, 95100, 1, '2026-10-09T00:00:00.000Z')")
      .run();

    const summary = await importPartsInOrder(fromJs, async (part) => {
      const response = await exports.default.fetch("http://test.local/api/v1/container-snapshot/import", {
        method: "POST",
        headers: {
          authorization: "Bearer test-sync-secret",
          "content-type": "text/csv",
          "content-length": String(bytes(part)),
        },
        body: part,
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { upserted: number; rowCount: number };
    });
    expect(summary).toMatchObject({ parts: fromJs.length, rows: count, upserted: count });

    const countRow = await db
      .prepare("SELECT COUNT(*) as n FROM container_snapshot WHERE container_id >= ? AND container_id < ?")
      .bind(firstId, firstId + count)
      .first<{ n: number }>();
    expect(countRow?.n).toBe(count);
    // Spread counts Unicode code points (🎉 = 1), matching D1 LENGTH();
    // JS .length counts UTF-16 units (🎉 = 2) and would overshoot by one.
    let expectedNoteChars = 0;
    for (let i = 0; i < count; i++) expectedNoteChars += [...(specials[i]?.container_note ?? note)].length;
    const sumRow = await db
      .prepare("SELECT SUM(LENGTH(container_note)) as s FROM container_snapshot WHERE container_id >= ? AND container_id < ?")
      .bind(firstId, firstId + count)
      .first<{ s: number }>();
    expect(sumRow?.s).toBe(expectedNoteChars);
    for (const [offset, want] of Object.entries(specials)) {
      const row = await db
        .prepare("SELECT serial_number, container_note FROM container_snapshot WHERE container_id = ?")
        .bind(firstId + Number(offset))
        .first<{ serial_number: string; container_note: string }>();
      expect(row?.serial_number).toBe(want.serial_number);
      expect(row?.container_note).toBe(want.container_note);
      const parsed = parseContainerSnapshotRow(cols, encodeSnapshotRow(spec, {
        container_id: firstId + Number(offset),
        pickup_address_id: aid,
        serial_number: want.serial_number,
        container_note: want.container_note,
        synced_at: syncedAt,
      }));
      expect(parsed?.serialNumber).toBe(want.serial_number);
      expect(parsed?.containerNote).toBe(want.container_note);
    }
  }, 300_000);
});
