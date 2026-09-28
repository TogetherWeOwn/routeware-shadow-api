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

## Upstream timeouts (`bad-gateway`, title "Upstream timed out")

Every Routeware fetch runs under a bounded per-attempt budget: 15s for
interactive forwards (API passthrough, anti-forgery modals, login), 60s for
report-CSV downloads. A hung upstream host answers as 502 problem+json, never
a 500 and never a hang to the 300s CPU limit. The single retry is reserved for
the login redirect (provably safe); a timeout is never retried, so worst case
is 2x one attempt. Override per deploy with the optional `UPSTREAM_TIMEOUT_MS`
/ `UPSTREAM_REPORT_TIMEOUT_MS` bindings (absent/invalid falls back to the
defaults).

## Session refresh timeouts (`bad-gateway`, title "Session refresh timed out")

Only one login runs at a time per `AuthSession` instance (the refresh lock).
A request that arrives while another request is refreshing waits up to 90s
for the fresh session — the waiter budget is derived from the 120s lock TTL
so it covers a worst-case ~47s browser login (TOG-6527); if the holder never
publishes (hung login), the waiter
answers as 502 problem+json — never by forwarding with the expired cookie,
which would surface upstream login HTML as a 200.
