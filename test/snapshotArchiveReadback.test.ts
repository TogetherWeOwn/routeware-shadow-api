import { describe, expect, it } from "vitest";
import { cell, mapCsvHeaders, parseCsvLine } from "../src/lib/csvParse";
import { streamCsvLines } from "../src/lib/csvStream";
import {
  CSV_SPREADSHEET_ENCODING,
  CSV_SPREADSHEET_ENCODING_HEADER
} from "../src/lib/csvSpreadsheet";
import {
  measureSpreadsheetSafeCsv,
  spreadsheetSafeCsvStream
} from "../src/lib/snapshot/archiveReadback";
import { CUSTOMER_SNAPSHOT_EXPORT, snapshotExportHeaderLine } from "../src/lib/snapshot/export";

/**
 * TOG-18829 — spreadsheet-safe re-encoding of an archived CSV.
 *
 * Pins the readback transform directly: blank records are dropped and cells
 * trimmed as the importer reads them, every formula-leading cell is escaped as
 * the export escapes it, the marker follows the header and every row, the
 * importer reads the marked values back, and the length and ETag describe the
 * exact bytes served. The ETag reference is a BigInt FNV-1a 64 over the whole
 * body, independent of the 32-bit implementation under test.
 */

const HOSTILE_VALUES = [
  "=1+1",
  "+1+1",
  "-1+1",
  "@SUM(A1)",
  '=HYPERLINK("https://example.invalid/","a,b")',
  "\t=1+1",
  " =1+1",
  "'=1+1",
  "'literal",
  "＝1+1",
  "line1\nline2",
  'say "hi"',
  "a,b",
  "-74.0060",
  "plain",
  ""
];

const FORMULA_LEAD = /^\s*[=+\-@'＝＋－＠\t\r\n]/;
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

function rawCsvRow(values: string[]): string {
  return values
    .map((v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
    .join(",");
}

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.byteLength; i += size) {
        controller.enqueue(bytes.slice(i, i + size));
      }
      controller.close();
    }
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

async function readback(text: string, chunkSize = Number.MAX_SAFE_INTEGER): Promise<string> {
  const bytes = await collect(spreadsheetSafeCsvStream(chunked(text, chunkSize)));
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

function fnv1a64Reference(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `"fnv64-${h.toString(16).padStart(16, "0")}"`;
}

describe("spreadsheet-safe archive readback (TOG-18829)", () => {
  it("escapes a formula-leading cell and leaves plain numbers and words alone", async () => {
    const input = [
      "CustomerID,CompanyName,Enabled",
      `101,${rawCsvRow(['=HYPERLINK("https://example.invalid","Acme")'])},true`,
      "102,-74.0060,false"
    ].join("\n");

    const out = await readback(input);

    expect(out).toBe(
      [
        "CustomerID,CompanyName,Enabled,_shadow_csv_encoding",
        '101,"\'=HYPERLINK(""https://example.invalid"",""Acme"")",true,1',
        "102,-74.0060,false,1",
        ""
      ].join("\n")
    );
  });

  it.each(HOSTILE_VALUES)("escapes %j exactly as the export does and the importer reads it back", async (value) => {
    const input = ["CustomerID,Value", `1,${rawCsvRow([value])}`].join("\n");

    const out = await readback(input);

    const records: string[] = [];
    for await (const line of streamCsvLines(chunked(out, Number.MAX_SAFE_INTEGER))) {
      records.push(line);
    }
    const cols = mapCsvHeaders(records[0]);
    const row = parseCsvLine(records[1]);
    const trimmed = value.trim();
    const expectedCell = FORMULA_LEAD.test(trimmed) && !PLAIN_NUMBER.test(trimmed) ? `'${trimmed}` : trimmed;
    expect(row[1]).toBe(expectedCell);
    expect(cell(cols, row, "Value")).toBe(trimmed);
    expect(cell(cols, row, CSV_SPREADSHEET_ENCODING_HEADER)).toBe(CSV_SPREADSHEET_ENCODING);
  });

  it("marks the header and every row, and keeps values out of the marker column", async () => {
    const input = ["A,B,C", "1,2,3", "=x,,"].join("\n");

    const out = await readback(input);

    const lines = out.split("\n");
    expect(lines[0]).toBe("A,B,C,_shadow_csv_encoding");
    expect(lines[1]).toBe("1,2,3,1");
    expect(lines[2]).toBe('"\'=x",,,1');
  });

  it("pads a short row to the header width before the marker, and places the marker at that width in a long row", async () => {
    const input = ["A,B,C", "1", "1,2,3,4"].join("\n");

    const out = await readback(input);

    expect(out.split("\n")).toEqual([
      "A,B,C,_shadow_csv_encoding",
      "1,,,1",
      "1,2,3,1,4",
      ""
    ]);
  });

  it("keeps a stray inch mark literal and a multi-line quoted field as one record", async () => {
    const input = ["A,B", '5" widget,"line1', 'line2"'].join("\n");

    const out = await readback(input);

    expect(out).toBe(
      ["A,B,_shadow_csv_encoding", '"5"" widget","line1', 'line2",1', ""].join("\n")
    );
  });

  it("drops blank records as the importer's row parsers do", async () => {
    const out = await readback(["A,B", "1,2", "   ", "", "3,4"].join("\n"));

    expect(out).toBe("A,B,_shadow_csv_encoding\n1,2,1\n3,4,1\n");
  });

  it("trims each cell as the importer's cell() does, so a padded number stays a plain number", async () => {
    const out = await readback(["A,B", " -74.0060 , =1+1 "].join("\n"));

    expect(out).toBe('A,B,_shadow_csv_encoding\n-74.0060,"\'=1+1",1\n');
  });

  it("escapes a formula-leading header cell too", async () => {
    const out = await readback("=Score,B\n1,2\n");

    expect(out).toBe('"\'=Score",B,_shadow_csv_encoding\n1,2,1\n');
  });

  it("produces identical bytes whatever the input chunk size", async () => {
    const rows = HOSTILE_VALUES.map((v, i) => `${i},${rawCsvRow([v, `x${i}`])}`);
    const input = ["Id,Value,Note", ...rows].join("\n");

    const whole = await readback(input);
    for (const size of [1, 3, 7, 64]) {
      expect(await readback(input, size)).toBe(whole);
    }
  });

  it("measures exactly the bytes it serves, with an ETag over those bytes", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) =>
      `${i},${rawCsvRow([HOSTILE_VALUES[i % HOSTILE_VALUES.length], `name ${i}`])}`
    );
    const input = ["Id,Value,Name", ...rows].join("\n");

    const measured = await measureSpreadsheetSafeCsv(chunked(input, 4096));
    const served = await collect(spreadsheetSafeCsvStream(chunked(input, 4096)));

    expect(measured.length).toBe(served.byteLength);
    expect(measured.etag).toBe(fnv1a64Reference(served));
  });

  it("answers an empty archive with an empty body and the empty-content ETag", async () => {
    const measured = await measureSpreadsheetSafeCsv(chunked("", 16));
    const served = await collect(spreadsheetSafeCsvStream(chunked("", 16)));

    expect(measured).toEqual({ length: 0, etag: '"fnv64-cbf29ce484222325"' });
    expect(served.byteLength).toBe(0);
  });

  it("serves a header-only archive as the header with the marker", async () => {
    expect(await readback("CustomerID,Name\n")).toBe("CustomerID,Name,_shadow_csv_encoding\n");
  });

  it("drops a leading BOM from the header cell, as the export and the importer's header normalization do", async () => {
    const out = await readback("\uFEFFCustomerID,Name\n1,a\n");

    expect(out).toBe("CustomerID,Name,_shadow_csv_encoding\n1,a,1\n");
  });

  it("cancels the archive source when the client cancels mid-download", async () => {
    const rows = Array.from({ length: 12000 }, (_, i) => `${i},value ${i}`);
    let sourceCancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(["Id,Value", ...rows].join("\n")));
      },
      cancel() {
        sourceCancelled = true;
      }
    });
    const reader = spreadsheetSafeCsvStream(source).getReader();

    await reader.read();
    await reader.cancel();

    expect(sourceCancelled).toBe(true);
  });

  it("uses the export's marker name and value on the readback", () => {
    const exportHeader = snapshotExportHeaderLine(CUSTOMER_SNAPSHOT_EXPORT).split(",");

    expect(exportHeader.at(-2)).toBe(CSV_SPREADSHEET_ENCODING_HEADER);
    expect(CSV_SPREADSHEET_ENCODING).toBe("1");
  });
});
