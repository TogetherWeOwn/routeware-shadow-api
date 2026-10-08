# Architecture and data flow

The shadow API is a Cloudflare Worker in front of Routeware WebRW. It separates
client bearer authentication from the upstream browser session, and maintains
customer, address and container snapshots in D1 with bulk CSV archives in R2.

## Overview

```text
Client (shadow bearer token; no Routeware cookies needed)
  |
  v
Worker fetch --> Hono auth gates --> route handlers
                                      |
                                      +-- get/lock/set --> AUTH_SESSION DO
                                      |                   (cookie jar + lock)
                                      +-- Worker fetch <--> Routeware WebRW
                                      |   stored cookie; no client bearer
                                      +-- hydrated GET <--> Cache API / D1
                                      +-- save --> detail refresh --> D1

UTC cron --> Worker scheduled() --> single-invocation or chained bulk sync
                                      | session via AUTH_SESSION DO
                                      | report CSV from WebRW
                                      +--> D1 --> best-effort R2 archive
```

Routeware is the source of truth. The DO stores session state and coordinates
login; **Worker helpers**, not the DO, fetch upstream. The client bearer is not
forwarded upstream, and upstream `Set-Cookie` is not returned to clients.
Request-time entity refresh and bulk CSV archival are different paths, not one
transaction spanning Routeware, D1, the Cache API and R2.

## Request paths

`src/worker.ts` sends HTTP requests to the Hono app. Two middlewares run before
the `/api/v1` route modules:

1. Answer OPTIONS preflight and allow public `GET /api/v1/health`. Other API
   requests need a bearer accepted by the outer gate: `SHADOW_API_TOKEN` or
   `CUSTOMER_SNAPSHOT_SYNC_SECRET`; `SHADOW_API_READ_TOKEN` is GET-only. The
   sync secret also works when the general token is unset. Failed bearer
   checks are throttled per client IP; this gate runs before reading the body.
2. Buffer write bodies for replay, except streaming snapshot imports, and
   attach the `AUTH_SESSION` stub named `primary`. Privileged route handlers
   then check **only** `CUSTOMER_SNAPSHOT_SYNC_SECRET`. In particular, the
   general/read token alone cannot access hydrated `/data/*` GETs or POSTs.

The prefix tells the reader which path follows:

| Surface | Main path after authorization |
|---|---|
| `GET /api/v1/data/customer`, `/data/address`, `/data/container` | Hydrated JSON aggregate from Cache API or D1; no live upstream read on this path. Identity is an `id` query parameter or its entity-specific alias. |
| `POST /api/v1/data/customer`, `/data/address`, `/data/container` | Upstream form save, then best-effort customer-graph refresh into D1 and cache invalidation; sanitized outcome JSON. |
| `/api/v1/routeware/*` | Explicit upstream actions, not an arbitrary-path proxy. Raw save routes also attempt local refresh, but retain the upstream response and suppress local-refresh errors. |
| `...-snapshot` reads, syncs and imports | Query the D1 mirror, fetch bulk report CSVs, or import supplied CSVs; see [Snapshot synchronization](#snapshot-synchronization). |

Do not confuse `POST /api/v1/routeware/data/app-settings-get` with the hydrated
entity writes: it forwards JSON to `Data/appSettingsGet`, does not refresh D1,
and returns the upstream response on success (silent 2xx failure becomes 502).
There is no wildcard `/routeware/data/*` proxy.

## Trace a `data/*` POST

Use **`POST /api/v1/data/customer`**, not `/data/customer/:id`. The ID belongs
in the URL-encoded form as `CustomerID`; `0` or absence means create. This is
not a JSON patch API, and there is no JSON-to-form conversion. The documented
POST body schemas describe the upstream forms; they are not runtime body
validators. Empty bodies are rejected; non-form bytes may pass through without
token preparation and cannot be relied on for post-save ID resolution.

Request shape (symbolic, not a complete save form or a command to execute):

```http
POST /api/v1/data/customer
Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>
Content-Type: application/x-www-form-urlencoded

CustomerID=<existing-id>&<remaining-SaveCustomerLongForm-fields>
```

Follow the request through these boundaries:

1. **Client authorization.** The outer bearer check runs first, the body is
   buffered, and the route's sync-secret check must also pass. A sync-secret
   bearer passes both checks; the client does not supply Routeware cookies.
2. **Session and anti-forgery preparation.** `handlePostDataCustomer` reads the
   primary DO's session. When enabled and needed, the token helper fetches the
   relevant Routeware create/edit modal and inserts its anti-forgery token into
   the form. This is upstream browser-form state, not the client bearer.
3. **Upstream save.** `forwardWithSessionRetry` sends the prepared body from
   the Worker to `TARGET_ORIGIN` + `TARGET_BASE_PATH` +
   `/Customer/SaveCustomerLongForm`, using the stored cookie. The session path
   below explains bounded re-login/replay. No D1 write has happened yet.
4. **Interpret the result.** The Worker consumes the upstream body and checks
   both status and content. Routeware can return HTTP 200 with login/error HTML
   or explicit JSON failure. `routewarePostLooksSuccessful` rejects those
   shapes; a 200 alone does not prove the save succeeded. The customer ID comes
   from the submitted form or, for a create, the save response.
5. **Refresh the local graph after success.** With a resolved customer ID,
   `syncCustomerDetailFullToD1` fetches `Customer/GetCustomerDetailFull`, validates
   its JSON graph, then upserts customer -> addresses -> containers into D1 and
   reconciles removed children. This is one customer graph, **not** a bulk CSV
   sync and **not** an R2 archive.
6. **Evict derived cache entries.** Invalidate the customer, address and
   container bundles, including removed children. Whole-graph invalidation is
   retried; on refresh/invalidation failure the handler attempts fallback
   entity eviction rather than deliberately serving the old bundle.
7. **Answer the client.** Return `ok`, `routewareStatus`, the resolved IDs,
   `upstreamBytes` and `localSync`. Submitted fields and the upstream body are
   not echoed. A normal successful local refresh sets `localSync.done=true`.

Failure boundaries matter when deciding whether to retry a write:

- A successful upstream save can return HTTP 200 with
  `localSync.code="sync_failed"` or `"unknown_customer_id"`. That does **not**
  roll back the Routeware write; blindly replaying a create can duplicate it.
- An upstream failure can retain status 200 while the envelope says `ok=false`.
  Inspect `ok` and `localSync`, not just the HTTP status.
- Some errors, including a failed fallback cache deletion, can escape to the
  app error handler. There is no atomic rollback across upstream, D1 and cache.

Address and container saves follow the same sequence, with different forms:

| POST route | Upstream action | How the owning customer is found |
|---|---|---|
| `/api/v1/data/address` | `PickupAddress/SaveAddressForm` | Posted `CustomerID`; new address uses `PickupAddressID=0`. |
| `/api/v1/data/container` | `Container/SaveContainerForm` | Posted `CustomerID`, or the D1 address identified by `PickupAddressID`; new container uses `ContainerID=0`. |

All three saves refresh the owning **customer graph**, not just the edited row.
For the read-side aggregates and cache contract, see [ENTITY-DATA-CACHE.md](ENTITY-DATA-CACHE.md).

## Session path

The `AUTH_SESSION` binding points to `AuthSession`. Its `primary` instance
stores `cookieHeader`, `expiresAtMs`, `refreshing` and `lockedAt` in DO storage.
Internal `/get`, `/set`, `/lock` and `/unlock` operations expose state and
coordinate refresh. They are not public API routes; the DO has no upstream
forwarding endpoint and no `/refresh` endpoint.

Login runs in Worker helpers under the DO's refresh lock:

- `AUTH_MODE=http`: fetch Routeware login HTML/init-script state, obtain the
  anti-forgery token, submit `LOGIN_USERNAME`/`LOGIN_PASSWORD`, merge cookies,
  and store the session with `/set`.
- `AUTH_MODE=browser`: use the `BROWSER` binding to complete the login form,
  collect session cookies, store them, and close the browser.
- `AUTH_MODE=auto`: try HTTP first, then browser fallback for ordinary HTTP
  login failure. Invalid `AUTH_MODE`, blocked login/init-script responses and
  missing `Headers.getSetCookie` support do not trigger that fallback.

The normal forwarding helper proactively refreshes an existing near-expiry or
TTL-inconsistent session. A recognized 302 login redirect or HTTP-200 login
HTML triggers one re-login and replay; a missing session can reach this reactive
path. Ordinary 401/429 responses and upstream timeouts are not retried there.
Bulk-report and detail-fetch helpers have their own retry boundaries; do not
assume every upstream action behaves identically.

The HTTP cookie jar is flat name/value state, not a browser's domain/path-aware
cookie store. Cookie deletion/expiry signals are applied during login merging.
Forwarding uses manual redirects, supplies stored cookies instead of client
cookies, and strips upstream `Set-Cookie`. `expiresAtMs` is a freshness timestamp,
not automatic deletion of persisted cookies. Expiry and stale-lock recovery are
request-driven; there is no DO session alarm in this implementation.

## Snapshot synchronization

Bulk snapshots mirror customer -> address -> container rows for local reads.
They are independent of the per-customer refresh after a save.

### One table

The privileged POST endpoints are `/api/v1/customer-snapshot/sync`,
`/api/v1/address-snapshot/sync` and `/api/v1/container-snapshot/sync`.
Each requires a configured `*_REPORT_QUERY_ID` or `*_REPORT_EXPORT_PATH`;
the query ID takes precedence. Missing source configuration returns 503.

A table runner obtains CSV from WebRW with the shared upstream session,
parses rows, batches D1 upserts and reconciles stale rows. Empty reports do not
reconcile-delete; timestamp guards prevent older runs from overwriting or
removing newer rows. Child rows must have their D1 parents. These guards do not
make the entire import a single transaction.

When `SNAPSHOTS_R2_ENABLED="true"`, the R2 wrapper buffers the report CSV before
replaying it into D1, then archives it **after successful D1 sync**. It is not
end-to-end bounded streaming. Archive writes are best-effort: an R2 failure
neither rolls back D1 nor fails the table's completed sync. Daily CSV keys are
overwritten by later same-day runs; a hash/size manifest accompanies the archive.

`?dryRun=true` parses reports and returns would-be counts without D1 writes or
reconcile-deletes, cache invalidation or R2 writes. It can read D1 for deletion
counts and skips FK validation because hypothetical parent writes are absent.
This is still an upstream read, not an offline validation mode.

CSV `...-snapshot/import` routes are a separate path: supplied CSV -> D1,
non-reconciling, no R2 archive, with a 50 MiB input limit. They also support
dry-run. Recovery uses verified archive bytes plus explicit imports, not an
automatic R2-to-D1 restore on every request.

### Chained versus single-invocation bulk sync

Both runners use the same dependency plan: run customer if configured, address
only if both customer and address exports are configured, and container only
if all three are configured. Existing parent rows alone do not enable a
missing parent export step.

| Mode | How work is dispatched | Operation-budget boundary |
|---|---|---|
| Chained HTTP | Sequential authenticated POSTs to each configured table's `/sync`; dry-run propagates. | Each subrequest is a separate Worker invocation with its own D1 budget. |
| Single invocation | Call the table runners sequentially in-process. | All tables share one invocation's D1 operation budget. |

`POST /api/v1/data-snapshot/sync` always uses chained HTTP against the request's
origin. Cron selects the mode as described below. Chaining separates budgets;
it does not prove any individual table fits its budget. Historical batch/scale
measurements and tuning guidance are in [CUSTOMER_SNAPSHOT.md](../CUSTOMER_SNAPSHOT.md).

A failed table stops later steps; earlier successful tables stay changed. The
runner carries partial counts in `PartialDataSnapshotSyncError` for cron logs.
The combined HTTP endpoint normally reaches the generic 500 handler on failure,
not a partial-success response. On success its per-table values are only
`{upserted, rowCount}` or `null`; deletion counts and R2 status are omitted.
Use per-table results/cron evidence to inspect archive outcomes.

## Data stores

| Store / binding | Owns | Does not own |
|---|---|---|
| Routeware WebRW | Authoritative operational records and login/form state. | Shadow bearer authentication or D1/R2 mirrors. |
| `AUTH_SESSION` DO | Primary upstream session and login lock; separate `auth-throttle:<client-ip>` instances hold bearer-throttle state. | Snapshot rows, bulk-sync locking or an upstream HTTP proxy. |
| `CUSTOMER_DB` (D1) | `customer_snapshot`, `address_snapshot`, `container_snapshot`, plus `cron_sync_state`. | Upstream cookies or archive bytes. |
| `SNAPSHOTS` (R2) | Report CSV archives and integrity manifests. | Queryable hydrated records or a live session. |
| `caches.default` | Entity/ID hydrated JSON bundles and ETags; cached responses have `private, max-age=60`. | Source-of-truth records. Bulk CSV sync/import does not explicitly evict these bundles. |
| Worker isolate memory | Customer anti-forgery token cache, scoped by session cookie and exact modal URL; cron overlap flag. | Durable coordination across isolates. |

`BROWSER` is a login service binding, not another data store. Customer records,
exports and cached aggregates contain PII: do not put real rows, cookies,
credentials or upstream bodies in logs, examples or committed fixtures.

## Cron and session alarms

The committed [wrangler.toml](../wrangler.toml) configures **`0 7 * * *`**, daily
at **07:00 UTC**, to call the Worker's `scheduled()` handler. The handler puts
bulk sync in `ctx.waitUntil`; it does not enter through the public client
bearer middleware.

- A `SHADOW_API_PUBLIC_BASE` accepted by `resolveChainedBase` selects chained
  HTTP. Configure a bare Worker origin: the subrequests carry the sync-secret
  bearer and pass the ordinary per-table routes.
- An absent or resolver-rejected base selects the single-invocation fallback
  and logs the shared-budget risk. The committed empty default selects it.
- There is no dedicated cron-enabled flag in the handler.
  `SNAPSHOTS_R2_ENABLED` controls **archival only**, not whether cron runs.

The resolver does not reject every non-bare input: empty query/fragment
delimiters such as `https://shadow.example/#` can pass its parsed-component
checks. Because the original string is then concatenated with the sync path,
that example puts the path in a fragment and requests `/`, not `/api/v1/...`.
Do not rely on malformed configuration always falling back safely.

`syncInFlight` skips overlapping scheduled bodies on the **same isolate**. It
is not a distributed lock, does not cover manual syncs and is separate from
the DO's login lock. A skipped overlap leaves the persisted last real run
unchanged. Cron reports success, unconfigured, failed or skipped-overlap;
counts/status are best-effort persisted in `cron_sync_state` for readiness.
Caught failures are logged rather than rethrown, so a platform event's success
alone does not prove snapshots are fresh.

**There is no `AuthSession.alarm()` or `setAlarm` at this implementation.**
Session TTL checks and lock recovery happen on requests; Worker cron refreshes
snapshots, not a separate DO alarm. The filename `CRON-SYNC-ALARM-RUNBOOK.md`
refers to operational alerting, not a DO alarm implementation.

These are repository configuration/implementation facts, not evidence of the
live deployment's trigger, overrides, data freshness or capacity.

## Source map and further reading

Source files are for maintainers; the trace above is sufficient to follow a
write without opening them.

| Responsibility | Source |
|---|---|
| HTTP entry, auth order, route mounts | [worker.ts](../src/worker.ts), [app.ts](../src/app.ts), [auth.ts](../src/lib/auth.ts), [shared.ts](../src/routes/shared.ts) |
| Hydrated GET/POST contracts and save outcomes | [dataEntity.ts](../src/routes/dataEntity.ts), [dataEntityHandlers.ts](../src/lib/dataEntityHandlers.ts), [routewarePostResult.ts](../src/lib/routewarePostResult.ts) |
| Form token preparation and graph reconciliation | [customerSaveAutoToken.ts](../src/lib/customerSaveAutoToken.ts), [addressContainerSaveForm.ts](../src/lib/addressContainerSaveForm.ts), [detailFullSync.ts](../src/lib/detailFullSync.ts) |
| Session storage, refresh locking, login and egress | [authSession.do.ts](../src/authSession.do.ts), [sessionRefreshLock.ts](../src/lib/sessionRefreshLock.ts), [establishSession.ts](../src/lib/establishSession.ts), [forwardWithSessionRetry.ts](../src/lib/forwardWithSessionRetry.ts), [upstreamForward.ts](../src/lib/upstreamForward.ts) |
| Bulk sync, archive and scheduled dispatch | [orchestration.ts](../src/lib/snapshot/orchestration.ts), [streamSync.ts](../src/lib/snapshot/streamSync.ts), [r2SnapshotArchive.ts](../src/lib/r2SnapshotArchive.ts), [scheduled.ts](../src/scheduled.ts) |

Operational details: [CONVENTIONS.md](CONVENTIONS.md),
[PROBLEMS.md](PROBLEMS.md), [CRON-SYNC-ALARM-RUNBOOK.md](CRON-SYNC-ALARM-RUNBOOK.md),
[R2-RESTORE-RUNBOOK.md](R2-RESTORE-RUNBOOK.md) and [HANDOVER.md](HANDOVER.md).

Platform terminology: Cloudflare's [Durable Objects storage overview](https://developers.cloudflare.com/durable-objects/),
[Cron Triggers (UTC)](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
and [scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/).
