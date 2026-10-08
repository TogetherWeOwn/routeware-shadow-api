# Readiness probe caching

`GET /api/v1/readiness` keeps its existing authenticated 200/503 JSON contract.
The dependency observations are cached **in memory for 20 seconds**:

- D1: one `SELECT 1 AS ok` ping.
- R2: whether the `SNAPSHOTS` binding exists and archiving is enabled. This is
  still a binding check, **not** an R2 read/write or permission test.
- Advisory cron: one `SELECT ... FROM cron_sync_state`, including its last-run
  timestamps, counts, outcomes, and 48-hour staleness result. Caching this read
  is necessary to cap the **total** D1 queries at two per refresh.

Both healthy and degraded dependency results are cached. A D1 outage, recovery,
or newly persisted cron run may not appear until the next refresh, up to 20
seconds after the refresh began. Hits do not extend the TTL; expiry is inclusive
at 20 seconds. Slow queries consume this window rather than starting a new
20-second window after they complete. Concurrent cold hits share the pending
refresh instead of each issuing their own queries, even if that refresh takes
longer than the TTL. Those requests wait for the original queries; once they
settle, an already-expired entry refreshes on the next hit. No timer or
background refresh runs.

The cache uses weak environment keys and lives only in the current Worker
isolate. It is best-effort, not a fleet-wide query limit: new environments,
cold starts, isolate eviction, or requests routed to other isolates can each
perform their own refresh. A change to the D1 binding, R2 binding, or effective
`SNAPSHOTS_R2_ENABLED` flag invalidates the local entry immediately. This also
handles binding-only deployments that reuse an isolate; see
[Cloudflare's binding lifecycle documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings).

Report-source configuration is recomputed on every request. Bearer authentication
still runs before the readiness route on every request; neither credentials nor
authorization decisions are cached. The JSON has no cache metadata or new fields,
and cron remains advisory (it cannot flip the overall HTTP status).

## Local acceptance check

Run without production credentials or a live database:

```sh
npm test -- test/readinessCache.test.ts test/readiness.test.ts test/cronSyncState.test.ts
```

The cache tests count actual fake-D1 statement executions for ten sequential
route hits and ten concurrent cold route hits: each burst runs **exactly two
queries** (one ping and one cron read). They pin the exact healthy JSON payload,
validate the existing schema, and cover TTL boundaries, degraded-result recovery,
binding invalidation, environment isolation, fresh config, and caller mutation.
The existing readiness tests separately verify the real Worker bearer gate and
OpenAPI 200/503 contract. No test calls production D1 or R2.

## Rollback

Revert the readiness-cache change and redeploy through the approved release
path. This restores per-request checks without migrations, data changes, new
bindings, or persistent state to clean up.
