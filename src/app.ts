import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { isApiAuthorized } from "./lib/auth";
import { clearAuthFailures, recordAuthFailure } from "./lib/authThrottle";
import { corsPreflightResponse, withCors } from "./lib/cors";
import { isInvalidAuthModeError } from "./lib/establishSession";
import { isLoginPageUnavailableError } from "./lib/loginPageError";
import { notFoundProblem, problemJsonResponse, problemType } from "./lib/problem";
import {
  concurrentRefreshTimeoutProblem,
  isConcurrentRefreshTimeout
} from "./lib/sessionRefreshLock";
import { isUpstreamTimeout, upstreamTimeoutProblem } from "./lib/upstreamTimeout";
import { APP_VERSION } from "./lib/version";
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
    // Single-sourced from package.json via src/lib/version.ts (TOG-5840):
    // bump package.json#version and the spec version moves with it.
    version: APP_VERSION,
    description:
      "Explicit proxy to Routeware WebRW. Session cookies are stored in a Worker Durable Object; clients do not send Routeware credentials.\n\n" +
      "**Customer:** `customers-read` lists rows; `detail-full` loads one record; `customer-types-read` feeds dropdowns; `add-new-long` and `load-long-modal` return the same HTML/JS shells the SPA uses before save; `save-long-form` creates or updates (URL-encoded form body). **Anti-forgery** for `save-long-form` is filled server-side from Routeware modal HTML when the client omits `__RequestVerificationToken` (see `CUSTOMER_SAVE_AUTO_TOKEN`). Routeware does not support HTTP DELETE for customers — use `save-long-form` with `Enabled=false` to disable. `DELETE /api/v1/routeware/customer` documents that limitation (returns 405 + problem+json).\n\n" +
      "**D1 snapshots (Routeware custom CSV reports):** `customer_snapshot` (CustomerID) → `address_snapshot` (PickupAddressID, CustomerID) → `container_snapshot` (ContainerID, PickupAddressID). **Export source:** set `*_REPORT_EXPORT_PATH` (static URL) **or** `*_REPORT_QUERY_ID` (WebRW: client `requestID` + `GET` `QueryExecuteDownload`), then `POST /api/v1/data-snapshot/sync` (bearer) or the daily cron. `POST /api/v1/...-snapshot/import` accepts a raw CSV body. See `CUSTOMER_SNAPSHOT.md` for setup and migration commands.\n\n" +
      "**Data entity (`/api/v1/data/*`, tag `data-entity`):** bearer = `CUSTOMER_SNAPSHOT_SYNC_SECRET`. `GET` reads nested D1 snapshots (customer + address + container graph) with ETag/cache. `POST` applies changes to Routeware, returns ids + sync outcome only (never submitted fields or the upstream body), then refreshes D1 from `GetCustomerDetailFull` and invalidates that cache for affected ids."
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
  // CORS preflight carries no `Authorization` header by design, so it must be
  // answered before the bearer gate — otherwise browsers never issue the real
  // request. A preflight reveals only the CORS policy, never data, and the
  // early return also skips the body-buffer/session middleware below.
  if (method === "OPTIONS") {
    return corsPreflightResponse(c.req.raw);
  }
  const isPublic = method === "GET" && path === "/api/v1/health";
  if (isPublic) {
    await next();
    // Public responses still need ACAO so browser clients can read them.
    c.res = withCors(c.res, c.req.raw);
    return;
  }
  if (!isApiAuthorized(c.env, c.req)) {
    // Brute-force throttle (TOG-5820): count failed outer-gate checks per IP
    // in the AuthSession DO. A blocked IP gets 429 instead of another 401, so
    // a token-guessing loop slows to a crawl. (Preflight returns above, so
    // OPTIONS never consumes throttle budget; CORS wraps the 429/401 so
    // browsers surface the real status instead of a CORS error.)
    const verdict = await recordAuthFailure(c.env, {
      header: (name: string) => c.req.header(name)
    });
    if (verdict.blocked) {
      const throttled = problemJsonResponse({
        type: problemType("rate-limited"),
        title: "Too Many Requests",
        status: 429,
        detail:
          "Too many failed authentication attempts. Wait and retry. See docs/PROBLEMS.md#rate-limited.",
        instance: new URL(c.req.raw.url).pathname
      });
      throttled.headers.set("Retry-After", String(verdict.retryAfterSec));
      return withCors(throttled, c.req.raw);
    }
    return withCors(
      problemJsonResponse({
        type: problemType("unauthorized"),
        title: "Unauthorized",
        status: 401,
        detail:
          "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.",
        instance: new URL(c.req.raw.url).pathname
      }),
      c.req.raw
    );
  }
  // A valid token clears the IP's failure count, so one bad burst (or a
  // shared NAT IP) never locks out legitimate traffic.
  await clearAuthFailures(c.env, {
    header: (name: string) => c.req.header(name)
  });
  await next();
  // Stamp CORS + hardening headers on every downstream response (including
  // 404s) so browsers surface the real status instead of a CORS error.
  c.res = withCors(c.res, c.req.raw);
  return;
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
      title: "Not Found",
      status: 404,
      detail:
        "OpenAPI spec is disabled (set OPENAPI_DOCS_ENABLED=true to enable). See docs/PROBLEMS.md#forbidden.",
      instance: new URL(c.req.url).pathname
    });
  }
  return c.json(app.getOpenAPI31Document(openApiDocumentConfig));
});

app.use("/docs", async (c, next) => {
  if (!openapiDocsEnabled(c.env)) {
    return problemJsonResponse({
      type: problemType("forbidden"),
      title: "Not Found",
      status: 404,
      detail:
        "OpenAPI UI is disabled (set OPENAPI_DOCS_ENABLED=true to enable). See docs/PROBLEMS.md#forbidden.",
      instance: new URL(c.req.url).pathname
    });
  }
  return next();
});

// Scalar UI config (TOG-8360): preselect the `bearerAuth` scheme so the
// Authorize dialog opens on the right scheme, keep the token across reloads,
// and default code samples to curl. No token value is embedded here — the
// reviewer pastes `CUSTOMER_SNAPSHOT_SYNC_SECRET` once; `persistAuth` keeps
// it for every try-it call (import/sync) in that browser.
app.use(
  "/docs",
  Scalar({
    pageTitle: "Routeware Shadow API",
    url: "/openapi.json",
    authentication: { preferredSecurityScheme: "bearerAuth" },
    persistAuth: true,
    defaultHttpClient: { targetKey: "shell", clientKey: "curl" }
  })
);

// `notFound` and `onError` run outside the `/api/v1/*` middleware chain, so
// they stamp CORS headers directly — otherwise a browser sees a CORS error
// instead of the real 404/500 status.
app.notFound((c) =>
  withCors(notFoundProblem(new URL(c.req.url).pathname), c.req.raw)
);

app.onError((err, c) => {
  // A hung Routeware host throws `UpstreamTimeoutError` from any direct
  // `forwardToUpstream` caller (TOG-5835): surface it as 502 problem+json, not
  // a 500. The message is a fixed string (no URL/body/PII). Session-retry
  // routes map this themselves before it reaches here; this is the backstop
  // for direct forwarders (login-page, modals, detail-full sync internals).
  // CORS-wrapped so browsers surface the real 502 instead of a CORS error.
  if (isUpstreamTimeout(err)) {
    console.error("UPSTREAM TIMEOUT", err.message);
    return withCors(
      upstreamTimeoutProblem(err.timeoutMs, new URL(c.req.url).pathname),
      c.req.raw
    );
  }
  // A waiter that gave up on a hung concurrent refresh (TOG-6526): surface
  // it as 502 problem+json, not a 500. The message is a fixed string (no
  // cookie/URL/body/PII). Session-retry routes map this themselves before it
  // reaches here; this is the backstop for direct `establishSession` callers
  // (snapshot sync routes, detail-full sync internals).
  if (isConcurrentRefreshTimeout(err)) {
    console.error("CONCURRENT REFRESH TIMEOUT", err.message);
    return withCors(
      concurrentRefreshTimeoutProblem(err.timeoutMs, new URL(c.req.url).pathname),
      c.req.raw
    );
  }
  // A typo'd AUTH_MODE fails fast in `establishSession` (TOG-6531): surface
  // it as 503 problem+json, not a 500. The detail names the received value
  // (operator config, never a credential or customer data) plus the closed
  // set, so the fix is obvious from the response alone.
  if (isInvalidAuthModeError(err)) {
    console.error("INVALID AUTH_MODE", err.message);
    return withCors(
      problemJsonResponse({
        type: problemType("misconfigured"),
        title: "Service Unavailable",
        status: 503,
        detail: `${err.message} See docs/PROBLEMS.md#misconfigured.`,
        instance: new URL(c.req.url).pathname
      }),
      c.req.raw
    );
  }
  // A WAF/maintenance block on the login page (TOG-6536): fast 502 naming
  // the upstream status, not a 500 and never a browser launch. The message
  // carries only the status number (a fixed PII-free string). Session-retry
  // routes rethrow this past their single retry (the retry budget heals
  // expired sessions, not blocked upstreams); this is the backstop.
  // CORS-wrapped so browsers surface the real 502 instead of a CORS error.
  if (isLoginPageUnavailableError(err)) {
    console.error("LOGIN PAGE UNAVAILABLE", err.message);
    return withCors(
      problemJsonResponse({
        type: problemType("bad-gateway"),
        title: "Upstream login unavailable",
        status: 502,
        detail:
          `Routeware answered the login page with HTTP ${err.status} (WAF block or ` +
          `maintenance page). Retry once; if it persists the upstream host is ` +
          `blocking logins. See docs/PROBLEMS.md#bad-gateway.`,
        instance: new URL(c.req.url).pathname
      }),
      c.req.raw
    );
  }
  // Log the full error for observability, but do not echo internal details
  // (messages, stack, upstream text) back to the client.
  console.error("APP ERROR", err);
  return withCors(
    problemJsonResponse({
      type: problemType("internal"),
      title: "Internal Server Error",
      status: 500,
      detail:
        "An unexpected error occurred. See Worker logs for details. See docs/PROBLEMS.md#internal."
    }),
    c.req.raw
  );
});

export default app;
