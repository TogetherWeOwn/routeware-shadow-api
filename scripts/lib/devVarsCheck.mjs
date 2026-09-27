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

function asText(value) {
  return (typeof value === "string" ? value : String(value ?? "")).trim();
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
