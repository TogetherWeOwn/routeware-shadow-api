import { createRoute } from "@hono/zod-openapi";
import { prepareSaveAddressFormBody } from "../lib/addressContainerSaveForm";
import { establishSession } from "../lib/establishSession";
import { forwardWithSessionRetry } from "../lib/forwardWithSessionRetry";
import { logEvent } from "../lib/logger";
import { problemJsonResponse, problemType } from "../lib/problem";
import { routewarePostLooksSuccessful } from "../lib/routewarePostResult";
import { refreshAfterRoutewareSave } from "../lib/routewareSaveRefresh";
import { readSessionState } from "../lib/sessionState";
import { routewareWebRwUrl } from "../lib/upstreamUrl";
import { addressSaveFormDocs, createRouteModule } from "./shared";

/** Routeware address endpoints (tag `address`). */
export const addressRoutes = createRouteModule();

const addressSaveAddressFormRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/address/save-address-form",
  tags: ["address"],
  summary: "SaveAddressForm (create or update)",
  description:
    "Proxies to WebRW `SaveAddressForm` with **application/x-www-form-urlencoded** bodies. **Anti-forgery:** when `__RequestVerificationToken` is missing or is a placeholder, the Worker uses the stored Routeware session to GET `CreateBlankAddress?customerID=` (create, `PickupAddressID` 0 / absent) or `LoadAddressModal?PickupAddressID=` (edit), parses the token from HTML, and injects it before forwarding—clients normally do not need to send a token. Set `CUSTOMER_SAVE_AUTO_TOKEN=false` to disable. Use `PickupAddressID=0` with `CustomerID` for create; set `PickupAddressID` for updates. Routeware signals a failed save as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  ...addressSaveFormDocs,
  responses: {
    ...addressSaveFormDocs.responses,
    400: {
      description:
        "Bad Request (application/problem+json). Empty body where save fields are required, or create (`PickupAddressID` 0 / absent) without `CustomerID` in the POST body."
    },
    502: {
      description:
        "Bad Gateway (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
});

addressRoutes.openapi(addressSaveAddressFormRoute, async (c) => {
  const rawBody = c.var.bodyBuffer;
  if (!rawBody || rawBody.byteLength === 0) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail:
        "POST application/x-www-form-urlencoded (SaveAddressForm fields). See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.url).pathname
    });
  }
  const session = await readSessionState(c.var.sessionStub);
  let bodyBuffer: ArrayBuffer | null = rawBody;
  try {
    bodyBuffer = await prepareSaveAddressFormBody(
      c.env,
      session,
      c.req.raw,
      bodyBuffer,
      c.req.raw.headers.get("content-type"),
      { sessionStub: c.var.sessionStub, establishSession }
    );
  } catch (err) {
    logEvent({
      level: "error",
      msg: "Address save token preparation failed",
      route: "POST /api/v1/routeware/address/save-address-form"
    });
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "New address requires CustomerID in POST body") {
      return problemJsonResponse({
        type: problemType("bad-request"),
        title: "Bad Request",
        status: 400,
        detail: `${msg}. See docs/PROBLEMS.md#bad-request.`,
        instance: new URL(c.req.url).pathname
      });
    }
    return problemJsonResponse({
      type: problemType("bad-gateway"),
      title: "Bad Gateway",
      status: 502,
      detail: `Anti-forgery token preparation failed: ${msg} See docs/PROBLEMS.md#bad-gateway.`,
      instance: new URL(c.req.url).pathname
    });
  }
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/PickupAddress/SaveAddressForm"
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
    await refreshAfterRoutewareSave(c.env, c.var.sessionStub, "address", bodyBuffer, upText);
    return up;
  }
  if (up.status >= 200 && up.status < 300) {
    return problemJsonResponse({
      type: problemType("bad-gateway"),
      title: "Bad Gateway",
      status: 502,
      detail:
        "Upstream save failed: Routeware answered SaveAddressForm with HTTP 200 but the body looks like an HTML error page (silent failure). The save did not succeed. See docs/PROBLEMS.md#bad-gateway.",
      instance: new URL(c.req.url).pathname
    });
  }
  return up;
});
