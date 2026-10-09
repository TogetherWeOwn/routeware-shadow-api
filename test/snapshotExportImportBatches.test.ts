import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCustomerSnapshotRow } from "../src/lib/csvCustomerSnapshot";
import { mapCsvHeaders } from "../src/lib/csvParse";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";
import { CUSTOMER_SNAPSHOT_EXPORT, encodeSnapshotRow, snapshotExportHeaderLine } from "../src/lib/snapshot/export";
import { batchSnapshotExportCsv, SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES } from "../src/lib/snapshot/exportImportBatches";
import { SNAPSHOT_IMPORT_MAX_BYTES } from "../src/lib/snapshot/streamSync";
import { rejectOversizedSnapshotImport } from "../src/routes/snapshotImport";
import { ensureD1TestTables } from "./d1TestMigrations";

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).byteLength;
const spec = CUSTOMER_SNAPSHOT_EXPORT;
const header = snapshotExportHeaderLine(spec);
const row = { customer_id: 100_000, company_name: "Synthetic", comments: "", enabled: 1, synced_at: "2026-10-08T00:00:00.000Z" };
const guard = (n: number) => rejectOversizedSnapshotImport({
  url: "https://example.invalid/api/v1/customer-snapshot/import", contentLength: String(n)
}, SNAPSHOT_IMPORT_MAX_BYTES);

async function collect(csv: string, maxBytes?: number, maxRows?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const part of batchSnapshotExportCsv(stringToUint8Stream(csv), maxBytes, maxRows)) out.push(part);
  return out;
}

async function lines(csv: string): Promise<string[]> {
  const out: string[] = [];
  for await (const line of streamCsvLines(stringToUint8Stream(csv))) out.push(line);
  return out;
}

describe("bounded recovery of marked snapshot exports", () => {
  it("preserves all 6,000 rows when metadata alone pushes the original over 50 MiB", async () => {
    const count = 6_000;
    const oldHeader = spec.columns.map(c => c.header).join(",") + "\n";
    const oldEmptyLine = encodeSnapshotRow(spec, row).replace(",apostrophe-v1,", ",") + "\n";
    const commentLength = Math.floor(SNAPSHOT_IMPORT_MAX_BYTES / count) - bytes(oldEmptyLine) - 7;
    const populated = { ...row, comments: "x".repeat(commentLength) };
    const newLine = encodeSnapshotRow(spec, populated) + "\n";
    const oldBytes = bytes(oldHeader) + count * bytes(newLine.replace(",apostrophe-v1,", ","));
    const newBytes = bytes(header + "\n") + count * bytes(newLine);
    expect(oldBytes).toBe(52_386_156);
    expect(newBytes).toBe(52_470_177);
    expect(guard(oldBytes)).toBeNull();
    // The cap is intentional and unchanged; splitting is the recovery, not a bypass.
    expect(guard(newBytes)?.status).toBe(413);
    let next = -1;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (next === count) return controller.close();
      controller.enqueue(encoder.encode(next < 0 ? header + "\n" : encodeSnapshotRow(spec, { ...populated, customer_id: 100_000 + next }) + "\n"));
      next++;
    } });
    let seen = 0;
    let parts = 0;
    for await (const part of batchSnapshotExportCsv(stream)) {
      parts++;
      expect(bytes(part)).toBeLessThanOrEqual(SNAPSHOT_EXPORT_IMPORT_BATCH_BYTES);
      expect(guard(bytes(part))).toBeNull();
      const records = await lines(part);
      expect(records[0]).toBe(header);
      expect(records.length - 1).toBe(500);
      const cols = mapCsvHeaders(records[0]!);
      for (const record of records.slice(1)) {
        const parsed = parseCustomerSnapshotRow(cols, record);
        expect(parsed?.customerId).toBe(100_000 + seen++);
        expect(parsed?.comments).toBe(populated.comments);
      }
    }
    expect(parts).toBe(12);
    expect(seen).toBe(count);
  });

  it("counts UTF-8 bytes and accepts exact-fit header + row, not one byte less", async () => {
    const csv = "ID,Name\n1,日本語🎉\n";
    expect(bytes(csv)).toBeGreaterThan(csv.length);
    expect(await collect(csv, bytes(csv))).toEqual([csv]);
    await expect(collect(csv, bytes(csv) - 1)).rejects.toThrow("record exceeds");
    const two = "ID,Name\n1,日本語🎉\n2,日本語🎉\n";
    expect(await collect(two, bytes(csv))).toEqual([csv, csv.replace("1,", "2,")]);
  });

  it("keeps encoded multiline, doubled quotes, semicolons, tabs and apostrophes unchanged", async () => {
    const records = ["=1+1\nsecond,\"quoted\"", "'=1+1;\tkeep", "@SUM(A1)"].map((company_name, i) =>
      encodeSnapshotRow(spec, { ...row, customer_id: 100_100 + i, company_name }));
    const parts = await collect([header, ...records].join("\r\n"), undefined, 1);
    expect(parts).toEqual(records.map(record => header + "\n" + record + "\n"));
    const cols = mapCsvHeaders(header);
    expect(parts.map(part => parseCustomerSnapshotRow(cols, part.slice(header.length + 1).trimEnd())?.companyName))
      .toEqual(["=1+1\nsecond,\"quoted\"", "'=1+1;\tkeep", "@SUM(A1)"]);
  });

  it("does not yield empty or header-only import bodies", async () => {
    expect(await collect("")).toEqual([]);
    expect(await collect(header + "\n")).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, SNAPSHOT_IMPORT_MAX_BYTES + 1])("rejects invalid byte budget %s", async limit => {
    await expect(collect("H\nx\n", limit)).rejects.toThrow("byte limit must");
  });
  it.each([0, -1, 1.5, NaN, Infinity, 501])("rejects invalid row budget %s", async limit => {
    await expect(collect("H\nx\n", undefined, limit)).rejects.toThrow("row limit must");
  });

  it("rejects oversized headers and late indivisible records without exposing content", async () => {
    await expect(collect("private-header\nx\n", 2)).rejects.toThrow("Snapshot CSV header exceeds the batch byte limit");
    const stream = stringToUint8Stream("H\na\nb\nprivate-row-too-wide\n");
    const iterator = batchSnapshotExportCsv(stream, 4, 1);
    expect((await iterator.next()).value).toBe("H\na\n");
    await expect(iterator.next()).rejects.toThrow("Snapshot CSV record exceeds the batch byte limit");
    expect(stream.locked).toBe(false);
  });

  it("releases the input reader when the caller stops preparing parts", async () => {
    const stream = stringToUint8Stream("H\na\nb\nc\n");
    for await (const part of batchSnapshotExportCsv(stream, 4, 1)) {
      expect(part).toBe("H\na\n");
      break;
    }
    expect(stream.locked).toBe(false);
  });
});

describe("sequential bounded HTTP upserts (test D1 only)", () => {
  beforeAll(async () => { await ensureD1TestTables(); });
  it("decodes marked cells across parts and retains rows absent from later parts", async () => {
    const names = ["=1+1", "'=1+1", "-1+1\nsecond,\"quote\"", "@SUM(A1)"];
    const records = names.map((company_name, i) => encodeSnapshotRow(spec, { ...row, customer_id: 899_100 + i, company_name }));
    const parts = await collect([header, ...records].join("\n"), undefined, 2);
    expect(parts).toHaveLength(2);
    for (const body of parts) {
      const response = await exports.default.fetch("http://test.local/api/v1/customer-snapshot/import", {
        method: "POST", headers: { authorization: "Bearer test-sync-secret", "content-type": "text/csv", "content-length": String(bytes(body)) }, body
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ upserted: 2, rowCount: 2 });
    }
    const db = (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
    const { results } = await db.prepare("SELECT company_name FROM customer_snapshot WHERE customer_id >= ? AND customer_id <= ? ORDER BY customer_id")
      .bind(899_100, 899_103).all<{ company_name: string }>();
    expect(results.map(r => r.company_name)).toEqual(names);
  });
});
