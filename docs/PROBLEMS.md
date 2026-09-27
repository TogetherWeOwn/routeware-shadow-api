# Problem types

Errors from the Routeware Shadow API use [RFC 7807](https://datatracker.ietf.org/doc/html/rfc7807)
`application/problem+json` bodies. Each `type` is a URL that points to the matching
section below.

| Slug (`type` anchor) | HTTP status | Meaning |
|----------------------|-------------|---------|
| `bad-request` | 400 | The request was malformed — a missing/invalid id, an empty body where one is required, etc. |
| `unauthorized` | 401 | Missing or invalid `Authorization: Bearer <token>`. See below. |
| `forbidden` | 404 | A feature is disabled by configuration (e.g. OpenAPI docs when `OPENAPI_DOCS_ENABLED` is not `true`). Returned as 404 to avoid advertising the surface. |
| `not-found` | 404 | No matching route, or no snapshot row/graph for the requested id. |
| `method-not-allowed` | 405 | The upstream does not support the HTTP method (e.g. customer hard delete). |
| `rate-limited` | 429 | Too many failed bearer-auth attempts from one IP. See below. |
| `misconfigured` | 503 | A required var/secret or report path is not set on the Worker. |
| `bad-gateway` | 502 | The Worker could not complete an upstream step (e.g. anti-forgery token preparation). |
| `internal` | 500 | An unexpected error. Details are logged, not returned. |

## Authentication (`unauthorized`)

All `/api/v1/*` endpoints **except** `GET /api/v1/health` require a bearer token:

```
Authorization: Bearer <SHADOW_API_TOKEN>
```

`SHADOW_API_TOKEN` gates general access. When it is unset, the Worker falls back to
`CUSTOMER_SNAPSHOT_SYNC_SECRET`. The privileged snapshot/data routes
(`.../sync`, `.../import`, `/api/v1/data/*`, `/api/v1/data-snapshot/sync`)
additionally require `CUSTOMER_SNAPSHOT_SYNC_SECRET` specifically.

### Dual-secret matrix (TOG-6298)

General `/api/v1/*` routes pass the outer gate with **either** secret:
`isApiAuthorized` (`src/lib/auth.ts`) accepts the bearer when it matches
`apiAccessToken()` — `SHADOW_API_TOKEN` when set, else the sync secret — **or**
`CUSTOMER_SNAPSHOT_SYNC_SECRET` directly. The second disjunct exists so the
chained `/api/v1/data-snapshot/sync` subrequests, which authenticate with
`Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`
(`src/lib/snapshot/orchestration.ts`), pass the outer gate even when a
distinct `SHADOW_API_TOKEN` is configured.

Outer gate by configured secrets (✓ = route reached, ✗ = 401):

| Secrets configured | `Bearer <API>` | `Bearer <SYNC>` | wrong | none |
|---|---|---|---|---|
| both | ✓ | ✓ | ✗ | ✗ |
| API only | ✓ | ✗ | ✗ | ✗ |
| sync only | ✗ | ✓ | ✗ | ✗ |
| neither | ✗ | ✗ | ✗ | ✗ |

When only one secret is set, the other string is simply unconfigured, so
presenting it 401s. When neither is set the Worker fails closed: every
`/api/v1/*` route except `GET /api/v1/health` 401s.

Privileged routes add the inner check `requireSnapshotAuth`
(`src/routes/shared.ts`), which requires the sync secret specifically —
passing the outer gate with the API token is not enough:

| Route class | `Bearer <API>` | `Bearer <SYNC>` | wrong / none |
|---|---|---|---|
| General (all `/api/v1/routeware/*`, snapshot list reads, `GET /api/v1/shadow/health`) | ✓ | ✓ | 401 outer gate |
| Privileged (`.../sync`, `.../import`, `/api/v1/data/*`, `/api/v1/data-snapshot/sync` — 13 routes) | 401 inner check | ✓ | 401 outer gate |
| Public (`GET /api/v1/health`) | n/a | n/a | 200, no token |

Pinned by `test/dualSecretMatrix.test.ts` (outer-gate unit matrix + HTTP
route-class matrix) and `test/snapshotAuth.test.ts` (per-route inner 401
bodies).

Set these as secrets in production — never in `wrangler.toml` `[vars]`:

```
npx wrangler secret put SHADOW_API_TOKEN
npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET
```

## Brute-force throttling (`rate-limited`)

Failed bearer-auth checks on `/api/v1/*` are counted per client IP (from
`CF-Connecting-IP`, falling back to `X-Forwarded-For`) in the `AuthSession`
Durable Object. After 20 failures inside a 60-second window, further failed
attempts from that IP get `429 Too Many Requests` with a problem+json body and
a `Retry-After` header, for 60 seconds. The block is per-IP, not per-token, so
rotating candidate tokens does not evade it.

Only failures count: a valid token always passes and resets the IP's counter,
so legitimate traffic is unaffected. The public `GET /api/v1/health` probe and
CORS preflight never touch the throttle.

A valid-token reset only clears the requester's own IP bucket (the same
`auth-throttle:<ip>` Durable Object key the failures were counted under), so
it cannot be abused to clear an attacker's budget: a reset requires passing
the bearer check, which an attacker without the token cannot do, and a reset
from one IP never touches another IP's counter. Pinned by
`test/throttleResetIsolation.test.ts`.

Shared-NAT note: clients behind one egress IP share a single 20-failure
budget, so a bad actor — or a misconfigured client retrying a stale token —
behind the same NAT can cause `429` responses for other clients' failed
attempts from that IP. This never blocks legitimate traffic: a request with
the valid token always passes, even while its IP is blocked, and clears the
shared counter. Operator remedy: confirm the affected client is sending the
current token (one good request clears the block immediately); otherwise the
block expires on its own after 60 seconds. If `429`s recur from one egress
IP, find the client burning the budget and fix its token, or route operator
traffic through a distinct egress IP.

## Query-param allowlist (reports probe)

`GET /api/v1/routeware/reports/query-request-is-complete` forwards only an
explicit allowlist upstream to `GET /WebRW/Reports/QueryRequestIsComplete`:
`requestID` (the one-time report request id the browser generates per
download) and `_` (the SPA's cache-buster timestamp). Any other query param is
silently dropped — never forwarded, never an error — so arbitrary client input
cannot reach Routeware as new query surface. Matching is case-sensitive.
Unknown params therefore need no problem+json `type`: there is no failure to
report.

## Query-param allowlist (load-long-modal probe)

`GET /api/v1/routeware/customer/load-long-modal` forwards only `customerID`
upstream to `GET /WebRW/Customer/LoadLongCustomerModal` (same allowlist
pattern as the reports probe above). Unknown params are silently dropped.
Unlike the reports probe, `customerID` is required: a missing, empty, or
non-positive-integer value is a 400 naming the required param, and no upstream
fetch is made.

## Login-page fetch (sessionless probe)

`GET /api/v1/routeware/account/login-page` fetches the fixed `LOGIN_URL` with
no session (`forwardToUpstream(..., null, ...)` in `src/routes/routeware.ts`):
it never calls `readSessionState` or `establishSession`, never reads or writes
the primary `AuthSession` state, sends no `Cookie` upstream, and strips
upstream `Set-Cookie` before responding (`docs/CONVENTIONS.md` § 4), so the
probe can neither leak nor plant the shared Routeware session. Pinned by
`test/loginPageSessionIsolation.test.ts`.

Usage notes:

- The route is bearer-gated like every `/api/v1/*` route except
  `GET /api/v1/health` — it is not a public probe. Unauthenticated calls 401
  at the outer gate and count toward the per-IP `rate-limited` budget above.
- Each authorized call makes exactly one upstream `GET` (no session-retry
  loop), and the client query string is never forwarded — the upstream URL is
  fixed. A valid token clears the caller's own per-IP throttle bucket
  (`auth-throttle:<ip>`), which is separate storage from the primary session
  state this route never touches.
