# Problem types

Errors from the Routeware Shadow API use [RFC 7807](https://datatracker.ietf.org/doc/html/rfc7807)
`application/problem+json` bodies. Each `type` is a URL that points to the matching
section below.

| Slug (`type` anchor) | HTTP status | Meaning |
|----------------------|-------------|---------|
| `bad-request` | 400 | <a name="bad-request"></a>The request was malformed — a missing/invalid id, an empty body where one is required, disallowed CSV control characters, or a snapshot row with a dangling foreign key (see below). |
| `unauthorized` | 401 | <a name="unauthorized"></a>Missing or invalid `Authorization: Bearer <token>`. See below. |
| `forbidden` | 404 | <a name="forbidden"></a>A feature is disabled by configuration (e.g. OpenAPI docs when `OPENAPI_DOCS_ENABLED` is not `true`). Returned as 404 to avoid advertising the surface. |
| `not-found` | 404 | <a name="not-found"></a>No matching route, or no snapshot row/graph for the requested id. |
| `method-not-allowed` | 405 | <a name="method-not-allowed"></a>The upstream does not support the HTTP method (e.g. customer hard delete). |
| `rate-limited` | 429 | <a name="rate-limited"></a>Too many failed bearer-auth attempts from one IP. See below. |
| `payload-too-large` | 413 | <a name="payload-too-large"></a>A `...-snapshot/import` body exceeds the size limit. See below. |
| `unsupported-media-type` | 415 | <a name="unsupported-media-type"></a>A snapshot import does not declare a supported CSV media type. See below. |
| `conflict` | 409 | <a name="conflict"></a>The snapshot archive changed while a readback was being read. Retry the download. See below. |
| `misconfigured` | 503 | <a name="misconfigured"></a>A required var/secret or report path is not set on the Worker. |
| `bad-gateway` | 502 | <a name="bad-gateway"></a>The Worker could not complete an upstream step (e.g. anti-forgery token preparation). |
| `upstream-error` | 400–599 (upstream status) | A client-facing retry passthrough received an upstream error; its body and headers are withheld. |
| `internal` | 500 | <a name="internal"></a>An unexpected error. Only a fixed summary is logged (`Unhandled request error`) with the error class as `kind`; the exception text and stack are neither logged nor returned. |

## CSV control characters (`bad-request`)

All three snapshot `.../import` routes reject NUL, vertical tab, other C0
controls (U+0000–U+001F except tab/LF/CR), DEL/C1 controls (U+007F–U+009F),
and lone CR inside a cell. Headers, unused columns, and whitespace-only
records are checked before trimming or binding any values to D1. The error
names the logical CSV row without echoing submitted values:

```
CSV row 2 contains a disallowed control character.
See docs/PROBLEMS.md#bad-request.
```

The header is row 1; embedded quoted newlines do not advance the row number.
Empty records are skipped by the stream reader, but whitespace-only and
invalid-ID records count. Tabs and quoted LF/CRLF remain supported. CR-only
record separators remain supported; a lone CR **inside a quoted cell** is
rejected, not silently removed. This is the API's import policy, stricter
for cell CR than [RFC 4180 §2](https://datatracker.ietf.org/doc/html/rfc4180#section-2).
Upstream report syncs and the default shared parser retain their permissive
behavior; import routes explicitly enable control rejection.

Fix the named record (remove forbidden controls or replace cell CR with LF)
and retry. No rejected record is written, and import never reconciles/deletes.
Earlier flushed batches of valid rows may remain; the upload is not atomic.

This policy also applies to the API's own exports and raw R2 report archives:
report-origin controls are retained by sync/export, so those CSVs may not be
HTTP-importable. Do not discover compatibility through a partial restore.
For recovery without control sanitization, use the integrity-verified in-code
report restore in [R2 restore runbook §6](R2-RESTORE-RUNBOOK.md#6-programmatic-restore-in-code-path).
Export → HTTP import is lossless only for import-compatible business cells.

## Dangling snapshot references (`bad-request`)

D1 enforces the snapshot FK chain (`address.customer_id` →
`customer_snapshot`, `container.pickup_address_id` → `address_snapshot`), so a
snapshot `.../import` or `.../sync` whose rows reference missing parents is
rejected with 400, never written as orphans:

```
Dangling reference: address_snapshot.customer_id=999 has no row in
customer_snapshot.customer_id (batch at row offset 0). Import customers first.
```

Only the failing batch is lost — earlier batches in the same upload still
land. Fix: import the parents first (customers, then addresses, then
containers). The `detail` lists up to 20 missing integer keys, then `+N more`
— integer keys only, never PII.

## Blocked customer erasure (`bad-request`)

`DELETE /api/v1/customer-snapshot/{customerId}` hard-deletes one cached
customer row (GDPR-style erasure for the stored extract — upstream Routeware
is untouched; see `method-not-allowed`). Erasure removes the D1
`customer_snapshot` row and evicts the data-entity cache entry. It does not
remove R2 history CSVs, daily aliases, latest pointers, or the
archived-CSV readback, and it does not touch upstream Routeware. The row
returns on the next sync — or on the next save for that customer through
the proxy — while upstream still holds it. Any R2 restore or CSV import of
an archive taken before the erasure re-inserts the row, and D1 Time Travel
can restore it for up to 30 days (7 days on the Workers Free plan), so
re-apply erasures after any restore. The same FK chain
refuses a delete while address rows still reference the customer, mapped to
400 (never an orphan, never a cascade):

```
Cannot delete customer_id=42: 2 address row(s) still reference it
(pickup_address_id=10, 11). Delete the addresses first.
See docs/PROBLEMS.md#bad-request.
```

Fix: remove the listed addresses, then retry. There is no address or
container DELETE route — "delete the addresses first" means either waiting
for the upstream deletion to reconcile (detail-full sync or report-sync
drops the child rows once upstream stops reporting them) or deleting them
directly with privileged `wrangler d1 execute` in container → address →
customer FK order. This route removes only the `customer_snapshot` row: the
customer's `address_snapshot` and `container_snapshot` rows are not removed
by this route. The `detail` names up to 20 blocking integer keys — integer
keys only, never PII.

## Authentication (`unauthorized`)

All `/api/v1/*` endpoints **except** `GET /api/v1/health` require a bearer token:

```
Authorization: Bearer <SHADOW_API_TOKEN>
```

`SHADOW_API_TOKEN` gates general access. When it is unset, the Worker falls back to
`CUSTOMER_SNAPSHOT_SYNC_SECRET`. The privileged snapshot/data routes
(`.../sync`, `.../import`, `.../export`, `/api/v1/data/*`,
`/api/v1/data-snapshot/sync`) additionally require
`CUSTOMER_SNAPSHOT_SYNC_SECRET` specifically.

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
| Privileged (`.../sync`, `.../import`, `.../export`, `/api/v1/data/*`, `/api/v1/data-snapshot/sync` — 16 routes) | 401 inner check | ✓ | 401 outer gate |
| Public (`GET /api/v1/health`) | n/a | n/a | 200, no token |

Pinned by `test/dualSecretMatrix.test.ts` (outer-gate unit matrix + HTTP
route-class matrix) and `test/snapshotAuth.test.ts` (per-route inner 401
bodies).

### Read-only bearer role (TOG-8878)

`SHADOW_API_READ_TOKEN` (optional) grants GET-only access to non-privileged
reads. It passes the outer gate on GET requests only: a GET with the read
token returns 200 on a general route, while any non-GET request with it 401s
at the outer gate, and every privileged route (sync/import, GET exports,
`/api/v1/data/*` reads) 401s at the inner sync-secret check — no privileged
route accepts the read token. Unset or blank means unconfigured: the role
fails closed. Use a distinct random value — if it ever equals the full token
it inherits full access.

```
npx wrangler secret put SHADOW_API_READ_TOKEN
```

Pinned by `test/readOnlyRole.test.ts` (unit matrix + HTTP acceptance pair +
per-privileged-route sweep + fail-closed contract).

Set these as secrets in production — never in `wrangler.toml` `[vars]`:

```
npx wrangler secret put SHADOW_API_TOKEN
npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET
```

## Brute-force throttling (`rate-limited`)

Failed bearer-auth checks on `/api/v1/*` are counted per client IP in the
`AuthSession` Durable Object. The IP comes from `CF-Connecting-IP` (which
Cloudflare overwrites, so clients cannot spoof it); `X-Forwarded-For` is
honored only when `THROTTLE_TRUST_XFF="true"` (dev/test) — production
XFF-only callers share the `"unknown"` bucket, so a client-controlled XFF
value can neither evade the throttle by rotation nor frame a victim's bucket.
After 19 failed checks inside a 60-second window, the 20th check from that IP
returns `429 Too Many Requests` and starts a 60-second block. Further failed
checks while that block is active also return 429 and restart the 60-second
timer, so continued failures keep `Retry-After` at 60 seconds. Each 429 has a
problem+json body, a `Retry-After` header reporting the remaining block
duration (at most 60 seconds), and `X-RateLimit-Limit` (`19`, the failed checks
allowed per window),
`X-RateLimit-Remaining` (`0`), and `X-RateLimit-Reset` (an absolute Unix
timestamp in seconds; for older Durable Objects that omit the expiry, it is a
conservative estimate derived from `Retry-After`). CORS exposes `Retry-After` and
all three `X-RateLimit-*` headers through `Access-Control-Expose-Headers`. The
block is per-IP, not per-token, so rotating candidate tokens does not evade it.

Only failures count: a valid token always passes and resets the IP's counter,
so legitimate traffic is unaffected. The public `GET /api/v1/health` probe and
CORS preflight never touch the throttle.

Throttle storage errors fail open to the pre-throttle 401 behavior — auth
stays enforced, only the counting degrades. Fail-opens log at most one
structured error event per isolate per 60-second window: `msg` is always
`AUTH THROTTLE FAIL-OPEN`, and a separate fixed-category `reason` field names
the failure class (never IP/token/PII). Operator alarm path — log query +
alert-rule proposal, nothing activated:
`docs/AUTH-THROTTLE-FAIL-OPEN-ALARM-RUNBOOK.md`. Pinned by
`test/authThrottleFailOpenAlarm.test.ts` (line fires exactly once per window
on DO failure) alongside the dedup cases in `test/authThrottle.test.ts`
(TOG-6530).

A valid-token reset only clears the requester's own IP bucket (the same
`auth-throttle:<ip>` Durable Object key the failures were counted under), so
it cannot be abused to clear an attacker's budget: a reset requires passing
the bearer check, which an attacker without the token cannot do, and a reset
from one IP never touches another IP's counter. Pinned by
`test/throttleResetIsolation.test.ts`.

Shared-NAT note: clients behind one egress IP share a single 19-failure
budget, so a bad actor — or a misconfigured client retrying a stale token —
behind the same NAT can cause `429` responses for other clients' failed
attempts from that IP. This never blocks legitimate traffic: a request with
the valid token always passes, even while its IP is blocked, and clears the
shared counter. Operator remedy: confirm the affected client is sending the
current token (one good request clears the block immediately); otherwise the
block expires 60 seconds after the last failed check. If `429`s recur from one egress
IP, find the client burning the budget and fix its token, or route operator
traffic through a distinct egress IP.

<a name="upstream-error"></a>

## Loud upstream errors (`upstream-error`)

Client-facing routes using `forwardPassthrough` retain upstream HTTP 400–599,
including 401, 429 and 503, but replace the response with local
`application/problem+json` titled "Upstream request failed" and the fixed detail:
"Routeware returned an error. Its response body has been withheld."
The body is never inspected, buffered or logged; upstream headers (including
`Set-Cookie`, `Location` and debug headers) and status text are not relayed.
A fixed local `Cache-Control: no-store` prevents caching the replacement error,
including heuristically cacheable 404/410 statuses, without copying upstream headers.
This contains possible customer/session material in HTML, JSON, text or binary
error pages on both the first forward and the single post-login retry.

The eleven retry passthroughs are home/index, app-settings-get,
query-request-is-complete, customers-read, detail-full, customer-types-read,
add-new-long, load-long-modal and the customer/address/container save routes.
Successful responses and redirects keep their existing contracts; silent
HTML-200 failure guards remain in place. Loud errors do not trigger another
login or retry. Internal `/api/v1/data/*` save consumers continue to use the raw
retry helper and their own sanitized envelope, preserving byte-count diagnostics.
The sessionless login-page probe is a direct forward, not a retry passthrough,
and is outside this control's scope.

Pinned by `test/passthroughLoudFailure.test.ts`, with synthetic customer, phone
and session markers only. This is an intentional compatibility change: clients
must use the HTTP status and local problem fields, not upstream error text or
headers (including upstream `Retry-After`). Worker-generated timeout and
session-refresh problems retain their existing types and details.

## Upstream timeouts (`bad-gateway`, title "Upstream timed out")

Every Routeware fetch runs under a bounded per-attempt budget
(`src/lib/upstreamTimeout.ts`, TOG-5835). Before the bound existed, a hung
upstream host held the Worker until the 300s CPU limit mid-sync. Now each
fetch races a timer covering time-to-headers only (the `fetch` promise): the
timer is cleared once headers arrive, so a large report CSV that starts
quickly is never cut off mid-stream. Handlers that must buffer a response
use a **separate total body-read deadline**, starting when consumption begins
(`src/lib/upstreamBody.ts`). That deadline uses `UPSTREAM_TIMEOUT_MS` too
(default 15s; invalid/absent uses the default), not the remainder of the
header budget. Each buffered read can therefore spend one header budget plus
one body budget. Completing headers does not make a never-finishing JSON or
modal body successful.

A timeout of the primary forwarded response fails fast to 502 problem+json
with a fixed PII-free detail (no URL, no body). The body deadline aborts the
original fetch and cancels pending reads; passthrough validation cancels both
clone/tee branches on timeout. Cancellation is not awaited, because an
underlying source can itself hang. The forwarding retry wrapper propagates a
timeout without refreshing the session or replaying the request. A timed-out
save response does not begin its local D1 refresh. Its upstream result is
**unknown**: verify the record before deciding whether to submit again.
A caller abort with the header timer unfired rethrows verbatim, never a 502.

Existing caller policies remain unchanged: with `AUTH_MODE=auto`, an HTTP
login timeout can fall back to Browser Rendering in `establishSession` rather
than immediately returning 502 (`AUTH_MODE=http` propagates it). After a
confirmed successful save, a timeout of the separate detail-full refresh is
caught: the routeware tier retains the successful save response, and the data
tier reports `localSync.code="sync_failed"` while retaining save success.
Neither case replays a timed-out save.

Buffered coverage: customer list/detail/type reads, app settings, report
completion control polls, customer/address/container saves at both routeware
and data tiers, detail-full refresh reads, anti-forgery modals, HTTP login HTML
and init scripts, and interactive login-page sniffing. Successful passthrough
validation preserves the original response bytes and headers.

Intentionally untouched: raw report CSV downloads and CSV-to-D1/R2 consumption
(including the archive's whole-CSV buffer) have **no total-body deadline**.
Report-download login sniffing retains its existing unbounded behavior for
nonstandard content types; it explicitly opts out so a legitimate long CSV
served as text/plain is not cut off. The sessionless login-page probe only
forwards a stream and remains header-bounded. Chained same-Worker sync response
reads are not Routeware responses and are outside this fix.

Per-step **header** budgets (single-retry max, so headers cost at most 2x one
attempt; buffered consumers additionally get the body budget described above):

| Step (code) | Header budget / attempt | Worst header time | Retry rule |
|---|---|---|---|
| Interactive forwards (`forwardWithSessionRetry`: API passthrough, modals, saves) | 15s (`DEFAULT_UPSTREAM_TIMEOUT_MS`) | 30s | retried once only for the login redirect / 200-with-login-form; timeouts never retried |
| Sessionless login-page probe (`forwardToUpstream` direct, no retry wrapper) | 15s (default) | 15s | single attempt, no retry |
| HTTP login (`httpAuth.httpLogin`: login-page GET, ext.NET init GET, login POST) | 15s per fetch | 45s for the three fetches | no retry inside; `establishSession` can fall back to Browser Rendering in auto mode |
| Report-CSV downloads (`routewareQueryReportCsv`, `snapshot/reportFetch`) | 60s (`REPORT_UPSTREAM_TIMEOUT_MS`) | 120s | one re-login + retry; timeouts never retried |
| Query-report poll (`pollQueryRequestIsComplete`: 2.5s × 24 attempts ≈ 60s) | ≈60s poll + 60s download | fits in one Worker invocation | poll loop, not a fetch retry |

Per-route wiring map (TOG-8359 audit — every Routeware-backed route/handler to
its budget source; all flow through `fetchWithUpstreamTimeout` via
`forwardToUpstream` or `forwardWithSessionRetry`, never a bare `fetch`):

| Public route(s) | Upstream (WebRW) | Path code | Budget / attempt |
|---|---|---|---|
| GET /api/v1/routeware/account/login-page | LOGIN_URL (fixed) | direct `forwardToUpstream` | 15s interactive (`UPSTREAM_TIMEOUT_MS`) |
| GET /api/v1/routeware/home/index | /Home/Index | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/data/app-settings-get | /Data/appSettingsGet | `forwardWithSessionRetry` | 15s interactive |
| GET /api/v1/routeware/reports/query-request-is-complete | /Reports/QueryRequestIsComplete | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/customer/customers-read | /Customer/CustomersRead | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/customer/detail-full | /Customer/GetCustomerDetailFull | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/customer/customer-types-read | /Customer/CustomerTypesRead | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/customer/save-long-form (+ AddNewLong / LoadLongCustomerModal token GET) | /Customer/SaveCustomerLongForm | `forwardWithSessionRetry` + modal via retry or direct (override-honoring) | 15s interactive |
| GET /api/v1/routeware/customer/add-new-long | /Customer/AddNewLong | `forwardWithSessionRetry` | 15s interactive |
| GET /api/v1/routeware/customer/load-long-modal | /Customer/LoadLongCustomerModal | `forwardWithSessionRetry` | 15s interactive |
| POST /api/v1/routeware/address/save-address-form (+ CreateBlankAddress / LoadAddressModal token GET) | /PickupAddress/SaveAddressForm | `forwardWithSessionRetry` + modal via retry or direct | 15s interactive |
| POST /api/v1/routeware/container/save-container-form (+ CreateBlankContainer / LoadContainerModal token GET) | /Container/SaveContainerForm | `forwardWithSessionRetry` + modal via retry or direct | 15s interactive |
| POST /api/v1/data/customer, /data/address, /data/container | Save forwards + GetCustomerDetailFull D1 refresh | `forwardWithSessionRetry` + `fetchGetCustomerDetailFull` (direct, override-honoring) | 15s interactive |
| POST /api/v1/customer-snapshot/sync, /address-snapshot/sync, /container-snapshot/sync, /data-snapshot/sync | report export path or QueryExecuteDownload (+ QueryRequestIsComplete poll) | `fetchReportCsvForPath` / `fetchReportCsvByQueryId` | 60s report (`UPSTREAM_REPORT_TIMEOUT_MS`) |
| (internal) login: login-page GET, Ext.NET init GET, login POST | LOGIN_URL + ext.axd | `httpAuth.httpLogin` direct `fetchWithUpstreamTimeout` | 15s interactive per fetch |
| (internal, NOT Routeware) chained self-fetch to own public URL | own /api/v1/*-snapshot/sync | `snapshot/orchestration.ts` bare `fetch` | no upstream budget — same-Worker subrequest, excluded |

TOG-8359 fixes: four direct `forwardToUpstream` callers (login-page probe,
`fetchGetCustomerDetailFull`, customer modal direct path, address/container
modal direct path) passed no `timeoutMs`, silently ignoring
`UPSTREAM_TIMEOUT_MS`. They now pass `readUpstreamTimeoutMs(env)`; report paths
already passed the report budget. Pinned by
`test/upstreamTimeoutRoutes.test.ts` (hung upstream → timely
`UpstreamTimeoutError` on each fixed path + source-wiring assertions).

Why timed-out forwards are never retried: the single retry is reserved for the login
redirect (provably safe — `forwardWithSessionRetry` retries only that), while
retrying a timeout could double-execute a non-idempotent POST. Pinned by
`test/upstreamTimeout.test.ts` (hung upstream → exactly one attempt, then 502)
and `docs/TEST-INVARIANTS.md` § `upstreamTimeout.ts`.

Tuning guidance (all overrides are optional per-deploy bindings — no
`wrangler.toml` change; absent/invalid falls back to the defaults):

- `UPSTREAM_TIMEOUT_MS`: raise if 502s cluster on a slow-but-healthy upstream
  whose time-to-headers p99 approaches 15s; lower to fail faster under load.
  Keep worst case (2x) well under the 300s CPU limit.
- `UPSTREAM_REPORT_TIMEOUT_MS`: raise only if report *headers* are slow — the
  streaming body is not counted, so large-but-fast-starting CSVs need no bump.
- `REPORT_QUERY_POLL_INTERVAL_MS` / `REPORT_QUERY_POLL_MAX_ATTEMPTS`: raise
  max attempts for slow async query builds; note the poll and the download
  share one Worker invocation.

## Oversized snapshot import (`payload-too-large`)

`POST /api/v1/{customer,address,container}-snapshot/import` refuses bodies
over `SNAPSHOT_IMPORT_MAX_BYTES` (`src/lib/snapshot/streamSync.ts`) with a
413. A truthful `Content-Length` fails fast before the stream is read; a
missing, non-numeric or understated one falls through to a streaming byte
counter that rejects the same way without buffering the file. The limit
covers operator uploads only — the report `sync` path is uncapped (upstream
export size is the operator's own config) — and a rejected import never
touches D1. Pinned by `test/snapshotImportEdges.test.ts` (TOG-6279).

## Unsupported snapshot import media type (`unsupported-media-type`)

`POST /api/v1/{customer,address,container}-snapshot/import` accepts raw CSV
bytes with `Content-Type: text/csv` or `application/octet-stream` (media types
are case-insensitive; parameters such as `charset=utf-8` are allowed). A request
with a body and any other or missing media type returns 415
`application/problem+json` after snapshot authentication, the size check and the
empty-body check, and before the body is read or D1 is changed. A POST with no
body keeps its 400 empty-body response. The response uses a fixed detail and
does not echo submitted bytes. Pinned by `test/snapshotImportEdges.test.ts`.

## Archive replaced during a readback (`conflict`)

`GET /api/v1/snapshots/{table}/{date}` reads the R2 archive twice: once to
measure the re-encoded body's exact length and ETag, then again to stream it,
conditional on the stored ETag. If a sync replaces that date's object between
the two reads, the route returns 409 `application/problem+json` naming the table
and date and streams nothing. Retry the download; the next attempt measures the
current object. The readback never modifies the stored object.

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

## Query-param allowlist (reports probe)

`GET /api/v1/routeware/reports/query-request-is-complete` forwards only an
explicit allowlist upstream to `GET /WebRW/Reports/QueryRequestIsComplete`:
`requestID` (the one-time report request id the browser generates per
download) and `_` (the SPA's cache-buster timestamp). Any other query param is
silently dropped — never forwarded, never an error — so arbitrary client input
cannot reach Routeware as new query surface. Matching is case-sensitive.
Unknown params therefore need no problem+json `type`: there is no failure to
report.

## Customer delete (`method-not-allowed`)

Routeware WebRW exposes no hard delete for customers, so
`DELETE /api/v1/routeware/customer` always answers `405` with a
`method-not-allowed` problem+json body. This is the one canonical reference
for that limitation: the OpenAPI descriptions in [`src/app.ts`](../src/app.ts)
and [`src/routes/customer.ts`](../src/routes/customer.ts) document the same
disable-via-save pattern.

Retire a customer by disabling it instead — the disable-via-save pattern:

1. `GET /api/v1/routeware/customer/load-long-modal?customerID={id}` loads
   the edit form and the required field set for the customer.
2. `POST /api/v1/routeware/customer/save-long-form` with an
   `application/x-www-form-urlencoded` body, resubmitting the loaded fields
   with `Enabled=false`:

```bash
curl -X POST http://localhost:8787/api/v1/routeware/customer/save-long-form \
  -H "Authorization: Bearer <SHADOW_API_TOKEN>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "CustomerID=42" \
  --data-urlencode "CustomerTypeID=1" \
  --data-urlencode "CompanyName=ExampleCo" \
  --data-urlencode "FirstName=Jane" \
  --data-urlencode "LastName=Doe" \
  --data-urlencode "Enabled=false"
```

Notes:

- The anti-forgery `__RequestVerificationToken` may be omitted — it is
  filled server-side from the Routeware modal HTML (see
  `CUSTOMER_SAVE_AUTO_TOKEN`). Send every other field the loaded record
  requires, not just the five above.
- A failed upstream save surfaces as 502 problem+json, never as a silent
  200. A successful disable also refreshes the customer snapshot/D1 and
  evicts the data-entity cache for the affected id.

Pinned by `test/problemAnchors.test.ts` (the 405 shape) and
`test/routewareSaveStaleCache.test.ts` (the disable flow).

## Session refresh timeouts (`bad-gateway`, title "Session refresh timed out")

Only one login runs at a time per `AuthSession` instance (the refresh lock).
A request that arrives while another request is refreshing waits up to 90s
for the fresh session — the waiter budget is derived from the 120s lock TTL
so it covers a worst-case ~47s browser login (TOG-6527); if the holder never
publishes (hung login), the waiter
answers as 502 problem+json — never by forwarding with the expired cookie,
which would surface upstream login HTML as a 200.

## Blocked login page (`bad-gateway`, title "Upstream login unavailable")

The HTTP login GETs the login page (and the Ext.NET init script) for the
anti-forgery token. When upstream answers either GET with a non-200 — a WAF
block or maintenance page (403/500/…) — the login fails fast as 502
problem+json naming the upstream status, with zero Browser Rendering launches:
a blocked page carries no token because there is no form, so falling back to
the browser would burn Browser Rendering budget misdiagnosed as a markup
change. A genuine 200 page with no token keeps the old behavior (treated as a
markup change, browser fallback in auto mode). The 502 detail carries only the
status number — never URL, body, or PII.

## Missing Set-Cookie capability (`misconfigured`, title "Service Unavailable")

The HTTP login merges upstream `Set-Cookie` via `Headers.getSetCookie`. When
the runtime has no `getSetCookie`, the login fails fast as 503
problem+json with a fixed detail — never an empty jar, never a silent flip to
Browser Rendering (`auto` mode) or a bare login failure (`http` mode): there
are no cookies to fall back from, so a browser retry would burn Browser
Rendering budget on a platform gap, not a markup change. The detail carries
only the fixed capability message — never URL, body, cookie, or PII.
