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
also accept `customerId` / `pickupAddressId` and exact `routeId` / `franchiseId`
scopes ([synthetic scoped-page recipe](#address-route-and-franchise-scopes)). Every list response includes
`nextCursor` (the last row's primary key on a full page, otherwise `null`);
full terminal pages still return a cursor, followed by an empty page. Pass it
back as `&cursor=` instead of `offset` to page deep result sets by primary-key
seek — `offset` re-scans everything before it, `cursor` does not:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?limit=500&cursor=50000"
# {"rows":[...],"total":...,"nextCursor":50500} — pass 50500 as the next cursor
# Stop on null from a partial page or the empty page after a full terminal page.
```

Scanning pages without needing an exact count? Pass `includeTotal=false` to
skip the `COUNT(*)` query: the response keeps the same `rows` and
`nextCursor`, but `total` comes back `null` — deliberately not computed, not
zero. Defaults are unchanged: omit the key (or pass `includeTotal=true`) for
today's exact count.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot?limit=2&includeTotal=false"
# {"rows":[...],"total":null,"nextCursor":2} — same page, no count query
```

### Address route and franchise scopes

Use the existing `listAddressSnapshot` operation to avoid fetching unrelated
addresses. Optional `routeId` and `franchiseId` intersect by AND with one
another and with every old filter. `routeId` must be unpadded ASCII decimal
`0..9007199254740991`; zero is literal stored zero. `franchiseId` is an opaque,
case-sensitive exact string of 1..100 Unicode code points. Preserve leading
zeros and nonblank whitespace; URL-encode it rather than interpolating it
into a URL. Blank/repeated/malformed scopes return the existing value-free
400 before D1 ([correction guidance](PROBLEMS.md#bad-request)); valid no-match
returns 200 empty. Null scope columns never match supplied values.

Synthetic scoped-page recipe, with no running service or real credentials:

```bash
npm run check:address-scope
```

The fixture seeds local test D1, then reads
`/api/v1/address-snapshot?routeId=7&franchiseId=001&fields=enabled&limit=2&includeTotal=false`.
Its first IDs are `20,30`, next IDs `120,130`; it follows the returned Link
unchanged and stops after the final empty page. Every row keeps its address
ID, `total` is null and each page executes one SELECT with no COUNT. The
counted offset/seek cases retain cursor-relative totals and pickup-address-ID
order. Other fixtures prove literal route zero, case/leading-zero distinction,
100 astral code points, nulls, duplicate scope pairs and URL-encoded quotes,
percent, underscore and whitespace. Network-deny and read-only D1/R2 doubles
fail on unexpected side effects. No upstream lookup or write is added.

For a custom synthetic local request, construct the query with
`new URLSearchParams({ routeId: "7", franchiseId: " 雪%_ " })` and use the
[same-origin next-page loop](#follow-the-servers-next-page-target) below.
Scopes, fields and count-free mode round-trip in Link; do not log scope
values or rows. Authentication, no-store, ETags and existing count semantics
remain unchanged. These checks are not deployed performance evidence.

### Highest primary IDs first

All three ordinary lists accept exact, case-sensitive `order=asc|desc`;
omission and `asc` keep the existing ascending order. `desc` starts at the
highest primary ID, **not necessarily the newest row in time**. Keep direction
and cursor together; changing direction starts a new traversal. Cursor overrides
offset in either direction. With counts enabled, `total` counts matching rows
after the cursor, before limit/offset; with `includeTotal=false`, no COUNT runs.
Follow-next `Link` targets preserve an explicitly requested `order`, so a
`desc` traversal continues downward; omitted `order` keeps the default target.

Synthetic IDs only; illustrative requests for a disposable local fixture:

```text
GET /api/v1/customer-snapshot?order=desc&limit=2&fields=company_name&includeTotal=false
# IDs [91,58], nextCursor 58 for a matching fixture
GET /api/v1/customer-snapshot?order=desc&cursor=58&limit=2&fields=company_name&includeTotal=false
# IDs [42,37], nextCursor 37; total remains null
GET /api/v1/address-snapshot?order=desc&limit=2&offset=2
GET /api/v1/container-snapshot?order=desc&cursor=58&limit=2&customerId=11
```

Empty/repeated/other `order` values return a value-free 400 before D1
(after auth); send one lowercase `asc` or `desc`, or omit it for `asc`.
Full pages return their last integer ID even when terminal; stop on `null`
from a partial or subsequent empty page. Concurrent writes are not a stable
snapshot guarantee. Changes feeds, by-id reads and exports are unchanged.
See [query policy](SNAPSHOT-LIST-QUERY-POLICY.md#primary-id-direction-order).
The focused check needs no credentials, running Worker or live tenant:

```bash
npm run check:snapshot-order
```

### Conditional JSON page reads (bandwidth only)

The three ordinary snapshot list GETs return an `ETag`: quoted SHA-256 of
exactly the served UTF-8 JSON envelope, **after** field projection, including
`rows`, `total` and `nextCursor`. An authorized agent can send that quoted
value in `If-None-Match`. An unchanged representation returns **304 with no
body** and the same ETag; a nonmatch returns the current **200 JSON** and its
ETag. Weak tags (`W/"…"`), comma-separated tag lists and standalone `*` work;
unquoted hashes, lowercase `w/` prefixes and other malformed lists do not
match. A quoted `"*"` is an ordinary opaque tag, not a wildcard.

This saves **response bytes only, not D1 queries**: authentication, query
validation and the usual D1 work still run on every request (two statements
for counted pages, one with `includeTotal=false`). Auth/validation/D1 errors
cannot turn into 304. `Cache-Control: no-store` is unchanged; this is **not a
cache hit**, shared-cache permission or a TTL change. No response cache or
persisted validator is added. CORS still exposes ETag and request IDs.
Changing a selected value, total or nextCursor changes the tag; changing
only selected-out values does not. Different requests serving identical
bytes may share a tag. Detail, changes, CSV and hydrated-read contracts are
unchanged.

Synthetic, credential-free recipe (no running Worker or live tenant):

```bash
npx vitest run --maxWorkers=2 test/snapshotListConditional.acceptance.test.ts
```

The hermetic fixture calls the real app with local test D1 and makes any
outbound fetch fail. For each resource it requests a projected page, computes
the expected SHA-256 from the first 200's actual bytes, repeats the request
with that ETag and checks a genuinely empty 304, then changes a selected
synthetic value and checks a fresh 200. It also asserts identical executed
SQL/binds on the 200/304 pair and preserved no-store/CORS/request-ID headers.
These are synthetic regression results, not deployed performance measurements.

### Follow the server's next-page target

The three ordinary snapshot lists also return `Link: <relative-target>; rel="next"`
exactly when `nextCursor` is non-null. Follow it rather than rebuilding the
query: the target retains recognized filters, explicit `fields`, the effective
limit and `includeTotal=false`, replaces the cursor, and drops `offset` even
when you started with one. Unknown keys and request origins are never copied.
CORS exposes `Link` alongside the existing exposed headers.

**Omission means stop.** A full terminal page can link to an empty page; there
is no lookahead query. JSON, count semantics (including cursor-relative totals)
and query counts are unchanged. This is not a consistency guarantee during
concurrent writes. The customer `changes` feed uses its own composite-cursor
[follow-next contract](#2c-follow-the-composite-next-link).

Node 24 recipe (local synthetic origin, `$TOKEN` from step 1; log counts, not
rows or credentials). Resolve the relative target against the current page,
refuse foreign origins before sending authorization, and reject redirects:

```javascript
const start = new URL("http://localhost:8787/api/v1/customer-snapshot?limit=2&includeTotal=false");
let url = start;
for (;;) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TOKEN}` }, redirect: "error"
  });
  if (!res.ok) throw new Error(`Snapshot read failed: ${res.status}`);
  const page = await res.json();
  console.log({ rows: page.rows.length, total: page.total });
  const link = res.headers.get("Link");
  if (link === null) break;
  const match = /^<([^>]+)>; rel="next"$/.exec(link);
  if (!match) throw new Error("Untrusted next Link");
  const next = new URL(match[1], url);
  if (next.origin !== start.origin || next.username || next.password)
    throw new Error("Untrusted next-link origin");
  url = next;
}
```

The executable-doc check runs this exact recipe with synthetic responses and
no network or real credentials (also included in `npm test`):

```bash
node --test test/snapshotNextLinksRecipe.acceptance.test.mjs
npx vitest run test/snapshotNextLinks.acceptance.test.ts
```

Single rows (same 404 `not-found` shape when the id is not in D1):

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/customer-snapshot/42
# HTTP 200 row, or 404 {"type":"...#not-found",...} when that id is not in D1

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/address-snapshot/10
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/api/v1/container-snapshot/100
```

Empty `rows` with HTTP 200 means auth works but no snapshot has been synced
yet — ask the operator to run `POST /api/v1/data-snapshot/sync` (or the daily
cron), not a bug in your call.

### Discover legal sparse-field selections

Each supported operation's actual `fields` query parameter has
`schema["x-snapshot-fieldset"]`. This **vendor extension**, not a standard
OpenAPI keyword or an enum of whole comma-separated selectors, defines v1:

| Key | Contract |
|---|---|
| `schemaVersion` | Integer `1`; stop selection for an unsupported version. |
| `resource` | `customer`, `address` or `container`, for this operation only. |
| `selectableFields` | Ordered array of all legal exact field names, including the primary identity. Generated from the same registry as validation, not record values. |
| `alwaysIncludedFields` | Array containing the resource's primary identity, even when not selected. |
| `delimiter` | `","`, also used by the parser. |
| `rules` | `{caseSensitive: true, whitespace: "reject", emptySegments: "reject", duplicates: "reject", unknownNames: "reject", repeatedKeys: "reject"}`. |

Use names exactly as advertised: no case folding, whitespace trimming, empty
selector/segment, duplicate name or repeated `fields` key. Unadvertised names
(including names exclusive to another resource) are invalid. An explicitly
selected identity is legal once and returned once, not treated as a duplicate
of the always-included identity. Invalid selectors yield the value-free 400
before D1 work described in the [existing query policy](SNAPSHOT-LIST-QUERY-POLICY.md#sparse-fieldsets-fields).

Use `fields` only where the operation declares it. The six flat snapshot
list/by-id reads project **each row** or the response object, retaining the
primary identity without changing `total`, `nextCursor` or the envelope.
The existing single-ID `GET /api/v1/data/customer`, `GET /api/v1/data/address`
and `GET /api/v1/data/container` reads also declare `fields`: only the matching
`.customer`, `.address` or `.container` root is projected, leaving related bundle
data unchanged. Those hydrated reads still require the sync secret; their
existing ETag and cache behavior is unchanged. The customer changes feed,
`GET /api/v1/customer-snapshot/changes`, declares the same customer catalog and
projects each row only after computing its page-length `total` and composite
`nextCursor`; keep the same selector when following the cursor. Omitting `fields`
preserves the full response. Exports, other changes feeds and batch paths do not
support `fields`.
Inspect each operation's actual parameter and route description; the catalog
does not grant authority. Operation IDs and access/effect metadata are unchanged.

Given JSON saved from the existing enabled `/openapi.json` response as
`openapi.json`, this offline example selects synthetic field names without
reading records, trying invalid requests or invoking a data route:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const doc = JSON.parse(readFileSync(0, "utf8"));
const op = doc.paths["/api/v1/customer-snapshot"].get;
const p = op.parameters.find(p => p.in === "query" && p.name === "fields");
const f = p?.schema?.["x-snapshot-fieldset"];
if (f?.schemaVersion !== 1 || f.resource !== "customer") throw Error("Unsupported catalog");
const wanted = ["company_name", "phone1"];
if (!wanted.every(n => f.selectableFields.includes(n))) throw Error("Unavailable selection");
const query = new URLSearchParams({ fields: wanted.join(f.delimiter) });
console.log(JSON.stringify({ query: query.toString(), alwaysIncludedFields: f.alwaysIncludedFields }));
' < openapi.json
```

Discovery itself needs no bearer, data bindings or upstream work;
`OPENAPI_DOCS_ENABLED` still gates the document. Data reads still require the
bearer from step 1. No separately published static spec is required. Run the
credential-free, synthetic, network-denying discovery oracle plus existing
projection/OpenAPI checks with `npm run check:snapshot-fieldset-discovery`.

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

## 2b. Incremental sync: the customer `changes` feed

`GET /api/v1/customer-snapshot/changes` replays only rows touched after your
cursor — the incremental counterpart to the full list in step 2. Omit the
cursor initially. Optional `fields=company_name` keeps `customer_id` and the
selected column; omit `fields` for full rows. Cursors are unchanged:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot/changes?limit=2&fields=company_name"
# {"rows":[...],"total":2,"nextCursor":{"since":"2026-09-01T00:00:00.000Z","since_id":7101}}
```

Resume chunked deltas with the whole pair: pass the previous page's
`nextCursor` back as `since` + `since_id`. A bare `since` replays every later
run whole (strict `>`); a mid-run resume needs the tiebreak, because every
upserted row in one sync run shares that run's stamp:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/customer-snapshot/changes?since=2026-09-01T00:00:00.000Z&since_id=7101&limit=2&fields=company_name"
```

`since` is UTC `Z` with seconds or 1–3 fractional digits, compared at
lossless millisecond precision — more than 3 digits is a 400, never rounded.
`since_id` is exact unpadded decimal (`0`–`9007199254740991`) and needs a
valid `since`. The feed surfaces upserts only: reconciled-away or erased rows
never appear as tombstones, so re-list to detect disappearance.

## 2c. Follow the composite next link

Prefer the server's `Link: <relative-target>; rel="next"` to rebuilding the
pair from JSON. It appears exactly when `nextCursor` is non-null, replaces
both cursor halves and retains the effective limit (1..500, default 50) and
the validated `fields` selector, so sparse traversal keeps sparse pages.
The target is always `/api/v1/customer-snapshot/changes` with URL-encoded
`since`, `since_id`, `limit` and, when requested, `fields`: unknown keys,
origins and credentials are never echoed. This feed recognizes optional
`fields` (sparse stored-column projection after cursor derivation; omit for
full rows) but not `until`. Other unknown keys remain ignored.

Omission means stop. A full terminal page may link to an empty page; short,
empty and error pages have no next link. JSON bytes/shape, row ordering,
`total` (returned page length), cursor and the single SELECT stay unchanged:
no COUNT or lookahead is added. This is not a completeness or snapshot-isolation
promise across concurrent writes. Read-token auth, no-store, request ID and
existing CORS exposure (including Link) are unchanged.

Node 24 recipe for a **disposable synthetic local fixture**; it is not a live
probe. Supply the local test bearer as `$TOKEN`. Resolve emitted URLs unchanged,
check same origin, fixed path and absence of URL credentials **before** sending
authorization, and use manual redirects. Reject non-2xx before parsing JSON;
log counts only, never records or credentials:

```javascript
const start = new URL("http://localhost:8787/api/v1/customer-snapshot/changes?limit=2");
let url = start;
for (;;) {
  if (url.origin !== start.origin || url.pathname !== start.pathname || url.username || url.password)
    throw new Error("Untrusted next-link origin, path or credentials");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TOKEN}` }, redirect: "manual"
  });
  if (!res.ok) throw new Error(`Changes read failed: ${res.status}`);
  const page = await res.json();
  console.log({ rows: page.rows.length, total: page.total });
  const link = res.headers.get("Link");
  if (link === null) break;
  const match = /^<([^>]+)>; rel="next"$/.exec(link);
  if (!match) throw new Error("Untrusted next Link");
  url = new URL(match[1], url);
}
```

Focused command (no Worker, credentials or network needed):

```bash
npm run check:customer-changes-next-links
# Or run the oracles separately:
npx vitest run test/customerChangesNextLinks.acceptance.test.ts --maxWorkers=2
node --test test/customerChangesNextLinksRecipe.acceptance.test.mjs
```

The HTTP oracle seeds real hermetic D1 with timestamp ties/multiple runs,
follows Link unchanged, pins JSON bytes/SQL/binds/query counts, proves zero
application writes and fails on unexpected outbound fetch. The recipe oracle
executes this exact block with synthetic responses and no real network. Both
run in normal `npm test`/CI. These are source regressions, not installed or
production verification.

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

Unknown valid ids return 404 `not-found` ("import/sync first"). Passing the general
token here returns 401 even though it works for step 2 — that is the inner
privileged gate, not a bad token.

All three reads use the same ID contract. Supply `id` or the existing alias:
`customerId` for customer, `pickupAddressId` for address, `containerId` for
container. Each supplied value must be canonical positive decimal text
(`^[1-9][0-9]*$`) in the safe-integer range `1`–`9007199254740991`.
Both valid spellings may be supplied with different values: **`id` wins**.
A malformed unused alias still returns 400, not a cached row or 304.

This deliberately tightens numeric coercion: empty/whitespace, leading zeros,
signs, fractions (even `42.0`), exponents, hex, nonpositive and unsafe values
are rejected before handler/cache/D1 access. Do not normalize malformed caller
text into a different row ID. Rejections use the anchored 400
`application/problem+json` envelope with fixed field-only detail and no input
values; see [bad-request guidance](PROBLEMS.md#bad-request).

Synthetic consumer examples (the acceptance fixture, not customer records):
`/api/v1/data/customer?id=42` and `?customerId=42` return the same row and ETag;
`?id=42&customerId=2` selects 42; `?id=42&customerId=042` returns 400.
Run the credential-free, network-denying local check instead of querying a tenant:

```bash
npx vitest run test/hydratedReadIds.acceptance.test.ts test/dataRoutes.test.ts
```

### Root-only sparse fields on hydrated reads

The three **single-ID** reads above accept the same strict `fields` allowlist
as their flat snapshot counterparts. Root means `.customer`, `.address` or
`.container`, not the bundle envelope. Synthetic examples:

```bash
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/customer?id=42&fields=company_name,phone1"
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/address?id=10&fields=city,address"
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/data/container?id=100&fields=serial_number,location_address"
```

For example, the first request selects only `customer_id`, `company_name`
and `phone1` inside `.customer`. The full `.addresses` array, including all
nested containers, is unchanged. Address/container requests likewise retain
all other bundle members, nulls and ordering. The primary ID is always
included, even for `fields=phone1`; omit `fields` for the existing full response.
This shapes the response, not the D1 queries, and **does not remove PII from
related data** or change authorization.

Use exact stored column names separated by commas, once each in a single
`fields` key. Empty/repeated/duplicate, unknown, cross-resource, dotted,
wildcard and relationship selectors return a fixed value-free 400 before
cache or D1 reads; auth still takes precedence over field validation. See the
[shared fieldset policy](SNAPSHOT-LIST-QUERY-POLICY.md#sparse-fieldsets-fields).
No batch `ids` support is added.

ETags hash the **served bundle bytes**, including unchanged related data.
Keep validators per URL and selector: a full-only validator cannot short-cut
a projected response. A matching projected validator returns an empty-body
304. Selected-out root changes can leave that validator unchanged; related
changes still invalidate it after normal cache expiry/invalidation. Warm reads
derive the projection from the canonical full cache without mutating it; cold
reads use ordinary hydration and cache only the full representation. The
existing `private, max-age=60` policy is unchanged; there is no second cache.
See [cache semantics](ENTITY-DATA-CACHE.md#sparse-representations).

Credential-free acceptance check:

```bash
npx vitest run test/hydratedFields.acceptance.test.ts
```

## 3a. Snapshot archives: `GET /api/v1/snapshots/{table}/{date}`

Syncs archive their raw CSV to R2 (`snapshots/YYYY-MM-DD/<table>.csv`, when
the binding is configured). The sync secret streams it back re-encoded for
spreadsheets (formula-leading cells quoted, `_shadow_csv_encoding` appended);
compare the download with a fresh export by business values, not bytes;
swap the date for `latest` to fetch the newest archive without naming its date:

```bash
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/snapshots/customer/2026-01-01" -o customer-2026-01-01.csv
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/snapshots/customer/latest" -o customer-latest.csv
curl -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/customer-snapshot/export" -o customer-fresh.csv
# Same pair for address and container — swap the table name:
# `/api/v1/snapshots/address/2026-01-01`, `/api/v1/address-snapshot/export`,
# `/api/v1/snapshots/container/2026-01-01`, `/api/v1/container-snapshot/export`.
```

The general token 401s here even on GET — the inner privileged gate from
step 3, not a bad token. A well-formed but absent archive is 404 `not-found`
(history is missing, not a bad call). Replays carry a content-hash `ETag`;
send it back for a 304:

```bash
curl -i -H "Authorization: Bearer $SYNC" \
  "http://localhost:8787/api/v1/snapshots/customer/2026-01-01"
# HTTP 200 + ETag header; repeat with -H "If-None-Match: <etag>" → 304
```

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
Their JSON envelopes additionally require nullable `pickupAddressId`, and the
container envelope also requires nullable `containerId`. `customerId` is also
nullable when unresolved. Creates answer **HTTP 201** with the resolved id
while updates echo the posted id with 200 (customer saves stay 200 on creates):

```bash
# Create address (PickupAddressID=0); the 201 body carries the created id
curl -X POST http://localhost:8787/api/v1/data/address \
  -H "Authorization: Bearer $SYNC" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "PickupAddressID=0" \
  --data-urlencode "CustomerID=5" \
  --data-urlencode "Address=1 Main St"
# HTTP 201 {"ok":true,"routewareStatus":200,"customerId":5,
#   "pickupAddressId":77,"upstreamBytes":46,
#   "localSync":{"done":true,"customerId":5,"addressIds":[10,77],"containerIds":[100]}}
```

For live creates, the id comes from upstream `data.PickupAddressID` / `data.ContainerID`
first, else the singleton post-refresh D1 id (address ids for the owning
customer, container ids for the owning address). The diff baseline is captured
**before** the upstream POST so a concurrent refresh cannot put this request's
created row into the baseline. Without an upstream id, `null` remains when the
diff is empty or ambiguous (0 or 2+ new ids), the owning graph is unknown, or
the baseline/refresh is unavailable. A failed baseline read disables only
id diffing: the save and normal refresh still run, and an upstream JSON id
still wins. Posted save keys are case-exact (`PickupAddressID`, `ContainerID`);
camelCase keys do not name an update. Upstream JSON ids must be positive safe
integers (numbers or digit-only strings); invalid candidates do not mask valid
fallback fields. There is deliberately no `Location`
header: the by-id snapshot URL may not exist locally when the refresh fails,
and a header that 404s is worse than none. Dry-run saves echo posted ids;
live creates resolve or return `null`, while live updates return the
case-exact posted key.

`routewareStatus` is the original upstream status, not necessarily the wrapper
status (for example, upstream 200 on a create returns wrapper 201 with the
resolved id).

**Read `dryRun`, `ok` and `localSync` separately.** On a live save (no `dryRun`
response flag), `ok=true` means the upstream write was accepted, not that local
data was refreshed. A `dryRun=true` response means validation passed only; no
upstream write or local refresh was attempted. Local refresh and cache
invalidation are best-effort; HTTP 200 does not guarantee a refreshed local graph.
The shared, served OpenAPI `LocalSyncSummary` contract has two exclusive shapes:

| `localSync` | Meaning and recovery |
| --- | --- |
| `{done:true, customerId, addressIds, containerIds}` | Graph refreshed and cache invalidation completed; arrays contain graph IDs, not submitted fields. |
| `{done:false, code:"sync_failed"}` | Write accepted, but refresh or cache invalidation failed; local state may be stale or partially refreshed. Verify local state and arrange graph reconciliation rather than repeating the save. |
| `{done:false, code:"unknown_customer_id"}` | Write accepted, but the owning customer was unresolved, so no graph refresh ran. Resolve the existing upstream identity before reconciling local state. |
| `{done:false, code:"not_attempted"}` | Upstream rejected the live save (`ok=false`), or this was validation-only (`dryRun=true`); no local refresh ran. This is not a write-success claim. |

Never blindly replay or retry creates after an ambiguous response or failed
refresh: the upstream write may already have landed. Verify existing identities
and reconcile local state without repeating the create; these codes do not
provide idempotency or authorize retries. Error codes are fixed strings, never
exception text, upstream HTML, form fields or PII. Inspect `application/json`
examples on each save operation in `/openapi.json` for the four live outcomes,
the validation-only dry-run outcome, and the 201 created-id outcome on address
and container saves. HTTP 200 advertises a union of those strict live and
dry-run schemas (live updates echo the posted id; live creates answer 201);
null upstream status is valid only on dry runs.

Runnable hermetic schema-vs-runtime check (no live provider, credentials or data):

```bash
npx vitest run test/saveOutcomeSchemas.acceptance.test.ts --maxWorkers=2
```

This serves OpenAPI via `app.fetch`, validates all three envelopes and synthetic
outcomes, rejects malformed `localSync`, and checks unchanged forwarding,
authentication, `no-store`, statuses and side effects. It exercises the behavior
present at this implementation head, including the merged dry-run and created-ID
resolution contracts; it does not introduce new save behavior.

On the `/api/v1/routeware/*` passthrough save routes, a silent Routeware-side
failure surfaces as `502` problem+json (Routeware reports failed saves as an
HTML page with HTTP 200 — the Worker converts that, never passes it through
as success); an explicit Routeware 4xx/5xx instead keeps its own status under
the `upstream-error` problem type. On the `/api/v1/data/*` saves above, the same silent upstream
failure instead returns **HTTP 200 with `"ok": false`** (plus the upstream
`routewareStatus` and `upstreamBytes`) — check the `ok` field, not just the
status code. Anti-forgery preparation failures return `502` problem+json,
but a forwarded failure can also return `502` with the ordinary `ok:false`
save envelope. Likewise, HTTP 503 can carry a forwarded live rejection as
JSON or a dry-run session precondition failure as problem+json. The exact
400/401 responses and the default error response also publish both media
schemas: a forwarded rejection is a JSON save outcome, while local validation,
bearer denial, auth throttling (429) and unhandled failures (500) use
problem+json. A problem response alone does not prove whether a write landed.
Inspect the media type and payload, not only the status. See the
[502 recipe](#502-and-other-upstream-failures-distinguish-them-from-client-authentication).

### Dry-run recipe: validate, fix, save

Append `?dryRun=true` to any of the three saves to validate — form fields
plus session health — without risking a non-idempotent create landing
upstream. Nothing is persisted: no upstream POST, no D1 write, no cache
invalidation, no login.

```bash
# 1. Validate (HTTP 200: dryRun: true, routewareStatus: null, upstreamBytes: 0)
curl -X POST "http://localhost:8787/api/v1/data/customer?dryRun=true" \
  -H "Authorization: Bearer $SYNC" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "CustomerID=0" \
  --data-urlencode "CustomerTypeID=1" \
  --data-urlencode "CompanyName=ExampleCo"
# 2. Fix whatever 400/502 the dry-run reports (identical shapes to the live path)
# 3. Save for real: drop the flag — or pass ?dryRun=false — and re-POST the body
```

Without a usable session the dry-run fails closed with 503
`failed-precondition` and never logs in — run a live request first. Only
`dryRun` is an allowed query key; after sync-secret authentication succeeds,
anything else is a value-free 400. Missing or invalid authentication retains
precedence over unknown-key rejection.
`routewareStatus` is unknowable without posting and is never predicted.
Run the hermetic proof: `npm run check:save-dry-run`.

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
# RateLimit: "auth-burst";r=0;t=60; RateLimit-Policy: "auth-burst";q=19;w=60
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

The same 429 also carries the standard equivalents (`draft-ietf-httpapi-ratelimit-headers`
shape), computed from the same throttle verdict, so any HTTP client can parse
them without knowing the `X-RateLimit-*` names:

- `RateLimit: "auth-burst";r=0;t=<retryAfterSec>` — quota policy `auth-burst`
  with `r` (remaining: always `0` here, matching `X-RateLimit-Remaining`) and
  `t` (backoff in seconds, matching `Retry-After`).
- `RateLimit-Policy: "auth-burst";q=19;w=60` — the policy itself: `q` (quota:
  19 failed checks allowed per window) and `w` (window: 60 seconds).

CORS exposes `Retry-After`, all three `X-RateLimit-*` headers, and the standard
`RateLimit`/`RateLimit-Policy` fields, so
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
`#upstream-error` carries no `Retry-After`, no `X-RateLimit-*` headers, and no
`RateLimit`/`RateLimit-Policy` fields
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
the `detail` names the configured timeout budget. **Not every timeout 502
carries `Retry-After`: the response path matters.**

| Timeout response path | `Retry-After` |
|---|---|
| Direct-forwarder timeout reaching the `app.onError` backstop | Fixed `5` seconds, from `UPSTREAM_TIMEOUT_RETRY_AFTER_SEC` in `src/lib/upstreamTimeout.ts`. |
| Timeout caught by `forwardWithSessionRetry`, on either the first forward or the post-login retry | Absent. This includes `GET /api/v1/routeware/home/index` and the customer, address and container read/save routes that use this helper. |

Both paths return the same problem type, title and body shape; those fields do
not tell clients whether a retry delay is supplied. Check the header itself.
The HTML error page above, concurrent-refresh timeout and login-unavailable
502s also send no `Retry-After`. Auth-throttle 429 responses retain their own
`Retry-After` header.

**Fix:** for a read timeout, honor `Retry-After` when present; if absent, wait
5 seconds as a client-side fallback before retrying once. Do not retry in a
tight loop. If it persists, ask the operator to check Routeware availability,
the session, and the login path. Changing the client bearer or raising the
timeout does not repair an upstream failure. For the HTML error above, have
the operator inspect the upstream session/report request before retrying;
the problem body never includes the raw HTML.

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

## Correlate retries with `X-Request-Id`

Send one id per logical attempt and reuse it across that attempt's retries;
every `/api/v1` response echoes it, including 401/429, 404, and 5xx, so the
id joins your retries to the server-side log line. Use 1–128 chars of RFC
7230 token chars (`A–Z a–z 0–9` plus `!#$%&'*+-.^_`|~`); anything else is
ignored and the server mints a UUID instead — the request never fails for a
bad id. The gate/notFound/onError problem bodies also carry it as
`requestId`, and browsers can send and read it (allowed + exposed via CORS).
This is correlation only, not idempotency: reusing an id never dedupes a
save — still verify the record before resubmitting (rows above).

```bash
RID="retry-$(date +%s)-a1"
curl -sS -i -H "Authorization: Bearer $TOKEN" -H "X-Request-Id: $RID" \
  "http://localhost:8787/api/v1/shadow/health" | grep -i "x-request-id"
# X-Request-Id: retry-...-a1 (echoed byte-identical)
```

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

Readiness waits up to 15 seconds for concurrent D1 ping and cron observations
(`min(DEFAULT_UPSTREAM_TIMEOUT_MS, READINESS_CACHE_TTL_MS)`); a ping timeout
returns 503, while a cron timeout leaves otherwise-healthy readiness at 200.
Results, including failures/timeouts, are cached for 20 seconds from refresh
start; hits never extend expiry. Failed checks add `code` (`d1_ping_timeout`,
`d1_ping_failed`, `cron_state_timeout`, or `cron_state_failed`) and
`next_action: "retry_after_cache_ttl"`. Wait 20 seconds before retrying rather
than spinning on cached failures. Exception messages/stacks are never exposed.
A response timeout does **not** cancel underlying D1 work. See
[the cache and bounded-wait contract](READINESS-CACHE.md) for recovery and the
credential-free focused acceptance command.
