import { describe, expect, it } from "vitest";
import { assertCsvControlCharacters, CsvControlCharacterError, parseCsvLine } from "../src/lib/csvParse";
import { stringToUint8Stream } from "../src/lib/csvStream";
import { syncCustomerSnapshotFromStream } from "../src/lib/snapshot/streamSync";
import { recordingDb } from "./snapshotDbFake";

const forbiddenControls = Array.from({ length: 0xa0 }, (_, code) => code)
  .filter((code) => (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) || code >= 0x7f)
  .map((code) => ({ code: code.toString(16), char: String.fromCharCode(code) }));

describe("CSV control character validation", () => {
  it.each(forbiddenControls)("rejects U+$code before trimming", ({ char }) => {
    for (const line of [`42,private${char}value`, `42,"${char}private"`, `42,private${char}`]) {
      expect(() => assertCsvControlCharacters(line, 3)).toThrow(CsvControlCharacterError);
      expect(() => parseCsvLine(line, 3)).toThrow(CsvControlCharacterError);
      expect(() => parseCsvLine(line, 3)).toThrow("CSV row 3 contains a disallowed control character.");
    }
  });

  it.each([
    '42,"private\rvalue"',
    '42,"private\r"',
    '42,"private\r',
    '42,"\rprivate"',
    "42,private\rvalue"
  ])("rejects lone CR cell content: %j", (line) => {
    expect(() => assertCsvControlCharacters(line, 2)).toThrow("CSV row 2 contains a disallowed control character.");
    expect(() => parseCsvLine(line, 2)).toThrow("CSV row 2 contains a disallowed control character.");
  });

  it.each(["\u0000", "\u000b", "\r", "\u0085"])("rejects chunked control content: %j", async (char) => {
    const csv = `CustomerID,CompanyName\n1,"private${char}value"`;
    const bytes = new TextEncoder().encode(csv);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      }
    });
    const { db, batches } = recordingDb();
    await expect(syncCustomerSnapshotFromStream(db, body)).rejects.toThrow(
      "CSV row 2 contains a disallowed control character."
    );
    expect(batches).toEqual([]);
  });

  it("counts logical records, including skipped-ID/whitespace records but not quoted newlines or empty records", async () => {
    const csv = 'CustomerID,CompanyName\n\n1,"first\r\nsecond"\ninvalid,skip\n \n2,"bad\u0000"';
    const { db, batches } = recordingDb();
    await expect(syncCustomerSnapshotFromStream(db, stringToUint8Stream(csv))).rejects.toThrow(
      "CSV row 5 contains a disallowed control character."
    );
    expect(batches).toEqual([]);
  });

  it("preserves earlier valid batches without ever binding rejected content or reconciling", async () => {
    const csv = 'CustomerID,CompanyName\n1,valid\n2,"bad\u000b"';
    const { db, batches, runs } = recordingDb();
    await expect(syncCustomerSnapshotFromStream(db, stringToUint8Stream(csv), 1, { reconcile: true })).rejects.toThrow(
      "CSV row 3 contains a disallowed control character."
    );
    expect(batches).toHaveLength(1);
    expect(batches[0][0].binds[0]).toBe(1);
    expect(batches[0][0].binds[2]).toBe("valid");
    expect(JSON.stringify(batches)).not.toContain("bad");
    expect(runs).toEqual([]);
  });

  it("validates a large whitespace-only record without materializing skipped cells", async () => {
    const csv = `CustomerID,CompanyName\n${" ".repeat(8 * 1024 * 1024)}\n1,valid`;
    const { db, batches } = recordingDb();
    const result = await syncCustomerSnapshotFromStream(db, stringToUint8Stream(csv));
    expect(result).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
    expect(batches).toHaveLength(1);
    expect(batches[0][0].binds[2]).toBe("valid");
  });

  it("validation mode shares quote/escape/stray-quote rules without allocating cells", () => {
    for (const line of ['42,"safe ""quoted"" text"\r', '42,5" widget\r', '42,"x\ny\r\nz"', "\t  "]) {
      expect(assertCsvControlCharacters(line, 2)).toBeUndefined();
    }
  });

  it("preserves tabs, quoted LF/CRLF, Unicode, and an unquoted terminal CR", () => {
    expect(parseCsvLine('42,"café\tline\nnext\r\nlast"\r')).toEqual([
      "42", "café\tline\nnext\r\nlast"
    ]);
  });
});
