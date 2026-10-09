# Entity data cache — TTL tuning guidance

The `GET /api/v1/data/customer|address|container` routes serve customer PII out
of D1 snapshots, fronted by the Workers Cache API (`src/lib/entityDataCache.ts`).
This note records where freshness comes from and how to tune it.

## Where the TTL lives

- One constant: `ENTITY_DATA_CACHE_MAX_AGE_SECONDS` in
  `src/lib/entityDataCache.ts` (currently 60). Every 200 and 304 served by
  `src/lib/dataEntityHandlers.ts` uses `entityDataCacheControlValue()`, which
  renders `private, max-age=<that constant>`.
- The freshness TTL is the `Cache-Control` header stored on each cached 200 —
  `cache.put()` takes no per-entry TTL argument, so there is no second knob.
  All three entity kinds (customer, address, container) share the one value.
- Writes evict, they do not wait for expiry: every successful POST runs
  `invalidateCustomerGraph` (or the single-entity fallback), so the TTL only
  bounds how long an **unwritten** entry stays warm.

## Tuning

- **Lower the TTL** (e.g. 30 s) if clients report seeing pre-write data after a
  save that returned 200 — that means an invalidation was missed, and a shorter
  TTL narrows the stale window. Then fix the invalidation path; the TTL is a
  backstop, not the freshness mechanism.
- **Raise the TTL** (e.g. 300 s) if hit rates are low and D1 read volume is the
  bottleneck — safe only because writes evict. Never raise it to cover for a
  broken invalidation path: a silently failed invalidation serves superseded
  PII for the full TTL.
- Change the constant, not the call sites; the per-file coverage gate and
  `test/entityDataCache.test.ts` pin the wiring.

## Observability

Every `getCachedDataEntity` call emits one structured event. For example:

```json
{"level":"info","msg":"Entity data cache miss","route":"cache.entityData","ms":null,"entity":"customer","hits":0,"misses":1}
```

Events carry only the entity kind and per-isolate aggregate counters — no ids,
bodies, or ETags (customer PII lives behind these keys). In `wrangler dev`,
repeated `GET /api/v1/data/customer?id=<id>` calls show a miss then a hit; a POST
to the matching save route evicts the entry, so the next GET logs another miss.
A cache-write failure emits a `warn` event with `msg` set to
`Cache put failed; serving the response uncached`. `getEntityDataCacheStats()`
exposes the same counters programmatically; `resetEntityDataCacheStats()` clears
them.
