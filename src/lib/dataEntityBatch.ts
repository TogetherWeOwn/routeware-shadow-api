/**
 * Bounded batch ID lookup for the hydrated data-entity GETs (batch v1).
 *
 * `GET /api/v1/data/{customer,address,container}?ids=1,2,3` hydrates up to
 * `BATCH_MAX_IDS` records in one round trip instead of N sequential single
 * GETs. Parsing/validation lives with the routes (`src/routes/dataEntity.ts`)
 * next to the canonical single-ID parser; this module only fetches already
 * validated ids and assembles the fixed-shape `{ entries }` body.
 *
 * Deliberately v1-shaped: direct D1 reads with no Cache API or ETag
 * involvement (batch 200s are `no-store` without validators; `If-None-Match`
 * is ignored). Each unique id is hydrated once per request with at most four
 * root jobs active; response entries retain request order and duplicates.
 * This bounds root jobs, not nested D1 queries, graph size or response bytes.
 */

import {
  getAddressBundleFromD1,
  getContainerBundleFromD1,
  getCustomerBundleFromD1
} from "./dataEntityRead";

/** Explicit batch bound: `?ids=` carries 1 to 50 ids; more fails 400. */
export const BATCH_MAX_IDS = 50;
const BATCH_MAX_ROOT_HYDRATIONS = 4;

async function hydrateUniqueIds<T>(
  ids: number[],
  hydrate: (id: number) => Promise<T>
): Promise<T[]> {
  const uniqueIds = [...new Set(ids)];
  const results = new Map<number, T>();
  let next = 0;
  let failed = false;
  let failure: unknown;

  async function worker(): Promise<void> {
    while (!failed && next < uniqueIds.length) {
      const id = uniqueIds[next++]!;
      try {
        // Keep the slot until the complete bundle (including nested reads) settles.
        results.set(id, await hydrate(id));
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }

  // Workers catch failures so all started jobs drain before the handler rejects.
  await Promise.all(
    Array.from({ length: Math.min(BATCH_MAX_ROOT_HYDRATIONS, uniqueIds.length) }, worker)
  );
  if (failed) throw failure;
  return ids.map((id) => results.get(id)!);
}

function batchJsonResponse(entries: unknown[]): Response {
  // No ETag, no Cache-Control here: the `/api/v1/*` middleware stamps
  // `no-store` on handler responses that set none (`withCors`).
  return new Response(JSON.stringify({ entries }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export async function handleGetDataCustomerBatch(
  db: D1Database,
  ids: number[]
): Promise<Response> {
  const entries = await hydrateUniqueIds(ids, async (id) => {
    const bundle = await getCustomerBundleFromD1(db, id);
    return bundle === null
      ? { id, found: false }
      : { id, found: true, customer: bundle };
  });
  return batchJsonResponse(entries);
}

export async function handleGetDataAddressBatch(
  db: D1Database,
  ids: number[]
): Promise<Response> {
  const entries = await hydrateUniqueIds(ids, async (id) => {
    const bundle = await getAddressBundleFromD1(db, id);
    // Same not-found condition as the single-address handler: a bundle
    // without its address row is a miss, never a partial entry.
    return bundle === null || bundle.address === null
      ? { id, found: false }
      : { id, found: true, address: bundle };
  });
  return batchJsonResponse(entries);
}

export async function handleGetDataContainerBatch(
  db: D1Database,
  ids: number[]
): Promise<Response> {
  const entries = await hydrateUniqueIds(ids, async (id) => {
    const bundle = await getContainerBundleFromD1(db, id);
    // Same not-found condition as the single-container handler.
    return bundle === null || bundle.container === null
      ? { id, found: false }
      : { id, found: true, container: bundle };
  });
  return batchJsonResponse(entries);
}
