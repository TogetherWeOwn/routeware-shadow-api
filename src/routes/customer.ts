import { createRoute } from "@hono/zod-openapi";
import { prepareSaveCustomerLongFormBody } from "../lib/customerSaveAutoToken";
import { translateSkipTakeToStartLimit } from "../lib/customersReadPagination";
import { establishSession } from "../lib/establishSession";
import { forwardWithSessionRetry } from "../lib/forwardWithSessionRetry";
import { problemJsonResponse, problemType } from "../lib/problem";
import { routewarePostLooksSuccessful } from "../lib/routewarePostResult";
import { readSessionState } from "../lib/sessionState";
import {
  routewareWebRwUrl,
  routewareWebRwUrlWithIncomingSearch
} from "../lib/upstreamUrl";
import { createRouteModule, upstreamPassthrough200 } from "./shared";

/** Routeware customer endpoints (tag `customer`). */
export const customerRoutes = createRouteModule();

const customersReadRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/customers-read",
  tags: ["customer"],
  summary: "CustomersRead (harvested SPA traffic)",
  description:
    "Forwards the JSON body to WebRW `CustomersRead` with **application/json** (e.g. the harvested Ext.NET store shape: `filter`, `page`, `start`, `limit`, `group`, `sort`). OData-style `skip`/`take` keys are translated server-side onto `start`/`limit` (which upstream is proven to honor via the harvested SPA traffic); an explicit `start`/`limit` always wins and non-JSON bodies pass through untouched.",
  responses: upstreamPassthrough200
});

customerRoutes.openapi(customersReadRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/CustomersRead"
  );
  // TOG-5936: `skip`/`take` are translated onto the Ext.NET `start`/`limit`
  // spelling before forwarding, so a client sending them gets the window it
  // asked for instead of a silent unpaged/default-window result. Bodies
  // without those keys forward byte-identical.
  let bodyBuffer = c.var.bodyBuffer;
  if (bodyBuffer && bodyBuffer.byteLength > 0) {
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bodyBuffer);
    const translated = translateSkipTakeToStartLimit(raw);
    if (translated.translated) {
      bodyBuffer = new TextEncoder().encode(translated.text).buffer;
    }
  }
  return forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    bodyBuffer,
    establishSession
  );
});

const customerDetailFullRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/detail-full",
  tags: ["customer"],
  summary: "GetCustomerDetailFull",
  responses: upstreamPassthrough200
});

customerRoutes.openapi(customerDetailFullRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/GetCustomerDetailFull"
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

const customerTypesReadRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/customer-types-read",
  tags: ["customer"],
  summary: "CustomerTypesRead",
  description:
    "Customer type / category list for pickers (same store pattern as other Ext.NET `*Read` actions). Send **application/x-www-form-urlencoded** (e.g. `EnabledOnly=true`). Request body is not validated here so the Worker can forward the raw body after session middleware consumes the stream once.",
  responses: upstreamPassthrough200
});

customerRoutes.openapi(customerTypesReadRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/CustomerTypesRead"
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

const customerSaveLongFormRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/save-long-form",
  tags: ["customer"],
  summary: "SaveCustomerLongForm (create or update)",
  description:
    "Proxies to WebRW `SaveCustomerLongForm` with **application/x-www-form-urlencoded** bodies. **Anti-forgery:** when `__RequestVerificationToken` is missing or is a placeholder, the Worker uses the stored Routeware session to GET `AddNewLong` (create, `CustomerID` 0 / absent) or `LoadLongCustomerModal?customerID=` (edit), parses the token from HTML, and injects it before forwarding—clients normally do not need to send a token. Set `CUSTOMER_SAVE_AUTO_TOKEN=false` to disable. Use `CustomerID=0` for create; set `CustomerID` for updates. Disable customers with `Enabled=false` (no upstream delete). Routeware signals a failed save as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  responses: {
    ...upstreamPassthrough200,
    502: {
      description:
        "Upstream save failed (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
});

customerRoutes.openapi(customerSaveLongFormRoute, async (c) => {
  const session = await readSessionState(c.var.sessionStub);
  let bodyBuffer = c.var.bodyBuffer;
  try {
    bodyBuffer = await prepareSaveCustomerLongFormBody(
      c.env,
      session,
      c.req.raw,
      bodyBuffer,
      c.req.raw.headers.get("content-type")
    );
  } catch (err) {
    console.error("prepareSaveCustomerLongFormBody", err);
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
    "/Customer/SaveCustomerLongForm"
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
  // worked when it did not. Same heuristic as the /data/* write path.
  const upText = await up.clone().text();
  if (routewarePostLooksSuccessful(up.status, upText)) {
    return up;
  }
  if (up.status >= 200 && up.status < 300) {
    return problemJsonResponse({
      type: problemType("bad-gateway"),
      title: "Upstream save failed",
      status: 502,
      detail:
        "Routeware answered SaveCustomerLongForm with HTTP 200 but the body looks like an HTML error page (silent failure). The save did not succeed.",
      instance: new URL(c.req.url).pathname
    });
  }
  return up;
});

const customerAddNewLongRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/customer/add-new-long",
  tags: ["customer"],
  summary: "AddNewLong (new customer form shell)",
  description:
    "Returns the same HTML/JS fragment Routeware uses for the long add-customer modal. Optional for API clients: `save-long-form` can fetch this page server-side to obtain `__RequestVerificationToken` when you omit the token.",
  responses: upstreamPassthrough200
});

customerRoutes.openapi(customerAddNewLongRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/AddNewLong"
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

const customerLoadLongModalRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/customer/load-long-modal",
  tags: ["customer"],
  summary: "LoadLongCustomerModal",
  description:
    "Loads the edit-customer long form HTML/JS for the given `customerID` query parameter (forwarded to upstream unchanged).",
  responses: upstreamPassthrough200
});

customerRoutes.openapi(customerLoadLongModalRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrlWithIncomingSearch(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/LoadLongCustomerModal",
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

const customerDeleteNotSupportedRoute = createRoute({
  method: "delete",
  path: "/api/v1/routeware/customer",
  tags: ["customer"],
  summary: "Delete customer (not supported upstream)",
  description:
    "Routeware WebRW does not expose a hard delete. Disable or retire a customer by submitting `save-long-form` with `Enabled=false` (and other required fields from the loaded record).",
  responses: {
    405: {
      description:
        "Method not allowed (application/problem+json). Use save-long-form with Enabled=false to disable."
    }
  }
});

customerRoutes.openapi(customerDeleteNotSupportedRoute, (c) =>
  problemJsonResponse({
    type: problemType("method-not-allowed"),
    title: "Customer delete not supported",
    status: 405,
    detail:
      "Routeware does not support deleting customers via HTTP DELETE. Load the customer with GET /api/v1/routeware/customer/load-long-modal?customerID={id}, then POST /api/v1/routeware/customer/save-long-form with the same field set and Enabled=false (or your tenant’s equivalent) to disable the record.",
    instance: new URL(c.req.url).pathname
  })
);
