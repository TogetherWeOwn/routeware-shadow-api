import { createRoute, z } from "@hono/zod-openapi";
import { establishSession } from "../lib/establishSession";
import { forwardWithSessionRetry } from "../lib/forwardWithSessionRetry";
import { forwardToUpstream } from "../lib/upstreamForward";
import {
  routewareWebRwUrl,
  routewareWebRwUrlWithIncomingSearch
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
  summary: "Routeware login page (upstream HTML)",
  responses: {
    200: {
      description:
        "Upstream HTML for the Routeware login page (unauthenticated fetch)",
      content: {
        "text/html": { schema: z.string() }
      }
    },
    401: { description: "Unauthorized" }
  }
});

routewareRoutes.openapi(loginPageRoute, async (c) => {
  const upstreamUrl = new URL(c.env.LOGIN_URL);
  return forwardToUpstream(c.req.raw, upstreamUrl, null, c.var.bodyBuffer);
});

const homeIndexRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/home/index",
  tags: ["routeware"],
  summary: "Routeware home index (upstream passthrough)",
  responses: {
    200: {
      description:
        "Upstream /WebRW/Home/Index (may be HTML, JSON, or other content types)",
      content: {
        "application/json": { schema: z.unknown() },
        "text/html": { schema: z.string() }
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
  return forwardWithSessionRetry(
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
  responses: upstreamPassthrough200
});

routewareRoutes.openapi(appSettingsGetRoute, async (c) => {
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
    establishSession
  );
});

const queryRequestIsCompleteRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/reports/query-request-is-complete",
  tags: ["reports"],
  summary: "QueryRequestIsComplete (query string forwarded to upstream)",
  responses: upstreamPassthrough200
});

routewareRoutes.openapi(queryRequestIsCompleteRoute, async (c) => {
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
    establishSession
  );
});
