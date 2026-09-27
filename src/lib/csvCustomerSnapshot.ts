import {
  cell,
  emptyToNull,
  mapCsvHeaders,
  parseBoolDefaultTrue,
  parseCsvLine
} from "./csvParse";

export type CustomerSnapshotRow = {
  customerId: number;
  customerTypeId: number | null;
  companyName: string | null;
  firstName: string | null;
  middleInitial: string | null;
  lastName: string | null;
  nameSuffix: string | null;
  customerNumber: string | null;
  subCustomerNumber: string | null;
  phone1: string | null;
  phone2: string | null;
  comments: string | null;
  enabled: boolean;
};

export function parseCustomerSnapshotRow(
  cols: Record<string, number>,
  line: string
): CustomerSnapshotRow | null {
  if (!line.trim()) {
    return null;
  }
  const row = parseCsvLine(line);
  const idStr = cell(cols, row, "CustomerID", "customerid");
  const customerId = Number.parseInt(idStr, 10);
  if (!Number.isFinite(customerId)) {
    return null;
  }
  const typeStr = cell(cols, row, "CustomerTypeID", "customertypeid");
  const customerTypeId =
    typeStr === "" ? null : Number.parseInt(typeStr, 10);
  return {
    customerId,
    customerTypeId: Number.isFinite(customerTypeId as number)
      ? (customerTypeId as number)
      : null,
    companyName: emptyToNull(cell(cols, row, "CompanyName", "companyname")),
    firstName: emptyToNull(cell(cols, row, "FirstName", "firstname")),
    middleInitial: emptyToNull(
      cell(cols, row, "MiddleInitial", "middleinitial")
    ),
    lastName: emptyToNull(cell(cols, row, "LastName", "lastname")),
    nameSuffix: emptyToNull(cell(cols, row, "NameSuffix", "namesuffix")),
    customerNumber: emptyToNull(
      cell(cols, row, "CustomerNumber", "customernumber")
    ),
    subCustomerNumber: emptyToNull(
      cell(cols, row, "SubCustomerNumber", "subcustomernumber")
    ),
    phone1: emptyToNull(cell(cols, row, "Phone1", "phone1")),
    phone2: emptyToNull(cell(cols, row, "Phone2", "phone2")),
    comments: emptyToNull(cell(cols, row, "Comments", "comments")),
    enabled: parseBoolDefaultTrue(cell(cols, row, "Enabled", "enabled"))
  };
}

/** Parse full CSV text; first line must be header. */
export function parseCustomerSnapshotCsv(csvText: string): {
  header: string;
  rows: CustomerSnapshotRow[];
} {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    return { header: lines[0] ?? "", rows: [] };
  }
  const header = lines[0];
  const cols = mapCsvHeaders(header);
  const rows: CustomerSnapshotRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const r = parseCustomerSnapshotRow(cols, lines[i]);
    if (r) {
      rows.push(r);
    }
  }
  return { header, rows };
}
