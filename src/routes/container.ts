import { createRoute } from "@hono/zod-openapi";
import { prepareSaveContainerFormBody } from "../lib/addressContainerSaveForm";
import { establishSession } from "../lib/establishSession";
import { forwardWithSessionRetry } from "../lib/forwardWithSessionRetry";
import { problemJsonResponse, problemType } from "../lib/problem";
import { readSessionState } from "../lib/sessionState";
import { routewareWebRwUrl } from "../lib/upstreamUrl";
import { createRouteModule, upstreamPassthrough200 } from "./shared";

/** Routeware container endpoints (tag `container`). */
export const containerRoutes = createRouteModule();

const containerSaveContainerFormRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/container/save-container-form",
  tags: ["container"],
  summary: "SaveContainerForm (create or update)",
  description:
    "Proxies to WebRW `SaveContainerForm` with **application/x-www-form-urlencoded** bodies. **Anti-forgery:** when `__RequestVerificationToken` is missing or is a placeholder, the Worker uses the stored Routeware session to GET `CreateBlankContainer?pickupAddressID=` (create, `ContainerID` 0 / absent) or `LoadContainerModal?ContainerID=` (edit), parses the token from HTML, and injects it before forwarding—clients normally do not need to send a token. Set `CUSTOMER_SAVE_AUTO_TOKEN=false` to disable. Use `ContainerID=0` with `PickupAddressID` for create; set `ContainerID` for updates.",
  responses: {
    ...upstreamPassthrough200,
    502: { description: "Anti-forgery token preparation failed (application/problem+json)" }
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
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    bodyBuffer,
    establishSession
  );
});
