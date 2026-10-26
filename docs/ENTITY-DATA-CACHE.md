# Entity data cache — TTL tuning guidance

The `GET /api/v1/data/customer|address|container` routes serve customer PII out
of D1 snapshots, fronted by the Workers Cache API (`src/lib/entityDataCache.ts`).
This note records where freshness comes from and how to tune it for **single-ID**
reads. Batch `ids` reads bypass this cache: their typed `{entries}` response is
always `no-store`, has no ETag, ignores `If-None-Match` and never returns 304.
Batch entries stay full; `ids` plus any fieldset is a value-free 400. See the
[single-or-batch contract](CONSUMER-QUICKSTART.md#typed-single-or-batch-hydrated-responses).

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

## Sparse representations

Single-ID hydrated reads accept `fields` for only the requested root object:
`.customer`, `.address` or `.container`, always retaining its primary ID. Other
bundle members remain unchanged. For example, the synthetic request
`/api/v1/data/address?id=10&fields=city` retains `pickup_address_id` and `city`
in `.address`, but still returns the full `.customer` and `.containers`.

The canonical cache key and stored full body are unchanged. A selected read
uses the warm full body or ordinary full D1 hydration on a miss, then projects
without mutating the canonical bundle. A cold read may populate only the full
canonical response; selected bodies are never cached there. There is no
second cache and no reduction in cold D1 query work.

`ETag` and the 200's `X-Entity-ETag` hash exactly the served projected bundle
bytes. The full representation's early conditional shortcut is not used for
selected reads: only the projected hash can produce an empty-body 304. Store
validators per request URL/selector, including for alternating selections.
After ordinary expiry/invalidation, a selected-out root change need not alter
the projected hash, but selected values and related bundle changes do. Every
selected 200/304 keeps the same `private, max-age=60` policy. Omitting `fields`
keeps the existing full response, validators and cache path unchanged.

Strict selector validation occurs after authorization and before any cache
lookup or D1 read, including requests with a matching full validator. Invalid
selectors cannot return a cached full body or 304.

Per-type `fields[customer]` / `fields[address]` / `fields[container]`
selectors extend the same shaping to nested relations: a listed type projects
everywhere it appears (root and relations) while omitted types stay full.
Flat `fields` plus `fields[<root>]` together is a 400, so a request carries at
most one root selector. Unknown `fields[TYPE]` keys are value-free 400s after
auth and before any cache lookup. The canonical full cache, the single-cache
invariant and per-representation validators above apply unchanged to every
typed combination; there is still no second cache and no reduction in cold D1
query work.

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

Every successful `getCachedDataEntity` lookup emits one structured event,
passed as a single object to `console.info` (a rejected lookup emits one extra
`warn` diagnostic plus the usual miss event — see Lookup failures below):

```json
{"level":"info","msg":"Entity data cache hit","route":"cache.entityData","ms":null,"entity":"customer","hits":3,"misses":1}
```

A miss has `"msg":"Entity data cache miss"`. `entity` is the kind
(`customer`, `address`, or `container`); `hits` and `misses` are the running
totals for that kind.

Counts only — no ids, no bodies, no ETags (customer PII lives behind these
keys). In `wrangler dev`, repeat `GET /api/v1/data/customer?id=<id>` calls
show `miss` then `hit`; a POST to the matching save route evicts the entry, so
the next GET logs `miss` again. `getEntityDataCacheStats()` exposes the same
counters programmatically; `resetEntityDataCacheStats()` clears them.

### Lookup failures

When `Cache.match` itself rejects (a transient platform error, not an absent
entry), the read is not failed: the rejection counts as exactly one miss and
the request continues through the normal D1 bundle/ETag path, returning the
same 200/304/404 the miss would have produced. The call emits one extra
`warn` diagnostic alongside the usual miss event:

```json
{"level":"warn","msg":"Cache lookup failed; reading from D1 instead","route":"cache.entityData","ms":null,"entity":"customer","kind":"Error"}
```

`kind` is the `errorKind` classification only (`Error`, a subclass name, or
`unknown`) — never the key, id, URL, or exception text. Troubleshooting: a
single line needs no action (the D1 read still served); a burst of them with
`misses` climbing and `hits` flat means lookups are failing and every read is
paying a D1 round trip — check Cloudflare status and Workers Cache health, not
the D1 data. Genuine D1 errors still surface as sanitized 500 problems, and
invalidation failures still fail loud; only the lookup is contained. Hermetic
regression: `npx vitest run test/entityCacheReadFailure.acceptance.test.ts`.
