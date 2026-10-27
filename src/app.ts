import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { isApiAuthorized, isReadAuthorized } from "./lib/auth";
import {
  AUTH_THROTTLE_ALLOWED_FAILURES,
  AUTH_THROTTLE_WINDOW_MS,
  clearAuthFailures,
  recordAuthFailure
} from "./lib/authThrottle";
import { corsPreflightResponse, withCors, withSecurityHeaders } from "./lib/cors";
import { scalarDocsConfiguration, withDocsBranding } from "./lib/docsPresentation";
import { isInvalidAuthModeError } from "./lib/establishSession";
import { isLoginPageUnavailableError } from "./lib/loginPageError";
import { errorKind, logEvent } from "./lib/logger";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
  stampRequestId
} from "./lib/requestId";
import { isMissingSetCookieCapabilityError } from "./lib/setCookieCapabilityError";
import { notFoundProblem, problemJsonResponse, problemType } from "./lib/problem";
import { InvalidReportQueryDatesError } from "./lib/reportQueryDates";
import {
  concurrentRefreshTimeoutProblem,
  isConcurrentRefreshTimeout
} from "./lib/sessionRefreshLock";
import {
  UPSTREAM_TIMEOUT_RETRY_AFTER_SEC,
  isUpstreamTimeout,
  upstreamTimeoutProblem
} from "./lib/upstreamTimeout";
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
import { snapshotArchiveRoutes } from "./routes/snapshotArchive";
import type { AppEnv } from "./routes/types";

const openApiDocumentConfig = {
  openapi: "3.1.0" as const,
  info: {
    title: "Routeware Shadow API",
    // Single-sourced from package.json via src/lib/version.ts:
    // the live spec updates on bump; also regenerate docs/openapi.json.
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
  security: [{ bearerAuth: [] }],
  // Compact discovery legend; operation metadata lives with each route definition.
  "x-agent-metadata": {
    access: {
      public: "No bearer required (health probe only).",
      read: "GET: SHADOW_API_READ_TOKEN, SHADOW_API_TOKEN or CUSTOMER_SNAPSHOT_SYNC_SECRET passes the outer gate.",
      full: "SHADOW_API_TOKEN or CUSTOMER_SNAPSHOT_SYNC_SECRET passes the outer gate; the read token cannot authorize non-GET requests.",
      "sync-secret": "CUSTOMER_SNAPSHOT_SYNC_SECRET only: the same bearer must pass both the outer and inner privileged gates, including on GET."
    },
    effect: {
      none: "No application data access (liveness or unsupported-operation response).",
      "local-read": "Reads local D1, R2 or configuration; no upstream data request.",
      "upstream-read": "Reads Routeware, including POST reads; may establish or renew the upstream session.",
      "local-write": "Writes local D1 state without writing Routeware; imports may also archive to R2.",
      "upstream-read-local-sync": "Reads Routeware reports and synchronizes local D1 state; may archive to R2.",
      "upstream-write-local-refresh": "Writes Routeware and attempts a best-effort local D1/cache refresh; not an atomic or guaranteed refresh."
    }
  }
};

const app = new OpenAPIHono<AppEnv>();

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description:
    "Use one Authorization: Bearer <token> header. SHADOW_API_TOKEN (falling back to CUSTOMER_SNAPSHOT_SYNC_SECRET) or CUSTOMER_SNAPSHOT_SYNC_SECRET passes the outer gate. SHADOW_API_READ_TOKEN passes that gate on GET only. Privileged operations, including privileged GETs, also require the same bearer to match CUSTOMER_SNAPSHOT_SYNC_SECRET at the inner gate; a distinct API or read token cannot pass it. See each operation's x-access class; only GET /api/v1/health is public."
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
  // Adopt-or-mint before any early return: the gate, preflight and every
  // downstream response echo this id, and onError/notFound read it from
  // context (falling back to a fresh resolve when the chain was bypassed).
  const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
  c.set("requestId", requestId);
  const { method } = c.req.raw;
  const path = new URL(c.req.raw.url).pathname;
  // CORS preflight carries no `Authorization` header by design, so it must be
  // answered before the bearer gate — otherwise browsers never issue the real
  // request. A preflight reveals only the CORS policy, never data, and the
  // early return also skips the body-buffer/session middleware below.
  if (method === "OPTIONS") {
    return stampRequestId(corsPreflightResponse(c.req.raw), requestId);
  }
  const isPublic = method === "GET" && path === "/api/v1/health";
  if (isPublic) {
    await next();
    // Public responses still need ACAO so browser clients can read them.
    c.res = stampRequestId(withCors(c.res, c.req.raw), requestId);
    return;
  }
  // Read-only role: SHADOW_API_READ_TOKEN passes the outer gate
  // on GET requests only, then flows through the same authorized path as a
  // full token below. Non-GET requests with the read token fall through to
  // the 401; privileged routes reject the read token at their inner
  // sync-secret check (`requireSnapshotAuth`).
  const readOnly = isReadAuthorized(c.env, c.req, method);
  if (!readOnly && !isApiAuthorized(c.env, c.req)) {
    // Brute-force throttle: count failed outer-gate checks per IP
    // in the AuthSession DO. A blocked IP gets 429 instead of another 401, so
    // a token-guessing loop slows to a crawl. (Preflight returns above, so
    // OPTIONS never consumes throttle budget; CORS wraps the 429/401 so
    // browsers surface the real status instead of a CORS error.)
    const verdict = await recordAuthFailure(c.env, {
      header: (name: string) => c.req.header(name)
    });
    if (verdict.blocked) {
      const throttled = problemJsonResponse({
        type: problemType("rate-limited", c.env),
        title: "Too Many Requests",
        status: 429,
        detail:
          "Too many failed authentication attempts. Wait and retry. See docs/PROBLEMS.md#rate-limited.",
        instance: new URL(c.req.raw.url).pathname,
        requestId
      });
      throttled.headers.set("Retry-After", String(verdict.retryAfterSec));
      throttled.headers.set("X-RateLimit-Limit", String(AUTH_THROTTLE_ALLOWED_FAILURES));
      throttled.headers.set("X-RateLimit-Remaining", "0");
      throttled.headers.set(
        "X-RateLimit-Reset",
        String(
          verdict.resetAtSec ??
            Math.ceil((Date.now() + verdict.retryAfterSec * 1000) / 1000)
        )
      );
      // Standard fields (`draft-ietf-httpapi-ratelimit-headers` shape over
      // RFC 9651 structured fields): derived from the same verdict +
      // AUTH_THROTTLE_* source of truth as the compat headers above, so all
      // five agree on remaining quota and backoff. The compat headers stay
      // byte-identical.
      throttled.headers.set(
        "RateLimit",
        `"auth-burst";r=0;t=${verdict.retryAfterSec}`
      );
      throttled.headers.set(
        "RateLimit-Policy",
        `"auth-burst";q=${AUTH_THROTTLE_ALLOWED_FAILURES};w=${AUTH_THROTTLE_WINDOW_MS / 1000}`
      );
      return stampRequestId(withCors(throttled, c.req.raw), requestId);
    }
    return stampRequestId(
      withCors(
        problemJsonResponse({
          type: problemType("unauthorized", c.env),
          title: "Unauthorized",
          status: 401,
          detail:
            "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.",
          instance: new URL(c.req.raw.url).pathname,
          requestId
        }),
        c.req.raw
      ),
      requestId
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
  c.res = stampRequestId(withCors(c.res, c.req.raw), requestId);
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
app.route("/", snapshotArchiveRoutes);

app.get("/openapi.json", (c) => {
  if (!openapiDocsEnabled(c.env)) {
    return withSecurityHeaders(
      problemJsonResponse({
        type: problemType("forbidden", c.env),
        title: "Not Found",
        status: 404,
        detail:
          "OpenAPI spec is disabled (set OPENAPI_DOCS_ENABLED=true to enable). See docs/PROBLEMS.md#forbidden.",
        instance: new URL(c.req.url).pathname
      })
    );
  }
  return withSecurityHeaders(
    c.json(app.getOpenAPI31Document(openApiDocumentConfig))
  );
});

app.use("/docs", async (c, next) => {
  if (!openapiDocsEnabled(c.env)) {
    return withSecurityHeaders(
      problemJsonResponse({
        type: problemType("forbidden", c.env),
        title: "Not Found",
        status: 404,
        detail:
          "OpenAPI UI is disabled (set OPENAPI_DOCS_ENABLED=true to enable). See docs/PROBLEMS.md#forbidden.",
        instance: new URL(c.req.url).pathname
      })
    );
  }
  await next();
  // Scalar renders the docs HTML downstream: stamp hardening headers on it
  // (/docs previously carried none).
  c.res = withSecurityHeaders(await withDocsBranding(c.res));
  return;
});

// Project-themed Scalar config: title, logo slot, deep-linkable
// operation anchors and try-it defaults live in `src/lib/docsPresentation`.
// No token value is embedded: users authorize in Scalar for each token role.
app.use("/docs", Scalar(scalarDocsConfiguration));

// `notFound` and `onError` run outside the `/api/v1/*` middleware chain, so
// they stamp CORS headers directly — otherwise a browser sees a CORS error
// instead of the real 404/500 status. Same for the request id: read it from
// context when the middleware ran, else re-resolve from the inbound header.
app.notFound((c) => {
  const requestId =
    (c.get("requestId") as string | undefined) ??
    resolveRequestId(c.req.header(REQUEST_ID_HEADER));
  return stampRequestId(
    withCors(
      notFoundProblem(new URL(c.req.url).pathname, c.env, requestId),
      c.req.raw
    ),
    requestId
  );
});

app.onError((err, c) => {
  // Thrown errors skip the stamping middleware above (`await next()` rejects),
  // so every error response is stamped here: same X-Request-Id header and
  // problem-body requestId the success path gets via stampRequestId.
  const requestId =
    (c.get("requestId") as string | undefined) ??
    resolveRequestId(c.req.header(REQUEST_ID_HEADER));
  const stamp = (problem: Response) =>
    stampRequestId(withCors(problem, c.req.raw), requestId);
  // Invalid REPORT_QUERY dates: fixed 503, never echoes env values.
  if (err instanceof InvalidReportQueryDatesError) {
    logEvent({
      level: "error",
      msg: "Invalid REPORT_QUERY date configuration",
      route: "app.onError",
      ms: null,
      requestId
    });
    return stamp(
      problemJsonResponse({
        type: problemType("misconfigured", c.env),
        title: "Service Unavailable",
        status: 503,
        detail: `${err.message} See docs/PROBLEMS.md#misconfigured.`,
        instance: new URL(c.req.url).pathname,
        requestId
      })
    );
  }
  // A hung Routeware host throws `UpstreamTimeoutError` from any direct
  // `forwardToUpstream` caller: surface it as 502 problem+json, not
  // a 500. The message is a fixed string (no URL/body/PII). Session-retry
  // routes map this themselves before it reaches here; this is the backstop
  // for direct forwarders (login-page, modals, detail-full sync internals).
  // CORS-wrapped so browsers surface the real 502 instead of a CORS error.
  if (isUpstreamTimeout(err)) {
    logEvent({
      level: "error",
      msg: "Upstream request timed out",
      route: "app.onError",
      ms: null,
      requestId,
      timeoutMs: err.timeoutMs
    });
    const timeoutRes = upstreamTimeoutProblem(
      err.timeoutMs,
      new URL(c.req.url).pathname,
      c.env,
      requestId
    );
    // Fixed backoff so clients pause instead of hammering a hung upstream.
    // Only this backstop 502 carries `Retry-After`: no other status gains one.
    timeoutRes.headers.set(
      "Retry-After",
      String(UPSTREAM_TIMEOUT_RETRY_AFTER_SEC)
    );
    return stamp(timeoutRes);
  }
  // A waiter that gave up on a hung concurrent refresh: surface
  // it as 502 problem+json, not a 500. The message is a fixed string (no
  // cookie/URL/body/PII). Session-retry routes map this themselves before it
  // reaches here; this is the backstop for direct `establishSession` callers
  // (snapshot sync routes, detail-full sync internals).
  if (isConcurrentRefreshTimeout(err)) {
    logEvent({
      level: "error",
      msg: "Concurrent session refresh timed out",
      route: "app.onError",
      ms: null,
      requestId,
      timeoutMs: err.timeoutMs
    });
    return stamp(
      concurrentRefreshTimeoutProblem(
        err.timeoutMs,
        new URL(c.req.url).pathname,
        c.env,
        requestId
      )
    );
  }
  // A typo'd AUTH_MODE fails fast in `establishSession`: surface
  // it as 503 problem+json, not a 500. The detail names the received value
  // (operator config, never a credential or customer data) plus the closed
  // set, so the fix is obvious from the response alone.
  if (isInvalidAuthModeError(err)) {
    logEvent({
      level: "error",
      msg: "Invalid AUTH_MODE configuration",
      route: "app.onError",
      ms: null,
      requestId
    });
    return stamp(
      problemJsonResponse({
        type: problemType("misconfigured", c.env),
        title: "Service Unavailable",
        status: 503,
        detail: `${err.message} See docs/PROBLEMS.md#misconfigured.`,
        instance: new URL(c.req.url).pathname,
        requestId
      })
    );
  }
  // A runtime without `Headers.getSetCookie`: fail fast as 503
  // misconfigured, not a 500 and never a browser launch. There are no cookies
  // to fall back from, so a browser retry would burn Browser Rendering budget
  // on a platform gap, not a markup change. The message is a fixed string
  // (never URL/body/cookie/PII). Session-retry routes rethrow this past their
  // single retry; this is the backstop. CORS-wrapped so browsers surface the
  // real 503 instead of a CORS error.
  if (isMissingSetCookieCapabilityError(err)) {
    logEvent({
      level: "error",
      msg: "Runtime is missing the set-cookie capability",
      route: "app.onError",
      ms: null,
      requestId
    });
    return stamp(
      problemJsonResponse({
        type: problemType("misconfigured", c.env),
        title: "Service Unavailable",
        status: 503,
        detail: `${err.message} See docs/PROBLEMS.md#misconfigured.`,
        instance: new URL(c.req.url).pathname,
        requestId
      })
    );
  }
  // A WAF/maintenance block on the login page: fast 502 naming
  // the upstream status, not a 500 and never a browser launch. The message
  // carries only the status number (a fixed PII-free string). Session-retry
  // routes rethrow this past their single retry (the retry budget heals
  // expired sessions, not blocked upstreams); this is the backstop.
  // CORS-wrapped so browsers surface the real 502 instead of a CORS error.
  if (isLoginPageUnavailableError(err)) {
    logEvent({
      level: "error",
      msg: "Routeware login page unavailable",
      route: "app.onError",
      ms: null,
      requestId,
      status: err.status
    });
    return stamp(
      problemJsonResponse({
        type: problemType("bad-gateway", c.env),
        title: "Upstream login unavailable",
        status: 502,
        detail:
          `Routeware answered the login page with HTTP ${err.status} (WAF block or ` +
          `maintenance page). Retry once; if it persists the upstream host is ` +
          `blocking logins. See docs/PROBLEMS.md#bad-gateway.`,
        instance: new URL(c.req.url).pathname,
        requestId
      })
    );
  }
  // Keep log fields stable and PII-safe; do not serialize the error message or stack.
  logEvent({
    level: "error",
    msg: "Unhandled request error",
    route: "app.onError",
    ms: null,
    requestId,
    method: c.req.method,
    kind: errorKind(err)
  });
  return stamp(
    problemJsonResponse({
      type: problemType("internal", c.env),
      title: "Internal Server Error",
      status: 500,
      detail:
        "An unexpected error occurred. See Worker logs for details. See docs/PROBLEMS.md#internal.",
      requestId
    })
  );
});

export default app;
