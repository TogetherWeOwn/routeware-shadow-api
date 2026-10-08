/**
 * dotenv-compatible `.dev.vars` parsing + full required-env validation.
 *
 * Runtime truth: `wrangler dev` loads `.dev.vars` with dotenv v16 `parse()`
 * (see `tryLoadDotDevDotVars` in the wrangler bundle), which strips an
 * `export` prefix, surrounding single/double/backtick quotes, and unquoted
 * trailing `#` comments. The old checker split each line on the first `=`
 * and kept all of that, so it validated values the Worker would never see —
 * dev printed OK and then crashed on a "quoted" `SESSION_TTL_SECONDS`
 * (NaN expiry in `sessionExpiryMs`) or 401'd on a comment-polluted token
 * (constant-time compare in `src/lib/auth.ts` never matches the polluted
 * value), per CONVENTIONS.md fact 1 (never trust the surface; validate the
 * effective value) and fact 2 (PII/secrets handling).
 *
 * Findings name keys only — values are never logged, returned, or echoed
 * (CONVENTIONS.md sections 4-5). Fixture values in tests are placeholders.
 */

// Mirrors the dotenv v16 LINE matcher wrangler bundles: optional `export`,
// `KEY = value` or `KEY: value`, single/double/backtick-quoted values,
// unquoted `#` comments stripped, `#` inside quotes preserved.
const LINE_SOURCE =
  "(?:^|^)\\s*(?:export\\s+)?([\\w.-]+)(?:\\s*=\\s*?|:\\s+?)" +
  "(\\s*'(?:\\\\'|[^'])*'|\\s*\"(?:\\\\\"|[^\"])*\"|\\s*`(?:\\\\`|[^`])*`|[^#\\r\\n]+)?" +
  "\\s*(?:#.*)?(?:$|$)";

/**
 * Parse `.dev.vars` text the way the runtime does. Later entries win on
 * duplicate keys (dotenv overwrites). Lines without `=`/`:` are ignored,
 * exactly as dotenv (and therefore wrangler) ignores them.
 *
 * @param {unknown} src
 * @returns {Record<string, string>}
 */
export function parseDevVarsText(src) {
  const line = new RegExp(LINE_SOURCE, "mg");
  const values = {};
  const text = String(src).replace(/\r\n?/mg, "\n");
  let match;
  while ((match = line.exec(text)) !== null) {
    const key = match[1];
    let value = (match[2] || "").trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/mg, "$2");
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    }
    values[key] = value;
  }
  return values;
}

export const LOGIN_KEYS = ["LOGIN_USERNAME", "LOGIN_PASSWORD"];
export const CLIENT_TOKEN_KEYS = ["SHADOW_API_TOKEN", "CUSTOMER_SNAPSHOT_SYNC_SECRET"];
/** Keys that must be present and non-empty in the effective dev vars. */
export const REQUIRED_KEYS = [...LOGIN_KEYS, "SESSION_TTL_SECONDS", "TARGET_ORIGIN", "LOGIN_URL"];
export const AUTH_MODES = ["auto", "http", "browser"];
/** Routeware custom-report query ids, one per snapshot table (TOG-9212, gap O2). */
export const REPORT_QUERY_ID_KEYS = [
  "CUSTOMER_REPORT_QUERY_ID",
  "ADDRESS_REPORT_QUERY_ID",
  "CONTAINER_REPORT_QUERY_ID"
];
/** Date range passed as startDate/endDate to QueryExecuteDownload (TOG-9212, gap O2). */
export const REPORT_QUERY_DATE_KEYS = ["REPORT_QUERY_START_DATE", "REPORT_QUERY_END_DATE"];
/** Optional poll-budget overrides for QueryRequestIsComplete (TOG-9212, gap O2). */
export const REPORT_QUERY_POLL_KEYS = [
  "REPORT_QUERY_POLL_INTERVAL_MS",
  "REPORT_QUERY_POLL_MAX_ATTEMPTS"
];

function asText(value) {
  return (typeof value === "string" ? value : String(value ?? "")).trim();
}

/**
 * Strict `yyyy-MM-dd` calendar-date check (TOG-9212, gap O2).
 *
 * A regex alone accepts `2026-13-99`; the UTC round-trip rejects impossible
 * month/day values (including Feb 29 on non-leap years) without ever echoing
 * the value — callers name the key only.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidReportQueryDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asText(value));
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
  );
}

/**
 * Bare http(s) origin check mirroring `resolveChainedBase` in
 * `src/scheduled.ts` (TOG-9212, gap O2): no path, query, fragment, or
 * userinfo, since the chained runner appends fixed `/api/v1/...` paths.
 * Empty means unset (single-invocation fallback) and is handled by the
 * caller, not here.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidChainedBase(value) {
  const trimmed = asText(value);
  if (!trimmed) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return false;
  }
  // URL.search/hash hide empty delimiters; the cron rejects them before
  // appending sync paths to the original string.
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return false;
  }
  return true;
}

/**
 * Validate the EFFECTIVE dev vars (wrangler.toml `[vars]` defaults overlaid
 * with parsed `.dev.vars`; see `mergeEffectiveVars`). Returns
 * `{ ok, errors }` where every error names a key, never a value.
 *
 * @param {Record<string, unknown>} [values]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkDevVarsValues(values) {
  const errors = [];
  const src = values ?? {};

  for (const key of REQUIRED_KEYS) {
    if (!(key in src)) {
      errors.push(`Missing required key in effective dev vars: ${key} (set it in .dev.vars).`);
    } else if (!asText(src[key])) {
      errors.push(
        `Empty value for required key: ${key} (wrangler strips quotes and trailing comments, so a quoted-empty or comment-only value arrives empty).`
      );
    }
  }

  const ttlRaw = asText(src.SESSION_TTL_SECONDS);
  if (ttlRaw) {
    const ttl = Number(ttlRaw);
    if (!Number.isFinite(ttl) || ttl <= 0) {
      errors.push(
        "SESSION_TTL_SECONDS must be a positive number of seconds (mirrors sessionExpiryMs in src/lib/sessionState.ts; check for quotes or a trailing comment)."
      );
    }
  }

  for (const key of ["TARGET_ORIGIN", "LOGIN_URL"]) {
    const raw = asText(src[key]);
    if (!raw) {
      continue;
    }
    try {
      new URL(raw);
    } catch {
      errors.push(`${key} is not a parseable absolute URL (check for quotes or a trailing comment in .dev.vars).`);
    }
  }

  const modeRaw = asText(src.AUTH_MODE);
  if (modeRaw && !AUTH_MODES.includes(modeRaw.toLowerCase())) {
    errors.push(
      `AUTH_MODE must be one of ${AUTH_MODES.join("/")} (an unknown mode silently falls back to browser login; check for quotes or a typo).`
    );
  }

  // Report query ids (TOG-9212, gap O2): optional per table (the
  // `*_REPORT_EXPORT_PATH` alternative covers an unset id), but a set id is
  // passed verbatim as `queryID` to QueryExecuteDownload — a non-numeric typo
  // only surfaces as a failed sync. Findings name keys only, never values.
  for (const key of REPORT_QUERY_ID_KEYS) {
    if (!(key in src)) {
      continue;
    }
    const raw = asText(src[key]);
    if (!raw) {
      continue;
    }
    if (!/^\d+$/.test(raw)) {
      errors.push(
        `${key} must be a numeric Routeware query id (it is passed verbatim as queryID to QueryExecuteDownload; check for quotes, a trailing comment, or a typo in .dev.vars).`
      );
    }
  }

  // Report query dates (TOG-9212, gap O2): absent/empty falls back to the
  // `1900-01-01` placeholder at runtime, but a malformed non-empty value is
  // passed verbatim as startDate/endDate to QueryExecuteDownload and only
  // surfaces as a wrong or failed sync.
  const dateValues = {};
  for (const key of REPORT_QUERY_DATE_KEYS) {
    if (!(key in src)) {
      continue;
    }
    const raw = asText(src[key]);
    if (!raw) {
      continue;
    }
    if (!isValidReportQueryDate(raw)) {
      errors.push(
        `${key} must be a real calendar date in yyyy-MM-dd form (it is passed verbatim as startDate/endDate to QueryExecuteDownload; check for quotes, a trailing comment, or a typo in .dev.vars).`
      );
    } else {
      dateValues[key] = raw;
    }
  }
  if (
    dateValues.REPORT_QUERY_START_DATE &&
    dateValues.REPORT_QUERY_END_DATE &&
    dateValues.REPORT_QUERY_START_DATE > dateValues.REPORT_QUERY_END_DATE
  ) {
    errors.push(
      "REPORT_QUERY_START_DATE must not be after REPORT_QUERY_END_DATE (the range is passed verbatim as startDate/endDate to QueryExecuteDownload)."
    );
  }

  // Poll-budget overrides (TOG-9212, gap O2): absent/empty keeps the compiled
  // defaults (2.5s cadence, 24 attempts); a set value must be a positive
  // number, mirroring readPositivePollValue in src/lib/routewareQueryReportCsv.ts.
  for (const key of REPORT_QUERY_POLL_KEYS) {
    if (!(key in src)) {
      continue;
    }
    const raw = asText(src[key]);
    if (!raw) {
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(
        `${key} must be a positive number when set (absent keeps the compiled poll default; check for quotes or a trailing comment in .dev.vars).`
      );
    }
  }

  // Chained-sync base (TOG-9212, gap O2): empty means unset (the cron falls
  // back to single-invocation, loudly warning at runtime), but a malformed
  // non-empty value silently degrades to the same fallback — fail fast here
  // instead. Shape mirrors resolveChainedBase in src/scheduled.ts: a bare
  // http(s) origin with no path, query, fragment, or userinfo.
  if ("SHADOW_API_PUBLIC_BASE" in src) {
    const raw = asText(src.SHADOW_API_PUBLIC_BASE);
    if (raw && !isValidChainedBase(raw)) {
      errors.push(
        "SHADOW_API_PUBLIC_BASE must be a bare http(s) origin with no path, query, fragment, or userinfo when set (the chained runner appends fixed /api/v1/... paths; empty keeps the single-invocation fallback)."
      );
    }
  }

  if (!CLIENT_TOKEN_KEYS.some((k) => asText(src[k]))) {
    errors.push(
      `Missing client auth token: set a non-empty value for one of ${CLIENT_TOKEN_KEYS.join(
        " or "
      )} (used as the /api/v1/* bearer).`
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Extract scalar `KEY = value` entries from the top-level `[vars]` section
 * of wrangler.toml text. Only the exact `[vars]` header counts
 * (`[env.*.vars]` sections are env-scoped and do not apply to plain
 * `wrangler dev`). Supports double-quoted (with \\, \", \n, \r, \t),
 * single-quoted literal, and bare (number/boolean) values.
 *
 * @param {unknown} tomlText
 * @returns {Record<string, string>}
 */
export function parseWranglerVarsSection(tomlText) {
  const vars = {};
  let inVars = false;
  for (const rawLine of String(tomlText).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const section = /^\[(.+)\]\s*$/.exec(line);
    if (section) {
      inVars = section[1].trim() === "vars";
      continue;
    }
    if (!inVars) {
      continue;
    }
    const kv = /^([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!kv) {
      continue;
    }
    const [, key, raw] = kv;
    // TOML `#` starts a comment outside strings: a quoted value may carry a
    // trailing comment, and a bare value may too (`1800 # seconds`). A `#`
    // without preceding whitespace is kept (e.g. a URL fragment).
    if (raw.startsWith('"')) {
      const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
      if (!quoted) {
        continue;
      }
      vars[key] = quoted[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (raw.startsWith("'")) {
      const quoted = /^'([^']*)'/.exec(raw);
      if (!quoted) {
        continue;
      }
      vars[key] = quoted[1];
    } else {
      vars[key] = raw.replace(/\s+#.*$/, "").trim();
    }
  }
  return vars;
}

/** Overlay parsed `.dev.vars` on wrangler `[vars]` defaults (dev wins).
 *
 * @param {Record<string, string>} [wranglerVars]
 * @param {Record<string, string>} [devVars]
 * @returns {Record<string, string>}
 */
export function mergeEffectiveVars(wranglerVars, devVars) {
  return { ...(wranglerVars ?? {}), ...(devVars ?? {}) };
}
