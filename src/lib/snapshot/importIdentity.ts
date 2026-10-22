import { cell, mapCsvHeaders, normHeader, parseCsvLine } from "../csvParse";

const IDENTITIES = {
  customer_snapshot: [["customerid", "customer_id"]],
  address_snapshot: [
    ["pickupaddressid", "pickup_address_id"],
    ["customerid", "customer_id"]
  ],
  container_snapshot: [
    ["containerid", "container_id"],
    ["pickupaddressid", "pickup_address_id"]
  ]
} as const;

type SnapshotTable = keyof typeof IDENTITIES;
type IdentityField = (typeof IDENTITIES)[SnapshotTable][number][1];

/** Only allowlisted identifiers and a logical row number; never submitted bytes. */
export class SnapshotImportIdentityError extends Error {
  constructor(table: SnapshotTable, rowNumber: number, field: IdentityField) {
    super(
      `Invalid identity in ${table} at row ${rowNumber}, field ${field}. ` +
      "Provide each required identity header exactly once and use positive safe whole-decimal integers, then retry."
    );
    this.name = "SnapshotImportIdentityError";
  }
}

/** Check ambiguity before mapCsvHeaders can overwrite normalized identity columns. */
export function validateSnapshotIdentityHeaders(
  table: SnapshotTable,
  line: string
): Record<string, number> {
  const headers = parseCsvLine(line).map(normHeader);
  for (const [header, field] of IDENTITIES[table]) {
    if (headers.filter((name) => name === header).length !== 1) {
      throw new SnapshotImportIdentityError(table, 1, field);
    }
  }
  return mapCsvHeaders(line);
}

/** Import-only policy: leave shared report parsers and optional numbers tolerant. */
export function assertSnapshotRecordIdentities(
  table: SnapshotTable,
  cols: Record<string, number>,
  line: string,
  rowNumber: number
): void {
  if (!line.trim()) return;
  const row = parseCsvLine(line);
  for (const [header, field] of IDENTITIES[table]) {
    // Match the existing spreadsheet-marker decode and whitespace normalization.
    const value = cell(cols, row, header);
    const number = Number(value);
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
      throw new SnapshotImportIdentityError(table, rowNumber, field);
    }
  }
}
