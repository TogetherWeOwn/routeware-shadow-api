import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { RouteConfig } from "@hono/zod-openapi";
import { bearerMatches } from "../lib/auth";
import { problemJsonResponse, problemType } from "../lib/problem";
import { findForeignKeyError } from "../lib/snapshot/upsert";
import type { AppEnv } from "./types";

/**
 * Default zod-validation hook for every route module (TOG-5836).
 *
 * Without this, `@hono/zod-openapi` answers schema rejections (bad query,
 * path or body shapes) with its raw `{success:false, error}` 400 as
 * `application/json` — the one error shape in the API that did not anchor
 * into `docs/PROBLEMS.md`. Every rejection now returns an anchored 400
 * `bad-request` problem+json, and the handler never runs.
 *
 * `detail` names the rejected target and fields, never values: query strings
 * here can carry customer PII (company-name/company substrings), so the zod
 * messages (which echo received values) are deliberately not forwarded.
 */
export function validationFailureHook(
  result: {
    success: boolean;
    target: string;
    error?: { issues: Array<{ path: PropertyKey[] }> };
  },
  // The framework calls hooks as `hook(result, context)` (zod-validator): the
  // second arg carries `env`, so schema rejections honor the
  // `PROBLEM_TYPE_BASE` override. Optional so direct unit-test calls
  // (`validationFailureHook({success, target, error})`) keep working and fall
  // back to the committed default.
  c?: { env?: Env }
): Response | undefined {
  if (result.success || !result.error) {
    return undefined;
  }
  const fields = result.error.issues.map((issue) =>
    issue.path.length > 0 ? issue.path.map((p) => String(p)).join(".") : result.target
  );
  const unique = [...new Set(fields)];
  return problemJsonResponse({
    type: problemType("bad-request", c?.env),
    title: "Bad Request",
    status: 400,
    detail: `Invalid request ${result.target} (${unique.join(", ")}). See docs/PROBLEMS.md#bad-request.`
  });
}

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
 *
 * The `defaultHook` is what keeps schema rejections anchored: the validators
 * are built when each module registers its routes, so the hook must live on
 * the module itself — setting it only on the root app would leave every
 * module returning raw `{success:false}` 400s.
 */
export function createRouteModule(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({ defaultHook: validationFailureHook });
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
  req: { header: (name: string) => string | undefined; url: string };
};

/**
 * Guard for the snapshot-secret routes: returns a 401 problem+json response to
 * return as-is, or `null` when the caller is authorized.
 *
 * The detail is fixed here (TOG-7030): every privileged route names the sync
 * secret and the remedy doc, so clients see one canonical 401 body.
 */
export function requireSnapshotAuth(c: SnapshotAuthContext): Response | null {
  if (snapshotSyncAuthorized(c)) {
    return null;
  }
  return problemJsonResponse({
    type: problemType("unauthorized", c.env),
    title: "Unauthorized",
    status: 401,
    detail:
      "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.",
    instance: new URL(c.req.url).pathname
  });
}

/**
 * Guard for routes that need `CUSTOMER_SNAPSHOT_SYNC_SECRET` to be configured
 * at all: returns a 503 problem+json response, or `null` when it is set.
 */
export function requireSnapshotSecret(c: SnapshotAuthContext): Response | null {
  if (c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim()) {
    return null;
  }
  return problemJsonResponse({
    type: problemType("misconfigured", c.env),
    title: "Service Unavailable",
    status: 503,
    detail:
      "Set CUSTOMER_SNAPSHOT_SYNC_SECRET in vars or secrets. See docs/PROBLEMS.md#misconfigured.",
    instance: new URL(c.req.url).pathname
  });
}

/**
 * Map a dangling-FK snapshot failure to 400 `bad-request` problem+json, or
 * `null` when the error is not an FK violation. Lists up to 20 missing integer
 * keys, then `+N more` — integer keys only, no PII, no secrets.
 *
 * Shared by the address/container import and sync handlers: a `sync` that
 * pulls an upstream export with dangling references is the same client-actionable
 * 400 as an `import` with dangling rows, not a 500.
 */
export function foreignKeyProblem(err: unknown, env?: Env): Response | null {
  const fk = findForeignKeyError(err);
  if (!fk) {
    return null;
  }
  const shown = fk.missingKeys.slice(0, 20);
  const extra = fk.missingKeys.length - shown.length;
  const keys = extra > 0 ? `${shown.join(", ")} +${extra} more` : shown.join(", ");
  const parents =
    fk.parentTable === "customer_snapshot" ? "customers" : "addresses";
  return problemJsonResponse({
    type: problemType("bad-request", env),
    title: "Bad Request",
    status: 400,
    detail:
      `Dangling reference: ${fk.table}.${fk.column}=${keys} has no row in ` +
      `${fk.parentTable}.${fk.column} (batch at row offset ${fk.rowOffset}). ` +
      `Import ${parents} first. See docs/PROBLEMS.md#bad-request.`
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
              group: { type: "string" },
              sort: { type: "string" }
            }
          },
          example: {
            filter: [{ property: "CustomerID", operator: ">", value: 0 }],
            page: 1,
            start: 0,
            limit: 50,
            group: "[]",
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

/**
 * Worked 200 result for the snapshot import/sync responses (TOG-8360).
 *
 * Byte-identical to the bodies pinned by `test/syncSummaryContract.test.ts`
 * (`{upserted: 2, rowCount: 2, deleted: 0}`), so the Scalar "try it" panel
 * shows the exact shape a real 200 returns. Applied via zod
 * `.openapi({ example })` metadata — schema-level only, no runtime validator
 * is installed.
 */
export const snapshotWriteResultExample = {
  upserted: 2,
  rowCount: 2,
  deleted: 0
};

/**
 * Worked 200 result for `POST /api/v1/data-snapshot/sync` (TOG-8360): one
 * `{upserted, rowCount}` pair per table, matching the combined-shape contract
 * in `test/syncSummaryContract.test.ts` (no `deleted` leak, `null` when a
 * table is skipped).
 */
export const dataSnapshotSyncResultExample = {
  customer: { upserted: 2, rowCount: 2 },
  address: { upserted: 2, rowCount: 2 },
  container: { upserted: 2, rowCount: 2 }
};
