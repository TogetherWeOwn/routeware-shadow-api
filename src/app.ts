import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { establishSessionWithBrowser } from "./lib/browserAuth";
import { prepareSaveCustomerLongFormBody } from "./lib/customerSaveAutoToken";
import { forwardWithSessionRetry } from "./lib/forwardWithSessionRetry";
import { forwardToUpstream } from "./lib/upstreamForward";
import { notFoundProblem, problemJsonResponse, problemType } from "./lib/problem";
import { bearerMatches, isApiAuthorized } from "./lib/auth";
import {
  runAddressSnapshotSync,
  runContainerSnapshotSync,
  runCustomerSnapshotSync,
  runDataSnapshotSyncChainedHttp,
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromStream
} from "./lib/d1SnapshotSync";
import {
  handleGetDataAddress,
  handleGetDataContainer,
  handleGetDataCustomer,
  handlePostDataAddress,
  handlePostDataContainer,
  handlePostDataCustomer
} from "./lib/dataEntityHandlers";
import { readSessionState } from "./lib/sessionState";
import {
  routewareWebRwUrl,
  routewareWebRwUrlWithIncomingSearch
} from "./lib/upstreamUrl";

type Variables = {
  bodyBuffer: ArrayBuffer | null;
  sessionStub: DurableObjectStub;
};

const openApiDocumentConfig = {
  openapi: "3.1.0" as const,
  info: {
    title: "Routeware Shadow API",
    version: "1.0.0",
    description:
      "Explicit proxy to Routeware WebRW. Session cookies are stored in a Worker Durable Object; clients do not send Routeware credentials.\n\n" +
      "**Customer:** `customers-read` lists rows; `detail-full` loads one record; `customer-types-read` feeds dropdowns; `add-new-long` and `load-long-modal` return the same HTML/JS shells the SPA uses before save; `save-long-form` creates or updates (URL-encoded form body). **Anti-forgery** for `save-long-form` is filled server-side from Routeware modal HTML when the client omits `__RequestVerificationToken` (see `CUSTOMER_SAVE_AUTO_TOKEN`). Routeware does not support HTTP DELETE for customers — use `save-long-form` with `Enabled=false` to disable. `DELETE /api/v1/routeware/customer` documents that limitation (returns 405 + problem+json).\n\n" +
      "**D1 snapshots (Routeware custom CSV reports):** `customer_snapshot` (CustomerID) → `address_snapshot` (PickupAddressID, CustomerID) → `container_snapshot` (ContainerID, PickupAddressID). **Export source:** set `*_REPORT_EXPORT_PATH` (static URL) **or** `*_REPORT_QUERY_ID` (WebRW: client `requestID` + `GET` `QueryExecuteDownload`), then `POST /api/v1/data-snapshot/sync` (bearer) or the daily cron. `POST /api/v1/...-snapshot/import` accepts a raw CSV body. See `CUSTOMER_SNAPSHOT.md` for setup and migration commands.\n\n" +
      "**Data entity (`/api/v1/data/*`, tag `data-entity`):** bearer = `CUSTOMER_SNAPSHOT_SYNC_SECRET`. `GET` reads nested D1 snapshots (customer + address + container graph) with ETag/cache. `POST` applies changes to Routeware, returns `upstream` + `posted` fields, then refreshes D1 from `GetCustomerDetailFull` and invalidates that cache for affected ids."
  },
  tags: [
    { name: "meta" },
    { name: "routeware" },
    { name: "customer" },
    { name: "data" },
    { name: "reports" },
    { name: "customer-snapshot", description: "D1: customer custom report" },
    { name: "address-snapshot", description: "D1: address custom report" },
    { name: "container-snapshot", description: "D1: container custom report" },
    { name: "data-snapshot", description: "D1: combined report sync" },
    {
      name: "data-entity",
      description:
        "D1 aggregate reads (customer + address + container) and writes through Routeware with local snapshot sync"
    }
  ],
  security: [{ bearerAuth: [] }]
};

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description:
    "SHADOW_API_TOKEN (falls back to CUSTOMER_SNAPSHOT_SYNC_SECRET) as a bearer token. Required on all /api/v1/* routes except GET /api/v1/health."
});

function openapiDocsEnabled(env: Env): boolean {
  return env.OPENAPI_DOCS_ENABLED === "true";
}

function snapshotSyncAuthorized(c: {
  env: Env;
  req: { header: (name: string) => string | undefined };
}): boolean {
  return bearerMatches(c.req, c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET);
}

// Client auth gate: every /api/v1/* route requires a bearer token except the
// public allowlist (health). Runs before body buffering so unauthorized
// requests are rejected without reading the body.
app.use("/api/v1/*", async (c, next) => {
  const { method } = c.req.raw;
  const path = new URL(c.req.raw.url).pathname;
  const isPublic = method === "GET" && path === "/api/v1/health";
  if (isPublic) {
    return next();
  }
  if (!isApiAuthorized(c.env, c.req)) {
    return problemJsonResponse({
      type: problemType("unauthorized"),
      title: "Unauthorized",
      status: 401,
      detail:
        "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized."
    });
  }
  return next();
});

app.use("/api/v1/*", async (c, next) => {
  const raw = c.req.raw;
  const path = new URL(raw.url).pathname;
  const snapshotImportStream =
    path.endsWith("/customer-snapshot/import") ||
    path.endsWith("/address-snapshot/import") ||
    path.endsWith("/container-snapshot/import");
  const bodyBuffer =
    raw.method === "GET" || raw.method === "HEAD" || snapshotImportStream
      ? null
      : await raw.arrayBuffer();
  c.set("bodyBuffer", bodyBuffer);
  c.set(
    "sessionStub",
    c.env.AUTH_SESSION.get(c.env.AUTH_SESSION.idFromName("primary"))
  );
  await next();
});

const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/health",
  security: [],
  responses: {
    200: {
      description: "Worker is running",
      content: {
        "application/json": {
          schema: z
            .object({
              status: z.literal("ok"),
              service: z.string()
            })
            .openapi("HealthResponse")
        }
      }
    }
  }
});

app.openapi(healthRoute, (c) =>
  c.json({ status: "ok" as const, service: "routeware-shadow-api" }, 200)
);

const loginPageRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/account/login-page",
  responses: {
    200: {
      description:
        "Upstream HTML for the Routeware login page (unauthenticated fetch)",
      content: {
        "text/html": { schema: z.string() }
      }
    }
  }
});

app.openapi(loginPageRoute, async (c) => {
  const upstreamUrl = new URL(c.env.LOGIN_URL);
  return forwardToUpstream(c.req.raw, upstreamUrl, null, c.var.bodyBuffer);
});

const homeIndexRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/home/index",
  responses: {
    200: {
      description:
        "Upstream /WebRW/Home/Index (may be HTML, JSON, or other content types)",
      content: {
        "application/json": { schema: z.unknown() },
        "text/html": { schema: z.string() }
      }
    }
  }
});

app.openapi(homeIndexRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Home/Index"
  );
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSessionWithBrowser
  );
});

const upstreamPassthrough200 = {
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

const customersReadRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/customers-read",
  tags: ["customer"],
  summary: "CustomersRead (harvested SPA traffic)",
  responses: upstreamPassthrough200
});

app.openapi(customersReadRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/CustomersRead"
  );
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSessionWithBrowser
  );
});

const customerDetailFullRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/detail-full",
  tags: ["customer"],
  summary: "GetCustomerDetailFull",
  responses: upstreamPassthrough200
});

app.openapi(customerDetailFullRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/GetCustomerDetailFull"
  );
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSessionWithBrowser
  );
});

const customerTypesReadRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/customer-types-read",
  tags: ["customer"],
  summary: "CustomerTypesRead",
  description:
    "Customer type / category list for pickers (same store pattern as other Ext.NET `*Read` actions). Send **application/x-www-form-urlencoded** (e.g. `EnabledOnly=true`). Request body is not validated here so the Worker can forward the raw body after session middleware consumes the stream once.",
  responses: upstreamPassthrough200
});

app.openapi(customerTypesReadRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/CustomerTypesRead"
  );
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSessionWithBrowser
  );
});

const customerSaveLongFormRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/save-long-form",
  tags: ["customer"],
  summary: "SaveCustomerLongForm (create or update)",
  description:
    "Proxies to WebRW `SaveCustomerLongForm` with **application/x-www-form-urlencoded** bodies. **Anti-forgery:** when `__RequestVerificationToken` is missing or is a placeholder, the Worker uses the stored Routeware session to GET `AddNewLong` (create, `CustomerID` 0 / absent) or `LoadLongCustomerModal?customerID=` (edit), parses the token from HTML, and injects it before forwarding—clients normally do not need to send a token. Set `CUSTOMER_SAVE_AUTO_TOKEN=false` to disable. Use `CustomerID=0` for create; set `CustomerID` for updates. Disable customers with `Enabled=false` (no upstream delete).",
  responses: upstreamPassthrough200
});

app.openapi(customerSaveLongFormRoute, async (c) => {
  const session = await readSessionState(c.var.sessionStub);
  let bodyBuffer = c.var.bodyBuffer;
  try {
    bodyBuffer = await prepareSaveCustomerLongFormBody(
      c.env,
      session,
      c.req.raw,
      bodyBuffer,
      c.req.raw.headers.get("content-type")
    );
  } catch (err) {
    console.error("prepareSaveCustomerLongFormBody", err);
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-gateway",
      title: "Anti-forgery token preparation failed",
      status: 502,
      detail: err instanceof Error ? err.message : String(err)
    });
  }
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/SaveCustomerLongForm"
  );
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    bodyBuffer,
    establishSessionWithBrowser
  );
});

const customerAddNewLongRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/customer/add-new-long",
  tags: ["customer"],
  summary: "AddNewLong (new customer form shell)",
  description:
    "Returns the same HTML/JS fragment Routeware uses for the long add-customer modal. Optional for API clients: `save-long-form` can fetch this page server-side to obtain `__RequestVerificationToken` when you omit the token.",
  responses: upstreamPassthrough200
});

app.openapi(customerAddNewLongRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/AddNewLong"
  );
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSessionWithBrowser
  );
});

const customerLoadLongModalRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/customer/load-long-modal",
  tags: ["customer"],
  summary: "LoadLongCustomerModal",
  description:
    "Loads the edit-customer long form HTML/JS for the given `customerID` query parameter (forwarded to upstream unchanged).",
  responses: upstreamPassthrough200
});

app.openapi(customerLoadLongModalRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrlWithIncomingSearch(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/LoadLongCustomerModal",
    c.req.raw
  );
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSessionWithBrowser
  );
});

const customerDeleteNotSupportedRoute = createRoute({
  method: "delete",
  path: "/api/v1/routeware/customer",
  tags: ["customer"],
  summary: "Delete customer (not supported upstream)",
  description:
    "Routeware WebRW does not expose a hard delete. Disable or retire a customer by submitting `save-long-form` with `Enabled=false` (and other required fields from the loaded record).",
  responses: {
    405: {
      description:
        "Method not allowed (application/problem+json). Use save-long-form with Enabled=false to disable."
    }
  }
});

app.openapi(customerDeleteNotSupportedRoute, (c) =>
  problemJsonResponse({
    type: problemType("method-not-allowed"),
    title: "Customer delete not supported",
    status: 405,
    detail:
      "Routeware does not support deleting customers via HTTP DELETE. Load the customer with GET /api/v1/routeware/customer/load-long-modal?customerID={id}, then POST /api/v1/routeware/customer/save-long-form with the same field set and Enabled=false (or your tenant’s equivalent) to disable the record.",
    instance: new URL(c.req.url).pathname
  })
);

const appSettingsGetRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/data/app-settings-get",
  tags: ["data"],
  summary: "appSettingsGet",
  responses: upstreamPassthrough200
});

app.openapi(appSettingsGetRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Data/appSettingsGet"
  );
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSessionWithBrowser
  );
});

const queryRequestIsCompleteRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/reports/query-request-is-complete",
  tags: ["reports"],
  summary: "QueryRequestIsComplete (query string forwarded to upstream)",
  responses: upstreamPassthrough200
});

app.openapi(queryRequestIsCompleteRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrlWithIncomingSearch(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Reports/QueryRequestIsComplete",
    c.req.raw
  );
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSessionWithBrowser
  );
});

const snapshotListResponse = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number().int()
  })
  .openapi("CustomerSnapshotList");

const customerSnapshotListRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot",
  tags: ["customer-snapshot"],
  summary: "List customer snapshot rows (D1)",
  description:
    "Reads the cached Routeware customer CSV (see `CUSTOMER_SNAPSHOT.md`). Filter by `customerId`, company substring `q`, or `enabled`.",
  request: {
    query: z.object({
      customerId: z.coerce.number().int().optional(),
      q: z.string().optional().describe("Company name substring (case-insensitive)"),
      enabled: z.enum(["true", "false", "any"]).optional().default("any"),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0)
    })
  },
  responses: {
    200: {
      description: "Rows and total count for pagination",
      content: { "application/json": { schema: snapshotListResponse } }
    }
  }
});

app.openapi(customerSnapshotListRoute, async (c) => {
  const p = c.req.valid("query");
  const db = c.env.CUSTOMER_DB;
  const where: string[] = ["1 = 1"];
  const binds: unknown[] = [];
  if (p.customerId !== undefined) {
    where.push("customer_id = ?");
    binds.push(p.customerId);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    where.push("instr(lower(coalesce(company_name, '')), lower(?)) > 0");
    binds.push(p.q.trim());
  }
  if (p.enabled === "true") {
    where.push("enabled = 1");
  }
  if (p.enabled === "false") {
    where.push("enabled = 0");
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare(`SELECT COUNT(*) as n FROM customer_snapshot WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const { results } = await db
    .prepare(
      `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
              name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
       FROM customer_snapshot WHERE ${whereSql} ORDER BY customer_id LIMIT ? OFFSET ?`
    )
    .bind(...binds, p.limit, p.offset)
    .all();
  return c.json({ rows: results ?? [], total });
});

const customerSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot/{customerId}",
  tags: ["customer-snapshot"],
  summary: "Get one customer snapshot row",
  request: {
    params: z.object({ customerId: z.coerce.number().int() })
  },
  responses: {
    200: {
      description: "Row",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown())
        }
      }
    },
    400: {
      description: "Invalid customer id (application/problem+json)"
    },
    404: {
      description: "Not found (application/problem+json)"
    }
  }
});

app.openapi(customerSnapshotByIdRoute, async (c) => {
  const customerId = Number(c.req.param("customerId"));
  if (!Number.isFinite(customerId)) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: "customerId must be an integer"
    });
  }
  const row = await c.env.CUSTOMER_DB.prepare(
    `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
            name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
     FROM customer_snapshot WHERE customer_id = ?`
  )
    .bind(customerId)
    .first<Record<string, unknown>>();
  if (!row) {
    return problemJsonResponse({
      type: problemType("not-found"),
      title: "Not Found",
      status: 404,
      detail: `No snapshot row for customer_id=${customerId}`
    });
  }
  return c.json(row, 200);
});

const customerSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/customer-snapshot/sync",
  tags: ["customer-snapshot"],
  summary: "Fetch Routeware report CSV and upsert D1",
  description:
    "Same logic as the daily cron. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>` and either `CUSTOMER_REPORT_EXPORT_PATH` (static path) or `CUSTOMER_REPORT_QUERY_ID` (Routeware query id for the async report pipeline).",
  responses: {
    200: {
      description: "Sync result",
      content: {
        "application/json": {
          schema: z.object({
            upserted: z.number().int(),
            rowCount: z.number().int(),
            deleted: z.number().int().optional(),
            skipped: z.boolean().optional()
          })
        }
      }
    },
    401: { description: "Missing or invalid bearer token" },
    503: { description: "Secret or report path not configured" }
  }
});

app.openapi(customerSnapshotSyncRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Set CUSTOMER_SNAPSHOT_SYNC_SECRET and send Authorization: Bearer <secret>."
    });
  }
  if (!c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim()) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#misconfigured",
      title: "Not configured",
      status: 503,
      detail: "Set CUSTOMER_SNAPSHOT_SYNC_SECRET in vars or secrets."
    });
  }
  if (!c.env.CUSTOMER_REPORT_EXPORT_PATH?.trim() && !c.env.CUSTOMER_REPORT_QUERY_ID?.trim()) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#misconfigured",
      title: "Not configured",
      status: 503,
      detail:
        "Set CUSTOMER_REPORT_EXPORT_PATH (static report URL) or CUSTOMER_REPORT_QUERY_ID (Routeware query id). See CUSTOMER_SNAPSHOT.md."
    });
  }
  const r = await runCustomerSnapshotSync(c.env);
  if (!r) {
    return c.json({ upserted: 0, rowCount: 0, skipped: true }, 200);
  }
  return c.json(r, 200);
});

const customerSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/customer-snapshot/import",
  tags: ["customer-snapshot"],
  summary: "Import CSV body into D1",
  description:
    "Raw CSV bytes (same format as the Routeware export). `Content-Type: text/csv` or `application/octet-stream`. Requires bearer secret.",
  responses: {
    200: {
      description: "Import result",
      content: {
        "application/json": {
          schema: z.object({ upserted: z.number().int(), rowCount: z.number().int(), deleted: z.number().int().optional() })
        }
      }
    },
    401: { description: "Unauthorized" }
  }
});

app.openapi(customerSnapshotImportRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Bearer token mismatch or CUSTOMER_SNAPSHOT_SYNC_SECRET unset."
    });
  }
  const body = c.req.raw.body;
  if (!body) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request",
      title: "Empty body",
      status: 400,
      detail: "POST the CSV file as the raw request body."
    });
  }
  const r = await syncCustomerSnapshotFromStream(
    c.env.CUSTOMER_DB,
    body
  );
  return c.json(r, 200);
});

const dataSnapshotResultSchema = z
  .object({
    customer: z
      .object({ upserted: z.number().int(), rowCount: z.number().int() })
      .nullable(),
    address: z
      .object({ upserted: z.number().int(), rowCount: z.number().int() })
      .nullable(),
    container: z
      .object({ upserted: z.number().int(), rowCount: z.number().int() })
      .nullable()
  })
  .openapi("DataSnapshotSyncResult");

const dataSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/data-snapshot/sync",
  tags: ["data-snapshot"],
  summary: "Fetch all configured Routeware CSV reports and upsert D1 (ordered)",
  description:
    "Runs **customer** → **address** → **container** when the corresponding `*_REPORT_EXPORT_PATH` or `*_REPORT_QUERY_ID` vars are set. Same bearer as other snapshot sync routes. This route **chains three internal HTTP calls** to the per-table `...-snapshot/sync` routes so each table runs in a **separate** Worker invocation (D1’s per-invocation operation limit applies per table, not to the whole job). The daily cron should set `SHADOW_API_PUBLIC_BASE` to this Worker’s public URL. Each table is streamed; see `CUSTOMER_SNAPSHOT.md`.",
  responses: {
    200: {
      description: "Per-table Result (null if that export path is empty or was skipped for FKs)",
      content: { "application/json": { schema: dataSnapshotResultSchema } }
    },
    401: { description: "Unauthorized" }
  }
});

app.openapi(dataSnapshotSyncRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Set CUSTOMER_SNAPSHOT_SYNC_SECRET and send Authorization: Bearer <secret>."
    });
  }
  if (!c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim()) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#misconfigured",
      title: "Not configured",
      status: 503,
      detail: "Set CUSTOMER_SNAPSHOT_SYNC_SECRET in vars or secrets."
    });
  }
  const origin = new URL(c.req.url).origin;
  const r = await runDataSnapshotSyncChainedHttp(origin, c.env);
  return c.json(r, 200);
});

const addressSnapshotListRoute = createRoute({
  method: "get",
  path: "/api/v1/address-snapshot",
  tags: ["address-snapshot"],
  summary: "List address snapshot rows (D1)",
  description:
    "Routeware addresses (`PickupAddressID` → `CustomerID`). Optional filters: `customerId`, `pickupAddressId`, free-text on street `q`, `enabled`.",
  request: {
    query: z.object({
      customerId: z.coerce.number().int().optional(),
      pickupAddressId: z.coerce.number().int().optional(),
      q: z.string().optional().describe("Address line substring (case-insensitive)"),
      enabled: z.enum(["true", "false", "any"]).optional().default("any"),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0)
    })
  },
  responses: {
    200: {
      description: "Rows and total",
      content: { "application/json": { schema: snapshotListResponse } }
    }
  }
});

app.openapi(addressSnapshotListRoute, async (c) => {
  const p = c.req.valid("query");
  const db = c.env.CUSTOMER_DB;
  const where: string[] = ["1 = 1"];
  const binds: unknown[] = [];
  if (p.customerId !== undefined) {
    where.push("customer_id = ?");
    binds.push(p.customerId);
  }
  if (p.pickupAddressId !== undefined) {
    where.push("pickup_address_id = ?");
    binds.push(p.pickupAddressId);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    where.push("instr(lower(coalesce(address, '')), lower(?)) > 0");
    binds.push(p.q.trim());
  }
  if (p.enabled === "true") {
    where.push("enabled = 1");
  }
  if (p.enabled === "false") {
    where.push("enabled = 0");
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare(`SELECT COUNT(*) as n FROM address_snapshot WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const { results } = await db
    .prepare(
      `SELECT pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
              extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at
       FROM address_snapshot WHERE ${whereSql} ORDER BY pickup_address_id LIMIT ? OFFSET ?`
    )
    .bind(...binds, p.limit, p.offset)
    .all();
  return c.json({ rows: results ?? [], total });
});

const addressSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/address-snapshot/{pickupAddressId}",
  tags: ["address-snapshot"],
  summary: "Get one address snapshot row",
  request: {
    params: z.object({ pickupAddressId: z.coerce.number().int() })
  },
  responses: {
    200: {
      description: "Row",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }
    },
    400: {
      description: "Invalid id (application/problem+json)"
    },
    404: {
      description: "Not found (application/problem+json)"
    }
  }
});

app.openapi(addressSnapshotByIdRoute, async (c) => {
  const id = Number(c.req.param("pickupAddressId"));
  if (!Number.isFinite(id)) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: "pickupAddressId must be an integer"
    });
  }
  const row = await c.env.CUSTOMER_DB.prepare(
    `SELECT pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
            extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at
     FROM address_snapshot WHERE pickup_address_id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) {
    return problemJsonResponse({
      type: problemType("not-found"),
      title: "Not Found",
      status: 404,
      detail: `No address row for pickup_address_id=${id}`
    });
  }
  return c.json(row, 200);
});

const containerSnapshotListRoute = createRoute({
  method: "get",
  path: "/api/v1/container-snapshot",
  tags: ["container-snapshot"],
  summary: "List container snapshot rows (D1)",
  description:
    "Routeware containers link to an address via `pickup_address_id` (and thus to a customer). Filter by `customerId` (joins through address), `pickupAddressId`, or `containerId`, text `q` on `location_address` or `serial_number`, and `enabled`.",
  request: {
    query: z.object({
      customerId: z.coerce.number().int().optional(),
      pickupAddressId: z.coerce.number().int().optional(),
      containerId: z.coerce.number().int().optional(),
      q: z.string().optional().describe("Substring on location or serial (case-insensitive)"),
      enabled: z.enum(["true", "false", "any"]).optional().default("any"),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0)
    })
  },
  responses: {
    200: {
      description: "Rows and total",
      content: { "application/json": { schema: snapshotListResponse } }
    }
  }
});

app.openapi(containerSnapshotListRoute, async (c) => {
  const p = c.req.valid("query");
  const db = c.env.CUSTOMER_DB;
  const fromJoin =
    p.customerId !== undefined
      ? "FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id"
      : "FROM container_snapshot c";
  const where: string[] = ["1 = 1"];
  const binds: unknown[] = [];
  if (p.customerId !== undefined) {
    where.push("a.customer_id = ?");
    binds.push(p.customerId);
  }
  if (p.pickupAddressId !== undefined) {
    where.push("c.pickup_address_id = ?");
    binds.push(p.pickupAddressId);
  }
  if (p.containerId !== undefined) {
    where.push("c.container_id = ?");
    binds.push(p.containerId);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    where.push(
      "(instr(lower(coalesce(c.location_address, '')), lower(?)) > 0 OR instr(lower(coalesce(c.serial_number, '')), lower(?)) > 0)"
    );
    const qv = p.q.trim();
    binds.push(qv, qv);
  }
  if (p.enabled === "true") {
    where.push("c.enabled = 1");
  }
  if (p.enabled === "false") {
    where.push("c.enabled = 0");
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) as n ${fromJoin} WHERE ${whereSql}`
    )
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const { results } = await db
    .prepare(
      `SELECT c.container_id, c.pickup_address_id, c.container_type_id, c.serial_number, c.rfid, c.oncall, c.event_code,
              c.gps_locked, c.latitude, c.longitude, c.enabled, c.location_address, c.city, c.state, c.zip, c.container_note,
              c.ud_cost_share_ud, c.ud_enclosure_doors_ud, c.ud_last_compactor_inspection_ud, c.ud_last_enclosure_inspection_ud,
              c.ud_material_stream_ud, c.color, c.service_code_type, c.service_code_input, c.service_code, c.service_date, c.route_ids, c.frequency_ids, c.synced_at
       ${fromJoin} WHERE ${whereSql} ORDER BY c.container_id LIMIT ? OFFSET ?`
    )
    .bind(...binds, p.limit, p.offset)
    .all();
  return c.json({ rows: results ?? [], total });
});

const containerSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/container-snapshot/{containerId}",
  tags: ["container-snapshot"],
  summary: "Get one container snapshot row",
  request: {
    params: z.object({ containerId: z.coerce.number().int() })
  },
  responses: {
    200: {
      description: "Row",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }
    },
    400: {
      description: "Invalid id (application/problem+json)"
    },
    404: {
      description: "Not found (application/problem+json)"
    }
  }
});

app.openapi(containerSnapshotByIdRoute, async (c) => {
  const id = Number(c.req.param("containerId"));
  if (!Number.isFinite(id)) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: "containerId must be an integer"
    });
  }
  const row = await c.env.CUSTOMER_DB.prepare(
    `SELECT container_id, pickup_address_id, container_type_id, serial_number, rfid, oncall, event_code, gps_locked,
            latitude, longitude, enabled, location_address, city, state, zip, container_note, ud_cost_share_ud,
            ud_enclosure_doors_ud, ud_last_compactor_inspection_ud, ud_last_enclosure_inspection_ud, ud_material_stream_ud,
            color, service_code_type, service_code_input, service_code, service_date, route_ids, frequency_ids, synced_at
     FROM container_snapshot WHERE container_id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) {
    return problemJsonResponse({
      type: problemType("not-found"),
      title: "Not Found",
      status: 404,
      detail: `No container row for container_id=${id}`
    });
  }
  return c.json(row, 200);
});

const addressSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/address-snapshot/sync",
  tags: ["address-snapshot"],
  summary: "Fetch address report CSV and upsert D1",
  description:
    "Same bearer as `customer-snapshot` sync. Requires `ADDRESS_REPORT_EXPORT_PATH` or `ADDRESS_REPORT_QUERY_ID`. Customers should exist in D1 (run customer import/sync first) so `customer_id` foreign keys are satisfied.",
  responses: {
    200: {
      description: "Result",
      content: {
        "application/json": {
          schema: z.object({
            upserted: z.number().int(),
            rowCount: z.number().int(),
            deleted: z.number().int().optional(),
            skipped: z.boolean().optional()
          })
        }
      }
    },
    401: { description: "Unauthorized" },
    503: { description: "Not configured" }
  }
});

app.openapi(addressSnapshotSyncRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Bearer token required."
    });
  }
  if (!c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim()) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#misconfigured",
      title: "Not configured",
      status: 503,
      detail: "Set CUSTOMER_SNAPSHOT_SYNC_SECRET in vars or secrets."
    });
  }
  if (!c.env.ADDRESS_REPORT_EXPORT_PATH?.trim() && !c.env.ADDRESS_REPORT_QUERY_ID?.trim()) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#misconfigured",
      title: "Not configured",
      status: 503,
      detail: "Set ADDRESS_REPORT_EXPORT_PATH or ADDRESS_REPORT_QUERY_ID (see CUSTOMER_SNAPSHOT.md)."
    });
  }
  const r = await runAddressSnapshotSync(c.env);
  if (!r) {
    return c.json({ upserted: 0, rowCount: 0, skipped: true }, 200);
  }
  return c.json(r, 200);
});

const addressSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/address-snapshot/import",
  tags: ["address-snapshot"],
  summary: "Import address CSV body into D1",
  description: "Raw CSV (Routeware Address Details custom report). Bear same secret; import **customers** first to satisfy `customer_id` foreign keys.",
  responses: {
    200: {
      description: "Result",
      content: {
        "application/json": {
          schema: z.object({ upserted: z.number().int(), rowCount: z.number().int(), deleted: z.number().int().optional() })
        }
      }
    },
    401: { description: "Unauthorized" }
  }
});

app.openapi(addressSnapshotImportRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401
    });
  }
  const body = c.req.raw.body;
  if (!body) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request",
      title: "Empty body",
      status: 400,
      detail: "POST the CSV as raw body."
    });
  }
  const r = await syncAddressSnapshotFromStream(c.env.CUSTOMER_DB, body);
  return c.json(r, 200);
});

const containerSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/container-snapshot/sync",
  tags: ["container-snapshot"],
  summary: "Fetch container report CSV and upsert D1",
  description:
    "Same bearer. Requires `CONTAINER_REPORT_EXPORT_PATH` or `CONTAINER_REPORT_QUERY_ID`. Address rows for each `pickup_address_id` should exist in D1 first.",
  responses: {
    200: {
      description: "Result",
      content: {
        "application/json": {
          schema: z.object({
            upserted: z.number().int(),
            rowCount: z.number().int(),
            deleted: z.number().int().optional(),
            skipped: z.boolean().optional()
          })
        }
      }
    },
    401: { description: "Unauthorized" },
    503: { description: "Not configured" }
  }
});

app.openapi(containerSnapshotSyncRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401
    });
  }
  if (!c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim()) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#misconfigured",
      title: "Not configured",
      status: 503
    });
  }
  if (!c.env.CONTAINER_REPORT_EXPORT_PATH?.trim() && !c.env.CONTAINER_REPORT_QUERY_ID?.trim()) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#misconfigured",
      title: "Not configured",
      status: 503,
      detail: "Set CONTAINER_REPORT_EXPORT_PATH or CONTAINER_REPORT_QUERY_ID (see CUSTOMER_SNAPSHOT.md)."
    });
  }
  const r = await runContainerSnapshotSync(c.env);
  if (!r) {
    return c.json({ upserted: 0, rowCount: 0, skipped: true }, 200);
  }
  return c.json(r, 200);
});

const containerSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/container-snapshot/import",
  tags: ["container-snapshot"],
  summary: "Import container CSV into D1",
  description: "Raw CSV. Bear same secret. Import or sync **addresses** (and **customers**) first for `pickup_address_id` foreign keys.",
  responses: {
    200: {
      description: "Result",
      content: {
        "application/json": {
          schema: z.object({ upserted: z.number().int(), rowCount: z.number().int(), deleted: z.number().int().optional() })
        }
      }
    },
    401: { description: "Unauthorized" }
  }
});

app.openapi(containerSnapshotImportRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401
    });
  }
  const body = c.req.raw.body;
  if (!body) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request",
      title: "Empty body",
      status: 400
    });
  }
  const r = await syncContainerSnapshotFromStream(c.env.CUSTOMER_DB, body);
  return c.json(r, 200);
});

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

app.openapi(dataCustomerGetRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Set CUSTOMER_SNAPSHOT_SYNC_SECRET and send Authorization: Bearer <secret>."
    });
  }
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

app.openapi(dataAddressGetRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Bearer required (same as snapshot sync secret)."
    });
  }
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

app.openapi(dataContainerGetRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Bearer required (same as snapshot sync secret)."
    });
  }
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

app.openapi(dataCustomerPostRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Bearer required."
    });
  }
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

app.openapi(dataAddressPostRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401
    });
  }
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

app.openapi(dataContainerPostRoute, async (c) => {
  if (!snapshotSyncAuthorized(c)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized",
      title: "Unauthorized",
      status: 401
    });
  }
  return handlePostDataContainer({ env: c.env, var: c.var, req: c.req });
});

app.get("/openapi.json", (c) => {
  if (!openapiDocsEnabled(c.env)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#forbidden",
      title: "Not available",
      status: 404,
      detail:
        "OpenAPI spec is disabled (set OPENAPI_DOCS_ENABLED=true to enable)."
    });
  }
  return c.json(app.getOpenAPI31Document(openApiDocumentConfig));
});

app.use("/docs", async (c, next) => {
  if (!openapiDocsEnabled(c.env)) {
    return problemJsonResponse({
      type: "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#forbidden",
      title: "Not available",
      status: 404,
      detail:
        "OpenAPI UI is disabled (set OPENAPI_DOCS_ENABLED=true to enable)."
    });
  }
  return next();
});

app.use(
  "/docs",
  Scalar({
    pageTitle: "Routeware Shadow API",
    url: "/openapi.json"
  })
);

app.notFound((c) => notFoundProblem(new URL(c.req.url).pathname));

app.onError((err, _c) => {
  // Log the full error for observability, but do not echo internal details
  // (messages, stack, upstream text) back to the client.
  console.error("APP ERROR", err);
  return problemJsonResponse({
    type: problemType("internal"),
    title: "Internal Server Error",
    status: 500,
    detail: "An unexpected error occurred. See Worker logs for details."
  });
});

export default app;
