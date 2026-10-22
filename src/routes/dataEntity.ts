import { createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig } from "@hono/zod-openapi";
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
  createRouteModule,
  parsePositiveIdParam,
  requireSnapshotAuth
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
    "Canonical positive decimal safe integer, from 1 to 9007199254740991, without leading zeros, whitespace, signs, fractions, exponents or hex. Every supplied spelling must be valid; id wins over the alias."
});
const hydratedReadBadRequest = {
  description:
    "Missing or invalid id or alias: every supplied ID must be a canonical positive decimal safe integer (application/problem+json)."
};

// Batch `ids` is a single comma-separated string, never repeated `?ids=`
// keys (repeated keys reach zod as an array and the shared validation hook
// 400s before the handler) and never mixed with `id`/alias.
const hydratedReadIdsQuery = z.string().optional().openapi({
  description:
    `Batch lookup as one comma-separated \`ids\` value: 1 to ${BATCH_MAX_IDS} canonical ` +
    "positive decimal safe integers (1 to 9007199254740991) without leading zeros, " +
    "whitespace, signs, fractions, exponents or hex. Every entry is validated before " +
    `any read; any malformed or empty entry, mixing with \`id\`/alias, or more than ${BATCH_MAX_IDS} ` +
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
 * `null` (→ the fixed value-free batch 400) when `id`/alias is also present,
 * when the list is empty or longer than `BATCH_MAX_IDS`, or when any entry
 * fails the canonical positive-safe-ID contract — before any read, so a
 * malformed batch performs zero handler/cache/D1 work.
 */
function parseBatchIds(
  rawIds: string,
  rawId: string | undefined,
  rawAlias: string | undefined
): number[] | null {
  if (rawId !== undefined || rawAlias !== undefined) return null;
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
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `customer_id` (alias `customerId`). Batch: `ids=1,2,3` hydrates up to 50 records as `{entries}` in request order (`no-store`, no ETag); `ids` cannot be combined with `id`/alias.",
  request: {
    query: z.object({
      id: hydratedReadIdQuery.openapi({ example: 345734 }),
      customerId: hydratedReadIdQuery.openapi({ example: 345734 }),
      ids: hydratedReadIdsQuery
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
  const rawIds = c.req.query("ids");
  if (rawIds !== undefined) {
    const batchIds = parseBatchIds(rawIds, c.req.query("id"), c.req.query("customerId"));
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
  return handleGetDataCustomer({ env: c.env, var: c.var, req: c.req }, id);
});

const dataAddressGetRoute = createRoute({
  method: "get",
  path: "/api/v1/data/address",
  operationId: "getDataAddress",
  "x-access": "sync-secret",
  "x-effect": "local-read",
  tags: ["data-entity"],
  summary: "Get address (D1) with customer and containers",
  description:
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `pickup_address_id` (alias `pickupAddressId`). Batch: `ids=1,2,3` hydrates up to 50 records as `{entries}` in request order (`no-store`, no ETag); `ids` cannot be combined with `id`/alias.",
  request: {
    query: z.object({
      id: hydratedReadIdQuery.openapi({ example: 10 }),
      pickupAddressId: hydratedReadIdQuery.openapi({ example: 10 }),
      ids: hydratedReadIdsQuery
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
  const rawIds = c.req.query("ids");
  if (rawIds !== undefined) {
    const batchIds = parseBatchIds(rawIds, c.req.query("id"), c.req.query("pickupAddressId"));
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
  return handleGetDataAddress({ env: c.env, var: c.var, req: c.req }, id);
});

const dataContainerGetRoute = createRoute({
  method: "get",
  path: "/api/v1/data/container",
  operationId: "getDataContainer",
  "x-access": "sync-secret",
  "x-effect": "local-read",
  tags: ["data-entity"],
  summary: "Get container (D1) with address and customer",
  description:
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `container_id` (alias `containerId`). Batch: `ids=1,2,3` hydrates up to 50 records as `{entries}` in request order (`no-store`, no ETag); `ids` cannot be combined with `id`/alias.",
  request: {
    query: z.object({
      id: hydratedReadIdQuery.openapi({ example: 100 }),
      containerId: hydratedReadIdQuery.openapi({ example: 100 }),
      ids: hydratedReadIdsQuery
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
  const rawIds = c.req.query("ids");
  if (rawIds !== undefined) {
    const batchIds = parseBatchIds(rawIds, c.req.query("id"), c.req.query("containerId"));
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
  return handleGetDataContainer({ env: c.env, var: c.var, req: c.req }, id);
});

function dataEntityPostResponse(example: Record<string, unknown>): RouteConfig["responses"] {
  return {
    200: {
      description:
        "Save outcome + resolved ids + local D1 sync summary (synthetic example). Never echoes submitted fields or the upstream body.",
      content: { "application/json": { schema: z.unknown(), example } }
    },
    400: { description: "Bad Request" },
    401: { description: "Unauthorized" },
    502: { description: "Bad Gateway" }
  };
}

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
    "Proxies to `SaveCustomerLongForm` (same as `/api/v1/routeware/customer/save-long-form`) with **application/x-www-form-urlencoded**. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. `CustomerID=0` or absent for create. On success, refreshes D1 for that customer from `GetCustomerDetailFull` and invalidates related cache entries. Response: `ok`, `routewareStatus`, `customerId`, `upstreamBytes`, `localSync` (ids + fixed `code` outcomes only — no submitted fields, no upstream body).",
  request: {
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
  return handlePostDataCustomer({ env: c.env, var: c.var, req: c.req });
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
    "Proxies to `PickupAddress/SaveAddressForm` with **application/x-www-form-urlencoded**. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. New address: `PickupAddressID=0` and `CustomerID` set; anti-forgery from `CreateBlankAddress`. Response: `ok`, `routewareStatus`, `customerId`, `pickupAddressId`, `upstreamBytes`, `localSync` (ids + fixed `code` outcomes only — no submitted fields, no upstream body).",
  request: {
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
  responses: dataEntityPostResponse({
    ok: true,
    routewareStatus: 200,
    customerId: 5,
    pickupAddressId: null,
    upstreamBytes: 16,
    localSync: { ...localSyncExample, customerId: 5 }
  })
});

dataEntityRoutes.openapi(dataAddressPostRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  return handlePostDataAddress({ env: c.env, var: c.var, req: c.req });
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
    "Proxies to `Container/SaveContainerForm` with **application/x-www-form-urlencoded**. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. New container: `ContainerID=0` and `PickupAddressID`; `CustomerID` optional (resolved from D1 address row). Response: `ok`, `routewareStatus`, `customerId`, `pickupAddressId`, `containerId`, `upstreamBytes`, `localSync` (ids + fixed `code` outcomes only — no submitted fields, no upstream body).",
  request: {
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
  responses: dataEntityPostResponse({
    ok: true,
    routewareStatus: 200,
    customerId: 345734,
    pickupAddressId: 10,
    containerId: null,
    upstreamBytes: 16,
    localSync: localSyncExample
  })
});

dataEntityRoutes.openapi(dataContainerPostRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  return handlePostDataContainer({ env: c.env, var: c.var, req: c.req });
});
