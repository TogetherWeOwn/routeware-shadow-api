# TOG-8368 — CORS + security-headers audit (`/api/v1/*`, `/openapi.json`, `/docs`)

Auditor: Security Engineer · 2026-09-28 · code at `src/lib/cors.ts`, `src/app.ts`.

## Recorded policy (after this slice)

- **Allowed origins:** reflective — the request `Origin` is echoed verbatim as
  `Access-Control-Allow-Origin` with `Vary: Origin`; `*` when no `Origin` is
  sent (non-browser clients). There is deliberately **no origin allowlist**:
  clients authenticate with a bearer token, never cookies, and
  `Access-Control-Allow-Credentials` is never set, so there is no ambient
  authority for a foreign origin to steal. `Vary: Origin` keeps shared caches
  correct.
- **Allowed methods (preflight):** `GET, POST, DELETE, OPTIONS` (the only
  methods the route modules use, plus `OPTIONS` for preflight itself).
- **Allowed request headers (preflight):** allowlist
  `authorization, content-type, if-none-match` (case-insensitive, deduped);
  anything else the browser asks for is dropped. Falls back to
  `Authorization, Content-Type` when nothing allowlisted is requested.
  `Authorization` = bearer gate, `Content-Type` = POST bodies,
  `If-None-Match` = conditional GETs against the data-entity ETag cache.
- **Exposed headers:** `ETag, Retry-After, Content-Disposition` (conditional
  reads, auth-throttle 429 backoff, CSV-download filename).
- **Preflight:** `OPTIONS /api/v1/*` answered `204` before the bearer gate
  (preflight carries no `Authorization` by design and reveals only the CORS
  policy, never data); `Access-Control-Max-Age: 86400`.
- **Hardening headers on every response** (`/api/v1/*` incl. 401/404/429/5xx,
  `/openapi.json`, `/docs` HTML, and the docs-disabled 404s):
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.
- **Docs fail-closed:** `OPENAPI_DOCS_ENABLED` defaults to `"false"` in
  deployed envs; `/openapi.json` and `/docs` return 404 unless explicitly
  enabled (pinned by `test/openapiDocsGate.test.ts`).

## Findings

1. **Fixed — over-permissive `Access-Control-Allow-Headers` reflection.**
   `corsPreflightResponse` echoed the browser's
   `Access-Control-Request-Headers` verbatim, granting any requested header
   (e.g. `X-Custom-Evil`). Now `resolveAllowedRequestHeaders()` intersects the
   request with the allowlist above. Severity: low (headers alone grant no
   data; the bearer gate still applies), but it widened the preflight grant
   beyond what any handler reads.
2. **Fixed — `/openapi.json` and `/docs` carried no hardening headers.**
   The API middleware chain stamps only `/api/v1/*`; the spec, the Scalar HTML
   and the docs-disabled 404s went out bare. Now wrapped with
   `withSecurityHeaders()`. Severity: low (no credentialed content involved),
   closed for completeness.
3. **Accepted — reflective `Access-Control-Allow-Origin` retained.**
   Equivalent to `*` under the no-credentials model, with correct `Vary`
   semantics. No change; switching to a fixed allowlist would add config
   without reducing risk while auth stays bearer-only.
4. **Accepted — no `Content-Security-Policy` on `/docs`.**
   Scalar renders inline scripts that a strict CSP would break without
   nonce/hash plumbing; out of scope for this slice. Upstream `Set-Cookie`
   stripping (`src/lib/upstreamForward.ts`) and the no-cookie client model are
   unchanged and unaffected.
5. **Accepted — no `Strict-Transport-Security` header from the Worker.**
   TLS is terminated at the Cloudflare edge, which owns HSTS; emitting it from
   the Worker would double-assert a transport property the app does not
   control.

## Regression tests pinning this policy

- `test/cors.test.ts`: preflight strips non-allowlisted headers; `If-None-Match`
  permitted; fallback to the default pair; echo/wildcard ACAO; no
  `Allow-Credentials`; hardening on 200/401/404; no upstream `Set-Cookie` relay.
- `test/openapiDocsGate.test.ts`: hardening headers on the disabled-branch
  404s and on the served spec + UI.
