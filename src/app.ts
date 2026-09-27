import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { isApiAuthorized } from "./lib/auth";
import { notFoundProblem, problemJsonResponse, problemType } from "./lib/problem";
import { addressSnapshotRoutes } from "./routes/addressSnapshot";
import { addressRoutes } from "./routes/address";
import { containerSnapshotRoutes } from "./routes/containerSnapshot";
import { containerRoutes } from "./routes/container";
import { customerRoutes } from "./routes/customer";
import { customerSnapshotRoutes } from "./routes/customerSnapshot";
import { dataEntityRoutes } from "./routes/dataEntity";
import { dataSnapshotRoutes } from "./routes/dataSnapshot";
import { metaRoutes } from "./routes/meta";
import { routewareRoutes } from "./routes/routeware";
import { shadowRoutes } from "./routes/shadow";
import type { AppEnv } from "./routes/types";

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
    { name: "shadow", description: "Versioned Shadow API staging slice" },
    { name: "routeware" },
    { name: "customer" },
    { name: "address", description: "Routeware PickupAddress writes (explicit proxy to WebRW)" },
    { name: "container", description: "Routeware Container writes (explicit proxy to WebRW)" },
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

const app = new OpenAPIHono<AppEnv>();

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description:
    "SHADOW_API_TOKEN (falls back to CUSTOMER_SNAPSHOT_SYNC_SECRET) as a bearer token. Required on all /api/v1/* routes except GET /api/v1/health."
});

function openapiDocsEnabled(env: Env): boolean {
  return env.OPENAPI_DOCS_ENABLED === "true";
}

// Client auth gate: every /api/v1/* route requires a bearer token except the
// public allowlist (health). Runs before body buffering so unauthorized
// requests are rejected without reading the body.
//
// Both middlewares below must stay registered BEFORE the route modules are
// mounted: Hono runs matching handlers in registration order, so a route
// mounted first would be reachable without passing the gate.
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

// Route modules. Each is an OpenAPIHono, so `route()` merges its
// `openAPIRegistry` into this app's and `/openapi.json` still sees every route.
// Mounted at "/" because each module's `createRoute` paths are already absolute.
app.route("/", metaRoutes);
app.route("/", shadowRoutes);
app.route("/", routewareRoutes);
app.route("/", customerRoutes);
app.route("/", addressRoutes);
app.route("/", containerRoutes);
app.route("/", customerSnapshotRoutes);
app.route("/", dataSnapshotRoutes);
app.route("/", addressSnapshotRoutes);
app.route("/", containerSnapshotRoutes);
app.route("/", dataEntityRoutes);

app.get("/openapi.json", (c) => {
  if (!openapiDocsEnabled(c.env)) {
    return problemJsonResponse({
      type: problemType("forbidden"),
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
      type: problemType("forbidden"),
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
