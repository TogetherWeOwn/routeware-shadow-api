import {
  cell,
  emptyToNull,
  mapCsvHeaders,
  parseBoolDefaultTrue,
  parseCsvLine,
  parseInt10
} from "./csvParse";

export type AddressSnapshotRow = {
  pickupAddressId: number;
  customerId: number;
  routeId: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  franchiseId: string | null;
  comments: string | null;
  extrasAllowed: boolean;
  enabled: boolean;
  driverNote: string | null;
  latitude: string | null;
  longitude: string | null;
  lastAuditDate: string | null;
};

export function parseAddressSnapshotRow(
  cols: Record<string, number>,
  line: string
): AddressSnapshotRow | null {
  if (!line.trim()) {
    return null;
  }
  const row = parseCsvLine(line);
  const pa = parseInt10(cell(cols, row, "PickupAddressID", "pickupaddressid"));
  const cust = parseInt10(cell(cols, row, "CustomerID", "customerid"));
  if (pa === null || cust === null) {
    return null;
  }
  return {
    pickupAddressId: pa,
    customerId: cust,
    routeId: parseInt10(cell(cols, row, "RouteID", "routeid")),
    address: emptyToNull(cell(cols, row, "Address", "address")),
    city: emptyToNull(cell(cols, row, "City", "city")),
    state: emptyToNull(cell(cols, row, "State", "state")),
    zip: emptyToNull(cell(cols, row, "Zip", "zip")),
    franchiseId: emptyToNull(
      cell(cols, row, "FranchiseID", "franchiseid")
    ),
    comments: emptyToNull(cell(cols, row, "Comments", "comments")),
    extrasAllowed: parseBoolDefaultTrue(
      cell(cols, row, "ExtrasAllowed", "extrasallowed")
    ),
    enabled: parseBoolDefaultTrue(cell(cols, row, "Enabled", "enabled")),
    driverNote: emptyToNull(cell(cols, row, "DriverNote", "drivernote")),
    latitude: emptyToNull(cell(cols, row, "Latitude", "latitude")),
    longitude: emptyToNull(cell(cols, row, "Longitude", "longitude")),
    lastAuditDate: emptyToNull(
      cell(
        cols,
        row,
        "Last_Audit_Date",
        "last_audit_date",
        "LastAuditDate",
        "lastauditdate"
      )
    )
  };
}

export function parseAddressSnapshotCsv(csvText: string): {
  header: string;
  rows: AddressSnapshotRow[];
} {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    return { header: lines[0] ?? "", rows: [] };
  }
  const header = lines[0];
  const cols = mapCsvHeaders(header);
  const rows: AddressSnapshotRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const r = parseAddressSnapshotRow(cols, lines[i]);
    if (r) {
      rows.push(r);
    }
  }
  return { header, rows };
}
