# Consumer quickstart

Read production Routeware data through the shadow API: authenticate, read
snapshots, write through Routeware, and handle the no-DELETE rule. Every
happy-path command below was validated against local dev (`wrangler dev`,
`http://localhost:8787` — replace the origin with your deployment for normal
use). Keep the deliberate error recipes in step 6 local-only.

Operator setup (secrets, D1 migrations, report sync) is out of scope here:
see [`README.md`](../README.md) and [`CUSTOMER_SNAPSHOT.md`](../CUSTOMER_SNAPSHOT.md).
Error catalog: [`PROBLEMS.md`](./PROBLEMS.md).
Full machine-readable spec: `GET /openapi.json` (interactive UI at `/docs`;
both gated by `OPENAPI_DOCS_ENABLED`).

## 0. Check the service is up (no token needed)

`GET /api/v1/health` is the only public route:

```bash
curl http://localhost:8787/api/v1/health
# {"status":"ok","service":"routeware-shadow-api","version":"1.0.0"} — HTTP 200
```

Anything else means the Worker is not running (`npm run dev`).

## 1. Authenticate: bearer roles

Use the least-privileged configured token supplied by your operator. Every
`/api/v1/*` route except the health check needs one
`Authorization: Bearer <token>` header:

| Token | Unlocks |
|---|---|
| `SHADOW_API_READ_TOKEN` (optional read-only role) | Non-privileged **GET** operations only; never POST reads or privileged GETs |
| `SHADOW_API_TOKEN` (general/full) | Snapshot list/by-id reads, all `/api/v1/routeware/*` forwards, health/readiness probes |
| `CUSTOMER_SNAPSHOT_SYNC_SECRET` (privileged) | Everything above, **plus** sync/import, snapshot exports/erasure, orphan checks, archives and all `/api/v1/data/*` reads/writes |

The general token falls back to `CUSTOMER_SNAPSHOT_SYNC_SECRET` when unset;
the sync secret also passes the outer gate when a distinct general token is
configured. A privileged operation checks that **same bearer** at the inner
gate. Distinct general and read tokens 401 there even on GET. Do not send
multiple credentials or interpret OpenAPI security entries as combined roles.

### Discover operations before choosing a tool

The enabled, mounted `/openapi.json` document is the source of truth. Each
`/api/v1` operation has the following compact discovery projection (example:
`GET /api/v1/customer-snapshot`):

```json
{
  "operationId": "listCustomerSnapshot",
  "x-access": "read",
  "x-effect": "local-read"
}
```

`operationId` is a unique, stable lowerCamelCase identifier, explicitly kept
with the route definition (including existing `health` and
`listCustomerSnapshot`). `x-access` describes authorization, **not effects**:

| `x-access` enum | Required bearer |
|---|---|
| `public` | None; only `GET /api/v1/health` (its `security: []` overrides the global bearer requirement) |
| `read` | Read-only token on GET, general/full token, or sync secret |
| `full` | General/full token or sync secret; includes **POST reads** |
| `sync-secret` | Sync secret only, through both gates; includes privileged GETs |

`x-effect` describes intended application-data effects, **not authority,
idempotency, replay safety or a guarantee of refresh success**:

| `x-effect` enum | Data effect |
|---|---|
| `none` | Liveness or unsupported-operation response; no application data access |
| `local-read` | D1/R2/config reads only; no upstream data request |
| `upstream-read` | Routeware read, including POST reads; may establish/renew the upstream session |
| `local-write` | Local D1 mutation without writing Routeware; imports may also archive to R2 |
| `upstream-read-local-sync` | Routeware report read plus local D1 sync and optional R2 archive |
| `upstream-write-local-refresh` | Routeware write plus best-effort D1/cache refresh, not an atomic guarantee; `/data/*` responses report `localSync`, passthrough saves do not |

For example, `POST /api/v1/routeware/customer/customers-read` is
`full` + `upstream-read`, while `GET /api/v1/data/customer` is
`sync-secret` + `local-read`. Method alone predicts neither access nor
effects. These classes exclude incidental auth-throttle bookkeeping and
session maintenance; `upstream-read` does not promise no side effects in the
upstream application (for example starting a report job).

The document root's `x-agent-metadata: {access, effect}` contains a one-line
legend keyed by these exact enum values. Unknown or missing metadata should
stop tool selection, not default to public/read-only access. No role,
credential, endpoint or execution authority is created by these annotations.

Credential-free check (no running Worker, live tenant or `.dev.vars` needed):

```bash
npm run check:openapi-agent-metadata
```

This validates completeness/uniqueness against the **actual mounted router
and document**, plus classification against hermetic authorization probes.
It is also included by the existing `npm test` / `npm run test:coverage`
Vitest discovery; it does not publish a static spec or generate a client.
`OPENAPI_DOCS_ENABLED` still gates `/openapi.json` and `/docs` unchanged.

```bash
export TOKEN=<paste-either-token>
export SYNC=<paste-CUSTOMER_SNAPSHOT_SYNC_SECRET>

# Wrong or missing token → 401 problem+json, never an empty body:
curl -s http://localhost:8787/api/v1/customer-snapshot?limit=1
# {"type":".../PROBLEMS.md#unauthorized","title":"Unauthorized","status":401,...}
```

Too many bad tokens from one IP trips per-IP throttling (HTTP 429 for 60 s);
a valid token always passes and resets the counter. See
[`PROBLEMS.md`](./PROBLEMS.md#rate-limited).

## 2. First 200: snapshot reads

Snapshots are the daily Routeware CSV reports cached in D1 — the fast path
that never touches upstream. Customer → address → container:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?limit=2"
# HTTP 200 — {"rows":[...],"total":N}

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/address-snapshot?limit=2"

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/container-snapshot?limit=2"
```

List filters: `?q=<company-substring>`, `&enabled=true|false|any`
(default `any`), `&limit=1..500` (default 50), `&offset=`. Address lists
also accept `customerId` / `pickupAddressId`. Every list response includes
`nextCursor` (the last row's primary key, or `null` on the last page); pass it
back as `&cursor=` instead of `offset` to page deep result sets by primary-key
seek — `offset` re-scans everything before it, `cursor` does not:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?limit=500&cursor=50000"
# {"rows":[...],"total":...,"nextCursor":50500} — pass 50500 as the next cursor, or null at the end
```

Single rows:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/customer-snapshot/42
# HTTP 200 row, or 404 {"type":"...#not-found",...} when that id is not in D1
```

Empty `rows` with HTTP 200 means auth works but no snapshot has been synced
yet — ask the operator to run `POST /api/v1/data-snapshot/sync` (or the daily
cron), not a bug in your call.

## 2a. Upstream customer pagination: `skip`/`take` or `start`/`limit`

`POST /api/v1/routeware/customer/customers-read` is an **upstream read**, not
one of the D1 snapshot lists above. Use either bearer token from step 1 and
`Content-Type: application/json`. A successful read also needs a working
Routeware session on the Worker (operator-configured login credentials).

These two requests ask for the same window: skip zero customers, take two.
The Worker maps `skip` → `start` and `take` → `limit` before forwarding:

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"skip":0,"take":2}' \
  http://localhost:8787/api/v1/routeware/customer/customers-read
# Upstream body: {"start":0,"limit":2}
# Typical success: {"success":true,"total":N,"data":[...]}
# HTTP 200

curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"start":0,"limit":2}' \
  http://localhost:8787/api/v1/routeware/customer/customers-read
# Same upstream window; success body comes from Routeware unchanged.
# HTTP 200
```

The response is not the snapshot `{rows,total,nextCursor}` envelope; row
contents and totals depend on upstream data. There is no Worker-generated
cursor or page number. `page`, `filter`, `sort`, and `group` are left untouched.
These examples were checked against a local Worker with a mocked upstream,
not the live tenant.

**Precedence is per key:** an explicit `start` wins over `skip`, and an
explicit `limit` wins over `take`. Valid aliases are removed, so upstream
receives only one spelling of each window component:

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"skip":200,"take":100,"start":0,"limit":2}' \
  http://localhost:8787/api/v1/routeware/customer/customers-read
# Upstream body: {"start":0,"limit":2}, not the 200/100 window.
# HTTP 200 on a successful upstream read.
```

Aliases must be JSON numbers that are nonnegative integers; `take: 0` maps
faithfully to `limit: 0`. If either present alias is invalid (e.g. `"take":"2"`,
`"skip":-1`, or `"take":1.5`), **no translation happens**: the entire original
body is forwarded unchanged. Non-object or non-JSON bodies also pass through.
This mapper is not a validator: invalid pagination does **not** guarantee a
local 400. An upstream 400 keeps its status; do not rely on its original
error body. An HTML error page — or a JSON body with `success: false` — on
an upstream HTTP 200 instead becomes a 502 `bad-gateway` problem.

For a guaranteed **local 400** example, use the neighboring read route with
an invalid `customerID`. This rejects before any upstream call, independently
of the pagination rules:

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/routeware/customer/load-long-modal?customerID=abc"
# application/problem+json:
# {"type":".../PROBLEMS.md#bad-request","title":"Bad Request","status":400,
#  "detail":"Query `customerID` is required and must be a positive integer. See docs/PROBLEMS.md#bad-request.",
#  "instance":"/api/v1/routeware/customer/load-long-modal"}
# HTTP 400
```

## 3. Nested reads: `/api/v1/data/*` (sync secret only)

One call returns the customer + addresses + containers graph from D1, with
`ETag` / `If-None-Match` caching (revalidates return `304`):

```bash
curl -i -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/customer?id=42"
# HTTP 200 + ETag header; repeat with -H "If-None-Match: <etag>" → 304

curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/address?id=10"    # by pickup_address_id

curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/container?id=100" # by container_id
```

Unknown ids return 404 `not-found` ("import/sync first"). Passing the general
token here returns 401 even though it works for step 2 — that is the inner
privileged gate, not a bad token.

## 4. Saves: write through Routeware, then D1 refreshes

Saves go **through** Routeware upstream (they need a live Routeware session
on the Worker) and then refresh the local D1 snapshot. Bodies are
`application/x-www-form-urlencoded`; omit `__RequestVerificationToken` —
the Worker injects it server-side from the Routeware modal HTML.

```bash
# Create customer (CustomerID=0); update by setting CustomerID=<id>
curl -X POST http://localhost:8787/api/v1/data/customer \
  -H "Authorization: Bearer $SYNC" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "CustomerID=0" \
  --data-urlencode "CustomerTypeID=1" \
  --data-urlencode "CompanyName=ExampleCo" \
  --data-urlencode "FirstName=Jane" \
  --data-urlencode "LastName=Doe" \
  --data-urlencode "Enabled=true"
```

Success response contract (ids + outcome only — submitted fields and the
upstream body are never echoed):

```json
{
  "ok": true,
  "routewareStatus": 200,
  "customerId": 42,
  "upstreamBytes": 1234,
  "localSync": { "done": true, "customerId": 42, "addressIds": [], "containerIds": [] }
}
```

Address/container saves work the same way (`PickupAddressID=0` + `CustomerID`
for a new address; `ContainerID=0` + `PickupAddressID` for a new container).
On the `/api/v1/routeware/*` passthrough save routes, a silent Routeware-side
failure surfaces as `502` problem+json (Routeware reports failed saves as an
HTML page with HTTP 200 — the Worker converts that, never passes it through
as success); an explicit Routeware 4xx/5xx instead keeps its own status under
the `upstream-error` problem type. On the `/api/v1/data/*` saves above, the same silent upstream
failure instead returns **HTTP 200 with `"ok": false`** (plus the upstream
`routewareStatus` and `upstreamBytes`) — check the `ok` field, not just the
status code. Anti-forgery preparation failures return `502` problem+json,
but a forwarded failure can also return `502` with the ordinary `ok:false`
save envelope. See the [502 recipe](#502-and-other-upstream-failures-distinguish-them-from-client-authentication).

## 5. There is no DELETE: disable instead (HTTP 405)

Routeware WebRW exposes no hard delete, so the API documents that instead of
guessing:

```bash
curl -X DELETE http://localhost:8787/api/v1/routeware/customer \
  -H "Authorization: Bearer $TOKEN"
# HTTP 405 {"type":"...#method-not-allowed","title":"Customer delete not supported",...}
```

Retire a customer by disabling it — resubmit the loaded record with
`Enabled=false`:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/routeware/customer/load-long-modal?customerID=42"
# returns the edit form + required field set; then:

curl -X POST http://localhost:8787/api/v1/routeware/customer/save-long-form \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "CustomerID=42" \
  --data-urlencode "CustomerTypeID=1" \
  --data-urlencode "CompanyName=ExampleCo" \
  --data-urlencode "FirstName=Jane" \
  --data-urlencode "LastName=Doe" \
  --data-urlencode "Enabled=false"
```

## 6. Error-path recipes: 401, 429, 502

**Local-only drills:** the commands in this section must not be pointed at
production or shared staging. Repeated invalid bearer requests can trigger
per-IP authentication throttling. Reproduce upstream errors with the mocked
tests below, not real tenant writes. Do not share tokens, cookies, raw upstream
HTML, or customer data when reporting a failure.

Use `curl -sS -i` to see the HTTP status, headers, and error body together;
`curl` normally exits successfully even for HTTP 401/429/502. The JSON below
is representative: `type` uses the default problem catalog URL, but an
operator can override its base with `PROBLEM_TYPE_BASE`. Match the status and
anchor, not the hostname. See [`PROBLEMS.md`](./PROBLEMS.md).

**Branch on the `type` anchor, not only the status.** A 401 or 429 does not
always come from this Worker's own gate:

| `type` anchor | Source | Next step |
|---|---|---|
| `#unauthorized`, `#rate-limited` | The shadow-API bearer gate or auth throttle | The 401 and 429 recipes below |
| `#upstream-error` | Routeware's own HTTP 400–599, **including 401 and 429**, on a `/api/v1/routeware/*` passthrough route | [Upstream errors keep their status](#upstream-errors-keep-their-status) |
| `#bad-gateway` | An HTML error page behind an upstream HTTP 200, or an upstream timeout | The 502 recipe below |
| No `type`: JSON with `"ok":false` and `routewareStatus` | An ordinary `/api/v1/data/*` save envelope, which can carry Routeware's own status (including 401 or 429) | The `/data/*` row in [Troubleshooting](#troubleshooting) |

### 401: fix the bearer or use the correct gate

With the local Worker running, omit the bearer on a D1-only read:

```bash
curl -sS -i "http://localhost:8787/api/v1/customer-snapshot?limit=1"
# HTTP 401; Content-Type: application/problem+json
```

Expected body (unless this IP is already throttled):

```json
{
  "type": "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.",
  "instance": "/api/v1/customer-snapshot"
}
```

`instance` contains the path, not `?limit=1`. The privileged gate uses the
same envelope but names `<CUSTOMER_SNAPSHOT_SYNC_SECRET>` in `detail`.

**Fix:** retry the same read with the general token already loaded in step 1:

```bash
curl -sS -i -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?limit=1"
# HTTP 200 once the local D1 migrations are applied; empty rows are OK.
```

If the same token works for that read but returns 401 on `/api/v1/data/*`,
use the privileged `$SYNC` value instead:

```bash
curl -sS -i -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/customer?id=42"
# HTTP 200 for a seeded id, or 404 not-found (auth passed, id is absent).
```

Do not repeatedly guess tokens or automatically escalate every read to the
sync secret. If the correct value still 401s, ask the operator to check the
server-side token configuration; local `.dev.vars` changes need a Worker
restart. This applies only when `type` ends in `#unauthorized`; a 401 ending
in `#upstream-error` is Routeware's response, so changing the bearer will not
help ([see below](#upstream-errors-keep-their-status)). Catalog:
[`unauthorized`](./PROBLEMS.md#unauthorized).

### 429: stop invalid-auth retries

The 20th failed outer-gate check in a fresh 60-second window returns 429.
This bounded **local-only** drill first uses a valid token to attempt a reset
of a synthetic IP bucket, then makes exactly 20 unauthenticated GETs. The
probe must return 200 before proceeding, but 200 proves authentication, not
that storage accepted the reset. The expected threshold assumes a fresh
bucket and healthy throttle storage. `/shadow/health` does not touch upstream.
`CF-Connecting-IP` below selects the local test bucket; Cloudflare supplies
that header on deployed requests. Do not spoof it on a deployed origin or
change the throttle configuration for this drill.

```bash
(
  set -e
  curl -fsS --max-time 2 -o /dev/null -H "Authorization: Bearer $TOKEN" \
    -H "CF-Connecting-IP: 192.0.2.21" \
    "http://localhost:8787/api/v1/shadow/health"
  for attempt in {1..19}; do
    curl -sS --max-time 2 -o /dev/null -H "CF-Connecting-IP: 192.0.2.21" \
      "http://localhost:8787/api/v1/shadow/health"
  done
  curl -sS --max-time 2 -i -H "CF-Connecting-IP: 192.0.2.21" \
    "http://localhost:8787/api/v1/shadow/health"
)
# First 19 failed checks: HTTP 401. Final check: HTTP 429.
# Content-Type: application/problem+json; Retry-After: 60
# X-RateLimit-Limit: 19; X-RateLimit-Remaining: 0
# X-RateLimit-Reset: <absolute Unix time in seconds when the block expires>
```

```json
{
  "type": "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#rate-limited",
  "title": "Too Many Requests",
  "status": 429,
  "detail": "Too many failed authentication attempts. Wait and retry. See docs/PROBLEMS.md#rate-limited.",
  "instance": "/api/v1/shadow/health"
}
```

`Retry-After` is a positive integer number of seconds (up to 60 here), not
an HTTP date. The same 429 also carries three `X-RateLimit-*` headers:

- `X-RateLimit-Limit: 19` — the failed auth checks allowed per IP in the
  60-second window; the next (20th) failed check is the first 429.
- `X-RateLimit-Remaining: 0` — no failed checks remain while blocked. It is
  always `0` on this 429; the headers appear only on the 429, not on the
  preceding 401s, so there is no countdown to poll.
- `X-RateLimit-Reset` — the moment the block expires as an absolute Unix
  time in **seconds** (not milliseconds and not a relative delay). It is
  the same expiry `Retry-After` counts down to, in absolute form; prefer
  `Retry-After` for the wait itself, since it needs no clock agreement
  with the server.

CORS exposes `Retry-After` and all three `X-RateLimit-*` headers, so
browser clients can read them cross-origin. **Fix:** stop the invalid-auth
loop and honor the returned delay before another unauthenticated attempt;
repeated failures can renew the
block. If you already have a valid token, it passes the outer gate immediately
and attempts to clear the bucket; a 200 does not confirm the reset:

```bash
curl -sS -i -H "Authorization: Bearer $TOKEN" \
  -H "CF-Connecting-IP: 192.0.2.21" \
  "http://localhost:8787/api/v1/shadow/health"
# HTTP 200, not 429. A later privileged gate can still reject this token.
```

If 429 arrives early, the bucket may not have reset or other local requests
may share it. If the drill remains at 401, counting may have failed open;
authentication still fails closed. Do not disable the gate to make the
example pass. The mocked threshold/recovery tests are the deterministic
alternative:

```bash
npm test -- test/authThrottle.test.ts
```

This recipe applies only when `type` ends in `#rate-limited`; a 429 ending in
`#upstream-error` carries no `Retry-After` and no `X-RateLimit-*` headers
([see below](#upstream-errors-keep-their-status)). Catalog:
[`rate-limited`](./PROBLEMS.md#rate-limited).

### 502 and other upstream failures: distinguish them from client authentication

An upstream HTTP 200 can still contain an HTML error page. For example,
`GET /api/v1/routeware/reports/query-request-is-complete?requestID=abc-123`
returns the following **only when upstream answers with that failure**, not
because `abc-123` is a magic error trigger:

```json
{
  "type": "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-gateway",
  "title": "Bad Gateway",
  "status": 502,
  "detail": "Upstream read failed: Routeware answered QueryRequestIsComplete with HTTP 200 but the body looks like an HTML error page (silent failure). The poll did not succeed. See docs/PROBLEMS.md#bad-gateway.",
  "instance": "/api/v1/routeware/reports/query-request-is-complete"
}
```

The Worker returns HTTP 502 with `Content-Type: application/problem+json`
and no `Retry-After` for this case. **Copy-paste reproduction:** the existing
fixture supplies fake session state and HTML, so it never calls the tenant:

```bash
npm test -- test/readRoutesSilentFailure.test.ts \
  -t "surfaces an upstream query-request-is-complete HTML-200 error page as 502 problem\+json"
# 1 matching test passes by asserting HTTP 502, not by returning 200.
```

Do not run an upstream-backed curl merely to force a 502: even local
`wrangler dev` forwards to Routeware. For timeout behavior, use the mocked
GET fixture instead:

```bash
npm test -- test/upstreamTimeout.test.ts \
  -t "a hung upstream answers 502 problem\+json with exactly one attempt"
```

A timeout uses the same `bad-gateway` type but the title `Upstream timed out`;
the `detail` names the configured timeout budget. **Fix:** for a read timeout,
retry once after a short backoff. If it persists, ask the operator to check
Routeware availability, the session, and the login path. Changing the client
bearer or raising the timeout does not repair an upstream failure. For the
HTML error above, have the operator inspect the upstream session/report
request before retrying; the problem body never includes the raw HTML.

For saves, **do not blindly replay the write**: verify the outcome first.
The `/routeware/*` silent-save failures described in step 4 use 502
`bad-gateway` problem+json, an explicit Routeware 4xx/5xx on those routes keeps
its own status as [`upstream-error`](#upstream-errors-keep-their-status), and
`/data/*` saves can return ordinary JSON with `ok:false` (and a 200 or
upstream error status). Anti-forgery preparation failures use problem+json
separately. Check both HTTP status and the save envelope; not every `/data/*`
502 is an anti-forgery failure. Catalog:
[`bad-gateway`](./PROBLEMS.md#bad-gateway).

### Upstream errors keep their status

When Routeware itself answers a `/api/v1/routeware/*` passthrough route with
HTTP 400–599, the Worker keeps that status (it can be 401, 429, 503 or any
other, not only 502) but replaces the response with a fixed problem body and
`Cache-Control: no-store`. The upstream body and headers are withheld, so
there is **no `Retry-After`** and no upstream error text. Representative
body for an upstream 429:

```json
{
  "type": "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#upstream-error",
  "title": "Upstream request failed",
  "status": 429,
  "detail": "Routeware returned an error. Its response body has been withheld."
}
```

**Fix:** the request already passed this Worker's bearer gate, so do not
change or rotate the bearer, and do not wait for a `Retry-After` header that
will not arrive. Do not loop on retries. For a save, verify the record before
resubmitting (see above), then ask the operator to check Routeware
availability, the session, and the login path. The mocked fixture below
reproduces this without calling the tenant:

```bash
npm test -- test/passthroughLoudFailure.test.ts \
  -t "preserves HTTP 429, not its body"
# 1 matching test passes by asserting HTTP 429 is kept with the upstream-error body.
```

Catalog: [`upstream-error`](./PROBLEMS.md#upstream-error).

## Troubleshooting

| Symptom | Meaning |
|---|---|
| 401 on everything except `/health`, `type` ends `#unauthorized` | Missing/wrong bearer, or no token configured server-side (fails closed). General token on a privileged route also 401s — use the sync secret only for that gate. See [401 recipe](#401-fix-the-bearer-or-use-the-correct-gate). |
| 429, `type` ends `#rate-limited` | Too many failed auth attempts from your IP; stop the bad requests and honor `Retry-After`. See [429 recipe](#429-stop-invalid-auth-retries). |
| 401, 429 or any 400–599 on a `/routeware/*` route, `type` ends `#upstream-error` | Routeware's own error, relayed with its status. Your bearer was accepted; do not change it, and there is no `Retry-After`. For a save, verify the record before resubmitting, then ask the operator. See [upstream errors](#upstream-errors-keep-their-status). |
| 200 with `"rows":[]` | Auth works; D1 has no snapshot data yet (operator runs the sync). |
| 404 `not-found` on `/data/*` | That id is not in D1. |
| 502 `bad-gateway` on a `/routeware/*` save | Routeware rejected the save with an HTTP 200 HTML error page, the upstream timed out, or anti-forgery preparation failed; see the problem+json `detail`. After a timeout the save may have completed, so verify the record before resubmitting. An explicit Routeware 4xx/5xx keeps its own status under `#upstream-error` (row above). |
| `"ok":false` on a `/data/*` save (HTTP 200 or Routeware's status, no `type`) | Same upstream rejection, different envelope — check `routewareStatus` / `upstreamBytes`. If `routewareStatus` is 401 or 429 it is Routeware's own error: do not change the bearer, there is no `Retry-After`, verify the record before resubmitting, then ask the operator. For any other status, also verify the record before resubmitting, fix the form if that is the cause, then retry. |
| 405 on `DELETE` | By design — disable via save (step 5). |

Worker-generated problem responses are `application/problem+json` with a
`type` URL pointing at the [`PROBLEMS.md`](./PROBLEMS.md) section that explains
them. The ordinary `/data/*` save envelope is the exception described above.

## Smoke ladder: five copy-paste commands (fresh clone → green)

Run these verbatim after `cp .dev.vars.example .dev.vars` (fill in
`LOGIN_USERNAME` / `LOGIN_PASSWORD` plus one token), `npm run db:migrate:local`,
and `npm run dev`. Every command below was run verbatim against local dev on
current `origin/main` — match the bodies and the `HTTP` footers exactly.

```bash
# 1. Liveness — no token. Proves the Worker is up.
curl -s -w '\nHTTP %{http_code}\n' http://localhost:8787/api/v1/health
# {"status":"ok","service":"routeware-shadow-api","version":"1.0.0"}
# HTTP 200
```

```bash
# 2. The bearer gate is up — no token must fail closed, never 200/empty.
curl -s -w '\nHTTP %{http_code}\n' http://localhost:8787/api/v1/shadow/health
# {"type":".../PROBLEMS.md#unauthorized","title":"Unauthorized","status":401,...}
# HTTP 401
```

```bash
# 3. Load the token from .dev.vars into this shell (never printed).
#    Prefers SHADOW_API_TOKEN, falls back to CUSTOMER_SNAPSHOT_SYNC_SECRET;
#    last non-empty line wins (the example file ships both keys empty).
TOKEN=$(grep -E '^[[:space:]]*(export[[:space:]]+)?SHADOW_API_TOKEN[[:space:]]*=' .dev.vars | cut -d= -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" | grep -v '^$' | tail -1)
[ -n "$TOKEN" ] || TOKEN=$(grep -E '^[[:space:]]*(export[[:space:]]+)?CUSTOMER_SNAPSHOT_SYNC_SECRET[[:space:]]*=' .dev.vars | cut -d= -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" | grep -v '^$' | tail -1)
[ -n "$TOKEN" ] && echo "token loaded (${#TOKEN} chars, value redacted)" || echo "EMPTY: set SHADOW_API_TOKEN in .dev.vars and restart wrangler dev"
# token loaded (N chars, value redacted)
```

```bash
# 4. Versioned shadow probe — authed. Extra "version":"v1" vs rung 1.
curl -s -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/shadow/health
# {"status":"ok","service":"routeware-shadow-api","version":"v1"}
# HTTP 200
```

```bash
# 5. Deep readiness — authed. 200 means D1 answers, R2 is bound (or archiving
#    explicitly disabled), and all three report sources are configured.
#    `checks.cron` is advisory only: on a fresh clone it reports stale with
#    null tables (the daily cron has never run) without flipping the overall
#    status — that is expected, not a failure. (Fresh clones show 200: the
#    [vars] defaults configure all three report query ids.)
#    A 503 with "status":"degraded" is still a *passing probe response* —
#    it names the sick dependency in checks — but stop and fix it, don't
#    roll forward.
curl -s -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/readiness
# {"status":"ok","service":"routeware-shadow-api","checks":{"d1":{"ok":true},"r2":{"ok":true,"bound":true,"enabled":true},"config":{"ok":true,"customer":true,"address":true,"container":true},"cron":{"ok":false,"stale":true,"lastRunAt":null,"tables":{"customer":null,"address":null,"container":null},"detail":"No cron run recorded yet (cron_sync_state is empty or unreadable)."}}}
# HTTP 200
```

Rung-by-rung failures: `curl: (7)` on rung 1 → `npm run dev` is not
listening (see `README.md` quick start); rung 2 returning anything but 401 →
the bearer gate is miswired, file a bug; rung 3 `EMPTY` → fill in a token in
`.dev.vars` and restart `wrangler dev` (it reads the file only at boot);
rungs 4–5 401 → the loaded value does not match the server's (edited
`.dev.vars` without restarting, or wrong shell); rung 5 503 → read
`checks.{d1,r2,config}` for the culprit (`detail` names it, values never
leak) — `checks.cron` staleness alone never 503s, it is advisory.
