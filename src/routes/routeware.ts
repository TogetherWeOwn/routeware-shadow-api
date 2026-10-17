import { createRoute, z } from "@hono/zod-openapi";
import { establishSession } from "../lib/establishSession";
import { forwardPassthrough } from "../lib/forwardPassthrough";
import { problemJsonResponse, problemType } from "../lib/problem";
import { routewarePostLooksSuccessful } from "../lib/routewarePostResult";
import { readUpstreamText } from "../lib/upstreamBody";
import { forwardToUpstream } from "../lib/upstreamForward";
import { readUpstreamTimeoutMs } from "../lib/upstreamTimeout";
import {
  routewareWebRwUrl,
  routewareWebRwUrlWithQueryAllowlist
} from "../lib/upstreamUrl";
import { createRouteModule, upstreamPassthrough200 } from "./shared";

/**
 * Thin passthrough routes to Routeware WebRW that are not customer-specific.
 * Customer endpoints live in `./customer`.
 *
 * Grouped by URL prefix (`/api/v1/routeware/*` minus the customer subtree)
 * rather than by OpenAPI tag: the `data` and `reports` tags hold one operation
 * each, so splitting strictly by tag would produce two ~35-line files whose only
 * shared trait is "not customer, not D1".
 */
export const routewareRoutes = createRouteModule();

const loginPageRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/account/login-page",
  tags: ["routeware"],
  summary: "Routeware login page (sessionless probe)",
  description:
    "Fetches the fixed `LOGIN_URL` with no session — never reads or writes the shared Routeware session, sends no `Cookie` upstream, and strips upstream `Set-Cookie`. Bearer-gated like every `/api/v1/*` route except `GET /api/v1/health`; the client query string is never forwarded. See `docs/PROBLEMS.md` § login-page fetch.",
  responses: {
    200: {
      description:
        "Upstream HTML for the Routeware login page (unauthenticated fetch; synthetic excerpt)",
      content: {
        "text/html": {
          schema: z.string(),
          example: '<!DOCTYPE html><html><body><form action="/Account/Login" method="post">Login</form></body></html>'
        }
      }
    },
    401: { description: "Unauthorized" }
  }
});

routewareRoutes.openapi(loginPageRoute, async (c) => {
  const upstreamUrl = new URL(c.env.LOGIN_URL);
  // Sessionless probe honors UPSTREAM_TIMEOUT_MS like every other interactive
  // forward — the forwarder default alone would ignore the override.
  return forwardToUpstream(c.req.raw, upstreamUrl, null, c.var.bodyBuffer, {
    timeoutMs: readUpstreamTimeoutMs(c.env)
  });
});

const homeIndexRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/home/index",
  tags: ["routeware"],
  summary: "Routeware home index (sessioned passthrough)",
  description:
    "Forwards to WebRW `Home/Index` under the shared Routeware session (unlike the sessionless `login-page` probe). Upstream answers with whatever content type the SPA serves — HTML, JSON, or other.",
  responses: {
    200: {
      description:
        "Upstream /WebRW/Home/Index (may be HTML, JSON, or other content types; synthetic excerpt)",
      content: {
        "application/json": { schema: z.unknown(), example: {} },
        "text/html": {
          schema: z.string(),
          example: "<!DOCTYPE html><html><body>Routeware home</body></html>"
        }
      }
    },
    401: { description: "Unauthorized" }
  }
});

routewareRoutes.openapi(homeIndexRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Home/Index"
  );
  return forwardPassthrough(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSession
  );
});

const appSettingsGetRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/data/app-settings-get",
  tags: ["data"],
  summary: "appSettingsGet",
  description:
    "Reads WebRW `Data/appSettingsGet` with **application/json** (the harvested body is `{}`). Routeware signals a failed read silently as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  request: {
    body: {
      description: "App-settings body (see example — the harvested body is empty)",
      content: {
        "application/json": {
          // Plain SchemaObject, not a zod schema: docs-only, no runtime
          // validator is installed (forwarding must stay byte-identical).
          schema: { type: "object" },
          // Mirrors tools/api-discovery/examples/app-settings-get.post.example.json.
          example: {}
        }
      }
    }
  },
  responses: {
    ...upstreamPassthrough200,
    200: {
      ...upstreamPassthrough200[200],
      description: "Upstream app settings (illustrative JSON; keys vary by tenant)",
      content: {
        ...upstreamPassthrough200[200].content,
        "application/json": { schema: z.unknown(), example: {} }
      }
    },
    502: {
      description:
        "Bad Gateway (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
});

routewareRoutes.openapi(appSettingsGetRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Data/appSettingsGet"
  );
  const up = await forwardPassthrough(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSession
  );
  // Same silent-failure shape as the save routes (CONVENTIONS.md §1): an
  // app-settings read is always JSON, so HTML here means the read failed.
  const upText = await readUpstreamText(up, readUpstreamTimeoutMs(c.env), true);
  if (routewarePostLooksSuccessful(up.status, upText)) {
    return up;
  }
  if (up.status >= 200 && up.status < 300) {
    return problemJsonResponse({
      type: problemType("bad-gateway", c.env),
      title: "Bad Gateway",
      status: 502,
      detail:
        "Upstream read failed: Routeware answered appSettingsGet with HTTP 200 but the body looks like an HTML error page (silent failure). The read did not succeed. See docs/PROBLEMS.md#bad-gateway.",
      instance: new URL(c.req.url).pathname
    });
  }
  return up;
});

/**
 * Query params the UI's `QueryRequestIsComplete` poll sends and the shadow API
 * forwards upstream. Everything else on the client query string is dropped
 * (silently ignored) so unknown params never reach Routeware.
 *
 * `requestID` is the one-time report request id (a UUID the browser generates
 * per download — see `CUSTOMER_SNAPSHOT.md` § query-id mode); `_` is the
 * jQuery cache-buster timestamp the SPA appends.
 */
export const QUERY_REQUEST_IS_COMPLETE_PARAMS = ["requestID", "_"] as const;

const queryRequestIsCompleteRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/reports/query-request-is-complete",
  tags: ["reports"],
  summary: "QueryRequestIsComplete (allowlisted query params forwarded upstream)",
  description:
    "Polls upstream `GET /Reports/QueryRequestIsComplete`. Only `requestID` (the one-time report request id) and `_` (the SPA's cache-buster timestamp) are forwarded upstream; any other query param is silently dropped. Documented in `docs/PROBLEMS.md` § query-param allowlist. Routeware signals a failed poll silently as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  request: {
    query: z.object({
      requestID: z.string().optional().openapi({ example: "00000000-0000-4000-8000-000000000001" }),
      _: z.string().optional().openapi({ example: "1767225600000" })
    })
  },
  responses: {
    ...upstreamPassthrough200,
    200: {
      ...upstreamPassthrough200[200],
      description: "Report completion poll (illustrative JSON boolean or plain text)",
      content: {
        ...upstreamPassthrough200[200].content,
        "application/json": { schema: z.unknown(), example: true },
        "text/plain": { schema: z.string(), example: "true" }
      }
    },
    502: {
      description:
        "Bad Gateway (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
});

routewareRoutes.openapi(queryRequestIsCompleteRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrlWithQueryAllowlist(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Reports/QueryRequestIsComplete",
    c.req.raw,
    QUERY_REQUEST_IS_COMPLETE_PARAMS
  );
  const up = await forwardPassthrough(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSession
  );
  // Same silent-failure shape as the save routes (CONVENTIONS.md §1): the
  // poll answer is `true`/`false`/`1`/`0` or JSON, so HTML here means the
  // session was lost or upstream errored.
  const upText = await readUpstreamText(up, readUpstreamTimeoutMs(c.env), true);
  if (routewarePostLooksSuccessful(up.status, upText)) {
    return up;
  }
  if (up.status >= 200 && up.status < 300) {
    return problemJsonResponse({
      type: problemType("bad-gateway", c.env),
      title: "Bad Gateway",
      status: 502,
      detail:
        "Upstream read failed: Routeware answered QueryRequestIsComplete with HTTP 200 but the body looks like an HTML error page (silent failure). The poll did not succeed. See docs/PROBLEMS.md#bad-gateway.",
      instance: new URL(c.req.url).pathname
    });
  }
  return up;
});
