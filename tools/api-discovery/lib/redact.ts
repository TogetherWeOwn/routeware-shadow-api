const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization"
]);

/** Every header name → value (Fetch `Headers` collapses duplicate names to last value). */
export function fullHeaders(
  headers: Headers | Record<string, string | undefined>
): Record<string, string> {
  const input = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
  const out: Record<string, string> = {};
  input.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

export function redactHeaders(
  headers: Headers | Record<string, string | undefined>
): Record<string, string> {
  const input = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
  const out: Record<string, string> = {};
  input.forEach((value, name) => {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      return;
    }
    out[name] = value;
  });
  return out;
}

export const REDACTED = "__REDACTED__";

/**
 * Field/param names whose *values* are secrets or PII. Header redaction alone
 * leaves these exposed in request bodies (login POST, save forms) and query
 * strings, so they are masked in the harvest too.
 */
const SENSITIVE_VALUE_KEYS = new Set([
  "password",
  "passwd",
  "pwd",
  "username",
  "user",
  "userid",
  "login",
  "token",
  "__requestverificationtoken",
  "apikey",
  "api_key",
  "secret",
  "authorization",
  "access_token",
  "refresh_token"
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_VALUE_KEYS.has(key.toLowerCase());
}

/** Mask sensitive values in an `a=1&b=2` string (urlencoded body or query string). */
export function redactUrlEncoded(raw: string): string {
  if (!raw) {
    return raw;
  }
  return raw
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) {
        return pair;
      }
      const key = pair.slice(0, eq);
      let decoded: string;
      try {
        decoded = decodeURIComponent(key.replace(/\+/g, " "));
      } catch {
        decoded = key;
      }
      return isSensitiveKey(decoded) ? `${key}=${REDACTED}` : pair;
    })
    .join("&");
}

/** Mask string values for sensitive keys in a JSON preview (best-effort, regex-based). */
export function redactJsonPreview(raw: string): string {
  let out = raw;
  for (const key of SENSITIVE_VALUE_KEYS) {
    const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi");
    out = out.replace(re, `$1"${REDACTED}"`);
  }
  return out;
}

/** Mask the value of any `__RequestVerificationToken` hidden input in HTML. */
export function redactHtmlAntiForgery(html: string): string {
  let out = html.replace(
    /(name\s*=\s*["']__RequestVerificationToken["'][^>]*\bvalue\s*=\s*)["'][^"']*["']/gi,
    `$1"${REDACTED}"`
  );
  out = out.replace(
    /(\bvalue\s*=\s*)["'][^"']*["']([^>]*\bname\s*=\s*["']__RequestVerificationToken["'])/gi,
    `$1"${REDACTED}"$2`
  );
  return out;
}

/** Redact secrets in a captured body preview, chosen by content type. */
export function redactBodyPreview(
  contentType: string | null | undefined,
  body: string | undefined
): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    return redactUrlEncoded(body);
  }
  if (ct.includes("json")) {
    return redactJsonPreview(body);
  }
  // HTML or unknown: strip anti-forgery token values (a safe no-op otherwise).
  return redactHtmlAntiForgery(body);
}

/** Redact sensitive params in a parsed query object. */
export function redactQueryObject(
  query: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    out[k] = isSensitiveKey(k) ? REDACTED : v;
  }
  return out;
}

/** Redact sensitive query params in a full URL string (query part only). */
export function redactUrlSearch(urlStr: string | null): string | null {
  if (!urlStr) {
    return urlStr;
  }
  const qIdx = urlStr.indexOf("?");
  if (qIdx === -1) {
    return urlStr;
  }
  const base = urlStr.slice(0, qIdx);
  const hashIdx = urlStr.indexOf("#", qIdx);
  const search = hashIdx === -1 ? urlStr.slice(qIdx + 1) : urlStr.slice(qIdx + 1, hashIdx);
  const hash = hashIdx === -1 ? "" : urlStr.slice(hashIdx);
  return `${base}?${redactUrlEncoded(search)}${hash}`;
}
