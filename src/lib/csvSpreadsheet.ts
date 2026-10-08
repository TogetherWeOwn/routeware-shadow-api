/** Export-only metadata: raw Routeware imports must never lose apostrophes. */
export const CSV_SPREADSHEET_ENCODING_HEADER = "_shadow_csv_encoding";
export const CSV_SPREADSHEET_ENCODING = "apostrophe-v1";

/**
 * OWASP text-cell mitigation for comma-delimited CSV with double-quote text
 * delimiters, then RFC 4180 quoting. Include controls,
 * whitespace-hidden prefixes and full-width operators; escape an original
 * apostrophe too so marked exports can remove exactly one without collisions.
 * https://owasp.org/www-community/attacks/CSV_Injection
 * Spreadsheet save/reopen transformations are not guaranteed safe or lossless.
 */
export function escapeCsvCell(value: string): string {
  if (/^\s*[=+\-@'＝＋－＠\t\r\n]/.test(value)) {
    return `"'${value.replace(/"/g, '""')}"`;
  }
  return /[",;\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
