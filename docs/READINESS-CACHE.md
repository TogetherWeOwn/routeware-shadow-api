# Readiness probe caching

`GET /api/v1/readiness` keeps its existing authenticated 200/503 JSON contract.
The dependency observations are cached **in memory for 20 seconds**:

- D1: one `SELECT 1 AS ok` ping.
- R2: whether the `SNAPSHOTS` binding exists and archiving is enabled. This is
  still a binding check, **not** an R2 read/write or permission test.
- Advisory cron: one `SELECT ... FROM cron_sync_state`, including its last-run
  timestamps, counts, outcomes, and 48-hour staleness result. Caching this read
  is necessary to cap the **total** D1 queries at two per refresh.

Healthy, degraded, failed and timed-out observations are cached. Hits do not
extend the TTL; expiry is inclusive at 20 seconds from **refresh start**, not
completion. Concurrent cold hits share the pending refresh instead of issuing
new queries. The next hit after expiry starts one new shared refresh, allowing
recovery without a query burst. Changes to D1 availability or cron state may
therefore remain invisible until that next refresh completes.

Ping and cron observations start concurrently, each with the same finite
response-wait budget: `READINESS_REFRESH_BUDGET_MS =
Math.min(DEFAULT_UPSTREAM_TIMEOUT_MS, READINESS_CACHE_TTL_MS)` in
`src/lib/readiness.ts`, currently **15 seconds**, not 15 seconds per sequential
query. Neither environment timeout overrides nor cache hits extend this budget.
A hung ping returns degraded HTTP 503. A hung cron read reports stale/unknown
cron state but remains advisory: otherwise-healthy readiness still returns 200.
The timers are cleared when each observation settles; there is no scheduled or
background refresh.

**Response timeout is not query cancellation.** D1 work may continue after its
observation times out. Its late resolution or rejection is consumed without
changing the settled observation or overwriting a newer cache entry. Expiry
permits another refresh even if the old underlying query has not finished, so
the two-query limit is per refresh, not a bound on outstanding D1 operations.

The cache uses weak environment keys and lives only in the current Worker
isolate. It is best-effort, not a fleet-wide query limit: new environments,
cold starts, isolate eviction, or requests routed to other isolates can each
perform their own refresh. A change to the D1 binding, R2 binding, or effective
`SNAPSHOTS_R2_ENABLED` flag invalidates the local entry immediately. This also
handles binding-only deployments that reuse an isolate; see
[Cloudflare's binding lifecycle documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings).

Report-source configuration is recomputed on every request. Bearer authentication
still runs before the readiness route on every request; neither credentials nor
authorization decisions are cached. Existing status/check fields and healthy JSON
are unchanged; there is no cache metadata. Cron remains advisory (it cannot flip
the overall HTTP status).

## Sanitized recovery diagnostics

Failed dependency observations add only these fixed allowlisted fields:

| Check | `code` | `next_action` |
| --- | --- | --- |
| D1 ping timeout | `d1_ping_timeout` | `retry_after_cache_ttl` |
| D1 ping failure | `d1_ping_failed` | `retry_after_cache_ttl` |
| Cron observation timeout | `cron_state_timeout` | `retry_after_cache_ttl` |
| Cron observation failure/unreadable state | `cron_state_failed` | `retry_after_cache_ttl` |

Wait a cache TTL (20 seconds) before retrying; do not spin on a cached failure.
Cron failures keep `stale: true`, `lastRunAt: null` and null table observations.
An empty successful cron read still means no run recorded; it is not a query
failure. Missing D1/R2 bindings, report configuration and cron staleness retain
their existing fixed status/detail guidance. Dependency exceptions are never
read, stringified or logged by readiness: no error messages, stacks, query text,
environment values or customer data are copied into failure diagnostics.
No new variable, credential, destination or permission is required.

## Local acceptance check

Run without production credentials or a live database:

```sh
npx vitest run test/readinessBoundedDependencies.acceptance.test.ts test/readinessCache.test.ts test/readiness.test.ts
npm run typecheck
npm run check:openapi-drift
```

The cache tests count actual fake-D1 statement executions for ten sequential
route hits and ten concurrent cold route hits: each burst runs **exactly two
queries** (one ping and one cron read). They pin the exact healthy JSON payload,
validate the existing schema, and cover TTL boundaries, degraded-result recovery,
binding invalidation, environment isolation, fresh config, and caller mutation.
The bounded-dependency acceptance suite uses deferred promises and controlled
time for ten-caller hangs, independent ping/cron failures, inclusive expiry
recovery, late resolution/rejection and marker-bearing exceptions. It denies
unexpected network calls and checks schema round-tripping, real Worker bearer
middleware and no-store responses. No test calls production D1 or R2. Run
`npm test` before PR readiness for the full local regression suite.

## Rollback

Revert the bounded-observation change through the approved release path. This
retains the existing cache but restores unbounded response waits and the old D1
error detail; it therefore reintroduces the hang/leak risks. No migrations,
data changes, new bindings or persistent state need cleanup.
