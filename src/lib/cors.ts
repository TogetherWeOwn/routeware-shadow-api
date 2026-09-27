/**
 * CORS preflight + response headers for `/api/v1/*` (TOG-5809).
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
const DEFAULT_ALLOW_HEADERS = "Authorization, Content-Type";
const MAX_AGE_SECONDS = "86400";

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
  const requested = req.headers.get("access-control-request-headers")?.trim();
  headers.set(
    "Access-Control-Allow-Headers",
    requested ? requested : DEFAULT_ALLOW_HEADERS
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
  // The data-entity GETs version with ETag; expose it so browser clients can
  // do conditional reads. Retry-After is exposed so browser clients can honor
  // the auth-throttle 429 backoff (TOG-7380) instead of retry-spinning blind.
  headers.set("Access-Control-Expose-Headers", "ETag, Retry-After");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
}

/** Return `res` with CORS + hardening headers applied, preserving status and body. */
export function withCors(res: Response, req: Request): Response {
  const headers = new Headers(res.headers);
  applyCorsHeaders(headers, req.headers.get("origin"));
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
