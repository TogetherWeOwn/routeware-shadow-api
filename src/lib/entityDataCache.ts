/**
 * HTTP Cache API (Workers) + ETag for GET /api/v1/data/*.
 * Stale on any successful write for affected entity ids.
 */

const workersCache: Cache = (caches as unknown as { default: Cache }).default;

function cacheKeyUrl(entity: "customer" | "address" | "container", id: number): string {
  return `https://routeware-shadow-entity/v1/${entity}/${id}`;
}

export async function getCachedDataEntity(
  entity: "customer" | "address" | "container",
  id: number
): Promise<Response | undefined> {
  return workersCache.match(new Request(cacheKeyUrl(entity, id), { method: "GET" }));
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
  entity: "customer" | "address" | "container",
  id: number,
  response: Response
): Promise<void> {
  try {
    await workersCache.put(
      new Request(cacheKeyUrl(entity, id), { method: "GET" }),
      response.clone()
    );
  } catch (err) {
    console.warn(
      `Cache put failed for ${entity}/${id}; serving the response uncached:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

export async function invalidateDataEntity(
  entity: "customer" | "address" | "container",
  id: number
): Promise<void> {
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
 * TOG-5937: invalidations run in bounded sequential chunks rather than one
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
