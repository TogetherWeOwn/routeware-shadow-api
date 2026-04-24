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

export async function putCachedDataEntity(
  entity: "customer" | "address" | "container",
  id: number,
  response: Response
): Promise<void> {
  await workersCache.put(
    new Request(cacheKeyUrl(entity, id), { method: "GET" }),
    response.clone()
  );
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

/** Invalidate a customer, its addresses, and all containers in one graph (after writes). */
export async function invalidateCustomerGraph(params: {
  customerId: number;
  addressIds: number[];
  containerIds: number[];
}): Promise<void> {
  const { customerId, addressIds, containerIds } = params;
  await Promise.all([
    invalidateDataEntity("customer", customerId),
    ...addressIds.map((id) => invalidateDataEntity("address", id)),
    ...containerIds.map((id) => invalidateDataEntity("container", id))
  ]);
}
