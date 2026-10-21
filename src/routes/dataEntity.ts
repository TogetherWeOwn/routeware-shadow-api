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
  handlePostDataAddress,
  handlePostDataContainer,
  handlePostDataCustomer
} from "../lib/dataEntitySave";
import { problemJsonResponse, problemType } from "../lib/problem";
import {
  createRouteModule,
  requireSnapshotAuth
} from "./shared";

/**
 * `/api/v1/data/*` (tag `data-entity`): D1 aggregate reads, and writes that go
 * through Routeware and then refresh the local snapshot.
 */
export const dataEntityRoutes = createRouteModule();

const dataCustomerGetRoute = createRoute({
  method: "get",
  path: "/api/v1/data/customer",
  operationId: "getDataCustomer",
  "x-access": "sync-secret",
  "x-effect": "local-read",
  tags: ["data-entity"],
  summary: "Get customer (D1) with addresses and containers",
  description:
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `customer_id` (alias `customerId`).",
  request: {
    query: z.object({
      id: z.coerce.number().int().optional().openapi({ example: 345734 }),
      customerId: z.coerce.number().int().optional().openapi({ example: 345734 })
    })
  },
  responses: {
    200: {
      description: "customer + nested addresses with containers (synthetic example)",
      content: { "application/json": { schema: z.unknown(), example: customerBundleExample } }
    },
    304: { description: "Not modified" },
    400: { description: "Missing id" },
    401: { description: "Unauthorized" },
    404: { description: "Not in D1" }
  }
});

dataEntityRoutes.openapi(dataCustomerGetRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const q = c.req.valid("query");
  const id = q.id ?? q.customerId;
  if (id === undefined) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "Query `id` or `customerId` (customer_id) is required. See docs/PROBLEMS.md#bad-request.",
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
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `pickup_address_id` (alias `pickupAddressId`).",
  request: {
    query: z.object({
      id: z.coerce.number().int().optional().openapi({ example: 10 }),
      pickupAddressId: z.coerce.number().int().optional().openapi({ example: 10 })
    })
  },
  responses: {
    200: {
      description: "address, customer, containers (synthetic example)",
      content: { "application/json": { schema: z.unknown(), example: addressBundleExample } }
    },
    304: { description: "Not modified" },
    400: { description: "Invalid id (application/problem+json)" },
    401: { description: "Unauthorized" },
    404: { description: "Not in D1" }
  }
});

dataEntityRoutes.openapi(dataAddressGetRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const q = c.req.valid("query");
  const id = q.id ?? q.pickupAddressId;
  if (id === undefined || !Number.isInteger(id) || id <= 0) {
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
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `container_id` (alias `containerId`).",
  request: {
    query: z.object({
      id: z.coerce.number().int().optional().openapi({ example: 100 }),
      containerId: z.coerce.number().int().optional().openapi({ example: 100 })
    })
  },
  responses: {
    200: {
      description: "container, address, customer (synthetic example)",
      content: { "application/json": { schema: z.unknown(), example: containerBundleExample } }
    },
    304: { description: "Not modified" },
    400: { description: "Invalid id (application/problem+json)" },
    401: { description: "Unauthorized" },
    404: { description: "Not in D1" }
  }
});

dataEntityRoutes.openapi(dataContainerGetRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const q = c.req.valid("query");
  const id = q.id ?? q.containerId;
  if (id === undefined || !Number.isInteger(id) || id <= 0) {
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
