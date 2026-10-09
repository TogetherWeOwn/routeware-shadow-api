/** Export-only metadata: raw Routeware imports must never lose apostrophes. */
export const CSV_SPREADSHEET_ENCODING_HEADER = "_shadow_csv_encoding";
export const CSV_SPREADSHEET_ENCODING = "1";

const FORMULA_LEAD = /^\s*[=+\-@'＝＋－＠\t\r\n]/;
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/** OWASP CSV-injection escape for formula-leading cells; plain numbers stay numeric. */
export function escapeCsvCell(value: string): string {
  if (FORMULA_LEAD.test(value) && !PLAIN_NUMBER.test(value)) {
    return `"'${value.replace(/"/g, '""')}"`;
  }
  return /[",;\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
