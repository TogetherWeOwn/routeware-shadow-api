# CORS + security-headers audit (`/api/v1/*`, `/openapi.json`, `/docs`)

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
- **Exposed headers:** `ETag, Retry-After, X-RateLimit-Limit,
  X-RateLimit-Remaining, X-RateLimit-Reset, Content-Disposition` (conditional
  reads, auth-throttle 429 backoff + rate-limit budget, CSV-download filename).
  The `X-RateLimit-*` trio joined in #216; see the 2026-10-21 delta below.
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

## Delta audit 2026-10-21 (R9-08)

Re-verification of the recorded policy against main `aea01c5` (2026-10-19),
covering the window since the 2026-09-28 audit (`2766afb`, #125).

### Method

- **Static route diff:** enumerated every registered `/api/v1/*` method+path
  pair at both ends of the window: 38 → 42 (+4, −0). The additions are
  `GET /api/v1/customer-snapshot/changes` (#178),
  `GET /api/v1/data-snapshot/orphans` (#163),
  `GET /api/v1/snapshots/{table}/{date}` (#176) and
  `DELETE /api/v1/customer-snapshot/{customerId}` (#173). All four mount under
  `/api/v1/*`, so they inherit the bearer gate and the `withCors` wrap from the
  shared middleware — no per-route header code was needed or added.
- **Static code review:** every `src/lib/cors.ts`, `src/app.ts` gate/`onError`,
  `src/lib/upstreamForward.ts` and client-auth change in the window, checked
  for header/CORS effect (verdicts per policy line below).
- **Dynamic probes:** the R9-08 acceptance suite
  (`test/securityHeadersCorsPosture.test.ts`, 58 tests, passing unmodified)
  issues synthetic requests through the app's fetch surface: an unauthenticated
  sweep of all 42 routes, authenticated 200/304 reads, the 400/404/405/415/429/
  500/503 error paths, preflight across four routes, and both docs surfaces
  with the docs gate enabled and disabled. Four direct `errorHandler` probes
  isolate the named `onError` branches (missing-`getSetCookie` 503,
  invalid-`AUTH_MODE` 503, upstream-timeout 502, login-page 502) past the
  `/api/v1/*` middleware wrap, with companion `app.fetch` posture asserts in
  the per-branch suites; the exposed-header pin asserts exact token membership
  after comma-splitting.

### Verdict per policy line

- **Allowed origins (reflective + `Vary: Origin`, no allowlist):** holds.
  Client auth is still bearer-only (`isApiAuthorized`/`isReadAuthorized`, the
  #159 read-only role included); `Set-Cookie` appears only in server-side
  upstream session handling, and `Access-Control-Allow-Credentials` is still
  never emitted. The no-ambient-authority rationale stands — no CISO gate
  needed.
- **Allowed methods (`GET, POST, DELETE, OPTIONS`):** holds. The four new
  routes use `GET`/`DELETE` only, inside the allowlist.
- **Allowed request headers (allowlist + fallback):** holds, byte-identical
  (`resolveAllowedRequestHeaders` untouched since the audit).
- **Exposed headers:** DELTA, recorded. #216 added the `X-RateLimit-*` trio
  next to the 429 `Retry-After`/`X-RateLimit-*` response headers, so browser
  clients can read the throttle budget. The recorded line above now lists the
  full sextet. Additive exposure of operational headers; no credentials or
  customer data newly readable cross-origin — not a weakening.
- **Preflight (unauthenticated 204 + `Max-Age: 86400`):** holds. Still
  answered in middleware before the bearer gate and before routing, so new
  routes are covered without per-route work.
- **Hardening trio on every response:** holds. The two new `onError` branches
  in the window (#189 missing-`getSetCookie` 503, #254 report-dates 503) are
  `withCors`-wrapped like every other branch; the docs-branding wrap (#222)
  stamps hardening after branding.
- **Docs fail-closed:** holds. `OPENAPI_DOCS_ENABLED` still defaults to
  `"false"` in deployed envs (`wrangler.toml`; `"true"` only under
  `[env.test.vars]`); docs surfaces still use `withSecurityHeaders`, never
  `withCors` — no `Access-Control-Allow-Origin`, no `Cache-Control`.
- **Cache policy:** DELTA, recorded. #249 made `no-store` the fail-closed
  default for `/api/v1/*` (`applyApiCachePolicy`) and made the upstream
  forwarders strip `Set-Cookie` and force `no-store` (`secureUpstreamResponse`,
  including the sessionless login-page proxy); the Cache policy section below
  already describes the resulting per-family table. The one deliberate
  exception stands: data-entity reads still send `private, max-age=60` from
  `entityDataCacheControlValue()` (`ENTITY_DATA_CACHE_MAX_AGE_SECONDS`, still
  60). Preflight and docs surfaces still send no `Cache-Control`.
- **Accepted findings 3–5 (reflective origin, no `/docs` CSP, no Worker
  HSTS):** stand. No CSP or HSTS value is emitted from `src/`; Scalar still
  renders the docs UI (finding 4) and TLS still terminates at the edge
  (finding 5).

### Gaps

None in runtime: every new route and error path carries the posture (proven by
the 42-route sweep, the error-path probes, the four direct `onError` branch
probes and the per-branch `app.fetch` asserts). The two test-integrity gaps
the 4/5 review proved with mutants (unasserted `onError` 503/502 branches,
substring-based expose check) are closed by test pins with mutant-red proof —
no runtime change was needed. The only remaining gap was documentary —
the recorded Exposed-headers line still listed the pre-#216 trio — fixed by
updating that line above in this same change. No follow-up card: nothing
larger was found.

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

## Cache policy

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
| Routeware / customer / address / container proxies (success responses) | `no-store` | Client-facing forwarders replace any upstream `Cache-Control` value before returning the response, including the sessionless login-page proxy. |
| Data-entity writes (`POST /api/v1/data/*`) | `no-store` | JSON outcome envelope sets no policy; stamped by `withCors`. |
| `GET /api/v1/health` (public) and `GET /api/v1/readiness` (200 and 503) | `no-store` | Stamped on the public path and the authorized path alike. |
| Gate `401` and throttle `429` problem responses | `no-store` | Returned through `withCors` at the gate. |
| `notFound` and `onError` problem responses (`404`/`5xx`, incl. `502`/`503` backstops) | `no-store` | Run outside the `/api/v1/*` chain and wrap with `withCors` directly. |
| Data-entity reads (`GET /api/v1/data/*`, 200 and `304`) | `private, max-age=60` (preserved) | Set by `src/lib/dataEntityHandlers.ts` via `entityDataCacheControlValue()`; the stamp leaves it untouched. |
| Contained upstream errors (`forwardPassthrough`, `4xx`/`5xx`) | `no-store` (preserved) | Set explicitly at containment; the stamp leaves it untouched. |
| `OPTIONS /api/v1/*` preflight (`204`) | none (unchanged) | Carries no body or data — only the CORS grant with its own `Access-Control-Max-Age: 86400`. |
| `/openapi.json` and `/docs` (served spec/UI and docs-disabled `404`s) | none (unchanged) | Use `withSecurityHeaders`, never `withCors`. |

Why data-entity reads differ: they are the one deliberately cacheable family.
Freshness comes from the `Cache-Control` header stored on each
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
- `test/cacheControlNoStore.test.ts`: `no-store` on snapshot list
  200, CSV export 200 (+ empty-body `304`), health 200, `401`, `429` and
  `404`; `private, max-age=60` preserved on a data-entity 200; no
  `Cache-Control` on preflight, `/openapi.json` or `/docs`.
- `test/securityHeadersCorsPosture.test.ts` (R9-08 acceptance, 54 tests):
  unauthenticated sweep of all 42 `/api/v1/*` routes (401 posture, 200 for
  public health), authenticated 200/304s, 400/404/405/415/429/500/503 paths,
  preflight allowlists + exposed headers, docs surfaces enabled + disabled.
  The swept route count is pinned: a new route without coverage fails.
