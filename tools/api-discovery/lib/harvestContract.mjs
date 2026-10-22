/** Pure, value-free record validation shared by all harvest consumers. */
export const MAX_HARVEST_FINDINGS = 100;

const ACTIONS = {
  HARVEST_INVALID_JSON: "Correct the JSON object on this line, then validate again.",
  HARVEST_RECORD_TYPE: "Use one nonarray JSON object per nonblank line.",
  HARVEST_TIMESTAMP_INVALID: "Set ts to a valid UTC ISO timestamp, then validate again.",
  HARVEST_METHOD_INVALID: "Set method to an uppercase HTTP method token.",
  HARVEST_PATH_INVALID: "Set pathname to an absolute URL path without a query or fragment.",
  HARVEST_FIELD_INVALID: "Correct this optional field's type using the harvest README contract."
};

function finding(code, line, field) {
  return { code, line, field, next_action: ACTIONS[code] };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  // Date.parse normalizes impossible calendar dates; reject those too.
  return Number.isFinite(time) && new Date(time).toISOString() ===
    value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = "") => `.${fraction.padEnd(3, "0")}Z`);
}

/** Findings contain only fixed codes, known field names and physical line numbers. */
export function validateHarvestRecord(row, line = 1) {
  if (!isObject(row)) {
    return [finding("HARVEST_RECORD_TYPE", line, "$")];
  }
  const findings = [];
  const check = (valid, code, field) => {
    if (!valid) findings.push(finding(code, line, field));
  };
  check(isTimestamp(row.ts), "HARVEST_TIMESTAMP_INVALID", "ts");
  check(typeof row.method === "string" && /^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(row.method),
    "HARVEST_METHOD_INVALID", "method");
  check(typeof row.pathname === "string" && /^\/(?!\/)[^\s?#\\\u0000-\u001f\u007f]*$/u.test(row.pathname) &&
    !/%(?![0-9a-f]{2})/i.test(row.pathname), "HARVEST_PATH_INVALID", "pathname");

  for (const field of ["requestBodyPreview", "responseBodyPreview", "queryString", "resourceType",
    "pathWithQuery", "frameUrl", "requestContentType", "responseContentType"]) {
    check(row[field] == null || typeof row[field] === "string", "HARVEST_FIELD_INVALID", field);
  }
  for (const field of ["requestBodyTruncated", "responseBodyTruncated"]) {
    check(row[field] === undefined || typeof row[field] === "boolean", "HARVEST_FIELD_INVALID", field);
  }
  check(row.query == null || (isObject(row.query) && Object.values(row.query).every(value =>
    typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string")))),
  "HARVEST_FIELD_INVALID", "query");
  for (const field of ["requestHeaders", "responseHeaders"]) {
    check(row[field] == null || (isObject(row[field]) && Object.values(row[field]).every(value => typeof value === "string")),
      "HARVEST_FIELD_INVALID", field);
  }
  check(row.responseStatus == null || (Number.isInteger(row.responseStatus) && row.responseStatus >= 100 && row.responseStatus <= 599),
    "HARVEST_FIELD_INVALID", "responseStatus");
  return findings;
}

export function parseHarvestLine(text, line) {
  if (!text.trim()) return { row: null, findings: [] };
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    return { row: null, findings: [finding("HARVEST_INVALID_JSON", line, "$")] };
  }
  return { row, findings: validateHarvestRecord(row, line) };
}

export class HarvestValidationError extends Error {
  constructor(findings, findingCount) {
    super("HARVEST_INVALID_RECORDS: correct harvest findings before aggregation.");
    this.name = "HarvestValidationError";
    this.code = "HARVEST_INVALID_RECORDS";
    this.findings = findings;
    this.findingCount = findingCount;
  }
}

/** Bounded diagnostics; even a caught refusal cannot make finish publish a valid subset. */
export function createHarvestValidation() {
  let physicalLineCount = 0;
  let lineCount = 0;
  let findingCount = 0;
  const findings = [];
  return {
    addLine(text) {
      physicalLineCount += 1;
      const result = parseHarvestLine(text, physicalLineCount);
      findingCount += result.findings.length;
      findings.push(...result.findings.slice(0, MAX_HARVEST_FINDINGS - findings.length));
      if (result.findings.length || result.row === null) return null;
      lineCount += 1;
      return result.row;
    },
    finish() {
      if (findingCount) throw new HarvestValidationError([...findings], findingCount);
      return { lineCount, physicalLineCount };
    }
  };
}
