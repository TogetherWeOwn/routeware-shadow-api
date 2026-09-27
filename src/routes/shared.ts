import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { RouteConfig } from "@hono/zod-openapi";
import { bearerMatches } from "../lib/auth";
import { problemJsonResponse, problemType } from "../lib/problem";
import type { AppEnv } from "./types";

/**
 * Build an empty route module.
 *
 * It must be an `OpenAPIHono`, never a plain `Hono`: `OpenAPIHono.route()`
 * copies a sub-app's `openAPIRegistry` into the parent only when the sub-app is
 * `instanceof OpenAPIHono`. Mounting a plain `Hono` would still serve traffic
 * while silently dropping every one of its routes from `/openapi.json`.
 *
 * Modules are mounted on the root app at `"/"` so the full `/api/v1/...` path
 * written in each `createRoute` is used verbatim, with no prefix merging.
 */
export function createRouteModule(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>();
}

/**
 * Snapshot and data-entity routes gate on `CUSTOMER_SNAPSHOT_SYNC_SECRET`
 * specifically. This is a second, narrower check that runs inside the handler,
 * on top of the app-wide `/api/v1/*` bearer gate in `app.ts`.
 */
export function snapshotSyncAuthorized(c: SnapshotAuthContext): boolean {
  return bearerMatches(c.req, c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET);
}

type SnapshotAuthContext = {
  env: Env;
  req: { header: (name: string) => string | undefined };
};

/**
 * Guard for the snapshot-secret routes: returns a 401 problem+json response to
 * return as-is, or `null` when the caller is authorized.
 *
 * `detail` is per-call-site rather than fixed here because the existing wording
 * differs between routes (several omit it entirely). That inconsistency is
 * pre-existing and pinned by `test/snapshotAuth.test.ts`; unifying it would
 * change what clients see, so it belongs in its own change.
 */
export function requireSnapshotAuth(
  c: SnapshotAuthContext,
  detail?: string
): Response | null {
  if (snapshotSyncAuthorized(c)) {
    return null;
  }
  return problemJsonResponse({
    type: problemType("unauthorized"),
    title: "Unauthorized",
    status: 401,
    detail
  });
}

/**
 * Guard for routes that need `CUSTOMER_SNAPSHOT_SYNC_SECRET` to be configured
 * at all: returns a 503 problem+json response, or `null` when it is set.
 */
export function requireSnapshotSecret(env: Env, detail?: string): Response | null {
  if (env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim()) {
    return null;
  }
  return problemJsonResponse({
    type: problemType("misconfigured"),
    title: "Not configured",
    status: 503,
    detail
  });
}

/**
 * Docs-only request/response payload pairs for the Scalar UI. Every schema
 * here is a raw OpenAPI object (never a zod schema), so
 * `@hono/zod-openapi` renders it into `/openapi.json` verbatim while its
 * `isZod` check skips validator installation — the Worker keeps forwarding
 * raw bodies untouched, exactly as the route descriptions promise.
 *
 * Request bodies are keyed to what the SPA actually sends (mirrored from
 * `tools/api-discovery/examples/`); response `example` values are the
 * documented upstream shapes (`{ success, total, data }` Ext.NET store reads,
 * `currentCustomer` + `data` detail payloads, `{ success }` saves).
 *
 * Each docs object is typed as `Pick<RouteConfig, "request" | "responses">`:
 * the contextual type keeps the raw-schema literals (`type: "object"`)
 * narrow so they satisfy `SchemaObject`, without any zod wrapper — which is
 * exactly what keeps `OpenAPIHono` from installing runtime validators for
 * these bodies (its `isZod` check skips non-zod schemas, so the Worker keeps
 * forwarding raw bodies untouched).
 */
type RouteDocs = Pick<RouteConfig, "request" | "responses">;

/**
 * One response entry (`ResponseConfig | ReferenceObject`). Annotating the
 * envelope helpers with this keeps raw-schema literals narrow in place —
 * contextual typing flows into the function body, which a bare annotation on
 * the outer docs const cannot do once the helper return type is inferred
 * (widened `type: string` then fails `SchemaObject` at the use site).
 */
type RouteResponse = RouteDocs["responses"][string];
/** Response shape for routes that stream an upstream Routeware body through. */
export const upstreamPassthrough200 = {
  200: {
    description:
      "Upstream Routeware response (JSON, form-encoded, HTML, or other)",
    content: {
      "application/json": { schema: z.unknown() },
      "text/plain": { schema: z.string() },
      "text/html": { schema: z.string() }
    }
  }
} as const;

/** Ext.NET store read envelope: `{ success, total, data[] }`. */
function storeReadResponse(exampleData: unknown[]): RouteResponse {
  return {
    description:
      "Upstream Routeware response (JSON, form-encoded, HTML, or other)",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            total: { type: "integer" },
            data: { type: "array", items: { type: "object" } }
          }
        },
        example: { success: true, total: exampleData.length, data: exampleData }
      },
      "text/plain": { schema: { type: "string" } },
      "text/html": { schema: { type: "string" } }
    }
  };
}

/** `GetCustomerDetailFull` envelope: `currentCustomer` + `data` addresses. */
function detailFullResponse(): RouteResponse {
  const currentCustomer = {
    CustomerID: 345734,
    CustomerTypeID: 2,
    CompanyName: "ExampleCo",
    NameFirst: "Jane",
    NameMI: "",
    NameLast: "Doe",
    CustomerNumber: "C-1001",
    Phone1: "555-0100",
    Enabled: true
  };
  const data = [
    {
      PickupAddressID: 10,
      CustomerID: 345734,
      Address: "1 Main St",
      City: "Killeen",
      State: "TX",
      Zip: "76541",
      Enabled: true,
      Containers: [{ ContainerID: 100, PickupAddressID: 10, SerialNumber: "C-100-A" }]
    }
  ];
  return {
    description:
      "Upstream Routeware response (JSON, form-encoded, HTML, or other)",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            currentCustomer: { type: "object" },
            data: { type: "array", items: { type: "object" } }
          }
        },
        example: { currentCustomer, data }
      },
      "text/plain": { schema: { type: "string" } },
      "text/html": { schema: { type: "string" } }
    }
  };
}

/** Save-form success envelope: Routeware `{ success }` JSON. */
function saveFormResponse(): RouteResponse {
  return {
    description:
      "Upstream Routeware response (JSON, form-encoded, HTML, or other)",
    content: {
      "application/json": {
        schema: { type: "object", properties: { success: { type: "boolean" } } },
        example: { success: true }
      },
      "text/plain": { schema: { type: "string" } },
      "text/html": { schema: { type: "string" } }
    }
  };
}

/** Customer `CustomersRead` docs: store-read request + response examples. */
export const customersReadDocs: RouteDocs = {
  request: {
    body: {
      description:
        "Ext.NET store read body (JSON). A non-empty `filter` avoids the upstream “You need to filter.” error.",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              filter: { type: "array", items: { type: "object" } },
              page: { type: "integer" },
              start: { type: "integer" },
              limit: { type: "integer" },
              sort: { type: "string" }
            }
          },
          example: {
            filter: [{ property: "CustomerID", operator: ">", value: 0 }],
            page: 1,
            start: 0,
            limit: 50,
            sort: '[{"property":"CustomerID","direction":"ASC"}]'
          }
        }
      }
    }
  },
  responses: {
    200: storeReadResponse([
      { CustomerID: 345734, CompanyName: "ExampleCo", Phone1: "555-0100", Enabled: true }
    ])
  }
};

/** Customer `GetCustomerDetailFull` docs: id request + detail response. */
export const customerDetailFullDocs: RouteDocs = {
  request: {
    body: {
      description: "Customer id to load (JSON).",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { CustomerID: { type: "integer" } },
            required: ["CustomerID"]
          },
          example: { CustomerID: 345734 }
        }
      }
    }
  },
  responses: { 200: detailFullResponse() }
};

/** Customer `CustomerTypesRead` docs: urlencoded filter + store response. */
export const customerTypesReadDocs: RouteDocs = {
  request: {
    body: {
      description:
        "Dropdown filter (application/x-www-form-urlencoded). Request body is not validated here so the Worker can forward the raw body.",
      content: {
        "application/x-www-form-urlencoded": {
          schema: { type: "object", properties: { EnabledOnly: { type: "string" } } },
          example: { EnabledOnly: "true" }
        }
      }
    }
  },
  responses: {
    200: storeReadResponse([{ CustomerTypeID: 1, CustomerType: "Commercial" }])
  }
};

/** Customer `SaveCustomerLongForm` docs: urlencoded save + success response. */
export const customerSaveLongFormDocs: RouteDocs = {
  request: {
    body: {
      description:
        "Save fields (application/x-www-form-urlencoded). Omit `__RequestVerificationToken` — the Worker fills it server-side from the Routeware modal. `CustomerID=0` creates; set it to update; `Enabled=false` disables.",
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            properties: {
              CustomerID: { type: "string" },
              CustomerTypeID: { type: "string" },
              CompanyName: { type: "string" },
              FirstName: { type: "string" },
              LastName: { type: "string" },
              Enabled: { type: "string" }
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
  responses: { 200: saveFormResponse() }
};

/** Address `SaveAddressForm` docs: urlencoded save + success response. */
export const addressSaveFormDocs: RouteDocs = {
  request: {
    body: {
      description:
        "Save fields (application/x-www-form-urlencoded). Omit `__RequestVerificationToken` — the Worker fills it server-side. `PickupAddressID=0` with `CustomerID` creates; set it to update.",
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            properties: {
              PickupAddressID: { type: "string" },
              CustomerID: { type: "string" },
              Address: { type: "string" },
              City: { type: "string" },
              State: { type: "string" },
              Zip: { type: "string" }
            }
          },
          example: {
            PickupAddressID: "0",
            CustomerID: "345734",
            Address: "1 Main St",
            City: "Killeen",
            State: "TX",
            Zip: "76541"
          }
        }
      }
    }
  },
  responses: { 200: saveFormResponse() }
};

/** Container `SaveContainerForm` docs: urlencoded save + success response. */
export const containerSaveFormDocs: RouteDocs = {
  request: {
    body: {
      description:
        "Save fields (application/x-www-form-urlencoded). Omit `__RequestVerificationToken` — the Worker fills it server-side. `ContainerID=0` with `PickupAddressID` creates; set it to update.",
      content: {
        "application/x-www-form-urlencoded": {
          schema: {
            type: "object",
            properties: {
              ContainerID: { type: "string" },
              PickupAddressID: { type: "string" },
              SerialNumber: { type: "string" }
            }
          },
          example: {
            ContainerID: "0",
            PickupAddressID: "10",
            SerialNumber: "C-100-A"
          }
        }
      }
    }
  },
  responses: { 200: saveFormResponse() }
};

/**
 * Shared by the customer, address and container snapshot list routes. Keep this
 * a single instance — the `.openapi()` name registers one reusable component,
 * and three separate instances would register it three times.
 */
export const snapshotListResponse = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number().int()
  })
  .openapi("CustomerSnapshotList");
