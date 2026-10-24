import { createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig } from "@hono/zod-openapi";
import { snapshotFieldsQuery } from "../lib/sparseFieldsets";
import {
  customerBundleExample,
  addressBundleExample,
  containerBundleExample
} from "./payloadExamples";
import {
  handleGetDataAddress,
  handleGetDataContainer,
  handleGetDataCustomer
} from "../lib/dataEntityHandlers";
import {
  BATCH_MAX_IDS,
  handleGetDataAddressBatch,
  handleGetDataContainerBatch,
  handleGetDataCustomerBatch
} from "../lib/dataEntityBatch";
import {
  handlePostDataAddress,
  handlePostDataContainer,
  handlePostDataCustomer
} from "../lib/dataEntitySave";
import { problemJsonResponse, problemType } from "../lib/problem";
import {
  DATA_ADDRESS_QUERY_KEYS,
  DATA_CONTAINER_QUERY_KEYS,
  DATA_CUSTOMER_QUERY_KEYS,
  createRouteModule,
  dryRunQuery,
  isDryRunRequested,
  parsePositiveIdParam,
  rejectUnknownQueryKeys,
  requireSnapshotAuth,
  validationFailureHook
} from "./shared";

/**
 * `/api/v1/data/*` (tag `data-entity`): D1 aggregate reads, and writes that go
 * through Routeware and then refresh the local snapshot.
 */
export const dataEntityRoutes = createRouteModule();

// Keep preliminary numeric validation in its existing position before the inner
// auth gate. Check raw text after that gate: coercion alone accepts noncanonical
// spellings and can round unsafe IDs before the data handler sees them.
const hydratedReadIdQuery = z.coerce.number().int().optional().openapi({
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description:
    "Canonical positive decimal safe integer, from 1 to 9007199254740991, without leading zeros, whitespace, signs, fractions, exponents or hex. Every supplied spelling must be valid; id wins over the alias. Hydrated entity reads reject any other query key with a value-free 400 before any work."
});
const hydratedReadBadRequest = {
  description:
    "Missing or invalid id or alias: every supplied ID must be a canonical positive decimal safe integer (application/problem+json). Invalid fields selectors and unknown query keys are value-free 400s before cache or D1 reads."
};

function hydratedReadValidationHook(
  result: Parameters<typeof validationFailureHook>[0],
  c: Parameters<typeof requireSnapshotAuth>[0]
): Response | undefined {
  // Any fields failure, including mixed ID/fields errors, must pass the inner
  // auth gate. Keep ID-only preliminary validation in its old order.
  if (!result.success && result.target === "query" &&
      result.error?.issues.some((issue) => issue.path[0] === "fields")) {
    const denied = requireSnapshotAuth(c);
    if (denied) return denied;
  }
  return validationFailureHook(result, c);
}

// Batch `ids` is a single comma-separated string, never repeated `?ids=`
// keys (repeated keys reach zod as an array and the shared validation hook
// 400s before the handler) and never mixed with `id`/alias.
const hydratedReadIdsQuery = z.string().optional().openapi({
  description:
    `Batch lookup as one comma-separated \`ids\` value: 1 to ${BATCH_MAX_IDS} canonical ` +
    "positive decimal safe integers (1 to 9007199254740991) without leading zeros, " +
    "whitespace, signs, fractions, exponents or hex. Every entry is validated before " +
    `any read; any malformed or empty entry, mixing with \`id\`/alias/\`fields\`, or more than ${BATCH_MAX_IDS} ` +
    "ids fails the whole request 400 with zero partial reads. Batch 200s return " +
    "`{entries}` in request order with `no-store` and no ETag.",
  example: "1,2,3"
});

// Fixed, value-free batch rejection: one detail for malformed entries, shape
// violations, `id`/alias mixing and over-max lists, so rejected input cannot
// be told apart (or echoed back) by the response.
const BATCH_IDS_BAD_REQUEST_DETAIL =
  `Query \`ids\` must be one comma-separated list of 1 to ${BATCH_MAX_IDS} canonical ` +
  "positive decimal safe integers without leading zeros, and cannot be combined " +
  "with `id` or the alias. See docs/PROBLEMS.md#bad-request.";

function parseHydratedReadId(rawId: string | undefined, rawAlias: string | undefined): number | null {
  const id = rawId === undefined ? undefined : parsePositiveIdParam(rawId);
  const alias = rawAlias === undefined ? undefined : parsePositiveIdParam(rawAlias);
  if (id === null || alias === null) return null;
  return id ?? alias ?? null;
}

/**
 * Parse a batch `ids` value into canonical ids in request order. Returns
 * `null` (→ the fixed value-free batch 400) when `id`/alias/`fields` is also
 * present — `?fields=` on batch is an unimplemented follow-up, so the
 * combination fails closed instead of silently ignoring `fields` — when the
 * list is empty or longer than `BATCH_MAX_IDS`, or when any entry fails the
 * canonical positive-safe-ID contract — before any read, so a malformed
 * batch performs zero handler/cache/D1 work.
 */
function parseBatchIds(
  rawIds: string,
  rawId: string | undefined,
  rawAlias: string | undefined,
  rawFields: string | undefined
): number[] | null {
  if (rawId !== undefined || rawAlias !== undefined || rawFields !== undefined) return null;
  const parts = rawIds.split(",");
  if (parts.length > BATCH_MAX_IDS) return null;
  const ids: number[] = [];
  for (const part of parts) {
    const id = parsePositiveIdParam(part);
    if (id === null) return null;
    ids.push(id);
  }
  return ids;
}

function batchBadRequest(c: { env: Env; req: { url: string } }): Response {
  return problemJsonResponse({
    type: problemType("bad-request", c.env),
    title: "Bad Request",
    status: 400,
    detail: BATCH_IDS_BAD_REQUEST_DETAIL,
    instance: new URL(c.req.url).pathname
  });
}

const dataCustomerGetRoute = createRoute({
  method: "get",
  path: "/api/v1/data/customer",
  operationId: "getDataCustomer",
  "x-access": "sync-secret",
  "x-effect": "local-read",
  tags: ["data-entity"],
  summary: "Get customer (D1) with addresses and containers",
  description:
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `customer_id` (alias `customerId`). Batch: `ids=1,2,3` hydrates up to 50 records as `{entries}` in request order (`no-store`, no ETag); `ids` cannot be combined with `id`/alias. Optional `fields=company_name,phone1` projects only the `.customer` root plus `customer_id` on single-ID reads; related data remains unchanged. Omitted `fields` preserves the full response. ETags hash the served bytes for each representation; projected validators never reuse a full-only validator, and the canonical full cache is never overwritten by a projection. `fields` applies to single-ID reads; combining `ids` with `fields` is a value-free 400. Unknown query keys are a value-free 400 before any cache or D1 work.",
  request: {
    query: z.object({
      id: hydratedReadIdQuery.openapi({ example: 345734 }),
      customerId: hydratedReadIdQuery.openapi({ example: 345734 }),
      ids: hydratedReadIdsQuery,
      fields: snapshotFieldsQuery("customer")
    })
  },
  responses: {
    200: {
      description: "customer + nested addresses with containers (synthetic example)",
      content: { "application/json": { schema: z.unknown(), example: customerBundleExample } }
    },
    304: { description: "Not modified" },
    400: hydratedReadBadRequest,
    401: { description: "Unauthorized" },
    404: { description: "Not in D1" }
  }
});

dataEntityRoutes.openapi(dataCustomerGetRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const unknownQuery = rejectUnknownQueryKeys(c, DATA_CUSTOMER_QUERY_KEYS, "allowed-only");
  if (unknownQuery) return unknownQuery;
  const rawIds = c.req.query("ids");
  if (rawIds !== undefined) {
    const batchIds = parseBatchIds(rawIds, c.req.query("id"), c.req.query("customerId"), c.req.query("fields"));
    if (batchIds === null) return batchBadRequest(c);
    return handleGetDataCustomerBatch(c.env.CUSTOMER_DB, batchIds);
  }
  const rawId = c.req.query("id");
  const rawAlias = c.req.query("customerId");
  const id = parseHydratedReadId(rawId, rawAlias);
  if (id === null) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail: rawId === undefined && rawAlias === undefined
        ? "Query `id` or `customerId` (customer_id) is required. See docs/PROBLEMS.md#bad-request."
        : "Query `id` and `customerId`, when supplied, must be canonical positive decimal safe integers without leading zeros. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.url).pathname
    });
  }
  return handleGetDataCustomer({ env: c.env, var: c.var, req: c.req }, id, c.req.valid("query").fields);
}, hydratedReadValidationHook);

const dataAddressGetRoute = createRoute({
  method: "get",
  path: "/api/v1/data/address",
  operationId: "getDataAddress",
  "x-access": "sync-secret",
  "x-effect": "local-read",
  tags: ["data-entity"],
  summary: "Get address (D1) with customer and containers",
  description:
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `pickup_address_id` (alias `pickupAddressId`). Batch: `ids=1,2,3` hydrates up to 50 records as `{entries}` in request order (`no-store`, no ETag); `ids` cannot be combined with `id`/alias. Optional `fields=city,address` projects only the `.address` root plus `pickup_address_id` on single-ID reads; related data remains unchanged. Omitted `fields` preserves the full response. ETags hash the served bytes for each representation; projected validators never reuse a full-only validator, and the canonical full cache is never overwritten by a projection. `fields` applies to single-ID reads; combining `ids` with `fields` is a value-free 400. Unknown query keys are a value-free 400 before any cache or D1 work.",
  request: {
    query: z.object({
      id: hydratedReadIdQuery.openapi({ example: 10 }),
      pickupAddressId: hydratedReadIdQuery.openapi({ example: 10 }),
      ids: hydratedReadIdsQuery,
      fields: snapshotFieldsQuery("address")
    })
  },
  responses: {
    200: {
      description: "address, customer, containers (synthetic example)",
      content: { "application/json": { schema: z.unknown(), example: addressBundleExample } }
    },
    304: { description: "Not modified" },
    400: hydratedReadBadRequest,
    401: { description: "Unauthorized" },
    404: { description: "Not in D1" }
  }
});

dataEntityRoutes.openapi(dataAddressGetRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const unknownQuery = rejectUnknownQueryKeys(c, DATA_ADDRESS_QUERY_KEYS, "allowed-only");
  if (unknownQuery) return unknownQuery;
  const rawIds = c.req.query("ids");
  if (rawIds !== undefined) {
    const batchIds = parseBatchIds(rawIds, c.req.query("id"), c.req.query("pickupAddressId"), c.req.query("fields"));
    if (batchIds === null) return batchBadRequest(c);
    return handleGetDataAddressBatch(c.env.CUSTOMER_DB, batchIds);
  }
  const id = parseHydratedReadId(c.req.query("id"), c.req.query("pickupAddressId"));
  if (id === null) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "Query `id` or `pickupAddressId` (pickup_address_id) is required and must be a positive integer. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.url).pathname
    });
  }
  return handleGetDataAddress({ env: c.env, var: c.var, req: c.req }, id, c.req.valid("query").fields);
}, hydratedReadValidationHook);

const dataContainerGetRoute = createRoute({
  method: "get",
  path: "/api/v1/data/container",
  operationId: "getDataContainer",
  "x-access": "sync-secret",
  "x-effect": "local-read",
  tags: ["data-entity"],
  summary: "Get container (D1) with address and customer",
  description:
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `container_id` (alias `containerId`). Batch: `ids=1,2,3` hydrates up to 50 records as `{entries}` in request order (`no-store`, no ETag); `ids` cannot be combined with `id`/alias. Optional `fields=serial_number,location_address` projects only the `.container` root plus `container_id` on single-ID reads; related data remains unchanged. Omitted `fields` preserves the full response. ETags hash the served bytes for each representation; projected validators never reuse a full-only validator, and the canonical full cache is never overwritten by a projection. `fields` applies to single-ID reads; combining `ids` with `fields` is a value-free 400. Unknown query keys are a value-free 400 before any cache or D1 work.",
  request: {
    query: z.object({
      id: hydratedReadIdQuery.openapi({ example: 100 }),
      containerId: hydratedReadIdQuery.openapi({ example: 100 }),
      ids: hydratedReadIdsQuery,
      fields: snapshotFieldsQuery("container")
    })
  },
  responses: {
    200: {
      description: "container, address, customer (synthetic example)",
      content: { "application/json": { schema: z.unknown(), example: containerBundleExample } }
    },
    304: { description: "Not modified" },
    400: hydratedReadBadRequest,
    401: { description: "Unauthorized" },
    404: { description: "Not in D1" }
  }
});

dataEntityRoutes.openapi(dataContainerGetRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const unknownQuery = rejectUnknownQueryKeys(c, DATA_CONTAINER_QUERY_KEYS, "allowed-only");
  if (unknownQuery) return unknownQuery;
  const rawIds = c.req.query("ids");
  if (rawIds !== undefined) {
    const batchIds = parseBatchIds(rawIds, c.req.query("id"), c.req.query("containerId"), c.req.query("fields"));
    if (batchIds === null) return batchBadRequest(c);
    return handleGetDataContainerBatch(c.env.CUSTOMER_DB, batchIds);
  }
  const id = parseHydratedReadId(c.req.query("id"), c.req.query("containerId"));
  if (id === null) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "Query `id` or `containerId` (container_id) is required and must be a positive integer. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.url).pathname
    });
  }
  return handleGetDataContainer({ env: c.env, var: c.var, req: c.req }, id, c.req.valid("query").fields);
}, hydratedReadValidationHook);

function dataEntityPostResponse(
  example: Record<string, unknown>,
  created?: { description: string; example: Record<string, unknown> }
): RouteConfig["responses"] {
  return {
    200: {
      description:
        "Save outcome + resolved ids + local D1 sync summary (synthetic example). Never echoes submitted fields or the upstream body.",
      content: { "application/json": { schema: z.unknown(), example } }
    },
    ...(created
      ? {
          201: {
            description: created.description,
            content: { "application/json": { schema: z.unknown(), example: created.example } }
          }
        }
      : {}),
    400: { description: "Bad Request" },
    401: { description: "Unauthorized" },
    502: { description: "Bad Gateway" },
    503: {
      description:
        "Dry-run without a usable Routeware session (failed-precondition problem+json; dry runs never log in)"
    }
  };
}

/**
 * Only `dryRun` is an allowed query key on the POST saves. Invalid values
 * 400 in the zod validator (before the inner auth gate); unknown keys pass
 * the non-strict schema and are rejected after auth by
 * `rejectUnknownQueryKeys`, so a wrong bearer still 401s first.
 */
const saveQueryKeys = ["dryRun"] as const;

const localSyncExample = {
  done: true,
  customerId: 345734,
  addressIds: [10],
  containerIds: [100]
};

const dataCustomerPostRoute = createRoute({
  method: "post",
  path: "/api/v1/data/customer",
  operationId: "saveDataCustomer",
  "x-access": "sync-secret",
  "x-effect": "upstream-write-local-refresh",
  tags: ["data-entity"],
  summary: "Create/update customer in Routeware + sync D1",
  description:
    "Proxies to `SaveCustomerLongForm` (same as `/api/v1/routeware/customer/save-long-form`) with **application/x-www-form-urlencoded**. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. `CustomerID=0` or absent for create. On success, refreshes D1 for that customer from `GetCustomerDetailFull` and invalidates related cache entries. Response: `ok`, `routewareStatus`, `customerId`, `upstreamBytes`, `localSync` (ids + fixed `code` outcomes only — no submitted fields, no upstream body). Pass `?dryRun=true` to validate only — same admission and validation, zero upstream/D1/cache writes, `dryRun: true` in the response; without a usable session the dry-run fails closed with 503 and never logs in. Only `dryRun` is an allowed query key.",
  request: {
    query: dryRunQuery,
    body: {
      description: "SaveCustomerLongForm fields — token injected server-side when omitted (see example)",
      content: {
        "application/x-www-form-urlencoded": {
          // Plain SchemaObject, not a zod schema: docs-only, no runtime
          // validator is installed (forwarding must stay byte-identical).
          schema: {
            type: "object",
            properties: {
              __RequestVerificationToken: { type: "string" },
              CustomerTypeID: { type: "string" },
              CompanyName: { type: "string" },
              FirstName: { type: "string" },
              LastName: { type: "string" },
              Enabled: { type: "string" },
              CustomerID: { type: "string" }
            }
          },
          example: {
            CustomerTypeID: "1",
            CompanyName: "ExampleCo",
            FirstName: "Jane",
            LastName: "Doe",
            Enabled: "true",
            CustomerID: "0"
          }
        }
      }
    }
  },
  responses: dataEntityPostResponse({
    ok: true,
    routewareStatus: 200,
    customerId: 345734,
    upstreamBytes: 36,
    localSync: localSyncExample
  })
});

dataEntityRoutes.openapi(dataCustomerPostRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const unknown = rejectUnknownQueryKeys(c, saveQueryKeys);
  if (unknown) return unknown;
  return handlePostDataCustomer(
    { env: c.env, var: c.var, req: c.req },
    { dryRun: isDryRunRequested(c.req.valid("query")) }
  );
});

const dataAddressPostRoute = createRoute({
  method: "post",
  path: "/api/v1/data/address",
  operationId: "saveDataAddress",
  "x-access": "sync-secret",
  "x-effect": "upstream-write-local-refresh",
  tags: ["data-entity"],
  summary: "Create/update address in Routeware + sync D1",
  description:
    "Proxies to `PickupAddress/SaveAddressForm` with **application/x-www-form-urlencoded**. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. New address: `PickupAddressID=0` and `CustomerID` set; anti-forgery from `CreateBlankAddress`. Response: `ok`, `routewareStatus`, `customerId`, `pickupAddressId`, `upstreamBytes`, `localSync` (ids + fixed `code` outcomes only — no submitted fields, no upstream body). Creates (posted id 0/absent, upstream ok) answer 201 with the resolved `pickupAddressId` — upstream `data.PickupAddressID` first, else the singleton post-refresh D1 id for the owning customer; `null` remains when no upstream id is available and the diff is empty, ambiguous (0 or 2+ new ids), or unavailable (unknown owner or failed baseline/refresh). Updates echo the posted id with 200. No `Location` header: the by-id snapshot URL may not exist locally when the refresh fails, and a header that 404s is worse than none. Dry-run saves echo posted ids while live saves resolve (R21-02 convergence). Pass `?dryRun=true` to validate only — same admission and validation, zero upstream/D1/cache writes, `dryRun: true` in the response; without a usable session the dry-run fails closed with 503 and never logs in. Only `dryRun` is an allowed query key.",
  request: {
    query: dryRunQuery,
    body: {
      description: "SaveAddressForm fields — token injected server-side when omitted (see example)",
      content: {
        "application/x-www-form-urlencoded": {
          // Plain SchemaObject, not a zod schema: docs-only, no runtime
          // validator is installed (forwarding must stay byte-identical).
          schema: {
            type: "object",
            properties: {
              __RequestVerificationToken: { type: "string" },
              PickupAddressID: { type: "string" },
              CustomerID: { type: "string" },
              Address: { type: "string" }
            }
          },
          example: { PickupAddressID: "0", CustomerID: "5", Address: "1 Main St" }
        }
      }
    }
  },
  responses: dataEntityPostResponse(
    {
      ok: true,
      routewareStatus: 200,
      customerId: 5,
      pickupAddressId: 10,
      upstreamBytes: 16,
      localSync: { ...localSyncExample, customerId: 5 }
    },
    {
      description:
        "Address created (posted id 0/absent, upstream ok) + resolved pickupAddressId + local D1 sync summary (synthetic example). The id comes from upstream data.PickupAddressID, else the singleton post-refresh D1 id for the owning customer; null remains when no upstream id is available and the diff is empty, ambiguous, or unavailable (unknown owner or failed baseline/refresh).",
      example: {
        ok: true,
        routewareStatus: 200,
        customerId: 5,
        pickupAddressId: 77,
        upstreamBytes: 46,
        localSync: { done: true, customerId: 5, addressIds: [10, 77], containerIds: [100] }
      }
    }
  )
});

dataEntityRoutes.openapi(dataAddressPostRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const unknown = rejectUnknownQueryKeys(c, saveQueryKeys);
  if (unknown) return unknown;
  return handlePostDataAddress(
    { env: c.env, var: c.var, req: c.req },
    { dryRun: isDryRunRequested(c.req.valid("query")) }
  );
});

const dataContainerPostRoute = createRoute({
  method: "post",
  path: "/api/v1/data/container",
  operationId: "saveDataContainer",
  "x-access": "sync-secret",
  "x-effect": "upstream-write-local-refresh",
  tags: ["data-entity"],
  summary: "Create/update container in Routeware + sync D1",
  description:
    "Proxies to `Container/SaveContainerForm` with **application/x-www-form-urlencoded**. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. New container: `ContainerID=0` and `PickupAddressID`; `CustomerID` optional (resolved from D1 address row). Response: `ok`, `routewareStatus`, `customerId`, `pickupAddressId`, `containerId`, `upstreamBytes`, `localSync` (ids + fixed `code` outcomes only — no submitted fields, no upstream body). Creates (posted id 0/absent, upstream ok) answer 201 with the resolved `containerId` — upstream `data.ContainerID` first, else the singleton post-refresh D1 id scoped to the owning address; `null` remains when no upstream id is available and the diff is empty, ambiguous (0 or 2+ new ids), or unavailable (unknown owner or failed baseline/refresh). Updates echo the posted id with 200. No `Location` header: the by-id snapshot URL may not exist locally when the refresh fails, and a header that 404s is worse than none. Dry-run saves echo posted ids while live saves resolve (R21-02 convergence). Pass `?dryRun=true` to validate only — same admission and validation, zero upstream/D1/cache writes, `dryRun: true` in the response; without a usable session the dry-run fails closed with 503 and never logs in. Only `dryRun` is an allowed query key.",
  request: {
    query: dryRunQuery,
    body: {
      description: "SaveContainerForm fields — token injected server-side when omitted (see example)",
      content: {
        "application/x-www-form-urlencoded": {
          // Plain SchemaObject, not a zod schema: docs-only, no runtime
          // validator is installed (forwarding must stay byte-identical).
          schema: {
            type: "object",
            properties: {
              __RequestVerificationToken: { type: "string" },
              ContainerID: { type: "string" },
              PickupAddressID: { type: "string" },
              CustomerID: { type: "string" }
            }
          },
          example: { ContainerID: "0", PickupAddressID: "10" }
        }
      }
    }
  },
  responses: dataEntityPostResponse(
    {
      ok: true,
      routewareStatus: 200,
      customerId: 345734,
      pickupAddressId: 10,
      containerId: 100,
      upstreamBytes: 16,
      localSync: localSyncExample
    },
    {
      description:
        "Container created (posted id 0/absent, upstream ok) + resolved containerId + local D1 sync summary (synthetic example). The id comes from upstream data.ContainerID, else the singleton post-refresh D1 id scoped to the owning address; null remains when no upstream id is available and the diff is empty, ambiguous, or unavailable (unknown owner or failed baseline/refresh).",
      example: {
        ok: true,
        routewareStatus: 200,
        customerId: 345734,
        pickupAddressId: 10,
        containerId: 177,
        upstreamBytes: 43,
        localSync: { ...localSyncExample, containerIds: [100, 177] }
      }
    }
  )
});

dataEntityRoutes.openapi(dataContainerPostRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const unknown = rejectUnknownQueryKeys(c, saveQueryKeys);
  if (unknown) return unknown;
  return handlePostDataContainer(
    { env: c.env, var: c.var, req: c.req },
    { dryRun: isDryRunRequested(c.req.valid("query")) }
  );
});
