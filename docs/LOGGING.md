# Structured application logs

Application code writes one structured log event through `logEvent` in `src/lib/logger.ts`. Each event has the same fields:

- `level`: `info`, `warn`, or `error`
- `msg`: a stable, human-readable event summary
- `route`: a static route or operation label; do not include request values or identifiers
- `ms`: elapsed milliseconds when measured, otherwise `null`

Additional context is limited to the fields declared by `LogEventInput`; unknown keys are dropped at runtime, and nested values are accepted only for the validated per-table aggregate counts. Callers must still pass only fixed or allowlisted values — never request payloads, business/customer identifiers (except the numeric internal `customerId` on `sync.detailFull` utilization lines, see below), raw exceptions, or customer data. Failure records that need a cause pass `kind: errorKind(err)`: the class name of the innermost error in its `cause` chain whose class is not the generic `Error` (`Error` when none is named), never its message (for example `ChainedHttpError`, `ChainedTimeoutError`, `SnapshotForeignKeyError` or `SessionCookiesMissing`). On the chained-HTTP path, wire R2 metadata is projected to `status` and fixed reason classifications only: keys, unknown properties, nested values and arbitrary driver text are dropped before reporting. The single-invocation fallback still carries its local R2 driver's message at `tables.<table>.r2.reason`. Chained failures additionally carry the fixed `next_action: inspect_table_sync_before_resubmitting`; unknown action values are dropped by the logger. See [the chained response boundary](CRON-SYNC-ALARM-RUNBOOK.md#41-chained-response-boundary).

Example fail-open event:

```json
{"level":"error","msg":"AUTH THROTTLE FAIL-OPEN","route":"authThrottle.failOpen","ms":null,"reason":"do_error"}
```

Log stable summaries only. Do not pass exception objects, exception messages, request bodies, credentials, or customer data; those values can contain sensitive information. The helper dispatches at the matching console severity while passing the event object so Cloudflare Workers Logs can index its fields. Cloudflare recommends logging JSON objects for searchable fields and supports `console.info`, `console.warn`, and `console.error` in Workers:

- [Workers Logs: structured JSON logging](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Console API](https://developers.cloudflare.com/workers/runtime-apis/console/)

`npm run lint` parses TypeScript under `src/` and rejects direct `console.*` access. The severity dispatch in `src/lib/logger.ts` is the only permitted console call.

## Request correlation (`requestId`)

Every `app.onError` line carries `requestId`: the id the earliest
`/api/v1/*` middleware adopted from the inbound `X-Request-Id` header (1–128
chars of RFC 7230 token chars) or minted as a UUID when absent or invalid.
The same id is echoed on the `X-Request-Id` response header and carried in
the gate/notFound/onError problem bodies, so one value joins a client
attempt (including retries, when the client reuses its id) to its server-side
log line: search Workers Logs for the echoed `requestId`. Route-level log
lines do not carry it (onError + gate only).

## Event catalogue

One row per distinct `msg` emitted under `src/` — the operator's search list for Workers Logs: what can fire, at which level, under which `route`, and what to do about it. `test/loggingCatalogueCoverage.test.ts` pins this table: it fails when a string-literal `msg` in `src/` has no row here, when a row names a message `src/` no longer emits, and when a `logEvent` call site is neither a string literal nor a known computed call site. Add the row in the same PR as any new `logEvent` call; never edit message text, level, or fields here — change the call site instead.

Three messages are computed, never string literals, so the test carries them as an explicit allowlist verified verbatim against their source files, and each appears below once in placeholder form: `Entity data cache hit` and `Entity data cache miss` (a ternary in `src/lib/entityDataCache.ts`), and the `SNAPSHOT_EXPORT_PAGE_SIZE ignored …` template (interpolated numbers in `src/lib/snapshot/export.ts`, shown with its `${…}` placeholders — search the `SNAPSHOT_EXPORT_PAGE_SIZE ignored` prefix in logs).

| msg | level | route(s) | when it fires | operator action |
|-----|-------|----------|---------------|-----------------|
| `AUTH THROTTLE FAIL-OPEN` | error | `authThrottle.failOpen` | Throttle Durable Object call failed or returned malformed data; the request was allowed through fail-open (at most once per window) | Investigate: `reason` is `do_error`, `do_non_ok status=N`, or `do_malformed`. Repeated lines mean throttling is blind — treat as an incident. |
| `Address save token preparation failed` | error | `POST /api/v1/routeware/address/save-address-form` | Save-address form POST could not prepare session or body tokens (missing CustomerID or upstream shape change) | Fix the request (new addresses need CustomerID). If valid requests keep failing, check upstream markup and establishSession. |
| `Address snapshot dry run: validating without writing D1 or R2` | info | `snapshot.address` | Dry-run sync validated the upstream CSV without writing D1 or R2 | none, informational. |
| `Address snapshot sync skipped because customer is not configured` | info | `snapshot.orchestration` | Address source is configured but the customer source is not, so address sync was skipped (customer is the parent) | none, informational — configure the customer source to enable address sync. |
| `Address snapshot sync skipped: source is not configured` | info | `snapshot.address`, `snapshot.orchestration` | No address report path or query ID configured | none, informational — set ADDRESS_REPORT_EXPORT_PATH or ADDRESS_REPORT_QUERY_ID to enable. |
| `Browser authentication failed` | error | `auth.browser` | Any failure of the Browser Rendering login in `establishSessionWithBrowser`; `kind` names the failure class | Act on `kind`: `MissingCredentials` — set the `LOGIN_USERNAME` and `LOGIN_PASSWORD` secrets; `SessionCookiesMissing` — verify the account (wrong password, MFA or lockout) or a changed login form, e.g. by logging in to Routeware manually; other kinds (browser launch, navigation or selector timeouts) — check Browser Rendering availability and the login page. |
| `Cache lookup failed; reading from D1 instead` | warn | `cache.entityData` | Workers Cache lookup rejected (transient platform error); counted as one miss and the read continued through the normal D1 bundle/ETag path. Carries the entity kind and the `kind` error classification only — never the key, id, URL, or exception text | none required — the D1 read still served. Watch for trends: repeated lines mean lookups are failing and every read pays a D1 round trip; see `docs/ENTITY-DATA-CACHE.md` §Observability. |
| `Cache put failed; serving the response uncached` | warn | `cache.entityData` | Workers Cache write failed (oversized body or transient platform error); the already-computed response was still served | none required — served uncached. Watch for trends: repeated lines mean the cache is ineffective. |
| `Concurrent session refresh timed out` | error | `app.onError` | A waiter gave up on a hung concurrent session refresh; surfaced as 502. Logged only from this `app.onError` backstop — session-retry routes return the same 502 without logging (see the `Upstream request timed out` row) | Check the auth refresh lock and upstream responsiveness; retry once. Do not read a low count of these lines as few timeouts. |
| `Container save token preparation failed` | error | `POST /api/v1/routeware/container/save-container-form` | Save-container form POST could not prepare session or body tokens (missing PickupAddressID or upstream shape change) | Fix the request (new containers need PickupAddressID). If valid requests keep failing, check upstream markup. |
| `Container snapshot dry run: validating without writing D1 or R2` | info | `snapshot.container` | Dry-run sync validated the upstream CSV without writing D1 or R2 | none, informational. |
| `Container snapshot sync skipped because a required parent source is not configured` | info | `snapshot.orchestration` | Container source is configured but a required parent (customer or address) is not, so container sync was skipped | none, informational — configure the parent source to enable container sync. |
| `Container snapshot sync skipped: source is not configured` | info | `snapshot.container`, `snapshot.orchestration` | No container report path or query ID configured | none, informational — set CONTAINER_REPORT_EXPORT_PATH or CONTAINER_REPORT_QUERY_ID to enable. |
| `Customer cache graph invalidation failed` | error | `cache.customerGraph.invalidate` | One attempt to invalidate the customer graph (customer plus sibling address and container keys) failed; retried up to `attempts`. `attempt` numbers the failed try | Check `attempt` and `attempts`. A final throw after the last attempt leaves stale cache — re-save or re-invalidate; investigate cache health if repeated. |
| `Customer save token preparation failed` | error | `POST /api/v1/routeware/customer/save-long-form` | Save-long-form POST could not prepare session or body tokens | Fix the request body. If valid requests keep failing, check upstream markup. |
| `Customer snapshot dry run: validating without writing D1 or R2` | info | `snapshot.customer` | Dry-run sync validated the upstream CSV without writing D1 or R2 | none, informational. |
| `Customer snapshot sync skipped: source is not configured` | info | `snapshot.customer`, `snapshot.orchestration` | No customer report path or query ID configured | none, informational — set CUSTOMER_REPORT_EXPORT_PATH or CUSTOMER_REPORT_QUERY_ID to enable. |
| `Detail-full sync D1 op-budget utilization` | info | `sync.detailFull` | Successful detail-full D1 refresh; includes graph shape, modeled D1 ops and cache invalidations against their budgets | none, informational — use the counts to monitor budget headroom. |
| `Entity data cache hit` | info | `cache.entityData` | Workers Cache lookup found an entry; carries the entity kind and running hit and miss totals, never the id | none, informational. |
| `Entity data cache miss` | info | `cache.entityData` | Workers Cache lookup found no entry; an upstream fetch follows | none, informational — sustained misses mean low cache effectiveness, not an error. |
| `Failed to release the auth refresh lock; it will expire via its TTL` | warn | `auth.refreshLock` | Unlock call to the auth Durable Object failed; the lock expires on its own | none required — the TTL heals it. Investigate DO reachability only if every refresh logs this. |
| `HTTP authentication failed; falling back to Browser Rendering` | warn | `auth.login` | Direct HTTP login failed with a retryable shape; retrying once via Browser Rendering | none required on its own. Watch: every login taking this path means HTTP auth is broken or upstream markup changed. |
| `Invalid AUTH_MODE configuration` | error | `app.onError` | AUTH_MODE holds a value outside the closed set; surfaced as 503 | Fix AUTH_MODE to a supported value and redeploy. |
| `Invalid REPORT_QUERY date configuration` | error | `app.onError` | REPORT_QUERY_START_DATE or REPORT_QUERY_END_DATE is not a real yyyy-MM-dd date, or start is after end; surfaced as 503 without echoing the configured values | Set valid calendar dates with start on or before end, then redeploy. |
| `Local address snapshot sync failed` | error | `POST /api/v1/data/address` | Post-save local address graph sync (detail-full to D1 plus graph invalidation) threw; the response carries a degraded localSync | Check `kind`; verify D1 against cache state and re-sync the customer graph if needed. |
| `Local container snapshot sync failed` | error | `POST /api/v1/data/container` | Post-save local container graph sync threw; the response carries a degraded localSync | Check `kind`; verify D1 against cache state and re-sync the customer graph if needed. |
| `Local customer snapshot sync failed` | error | `POST /api/v1/data/customer` | Post-save local customer graph sync threw; the response carries a degraded localSync | Check `kind`; verify D1 against cache state and re-sync the customer graph if needed. |
| `Post-save customer cache invalidation failed` | error | `routeware.saveRefresh.invalidate` | Fallback eviction of the customer cache key failed after a sync failure; the save itself had succeeded | Re-invalidate or re-save; reads may be stale until evicted. |
| `Post-save entity cache invalidation failed` | error | `routeware.saveRefresh.invalidate` | Fallback eviction of the posted address or container key failed; the save itself had succeeded | Re-invalidate or re-save; reads may be stale until evicted. |
| `Post-save fallback cache eviction failed` | error | `POST /api/v1/data/customer`, `POST /api/v1/data/address`, `POST /api/v1/data/container` | Cache eviction failed after a successful upstream save and a local-sync failure or missing owner id; the save response remains successful, but affected cache entries may stay stale until TTL expiry | Check `kind`; re-invalidate or re-save. If recurring, investigate Workers Cache health. |
| `Post-save refresh failed` | error | `routeware.saveRefresh` | Post-save refresh threw outside the snapshot-sync path (session or unexpected error); no sync was attempted | Check `kind` and retry the save-refresh; investigate session and auth if repeated. |
| `Post-save snapshot sync failed; evicting affected cache keys` | error | `routeware.saveRefresh` | Post-save detail-full sync to D1 threw; fallback cache eviction ran so reads do not serve rewritten-then-stale rows | Check `kind`; the D1 write may have failed — verify and re-sync. |
| `Pre-save id snapshot unavailable` | error | `POST /api/v1/data/address`, `POST /api/v1/data/container` | The owner-scoped baseline D1 read failed before a create; save and refresh still run, but D1-diff id resolution is disabled | Check `kind` and D1 read health. The create may return a null id without changing `localSync`; do not repeat the save to discover its id. |
| `R2 multipart abort failed; upload may be left dangling` | warn | `snapshot.r2.multipart` | Cleanup abort of a failed multipart upload itself failed; the primary failure is recorded separately | Check the bucket for abandoned multipart uploads (billed until lifecycle cleanup) and abort manually if needed. |
| `R2 snapshot archive disabled` | info | `snapshot.r2.archive` | R2 archiving skipped: bucket, binding, or config missing (`reason` names why); D1 sync still succeeded | none, informational — bind SNAPSHOTS and configure archiving to enable. |
| `R2 snapshot manifest failed validation; replacing` | warn | `snapshot.r2.manifest` | Existing manifest parsed but failed schema validation; replaced with a fresh manifest | none required — the old manifest was corrupt. Investigate only if every run logs this. |
| `R2 snapshot manifest is not JSON; replacing` | warn | `snapshot.r2.manifest` | Existing manifest is not JSON (corrupt or hand-edited); replaced with a fresh manifest | none required — same as above. |
| `R2 snapshot manifest update failed` | error | `snapshot.r2.manifest` | Both CSV copies landed but manifest or latest-pointer publication failed (`key` is the failed stage) | Archive exists but discovery is incomplete — re-run sync or repair the manifest pointer; check R2 write health. |
| `R2 snapshot manifest updated` | info | `snapshot.r2.manifest` | Manifest and latest pointer published after both CSV copies landed | none, informational. |
| `R2 snapshot put failed` | error | `snapshot.r2.archive` | CSV upload to R2 failed; D1 had already succeeded so this stays best-effort (logged, not thrown) and no manifest entry was recorded | Check R2 health and re-archive manually; D1 is the source of truth meanwhile. |
| `R2 snapshot stored` | info | `snapshot.r2.archive` | Both CSV copies landed in R2 | none, informational. |
| `Routeware login page unavailable` | error | `app.onError` | Login page answered non-OK (WAF block or maintenance page); surfaced as 502 and never retried via browser | Check upstream `status` and retry once; if persistent, the upstream host is blocking logins. |
| `Runtime is missing the set-cookie capability` | error | `app.onError` | Runtime lacks Headers.getSetCookie; surfaced as 503 and never retried via browser | Fix the runtime (Workers compat) — a platform gap, not an upstream change. |
| `SHADOW_API_PUBLIC_BASE is not set; data-snapshot-sync is using one invocation` | warn | `scheduled.data-snapshot-sync` | Cron chained sync fell back to a single invocation sharing one D1 budget, so a large export can die partway through | Set SHADOW_API_PUBLIC_BASE so chained sync fans out. |
| `SNAPSHOT_EXPORT_PAGE_SIZE ignored (quote an integer from 1 to ${SNAPSHOT_EXPORT_MAX_PAGE_SIZE}); using ${SNAPSHOT_EXPORT_PAGE_SIZE}` | warn | `snapshotExport.pageSize` | SNAPSHOT_EXPORT_PAGE_SIZE binding was set but invalid (not an integer from 1 to the max); the safe default was used and the live line carries the numbers | Fix the binding to an integer from 1 to 5000, or remove it to silence the warning. |
| `Unhandled request error` | error | `app.onError` | Request threw outside all named backstops; 500 with method and `kind` (the error class chain, never the message) | Investigate with `method` and `kind`; add a named backstop if a new error class emerges. |
| `Upstream request timed out` | error | `app.onError` | Direct upstream forward hung past its timeout; surfaced as 502. Logged only from this `app.onError` backstop: `forwardWithSessionRetry` (the save and read routes) returns the same 502 without logging, so this line under-reports real timeouts and its absence is not evidence none occurred | Check upstream latency and retry once; investigate if repeated — and check 502 counts, not just this line. |
| `data-snapshot-sync` | info | `scheduled.data-snapshot-sync` | Cron data-snapshot-sync emitted its run record: `skipped-overlap` when a previous run was still in flight, otherwise the completion record with `outcome` and per-table counts | none, informational — `skipped-overlap` means the previous run was still in flight. |
| `data-snapshot-sync failed` | error | `scheduled.data-snapshot-sync` | Cron sync threw; emitted with `outcome: failed` | Check the earlier error lines in the same run (`kind`, per-table failures), then re-trigger the cron or run the sync manually. |
| `data-snapshot-sync persistence failed` | error | `scheduled.data-snapshot-sync` | Cron result could not be recorded to D1; the sync result itself stands and the log line is the record | Check D1 health; backfill the cron-run row if history matters. |

## Detail-full sync D1 op-budget utilization

Every successful `syncCustomerDetailFullToD1` run (`src/lib/detailFullSync.ts`) emits exactly one `info` line so operators can see D1 op-budget headroom. Over-budget runs throw fail-closed before the first write and emit no line.

- `msg`: `Detail-full sync D1 op-budget utilization`
- `route`: `sync.detailFull`
- `customerId`: the synced customer id (a numeric internal key, never customer payload data)
- `addressCount` / `containerCount`: the graph shape that was synced
- `d1Ops`: `detailFullD1Ops(addressCount, containerCount)` for the run
- `d1OpsBudget`: `DETAIL_FULL_MAX_D1_OPS`
- `cacheInvalidations`: `detailFullCacheInvalidations(addressCount, containerCount)`
- `cacheInvalidationBudget`: `DETAIL_FULL_MAX_CACHE_INVALIDATIONS`

```json
{"level":"info","msg":"Detail-full sync D1 op-budget utilization","route":"sync.detailFull","ms":null,"customerId":5,"addressCount":3,"containerCount":2,"d1Ops":4,"d1OpsBudget":900,"cacheInvalidations":6,"cacheInvalidationBudget":950}
```

Pinned by `test/detailFullOpBudgetUtilization.test.ts`.
