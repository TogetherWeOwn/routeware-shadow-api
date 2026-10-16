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

## Cache policy (TOG-22087)

Every `/api/v1/*` response flowing through `withCors` (`src/lib/cors.ts`)
leaves with a `Cache-Control` value: the handler's own when it set one,
otherwise `no-store` (stamped by `applyApiCachePolicy` after the handler
runs). Browsers may otherwise keep authenticated PII responses in their
private cache; `no-store` is the fail-closed default.

| Route family | `Cache-Control` sent | Notes |
|---|---|---|
| Snapshot list / by-id (`customer/address/container-snapshot`, incl. `changes`, `sync`, `import`, `DELETE`) | `no-store` | No handler value; stamped by `withCors`. |
| Snapshot CSV exports (`...-snapshot/export`, 200 and `304`) | `no-store` | Export sets `ETag` only; the `304` keeps its empty body. Conditional re-downloads still skip the body via `If-None-Match`. |
| Archived-CSV readback (`GET /api/v1/snapshots/{table}/{date}`, 200 and `304`) | `no-store` | Same shape as exports: `ETag` set, policy stamped. |
| Data-snapshot sync / orphans (`/api/v1/data-snapshot/*`) | `no-store` | No handler value; stamped by `withCors`. |
| Routeware / customer / address / container proxies (success passthroughs) | `no-store` | `forwardPassthrough` replaces any upstream `Cache-Control` value before returning success responses. |
| Data-entity writes (`POST /api/v1/data/*`) | `no-store` | JSON outcome envelope sets no policy; stamped by `withCors`. |
| `GET /api/v1/health` (public) and `GET /api/v1/readiness` (200 and 503) | `no-store` | Stamped on the public path and the authorized path alike. |
| Gate `401` and throttle `429` problem responses | `no-store` | Returned through `withCors` at the gate. |
| `notFound` and `onError` problem responses (`404`/`5xx`, incl. `502`/`503` backstops) | `no-store` | Run outside the `/api/v1/*` chain and wrap with `withCors` directly. |
| Data-entity reads (`GET /api/v1/data/*`, 200 and `304`) | `private, max-age=60` (preserved) | Set by `src/lib/dataEntityHandlers.ts` via `entityDataCacheControlValue()` (decision TOG-6294); the stamp leaves it untouched. |
| Contained upstream errors (`forwardPassthrough`, `4xx`/`5xx`) | `no-store` (preserved) | Set explicitly at containment; the stamp leaves it untouched. |
| `OPTIONS /api/v1/*` preflight (`204`) | none (unchanged) | Carries no body or data — only the CORS grant with its own `Access-Control-Max-Age: 86400`. |
| `/openapi.json` and `/docs` (served spec/UI and docs-disabled `404`s) | none (unchanged) | Use `withSecurityHeaders`, never `withCors`. |

Why data-entity reads differ: they are the one deliberately cacheable family
(TOG-6294). Freshness comes from the `Cache-Control` header stored on each
cached `200` (`private, max-age=60`), not from a `cache.put` TTL; the Workers
Cache API holds the bundle and every successful `POST` evicts the affected
graph (`invalidateCustomerGraph`), so the 60-second TTL only bounds how long
an *unwritten* entry stays warm. Changing that policy is out of scope here —
if PII caching there should change, it is a separate decision.

## Regression tests pinning this policy

- `test/cors.test.ts`: preflight strips non-allowlisted headers; `If-None-Match`
  permitted; fallback to the default pair; echo/wildcard ACAO; no
  `Allow-Credentials`; hardening on 200/401/404; no upstream `Set-Cookie` relay.
- `test/openapiDocsGate.test.ts`: hardening headers on the disabled-branch
  404s and on the served spec + UI.
- `test/cacheControlNoStore.test.ts` (TOG-22087): `no-store` on snapshot list
  200, CSV export 200 (+ empty-body `304`), health 200, `401`, `429` and
  `404`; `private, max-age=60` preserved on a data-entity 200; no
  `Cache-Control` on preflight, `/openapi.json` or `/docs`.
