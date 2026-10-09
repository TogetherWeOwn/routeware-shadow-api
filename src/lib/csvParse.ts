import {
  CSV_SPREADSHEET_ENCODING,
  CSV_SPREADSHEET_ENCODING_HEADER
} from "./csvSpreadsheet";

/** Shared CSV field parser (RFC 4180-style quoted fields). */

export class CsvControlCharacterError extends Error {
  constructor(readonly rowNumber: number) {
    super(`CSV row ${rowNumber} contains a disallowed control character.`);
    this.name = "CsvControlCharacterError";
  }
}

/** Report parsing stays permissive; import control rejection is opt-in. */
export function parseCsvLine(
  line: string,
  rowNumber = 1,
  options: { rejectControlCharacters?: boolean } = {}
): string[] {
  return scanCsvLine(line, rowNumber, false, options.rejectControlCharacters ?? false);
}

/** Validate without allocating cell strings, including rows later skipped by trim. */
export function assertCsvControlCharacters(line: string, rowNumber = 1): void {
  scanCsvLine(line, rowNumber, true, true);
}

function scanCsvLine(
  line: string,
  rowNumber: number,
  validateOnly: boolean,
  rejectControlCharacters: boolean
): string[] {
  const s = !rejectControlCharacters && line.endsWith("\r") ? line.slice(0, -1) : line;
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  // Whether the current position starts a field: a `"` only opens a quoted
  // field here (cf. `scanForLineBreak` in csvStream.ts). A mid-field `"` is a
  // literal stray (inch mark) — otherwise one bad cell silently swallows every
  // following row (TOG-8536).
  let fieldStart = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // A terminal, unquoted CR is a record separator, not cell content.
    if (rejectControlCharacters && ch === "\r" && i === s.length - 1 && !inQuotes) {
      continue;
    }
    const code = s.charCodeAt(i);
    if (rejectControlCharacters && (
      (code < 0x20 && ch !== "\t" && ch !== "\n" && ch !== "\r") ||
      (code >= 0x7f && code <= 0x9f) ||
      (ch === "\r" && s[i + 1] !== "\n")
    )) {
      throw new CsvControlCharacterError(rowNumber);
    }
    if (ch === '"') {
      if (inQuotes) {
        if (s[i + 1] === '"') {
          if (!validateOnly) {
            cur += '"';
          }
          i += 1;
          continue;
        }
        inQuotes = false;
        fieldStart = false;
        continue;
      }
      if (fieldStart) {
        inQuotes = true;
        fieldStart = false;
        continue;
      }
      if (!validateOnly) {
        cur += ch;
      }
      fieldStart = false;
      continue;
    }
    if (!inQuotes && ch === ",") {
      if (!validateOnly) {
        out.push(cur);
      }
      cur = "";
      fieldStart = true;
      continue;
    }
    if (!validateOnly) {
      cur += ch;
    }
    if (!inQuotes && ch !== " " && ch !== "\t") {
      fieldStart = false;
    }
  }
  if (!validateOnly) {
    out.push(cur);
  }
  return out;
}

export function normHeader(h: string): string {
  return h.trim().replace(/^\uFEFF/, "").toLowerCase();
}

export function mapCsvHeaders(headerLine: string): Record<string, number> {
  const cells = parseCsvLine(headerLine).map((c) => c.trim());
  const map: Record<string, number> = {};
  for (let i = 0; i < cells.length; i++) {
    map[normHeader(cells[i])] = i;
  }
  return map;
}

export function cell(
  cols: Record<string, number>,
  row: string[],
  ...names: string[]
): string {
  for (const n of names) {
    const i = cols[normHeader(n)];
    if (i !== undefined && row[i] !== undefined) {
      const value = row[i];
      const encodingIndex = cols[CSV_SPREADSHEET_ENCODING_HEADER];
      // Decode only version-marked export rows; unmarked upstream CSV is untouched.
      return (
        encodingIndex !== undefined &&
        row[encodingIndex]?.trim() === CSV_SPREADSHEET_ENCODING &&
        value.startsWith("'")
          ? value.slice(1)
          : value
      ).trim();
    }
  }
  return "";
}

export function emptyToNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

export function parseBool(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t === "true" || t === "1" || t === "yes";
}

/**
 * TOG-6542: missing/empty boolean with an enabled-true default.
 *
 * The cron CSV path collapses "column absent" and "empty cell" to `""`
 * (via `cell()`), while the write-through path (`detailFullSync.ts`) and
 * the D1 schema (`DEFAULT 1`) default absent `Enabled`/`ExtrasAllowed` to
 * `true`. Plain `parseBool("")` is `false`, so the same entity flapped
 * disabled (cron) / enabled (POST). Use this for `Enabled`/`ExtrasAllowed`
 * only; `OnCall`/`GPSLocked` correctly stay on `parseBool` (DB `DEFAULT 0`,
 * write-through defaults `false`).
 */
export function parseBoolDefaultTrue(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (t === "") {
    return true;
  }
  return t === "true" || t === "1" || t === "yes";
}

export function parseInt10(s: string): number | null {
  const t = s.trim();
  if (t === "") {
    return null;
  }
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
