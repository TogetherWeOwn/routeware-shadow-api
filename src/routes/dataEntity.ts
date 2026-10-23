import { createRoute, z } from "@hono/zod-openapi";
import type { RouteConfig } from "@hono/zod-openapi";
import {
  BUNDLE_TYPED_FIELD_KEYS,
  findUnknownTypedBundleFieldKeys,
  snapshotFieldsQuery,
  typedBundleFieldsQuery,
  type SnapshotFieldsetResource
} from "../lib/sparseFieldsets";
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
  parsePositiveIdParam,
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
    "Canonical positive decimal safe integer, from 1 to 9007199254740991, without leading zeros, whitespace, signs, fractions, exponents or hex. Every supplied spelling must be valid; id wins over the alias."
});
const hydratedReadBadRequest = {
  description:
    "Missing or invalid id or alias: every supplied ID must be a canonical positive decimal safe integer (application/problem+json). Invalid `fields` or `fields[type]` selectors — including unknown `fields[TYPE]` keys and flat-plus-typed-root pairs — are value-free 400s before cache or D1 reads."
};

function hydratedReadValidationHook(
  result: Parameters<typeof validationFailureHook>[0],
  c: Parameters<typeof requireSnapshotAuth>[0]
): Response | undefined {
  // Any fields failure, including mixed ID/fields errors, must pass the inner
  // auth gate. Keep ID-only preliminary validation in its old order.
  if (!result.success && result.target === "query" &&
      result.error?.issues.some((issue) => {
        const head = issue.path[0];
        return typeof head === "string" && (head === "fields" || head.startsWith("fields["));
      })) {
    const denied = requireSnapshotAuth(c);
    if (denied) return denied;
  }
  return validationFailureHook(result, c);
}

type HydratedReadFieldsQuery = {
  fields?: string[];
  "fields[customer]"?: string[];
  "fields[address]"?: string[];
  "fields[container]"?: string[];
};

/**
 * Reject unknown `fields[TYPE]` keys and ambiguous flat-plus-typed-root pairs
 * with the anchored value-free 400. Runs in-handler, after auth and before ID
 * parsing, cache or D1: the schema strips unknown keys before validation, and
 * the flat/typed-root pair is only ambiguous once both parse. Returns the 400
 * response, or null when the selectors may proceed.
 */
function rejectInvalidBundleSelectors(
  env: Env,
  url: string,
  queryKeys: string[],
  root: SnapshotFieldsetResource,
  query: HydratedReadFieldsQuery
): Response | null {
  const unknown = findUnknownTypedBundleFieldKeys(queryKeys);
  if (unknown.length > 0) {
    return problemJsonResponse({
      type: problemType("bad-request", env),
      title: "Bad Request",
      status: 400,
      detail: `Invalid request query (${unknown.join(", ")}). See docs/PROBLEMS.md#bad-request.`,
      instance: new URL(url).pathname
    });
  }
  const rootKey = BUNDLE_TYPED_FIELD_KEYS[root];
  if (query.fields !== undefined && query[rootKey] !== undefined) {
    return problemJsonResponse({
      type: problemType("bad-request", env),
      title: "Bad Request",
      status: 400,
      detail: `Invalid request query (fields, ${rootKey}). See docs/PROBLEMS.md#bad-request.`,
      instance: new URL(url).pathname
    });
  }
  return null;
}

/** Collect the validated per-type selections, or undefined when none were sent. */
function typedBundleSelection(
  query: HydratedReadFieldsQuery
): Partial<Record<SnapshotFieldsetResource, string[]>> | undefined {
  const typed: Partial<Record<SnapshotFieldsetResource, string[]>> = {
    customer: query["fields[customer]"],
    address: query["fields[address]"],
    container: query["fields[container]"]
  };
  return typed.customer === undefined && typed.address === undefined && typed.container === undefined
    ? undefined
    : typed;
}

function parseHydratedReadId(rawId: string | undefined, rawAlias: string | undefined): number | null {
  const id = rawId === undefined ? undefined : parsePositiveIdParam(rawId);
  const alias = rawAlias === undefined ? undefined : parsePositiveIdParam(rawAlias);
  if (id === null || alias === null) return null;
  return id ?? alias ?? null;
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
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `customer_id` (alias `customerId`). Optional `fields=company_name,phone1` projects only the `.customer` root plus `customer_id`; related data remains unchanged unless a typed selector below names its type. Optional `fields[customer]`, `fields[address]`, `fields[container]` project every object of that type — the root and all nested relations — from the same per-type allowlists; omitted types stay full, every projected object keeps its primary id, and `fields` plus `fields[customer]` together are a 400. Omitted selectors preserve the full response. ETags hash the served bytes for each representation; projected validators never reuse a full-only validator, and the canonical full cache is never overwritten by a projection. Single-ID only; no batch `ids`.",
  request: {
    query: z.object({
      id: hydratedReadIdQuery.openapi({ example: 345734 }),
      customerId: hydratedReadIdQuery.openapi({ example: 345734 }),
      fields: snapshotFieldsQuery("customer"),
      "fields[customer]": typedBundleFieldsQuery("customer"),
      "fields[address]": typedBundleFieldsQuery("address"),
      "fields[container]": typedBundleFieldsQuery("container")
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
  const fieldsQuery = c.req.valid("query");
  const rejected = rejectInvalidBundleSelectors(
    c.env, c.req.url, Object.keys(c.req.query()), "customer", fieldsQuery);
  if (rejected) return rejected;
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
  return handleGetDataCustomer(
    { env: c.env, var: c.var, req: c.req }, id, fieldsQuery.fields, typedBundleSelection(fieldsQuery));
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
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `pickup_address_id` (alias `pickupAddressId`). Optional `fields=city,address` projects only the `.address` root plus `pickup_address_id`; related data remains unchanged unless a typed selector below names its type. Optional `fields[customer]`, `fields[address]`, `fields[container]` project every object of that type — the root and all nested relations — from the same per-type allowlists; omitted types stay full, every projected object keeps its primary id, and `fields` plus `fields[address]` together are a 400. Omitted selectors preserve the full response. ETags hash the served bytes for each representation; projected validators never reuse a full-only validator, and the canonical full cache is never overwritten by a projection. Single-ID only; no batch `ids`.",
  request: {
    query: z.object({
      id: hydratedReadIdQuery.openapi({ example: 10 }),
      pickupAddressId: hydratedReadIdQuery.openapi({ example: 10 }),
      fields: snapshotFieldsQuery("address"),
      "fields[customer]": typedBundleFieldsQuery("customer"),
      "fields[address]": typedBundleFieldsQuery("address"),
      "fields[container]": typedBundleFieldsQuery("container")
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
  const fieldsQuery = c.req.valid("query");
  const rejected = rejectInvalidBundleSelectors(
    c.env, c.req.url, Object.keys(c.req.query()), "address", fieldsQuery);
  if (rejected) return rejected;
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
  return handleGetDataAddress(
    { env: c.env, var: c.var, req: c.req }, id, fieldsQuery.fields, typedBundleSelection(fieldsQuery));
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
    "Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Read aggregate from the daily snapshot DB. Caching: `ETag` / `If-None-Match` and the Workers **Cache** API; invalidated after successful POST. Query: `id` = `container_id` (alias `containerId`). Optional `fields=serial_number,location_address` projects only the `.container` root plus `container_id`; related data remains unchanged unless a typed selector below names its type. Optional `fields[customer]`, `fields[address]`, `fields[container]` project every object of that type — the root and all nested relations — from the same per-type allowlists; omitted types stay full, every projected object keeps its primary id, and `fields` plus `fields[container]` together are a 400. Omitted selectors preserve the full response. ETags hash the served bytes for each representation; projected validators never reuse a full-only validator, and the canonical full cache is never overwritten by a projection. Single-ID only; no batch `ids`.",
  request: {
    query: z.object({
      id: hydratedReadIdQuery.openapi({ example: 100 }),
      containerId: hydratedReadIdQuery.openapi({ example: 100 }),
      fields: snapshotFieldsQuery("container"),
      "fields[customer]": typedBundleFieldsQuery("customer"),
      "fields[address]": typedBundleFieldsQuery("address"),
      "fields[container]": typedBundleFieldsQuery("container")
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
  const fieldsQuery = c.req.valid("query");
  const rejected = rejectInvalidBundleSelectors(
    c.env, c.req.url, Object.keys(c.req.query()), "container", fieldsQuery);
  if (rejected) return rejected;
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
  return handleGetDataContainer(
    { env: c.env, var: c.var, req: c.req }, id, fieldsQuery.fields, typedBundleSelection(fieldsQuery));
}, hydratedReadValidationHook);

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
