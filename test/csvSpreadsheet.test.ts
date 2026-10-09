import { describe, expect, it } from "vitest";
import { parseAddressSnapshotRow } from "../src/lib/csvAddressSnapshot";
import { parseContainerSnapshotRow } from "../src/lib/csvContainerSnapshot";
import { parseCustomerSnapshotRow } from "../src/lib/csvCustomerSnapshot";
import { cell, mapCsvHeaders, parseCsvLine } from "../src/lib/csvParse";
import {
  CSV_SPREADSHEET_ENCODING,
  CSV_SPREADSHEET_ENCODING_HEADER,
  escapeCsvCell
} from "../src/lib/csvSpreadsheet";
import {
  ADDRESS_SNAPSHOT_EXPORT,
  CONTAINER_SNAPSHOT_EXPORT,
  CUSTOMER_SNAPSHOT_EXPORT,
  encodeSnapshotRow,
  snapshotExportHeaderLine
} from "../src/lib/snapshot/export";

const HOSTILE_CELLS = [
  "=1+1", "+1+1", "-1+1", "@SUM(A1)",
  '=HYPERLINK("https://example.invalid/","a,b")',
  '=1+1";=2+2', '=1+1\'" ,=2+2',
  "\t=1+1", "\r\n=1+1", "\n=1+1", " =1+1", "﻿=1+1",
  "＝1+1", "＋1+1", "－1+1", "＠SUM(A1)",
  "'=1+1", "''=1+1", "'literal", "'", "''", " 'literal"
];

describe("spreadsheet-safe CSV cells", () => {
  it.each(HOSTILE_CELLS)("quotes and prefixes %j without CSV field breakout", (value) => {
    const encoded = escapeCsvCell(value);
    expect(encoded.startsWith('"\'')).toBe(true);
    expect(encoded.endsWith('"')).toBe(true);
    expect(parseCsvLine(encoded)).toEqual([`'${value}`]);
    const cols = mapCsvHeaders(`Value,${CSV_SPREADSHEET_ENCODING_HEADER}`);
    expect(cell(cols, [`'${value}`, CSV_SPREADSHEET_ENCODING], "Value"))
      .toBe(value.trim());
  });

  it.each(["", "Acme Co", "a=b", "555-0101", "a,b", 'say "hi"', "line1\nline2", "safe;=1+1;tail", "safe\t=1+1"])(
    "keeps ordinary cells unchanged after RFC 4180 parsing: %j", (value) => {
      expect(parseCsvLine(escapeCsvCell(value))).toEqual([value]);
    }
  );

  it.each(["-74.0060", "+1", "-0.5", "-.5", "1e5", "-1E+3", "-0"])(
    "leaves plain numbers unprefixed and parseable: %j", (value) => {
      expect(escapeCsvCell(value)).toBe(value);
      expect(parseCsvLine(escapeCsvCell(value))).toEqual([value]);
    }
  );

  it.each(["-", "+", "- 1", " -1", "-1+1", "-1e5x", "-1,000"])(
    "still prefixes operator-led text that is not a plain number: %j", (value) => {
      expect(escapeCsvCell(value).startsWith('"\'')).toBe(true);
    }
  );

  it("also quotes embedded semicolons and tabs without changing comma-CSV cells", () => {
    expect(escapeCsvCell("safe;=1+1;tail")).toBe('"safe;=1+1;tail"');
    expect(escapeCsvCell("safe\t=1+1")).toBe('"safe\t=1+1"');
  });

  it("does not confuse an original apostrophe with an inserted one", () => {
    expect(escapeCsvCell("=1+1")).not.toBe(escapeCsvCell("'=1+1"));
    expect(escapeCsvCell("'=1+1")).not.toBe(escapeCsvCell("''=1+1"));
  });

  it.each([undefined, "", "apostrophe-v2", "unknown"])(
    "never decodes an unmarked or unknown-version upstream row: %j", (marker) => {
      const header = marker === undefined ? "Value" : `Value,${CSV_SPREADSHEET_ENCODING_HEADER}`;
      const cols = mapCsvHeaders(header);
      const row = marker === undefined ? ["'=1+1"] : ["'=1+1", marker];
      expect(cell(cols, row, "Value")).toBe("'=1+1");
    }
  );

  it.each([
    { spec: CUSTOMER_SNAPSHOT_EXPORT, parse: parseCustomerSnapshotRow, db: "company_name", property: "companyName", id: "customer_id" },
    { spec: ADDRESS_SNAPSHOT_EXPORT, parse: parseAddressSnapshotRow, db: "address", property: "address", id: "pickup_address_id" },
    { spec: CONTAINER_SNAPSHOT_EXPORT, parse: parseContainerSnapshotRow, db: "serial_number", property: "serialNumber", id: "container_id" }
  ])("round-trips every hostile cell through the $spec.table export and row parser", ({ spec, parse, db, property, id }) => {
    const cols = mapCsvHeaders(snapshotExportHeaderLine(spec));
    for (const value of HOSTILE_CELLS) {
      const encoded = encodeSnapshotRow(spec, {
        [id]: 1, customer_id: 1, pickup_address_id: 1, [db]: value,
        latitude: "30.1", longitude: "-97.7"
      });
      const fields = parseCsvLine(encoded);
      expect(fields).toHaveLength(spec.columns.length + 1);
      expect(fields.at(-2)).toBe(CSV_SPREADSHEET_ENCODING);
      expect(parse(cols, encoded)).toMatchObject({ [property]: value.trim() });
      if (spec !== CUSTOMER_SNAPSHOT_EXPORT) {
        expect(parse(cols, encoded)).toMatchObject({ longitude: "-97.7" });
      }
    }
  });
});
