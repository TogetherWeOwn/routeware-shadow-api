/**
 * CORS preflight + response headers for `/api/v1/*`.
 *
 * Browser clients calling the API cross-origin were failing before any
 * handler ran: a preflight (`OPTIONS`) carries no `Authorization` header by
 * design, so the bearer gate in `app.ts` answered it 401 and the browser
 * never issued the real request.
 *
 * This module answers preflight unauthenticated (a preflight reveals only
 * the CORS policy, never data) and stamps every other `/api/v1/*` response —
 * including the gate's 401s and 404s, so a browser can surface the real
 * status — with `Access-Control-Allow-Origin` plus hardening headers.
 *
 * Auth model notes:
 * - Clients authenticate with a bearer token, never cookies, so
 *   `Access-Control-Allow-Credentials` is intentionally absent and the
 *   request `Origin` is echoed verbatim (with `Vary: Origin`) rather than
 *   allow-listed. There is no ambient authority to steal.
 * - Upstream `Set-Cookie` containment still lives in
 *   `src/lib/upstreamForward.ts`; nothing here re-introduces it.
 */

const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const DEFAULT_ALLOW_HEADERS = "Authorization, Content-Type, X-Request-Id";
// Allowlist for `Access-Control-Allow-Headers`: the API only
// reads `Authorization` (bearer gate) and `Content-Type` (POST bodies) plus
// `If-None-Match` (conditional GETs on JSON lists, data entities and CSV) and
// `X-Request-Id` (request correlation). Anything
// else the browser asks for is dropped instead of reflected.
const ALLOWED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "if-none-match",
  "x-request-id"
];
const MAX_AGE_SECONDS = "86400";
// One-per-line so parallel header cards merge without conflicts: each new
// exposed field gets its own line.
const EXPOSED_RESPONSE_HEADERS = [
  "ETag",
  "Retry-After",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  "RateLimit",
  "RateLimit-Policy",
  "Content-Disposition",
  "X-Request-Id",
  "X-Build-Version",
  "Link"
];
// Default `Cache-Control` for `/api/v1/*` responses: nothing under
// the bearer gate is public-cacheable, and the authenticated snapshot routes
// return customer PII to browser clients, so an unset policy must fail closed
// to `no-store`. Handlers that set their own value keep it (the data-entity
// `private, max-age=60` reads, contained upstream errors).
export const API_CACHE_CONTROL_NO_STORE = "no-store";

/**
 * Stamp the default API cache policy: set `Cache-Control: no-store` only when
 * the handler left none. Case-insensitive via the `Headers` API, so a
 * handler-set value in any casing is preserved.
 */
export function applyApiCachePolicy(headers: Headers): void {
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", API_CACHE_CONTROL_NO_STORE);
  }
}

/**
 * Resolve the `Access-Control-Allow-Headers` value for a preflight: the
 * intersection of what the browser asked for with the allowlist above.
 * Falls back to the default pair when nothing (allowlisted) was requested.
 */
export function resolveAllowedRequestHeaders(requested: string | null): string {
  const tokens = (requested ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  const seen = new Set<string>();
  const allowed = tokens.filter((h) => {
    const lower = h.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.includes(lower) || seen.has(lower)) {
      return false;
    }
    seen.add(lower);
    return true;
  });
  return allowed.length > 0 ? allowed.join(", ") : DEFAULT_ALLOW_HEADERS;
}

/** Hardening headers stamped on every API, spec and docs response. */
export function applySecurityHeaders(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
}

/** Return `res` with hardening headers applied, preserving status and body. */
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  applySecurityHeaders(headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  });
}

/**
 * 204 response to an `OPTIONS /api/v1/*` preflight. When the request carries
 * no `Origin` (e.g. a curl probe rather than a browser preflight) the
 * wildcard origin is returned; browsers always send `Origin` on preflight,
 * so they get the echo.
 */
export function corsPreflightResponse(req: Request): Response {
  const headers = new Headers();
  applyCorsHeaders(headers, req.headers.get("origin"));
  headers.set("Access-Control-Allow-Methods", ALLOW_METHODS);
  headers.set(
    "Access-Control-Allow-Headers",
    resolveAllowedRequestHeaders(req.headers.get("access-control-request-headers"))
  );
  headers.set("Access-Control-Max-Age", MAX_AGE_SECONDS);
  return new Response(null, { status: 204, headers });
}

/**
 * Stamp CORS + hardening headers onto an existing header set. `origin` is
 * the request's `Origin` header value (or null when absent).
 */
export function applyCorsHeaders(headers: Headers, origin: string | null): void {
  const clean = origin?.trim();
  headers.set("Access-Control-Allow-Origin", clean ? clean : "*");
  appendVary(headers, "Origin");
  // JSON lists, data entities and CSV reads version with ETag; expose it so
  // browser clients can do conditional reads. Retry-After and X-RateLimit-* are exposed so clients
  // can honor the auth-throttle 429 backoff; RateLimit/RateLimit-Policy are
  // the standard equivalents stamped on that same 429 (Retry-After is also on
  // the upstream-timeout backstop 502). Content-Disposition is
  // exposed so a fetch-based CSV download (`GET ...-snapshot/export`) can read
  // the attachment filename. X-Request-Id is exposed so browser clients can
  // correlate retries with server-side logs. Link exposes snapshot list continuations.
  headers.set(
    "Access-Control-Expose-Headers",
    EXPOSED_RESPONSE_HEADERS.join(", ")
  );
  applySecurityHeaders(headers);
}

/**
 * Return `res` with CORS + hardening headers applied, preserving status and
 * body — plus the default API cache policy: `Cache-Control:
 * no-store` when the handler set none. A handler-set value is preserved (the
 * data-entity `private, max-age=60` reads, contained upstream errors).
 * Preflight (`corsPreflightResponse`) is intentionally untouched: it carries
 * no body or data, only the CORS grant with its own `Access-Control-Max-Age`.
 * `/openapi.json` and `/docs` use `withSecurityHeaders` directly, so they are
 * untouched as well.
 */
export function withCors(res: Response, req: Request): Response {
  const headers = new Headers(res.headers);
  applyCorsHeaders(headers, req.headers.get("origin"));
  applyApiCachePolicy(headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  });
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }
  const tokens = existing.split(",").map((t) => t.trim().toLowerCase());
  if (!tokens.includes(value.toLowerCase()) && !tokens.includes("*")) {
    headers.set("Vary", `${existing}, ${value}`);
  }
}
