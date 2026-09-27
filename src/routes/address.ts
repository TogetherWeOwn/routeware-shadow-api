import { createRoute } from "@hono/zod-openapi";
import { prepareSaveAddressFormBody } from "../lib/addressContainerSaveForm";
import { establishSession } from "../lib/establishSession";
import { forwardWithSessionRetry } from "../lib/forwardWithSessionRetry";
import { problemJsonResponse, problemType } from "../lib/problem";
import { readSessionState } from "../lib/sessionState";
import { routewareWebRwUrl } from "../lib/upstreamUrl";
import { createRouteModule, upstreamPassthrough200 } from "./shared";

/** Routeware address endpoints (tag `address`). */
export const addressRoutes = createRouteModule();

const addressSaveAddressFormRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/address/save-address-form",
  tags: ["address"],
  summary: "SaveAddressForm (create or update)",
  description:
    "Proxies to WebRW `SaveAddressForm` with **application/x-www-form-urlencoded** bodies. **Anti-forgery:** when `__RequestVerificationToken` is missing or is a placeholder, the Worker uses the stored Routeware session to GET `CreateBlankAddress?customerID=` (create, `PickupAddressID` 0 / absent) or `LoadAddressModal?PickupAddressID=` (edit), parses the token from HTML, and injects it before forwarding—clients normally do not need to send a token. Set `CUSTOMER_SAVE_AUTO_TOKEN=false` to disable. Use `PickupAddressID=0` with `CustomerID` for create; set `PickupAddressID` for updates.",
  responses: upstreamPassthrough200
});

addressRoutes.openapi(addressSaveAddressFormRoute, async (c) => {
  const session = await readSessionState(c.var.sessionStub);
  let bodyBuffer = c.var.bodyBuffer;
  try {
    bodyBuffer = await prepareSaveAddressFormBody(
      c.env,
      session,
      c.req.raw,
      bodyBuffer,
      c.req.raw.headers.get("content-type")
    );
  } catch (err) {
    console.error("prepareSaveAddressFormBody", err);
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
    "/PickupAddress/SaveAddressForm"
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
