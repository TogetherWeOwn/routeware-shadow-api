import { createRoute } from "@hono/zod-openapi";
import { prepareSaveContainerFormBody } from "../lib/addressContainerSaveForm";
import { establishSession } from "../lib/establishSession";
import { forwardWithSessionRetry } from "../lib/forwardWithSessionRetry";
import { problemJsonResponse, problemType } from "../lib/problem";
import { routewarePostLooksSuccessful } from "../lib/routewarePostResult";
import { refreshAfterRoutewareSave } from "../lib/routewareSaveRefresh";
import { readSessionState } from "../lib/sessionState";
import { routewareWebRwUrl } from "../lib/upstreamUrl";
import { containerSaveFormDocs, createRouteModule } from "./shared";

/** Routeware container endpoints (tag `container`). */
export const containerRoutes = createRouteModule();

const containerSaveContainerFormRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/container/save-container-form",
  tags: ["container"],
  summary: "SaveContainerForm (create or update)",
  description:
    "Proxies to WebRW `SaveContainerForm` with **application/x-www-form-urlencoded** bodies. **Anti-forgery:** when `__RequestVerificationToken` is missing or is a placeholder, the Worker uses the stored Routeware session to GET `CreateBlankContainer?pickupAddressID=` (create, `ContainerID` 0 / absent) or `LoadContainerModal?ContainerID=` (edit), parses the token from HTML, and injects it before forwarding—clients normally do not need to send a token. Set `CUSTOMER_SAVE_AUTO_TOKEN=false` to disable. Use `ContainerID=0` with `PickupAddressID` for create; set `ContainerID` for updates. Routeware signals a failed save as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  ...containerSaveFormDocs,
  responses: {
    ...containerSaveFormDocs.responses,
    502: {
      description:
        "Upstream save failed (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
});

containerRoutes.openapi(containerSaveContainerFormRoute, async (c) => {
  const session = await readSessionState(c.var.sessionStub);
  let bodyBuffer = c.var.bodyBuffer;
  try {
    bodyBuffer = await prepareSaveContainerFormBody(
      c.env,
      session,
      c.req.raw,
      bodyBuffer,
      c.req.raw.headers.get("content-type")
    );
  } catch (err) {
    console.error("prepareSaveContainerFormBody", err);
    return problemJsonResponse({
      type: problemType("bad-gateway"),
      title: "Anti-forgery token preparation failed",
      status: 502,
      detail: err instanceof Error ? err.message : String(err)
    });
  }
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Container/SaveContainerForm"
  );
  const up = await forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    bodyBuffer,
    establishSession
  );
  // Routeware signals a failed save silently: an HTML error page with HTTP 200
  // (CONVENTIONS.md §1). Passing that through as 200 tells the client the save
  // worked when it did not. Same heuristic as the save-long-form route.
  const upText = await up.clone().text();
  if (routewarePostLooksSuccessful(up.status, upText)) {
    // TOG-6463: refresh D1 + evict the data-entity cache after a successful
    // save so shadow reads stop serving the pre-save record. Never throws.
    await refreshAfterRoutewareSave(c.env, c.var.sessionStub, "container", bodyBuffer, upText);
    return up;
  }
  if (up.status >= 200 && up.status < 300) {
    return problemJsonResponse({
      type: problemType("bad-gateway"),
      title: "Upstream save failed",
      status: 502,
      detail:
        "Routeware answered SaveContainerForm with HTTP 200 but the body looks like an HTML error page (silent failure). The save did not succeed.",
      instance: new URL(c.req.url).pathname
    });
  }
  return up;
});
