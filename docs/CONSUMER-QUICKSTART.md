# Consumer quickstart

Read production Routeware data through the shadow API: authenticate, read
snapshots, write through Routeware, and handle the no-DELETE rule. Every
command below was validated against local dev (`wrangler dev`,
`http://localhost:8787` — replace the origin with your deployment).

Operator setup (secrets, D1 migrations, report sync) is out of scope here:
see [`README.md`](../README.md) and [`CUSTOMER_SNAPSHOT.md`](../CUSTOMER_SNAPSHOT.md).
Error catalog: [`PROBLEMS.md`](./PROBLEMS.md).
Full machine-readable spec: `GET /openapi.json` (interactive UI at `/docs`;
both gated by `OPENAPI_DOCS_ENABLED`).

## 0. Check the service is up (no token needed)

`GET /api/v1/health` is the only public route:

```bash
curl http://localhost:8787/api/v1/health
# {"status":"ok","service":"routeware-shadow-api"} — HTTP 200
```

Anything else means the Worker is not running (`npm run dev`).

## 1. Authenticate: two bearer tokens

Ask your operator for both tokens. Every `/api/v1/*` route except the health
check needs `Authorization: Bearer <token>`:

| Token | Unlocks |
|---|---|
| `SHADOW_API_TOKEN` (general) | Snapshot list reads, all `/api/v1/routeware/*` forwards, `GET /api/v1/shadow/health` |
| `CUSTOMER_SNAPSHOT_SYNC_SECRET` (privileged) | Everything above, **plus** `.../sync`, `.../import`, and all `/api/v1/data/*` reads/writes |

Rule of thumb: **start with the sync secret** — it passes every gate. The
general token 401s on privileged routes even when it is otherwise valid.

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
also accept `customerId` / `pickupAddressId`. Single rows:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/customer-snapshot/42
# HTTP 200 row, or 404 {"type":"...#not-found",...} when that id is not in D1
```

Empty `rows` with HTTP 200 means auth works but no snapshot has been synced
yet — ask the operator to run `POST /api/v1/data-snapshot/sync` (or the daily
cron), not a bug in your call.

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
On the `/api/v1/routeware/*` passthrough save routes, a Routeware-side
failure surfaces as `502` problem+json (Routeware reports failed saves as an
HTML page with HTTP 200 — the Worker converts that, never passes it through
as success). On the `/api/v1/data/*` saves above, the same silent upstream
failure instead returns **HTTP 200 with `"ok": false`** (plus the upstream
`routewareStatus` and `upstreamBytes`) — check the `ok` field, not just the
status code. (`502` on `/data/*` only covers the anti-forgery prep path.)

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

## Troubleshooting

| Symptom | Meaning |
|---|---|
| 401 on everything except `/health` | Missing/wrong bearer, or no token configured server-side (fails closed). General token on a privileged route also 401s — retry with the sync secret. |
| 429 | Too many failed auth attempts from your IP; wait 60 s, then use a valid token. |
| 200 with `"rows":[]` | Auth works; D1 has no snapshot data yet (operator runs the sync). |
| 404 `not-found` on `/data/*` | That id is not in D1. |
| 502 on a `/routeware/*` save | Routeware rejected the save upstream; see the problem+json `detail`. |
| 200 with `"ok":false` on a `/data/*` save | Same upstream rejection, different envelope — check `routewareStatus` / `upstreamBytes`, fix the form, retry. |
| 405 on `DELETE` | By design — disable via save (step 5). |

All errors are `application/problem+json` with a `type` URL pointing at the
[`PROBLEMS.md`](./PROBLEMS.md) section that explains them.
