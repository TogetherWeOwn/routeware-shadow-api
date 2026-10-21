import { createRoute } from "@hono/zod-openapi";
import { prepareSaveContainerFormBody, validateSaveFormBody } from "../lib/addressContainerSaveForm";
import { establishSession } from "../lib/establishSession";
import { forwardPassthrough } from "../lib/forwardPassthrough";
import type { SessionForwardOptions } from "../lib/forwardWithSessionRetry";
import { logEvent } from "../lib/logger";
import { problemJsonResponse, problemType } from "../lib/problem";
import { routewarePostLooksSuccessful } from "../lib/routewarePostResult";
import { refreshAfterRoutewareSave } from "../lib/routewareSaveRefresh";
import { SessionBodyPreparationError } from "../lib/sessionPreparation";
import { isLoginPageResponse } from "../lib/loginRedirect";
import { readUpstreamText } from "../lib/upstreamBody";
import { readUpstreamTimeoutMs } from "../lib/upstreamTimeout";
import { routewareWebRwUrl } from "../lib/upstreamUrl";
import { containerSaveFormDocs, createRouteModule } from "./shared";

/** Routeware container endpoints (tag `container`). */
export const containerRoutes = createRouteModule();

const containerSaveContainerFormRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/container/save-container-form",
  operationId: "saveRoutewareContainer",
  "x-access": "full",
  "x-effect": "upstream-write-local-refresh",
  tags: ["container"],
  summary: "SaveContainerForm (create or update)",
  description:
    "Proxies to WebRW `SaveContainerForm` with **application/x-www-form-urlencoded** bodies. **Anti-forgery:** when `__RequestVerificationToken` is missing or is a placeholder, the Worker uses the stored Routeware session to GET `CreateBlankContainer?pickupAddressID=` (create, `ContainerID` 0 / absent) or `LoadContainerModal?ContainerID=` (edit), parses the token from HTML, and injects it before forwarding—clients normally do not need to send a token. Set `CUSTOMER_SAVE_AUTO_TOKEN=false` to disable. Use `ContainerID=0` with `PickupAddressID` for create; set `ContainerID` for updates. Routeware signals a failed save as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  ...containerSaveFormDocs,
  responses: {
    ...containerSaveFormDocs.responses,
    400: {
      description:
        "Bad Request (application/problem+json). Empty body where save fields are required, or create (`ContainerID` 0 / absent) without `PickupAddressID` in the POST body."
    },
    502: {
      description:
        "Bad Gateway (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
});

containerRoutes.openapi(containerSaveContainerFormRoute, async (c) => {
  const rawBody = c.var.bodyBuffer;
  if (!rawBody || rawBody.byteLength === 0) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "POST application/x-www-form-urlencoded (SaveContainerForm fields). See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.url).pathname
    });
  }
  let bodyBuffer: ArrayBuffer | null = rawBody;
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Container/SaveContainerForm"
  );
  let up: Response;
  try {
    // Validate before entering the async passthrough or any session operation.
    try {
      validateSaveFormBody(c.env, rawBody, c.req.raw.headers.get("content-type"), "container");
    } catch (err) {
      throw new SessionBodyPreparationError(err);
    }
    const options: SessionForwardOptions = {
      prepareBody: async (session, originalBody) => {
        bodyBuffer = await prepareSaveContainerFormBody(
          c.env,
          session,
          c.req.raw,
          originalBody,
          c.req.raw.headers.get("content-type")
        );
        return bodyBuffer;
      }
    };
    up = await forwardPassthrough(
      c.env,
      c.var.sessionStub,
      c.req.raw,
      upstreamUrl,
      rawBody,
      establishSession,
      options
    );
  } catch (err) {
    if (!(err instanceof SessionBodyPreparationError)) {
      throw err;
    }
    const cause = err.preparationCause;
    logEvent({
      level: "error",
      msg: "Container save token preparation failed",
      route: "POST /api/v1/routeware/container/save-container-form"
    });
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (msg === "New container requires PickupAddressID in POST body") {
      return problemJsonResponse({
        type: problemType("bad-request", c.env),
        title: "Bad Request",
        status: 400,
        detail: `${msg}. See docs/PROBLEMS.md#bad-request.`,
        instance: new URL(c.req.url).pathname
      });
    }
    return problemJsonResponse({
      type: problemType("bad-gateway", c.env),
      title: "Bad Gateway",
      status: 502,
      detail: `Anti-forgery token preparation failed: ${msg} See docs/PROBLEMS.md#bad-gateway.`,
      instance: new URL(c.req.url).pathname
    });
  }
  // Routeware signals a failed save silently: an HTML error page with HTTP 200
  // (CONVENTIONS.md §1). Passing that through as 200 tells the client the save
  // worked when it did not. Same heuristic as the save-long-form route.
  const upText = await readUpstreamText(up, readUpstreamTimeoutMs(c.env), true);
  if (routewarePostLooksSuccessful(up.status, upText) && !(await isLoginPageResponse(up, readUpstreamTimeoutMs(c.env)))) {
    // Refresh D1 + evict the data-entity cache after a successful
    // save so shadow reads stop serving the pre-save record. Never throws.
    await refreshAfterRoutewareSave(c.env, c.var.sessionStub, "container", bodyBuffer, upText);
    return up;
  }
  if (up.status >= 200 && up.status < 300) {
    return problemJsonResponse({
      type: problemType("bad-gateway", c.env),
      title: "Bad Gateway",
      status: 502,
      detail:
        "Upstream save failed: Routeware answered SaveContainerForm with HTTP 200 but the body looks like an HTML error page (silent failure). The save did not succeed. See docs/PROBLEMS.md#bad-gateway.",
      instance: new URL(c.req.url).pathname
    });
  }
  return up;
});
