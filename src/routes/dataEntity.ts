import { createRoute, z } from "@hono/zod-openapi";
import {
  handleGetDataAddress,
  handleGetDataContainer,
  handleGetDataCustomer,
  handlePostDataAddress,
  handlePostDataContainer,
  handlePostDataCustomer
} from "../lib/dataEntityHandlers";
import { problemJsonResponse } from "../lib/problem";
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
  tags: ["data-entity"],
  summary: "Get customer (D1) with addresses and containers",
  description:
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `customer_id` (alias `customerId`).",
  request: {
    query: z.object({
      id: z.coerce.number().int().optional(),
      customerId: z.coerce.number().int().optional()
    })
  },
  responses: {
    200: {
      description: "customer + nested addresses with containers",
      content: { "application/json": { schema: z.unknown() } }
    },
    304: { description: "Not modified" },
    400: { description: "Missing id" },
    401: { description: "Unauthorized" },
    404: { description: "Not in D1" }
  }
});

dataEntityRoutes.openapi(dataCustomerGetRoute, async (c) => {
  const denied = requireSnapshotAuth(c, "Set CUSTOMER_SNAPSHOT_SYNC_SECRET and send Authorization: Bearer <secret>.");
  if (denied) return denied;
  const q = c.req.valid("query");
  const id = q.id ?? q.customerId;
  if (id === undefined) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request",
      title: "Bad request",
      status: 400,
      detail: "Query `id` or `customerId` (customer_id) is required."
    });
  }
  return handleGetDataCustomer({ env: c.env, var: c.var, req: c.req }, id);
});

const dataAddressGetRoute = createRoute({
  method: "get",
  path: "/api/v1/data/address",
  tags: ["data-entity"],
  summary: "Get address (D1) with customer and containers",
  request: { query: z.object({ id: z.coerce.number().int() }) },
  responses: {
    200: {
      description: "address, customer, containers",
      content: { "application/json": { schema: z.unknown() } }
    },
    304: { description: "Not modified" },
    401: { description: "Unauthorized" },
    404: { description: "Not in D1" }
  }
});

dataEntityRoutes.openapi(dataAddressGetRoute, async (c) => {
  const denied = requireSnapshotAuth(c, "Bearer required (same as snapshot sync secret).");
  if (denied) return denied;
  const id = Number(c.req.query("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request",
      title: "Bad request",
      status: 400,
      detail: "Query `id` (pickup_address_id) is required and must be a positive integer."
    });
  }
  return handleGetDataAddress({ env: c.env, var: c.var, req: c.req }, id);
});

const dataContainerGetRoute = createRoute({
  method: "get",
  path: "/api/v1/data/container",
  tags: ["data-entity"],
  summary: "Get container (D1) with address and customer",
  request: { query: z.object({ id: z.coerce.number().int() }) },
  responses: {
    200: {
      description: "container, address, customer",
      content: { "application/json": { schema: z.unknown() } }
    },
    304: { description: "Not modified" },
    401: { description: "Unauthorized" },
    404: { description: "Not in D1" }
  }
});

dataEntityRoutes.openapi(dataContainerGetRoute, async (c) => {
  const denied = requireSnapshotAuth(c, "Bearer required (same as snapshot sync secret).");
  if (denied) return denied;
  const id = Number(c.req.query("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request",
      title: "Bad request",
      status: 400,
      detail: "Query `id` (container_id) is required and must be a positive integer."
    });
  }
  return handleGetDataContainer({ env: c.env, var: c.var, req: c.req }, id);
});

const dataEntityPostResponse = {
  200: {
    description: "Routeware response + `posted` fields + optional local D1 sync summary",
    content: { "application/json": { schema: z.unknown() } }
  },
  400: { description: "Bad request" },
  401: { description: "Unauthorized" },
  502: { description: "Token preparation failed" }
} as const;

const dataCustomerPostRoute = createRoute({
  method: "post",
  path: "/api/v1/data/customer",
  tags: ["data-entity"],
  summary: "Create/update customer in Routeware + sync D1",
  description:
    "Proxies to `SaveCustomerLongForm` (same as `/api/v1/routeware/customer/save-long-form`). `CustomerID=0` or absent for create. On success, refreshes D1 for that customer from `GetCustomerDetailFull` and invalidates related cache entries. Response: `upstream` (Routeware body), `posted` (form fields you sent), `ok`, `localSync`.",
  responses: dataEntityPostResponse
});

dataEntityRoutes.openapi(dataCustomerPostRoute, async (c) => {
  const denied = requireSnapshotAuth(c, "Bearer required.");
  if (denied) return denied;
  return handlePostDataCustomer({ env: c.env, var: c.var, req: c.req });
});

const dataAddressPostRoute = createRoute({
  method: "post",
  path: "/api/v1/data/address",
  tags: ["data-entity"],
  summary: "Create/update address in Routeware + sync D1",
  description:
    "Proxies to `PickupAddress/SaveAddressForm`. New address: `PickupAddressID=0` and `CustomerID` set; anti-forgery from `CreateBlankAddress`.",
  responses: dataEntityPostResponse
});

dataEntityRoutes.openapi(dataAddressPostRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  return handlePostDataAddress({ env: c.env, var: c.var, req: c.req });
});

const dataContainerPostRoute = createRoute({
  method: "post",
  path: "/api/v1/data/container",
  tags: ["data-entity"],
  summary: "Create/update container in Routeware + sync D1",
  description:
    "Proxies to `Container/SaveContainerForm`. New container: `ContainerID=0` and `PickupAddressID`; `CustomerID` optional (resolved from D1 address row).",
  responses: dataEntityPostResponse
});

dataEntityRoutes.openapi(dataContainerPostRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  return handlePostDataContainer({ env: c.env, var: c.var, req: c.req });
});
