/**
 * HTTP Cache API (Workers) + ETag for GET /api/v1/data/*.
 * Stale on any successful write for affected entity ids.
 *
 * TTL review: freshness comes from the `Cache-Control` header stored
 * on each cached 200 (`private, max-age=<ENTITY_DATA_CACHE_MAX_AGE_SECONDS>`),
 * not from a `cache.put` option — the Cache API has no per-entry TTL argument.
 * All three entity kinds share one TTL; writes evict via
 * `invalidateCustomerGraph`, so the TTL only bounds how long an *unwritten*
 * entry stays warm. See `docs/ENTITY-DATA-CACHE.md` for tuning guidance.
 */

import { errorKind, logEvent } from "./logger";

/**
 * Shared freshness TTL (seconds) for all three data-entity kinds. The value is
 * referenced by `entityDataCacheControlValue()` and consumed by
 * `src/lib/dataEntityHandlers.ts` for every 200 and 304 it serves — change it
 * here, not at the call sites.
 */
export const ENTITY_DATA_CACHE_MAX_AGE_SECONDS = 60;

/** The `Cache-Control` value stored on cached 200s and sent on 304s. */
export function entityDataCacheControlValue(): string {
  return `private, max-age=${ENTITY_DATA_CACHE_MAX_AGE_SECONDS}`;
}

export type EntityKind = "customer" | "address" | "container";

export type EntityCacheCounters = { hits: number; misses: number };

const stats: Record<EntityKind, EntityCacheCounters> = {
  customer: { hits: 0, misses: 0 },
  address: { hits: 0, misses: 0 },
  container: { hits: 0, misses: 0 }
};

/** Snapshot of the per-kind hit/miss counters (copies, not live refs). */
export function getEntityDataCacheStats(): Record<EntityKind, EntityCacheCounters> {
  return {
    customer: { ...stats.customer },
    address: { ...stats.address },
    container: { ...stats.container }
  };
}

/** Reset the hit/miss counters (tests; also handy in dev). */
export function resetEntityDataCacheStats(): void {
  for (const kind of Object.keys(stats) as EntityKind[]) {
    stats[kind].hits = 0;
    stats[kind].misses = 0;
  }
}

const workersCache: Cache = (caches as unknown as { default: Cache }).default;

function cacheKeyUrl(entity: EntityKind, id: number): string {
  return `https://routeware-shadow-entity/v1/${entity}/${id}`;
}

/**
 * Read one cached entity. Only a *rejected* `Cache.match` lookup falls back:
 * it counts as exactly one miss and execution continues through the normal
 * D1 bundle/ETag path, so a transient cache outage cannot turn healthy D1
 * data into a 500. One attempt only — no retry. The catch is scoped to the
 * lookup alone: population stays best-effort (`putCachedDataEntity`) and
 * invalidation stays loud (`invalidateDataEntity`), and D1/auth/parse errors
 * are untouched.
 */
export async function getCachedDataEntity(
  entity: EntityKind,
  id: number
): Promise<Response | undefined> {
  let entry: Response | undefined;
  try {
    entry = await workersCache.match(
      new Request(cacheKeyUrl(entity, id), { method: "GET" })
    );
  } catch (err) {
    // Diagnostic carries the error kind only — never the key, id, URL, or
    // exception text. The shared miss event below records the counters.
    logEvent({
      level: "warn",
      msg: "Cache lookup failed; reading from D1 instead",
      route: "cache.entityData",
      entity,
      kind: errorKind(err)
    });
  }
  const counters = stats[entity];
  if (entry) {
    counters.hits += 1;
  } else {
    counters.misses += 1;
  }
  // Counts only — never the id. Customer PII lives behind these keys, so the
  // log event carries the entity kind and the running totals, nothing else.
  logEvent({
    level: "info",
    msg: entry ? "Entity data cache hit" : "Entity data cache miss",
    route: "cache.entityData",
    entity,
    hits: counters.hits,
    misses: counters.misses
  });
  return entry;
}

/**
 * Populate the cache. Best-effort by design: the response is already computed and
 * valid, so a cache write that fails (oversized body, transient platform error)
 * must not turn a good 200 into a 500. Failures are logged, never rethrown.
 *
 * Note the asymmetry with `invalidateDataEntity`, which deliberately does NOT
 * swallow errors — a failed invalidation means stale data would be served.
 */
export async function putCachedDataEntity(
  entity: EntityKind,
  id: number,
  response: Response
): Promise<void> {
  try {
    await workersCache.put(
      new Request(cacheKeyUrl(entity, id), { method: "GET" }),
      response.clone()
    );
  } catch (err) {
    logEvent({
      level: "warn",
      msg: "Cache put failed; serving the response uncached",
      route: "cache.entityData",
      entity,
      kind: errorKind(err)
    });
  }
}

export async function invalidateDataEntity(entity: EntityKind, id: number): Promise<void> {
  await workersCache.delete(new Request(cacheKeyUrl(entity, id), { method: "GET" }));
}

export async function sha256Etag(s: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Invalidate a customer, its addresses, and all containers in one graph (after writes).
 *
 * Invalidations run in bounded sequential chunks rather than one
 * `Promise.all` over the whole graph, so a very large customer cannot fan out
 * tens of thousands of concurrent cache deletes in a single invocation.
 * Failure semantics are unchanged: any single failure still rejects, leaving
 * the graph partially invalidated (the caller must not report success).
 */
export const INVALIDATE_GRAPH_CHUNK_SIZE = 200;

export async function invalidateCustomerGraph(params: {
  customerId: number;
  addressIds: number[];
  containerIds: number[];
}): Promise<void> {
  const { customerId, addressIds, containerIds } = params;
  const ops: Array<() => Promise<void>> = [
    () => invalidateDataEntity("customer", customerId),
    ...addressIds.map((id) => () => invalidateDataEntity("address", id)),
    ...containerIds.map((id) => () => invalidateDataEntity("container", id))
  ];
  for (let i = 0; i < ops.length; i += INVALIDATE_GRAPH_CHUNK_SIZE) {
    await Promise.all(ops.slice(i, i + INVALIDATE_GRAPH_CHUNK_SIZE).map((op) => op()));
  }
}

/**
 * Bounded retry around `invalidateCustomerGraph`.
 *
 * A mid-graph throw leaves the graph partially invalidated — the deletes
 * before the failure landed, the rest did not — and the POST handlers cannot
 * resume the remainder from the single customer id alone, so stale
 * address/container PII keeps serving. Cache deletes are idempotent, so the
 * whole graph is simply attempted again, up to `maxAttempts` total tries.
 * Each failed attempt is logged server-side (error only, never bodies); if
 * every attempt fails the last error propagates — the same loud contract as
 * `invalidateCustomerGraph`, so the caller still must not report success.
 */
export const INVALIDATE_GRAPH_MAX_ATTEMPTS = 2;

export async function invalidateCustomerGraphWithRetry(
  params: {
    customerId: number;
    addressIds: number[];
    containerIds: number[];
  },
  maxAttempts: number = INVALIDATE_GRAPH_MAX_ATTEMPTS
): Promise<void> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  let lastError: unknown = new Error("invalidateCustomerGraphWithRetry: no attempts made");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await invalidateCustomerGraph(params);
      return;
    } catch (e) {
      lastError = e;
      logEvent({
        level: "error",
        msg: "Customer cache graph invalidation failed",
        route: "cache.customerGraph.invalidate",
        attempt,
        attempts
      });
    }
  }
  throw lastError;
}
