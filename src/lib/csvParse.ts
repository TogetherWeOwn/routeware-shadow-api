/** Shared CSV field parser (RFC 4180-style quoted fields). */

export function parseCsvLine(line: string): string[] {
  const s = line.endsWith("\r") ? line.slice(0, -1) : line;
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQuotes && s[i + 1] === '"') {
        cur += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
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
      return row[i].trim();
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

export function parseInt10(s: string): number | null {
  const t = s.trim();
  if (t === "") {
    return null;
  }
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
