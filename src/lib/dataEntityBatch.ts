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
 * is ignored), and one bundle read per requested id in request order,
 * duplicates included. Composite caching/ETags are future work.
 */

import {
  getAddressBundleFromD1,
  getContainerBundleFromD1,
  getCustomerBundleFromD1
} from "./dataEntityRead";

/** Explicit batch bound: `?ids=` carries 1 to 50 ids; more fails 400. */
export const BATCH_MAX_IDS = 50;

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
  // One bundle read per requested id, duplicates included; Promise.all
  // preserves request order in the resolved entries.
  const entries = await Promise.all(
    ids.map(async (id) => {
      const bundle = await getCustomerBundleFromD1(db, id);
      return bundle === null
        ? { id, found: false }
        : { id, found: true, customer: bundle };
    })
  );
  return batchJsonResponse(entries);
}

export async function handleGetDataAddressBatch(
  db: D1Database,
  ids: number[]
): Promise<Response> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      const bundle = await getAddressBundleFromD1(db, id);
      // Same not-found condition as the single-address handler: a bundle
      // without its address row is a miss, never a partial entry.
      return bundle === null || bundle.address === null
        ? { id, found: false }
        : { id, found: true, address: bundle };
    })
  );
  return batchJsonResponse(entries);
}

export async function handleGetDataContainerBatch(
  db: D1Database,
  ids: number[]
): Promise<Response> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      const bundle = await getContainerBundleFromD1(db, id);
      // Same not-found condition as the single-container handler.
      return bundle === null || bundle.container === null
        ? { id, found: false }
        : { id, found: true, container: bundle };
    })
  );
  return batchJsonResponse(entries);
}
