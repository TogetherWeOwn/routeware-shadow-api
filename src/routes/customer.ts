import { createRoute, z } from "@hono/zod-openapi";
import {
  evictAntiForgeryTokenCacheForBody,
  prepareSaveCustomerLongFormBody
} from "../lib/customerSaveAutoToken";
import { translateSkipTakeToStartLimit } from "../lib/customersReadPagination";
import { establishSession } from "../lib/establishSession";
import { forwardPassthrough } from "../lib/forwardPassthrough";
import { problemJsonResponse, problemType } from "../lib/problem";
import { routewarePostLooksSuccessful } from "../lib/routewarePostResult";
import { refreshAfterRoutewareSave } from "../lib/routewareSaveRefresh";
import { readSessionState } from "../lib/sessionState";
import { readUpstreamText } from "../lib/upstreamBody";
import { readUpstreamTimeoutMs } from "../lib/upstreamTimeout";
import {
  routewareWebRwUrl,
  routewareWebRwUrlWithQueryAllowlist
} from "../lib/upstreamUrl";
import {
  createRouteModule,
  customerDetailFullDocs,
  customerSaveLongFormDocs,
  customerTypesReadDocs,
  customersReadDocs,
  upstreamPassthrough200
} from "./shared";

/** Routeware customer endpoints (tag `customer`). */
export const customerRoutes = createRouteModule();

const customersReadRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/customers-read",
  tags: ["customer"],
  summary: "CustomersRead (harvested SPA traffic)",
  description:
    "Forwards the JSON body to WebRW `CustomersRead` with **application/json** (e.g. the harvested Ext.NET store shape: `filter`, `page`, `start`, `limit`, `group`, `sort`). OData-style `skip`/`take` keys are translated server-side onto `start`/`limit` (which upstream is proven to honor via the harvested SPA traffic); an explicit `start`/`limit` always wins and non-JSON bodies pass through untouched. Routeware signals a failed read silently as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  ...customersReadDocs,
  responses: {
    ...customersReadDocs.responses,
    502: {
      description:
        "Bad Gateway (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
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
  const up = await forwardPassthrough(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    bodyBuffer,
    establishSession
  );
  // Routeware signals a failed read silently: an HTML error page with HTTP 200
  // (CONVENTIONS.md §1). Passing that through as 200 tells the client the read
  // worked when it did not. Same heuristic as the save-long-form route.
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
        "Upstream read failed: Routeware answered CustomersRead with HTTP 200 but the body looks like an HTML error page (silent failure). The read did not succeed. See docs/PROBLEMS.md#bad-gateway.",
      instance: new URL(c.req.url).pathname
    });
  }
  return up;
});

const customerDetailFullRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/detail-full",
  tags: ["customer"],
  summary: "GetCustomerDetailFull",
  description:
    "Loads one customer record from WebRW `GetCustomerDetailFull` with **application/json** (e.g. `{\"CustomerID\": 345734}` — set a real id). Routeware signals a failed read silently as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  ...customerDetailFullDocs,
  responses: {
    ...customerDetailFullDocs.responses,
    502: {
      description:
        "Bad Gateway (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
});

customerRoutes.openapi(customerDetailFullRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/GetCustomerDetailFull"
  );
  const up = await forwardPassthrough(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSession
  );
  // Same silent-failure shape as the save routes (CONVENTIONS.md §1): an HTML
  // error page with HTTP 200. A detail payload is always JSON, so HTML here
  // means the read failed.
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
        "Upstream read failed: Routeware answered GetCustomerDetailFull with HTTP 200 but the body looks like an HTML error page (silent failure). The read did not succeed. See docs/PROBLEMS.md#bad-gateway.",
      instance: new URL(c.req.url).pathname
    });
  }
  return up;
});

const customerTypesReadRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/customer-types-read",
  tags: ["customer"],
  summary: "CustomerTypesRead",
  description:
    "Customer type / category list for pickers (same store pattern as other Ext.NET `*Read` actions). Send **application/x-www-form-urlencoded** (e.g. `EnabledOnly=true`). Request body is not validated here so the Worker can forward the raw body after session middleware consumes the stream once. Routeware signals a failed read silently as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  ...customerTypesReadDocs,
  responses: {
    ...customerTypesReadDocs.responses,
    502: {
      description:
        "Bad Gateway (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
});

customerRoutes.openapi(customerTypesReadRoute, async (c) => {
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/CustomerTypesRead"
  );
  const up = await forwardPassthrough(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSession
  );
  // Same silent-failure shape as the save routes (CONVENTIONS.md §1): a
  // dropdown store read is always JSON, so HTML here means the read failed.
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
        "Upstream read failed: Routeware answered CustomerTypesRead with HTTP 200 but the body looks like an HTML error page (silent failure). The read did not succeed. See docs/PROBLEMS.md#bad-gateway.",
      instance: new URL(c.req.url).pathname
    });
  }
  return up;
});

const customerSaveLongFormRoute = createRoute({
  method: "post",
  path: "/api/v1/routeware/customer/save-long-form",
  tags: ["customer"],
  summary: "SaveCustomerLongForm (create or update)",
  description:
    "Proxies to WebRW `SaveCustomerLongForm` with **application/x-www-form-urlencoded** bodies. **Anti-forgery:** when `__RequestVerificationToken` is missing or is a placeholder, the Worker uses the stored Routeware session to GET `AddNewLong` (create, `CustomerID` 0 / absent) or `LoadLongCustomerModal?customerID=` (edit), parses the token from HTML, and injects it before forwarding—clients normally do not need to send a token. Set `CUSTOMER_SAVE_AUTO_TOKEN=false` to disable. Use `CustomerID=0` for create; set `CustomerID` for updates. Disable customers with `Enabled=false` (no upstream delete). Routeware signals a failed save as an HTML error page with HTTP 200 — that shape is surfaced as 502 problem+json, never passed through as 200.",
  ...customerSaveLongFormDocs,
  responses: {
    ...customerSaveLongFormDocs.responses,
    400: {
      description:
        "Bad Request (application/problem+json). Empty body where save fields are required."
    },
    502: {
      description:
        "Bad Gateway (application/problem+json). Routeware answered with an HTML error page + HTTP 200 instead of a success body."
    }
  }
});

customerRoutes.openapi(customerSaveLongFormRoute, async (c) => {
  const rawBody = c.var.bodyBuffer;
  if (!rawBody || rawBody.byteLength === 0) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "POST application/x-www-form-urlencoded (SaveCustomerLongForm fields). See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.url).pathname
    });
  }
  const session = await readSessionState(c.var.sessionStub);
  let bodyBuffer: ArrayBuffer | null = rawBody;
  try {
    bodyBuffer = await prepareSaveCustomerLongFormBody(
      c.env,
      session,
      c.req.raw,
      bodyBuffer,
      c.req.raw.headers.get("content-type"),
      { sessionStub: c.var.sessionStub, establishSession }
    );
  } catch (err) {
    console.error("prepareSaveCustomerLongFormBody", err);
    const msg = err instanceof Error ? err.message : String(err);
    return problemJsonResponse({
      type: problemType("bad-gateway", c.env),
      title: "Bad Gateway",
      status: 502,
      detail: `Anti-forgery token preparation failed: ${msg} See docs/PROBLEMS.md#bad-gateway.`,
      instance: new URL(c.req.url).pathname
    });
  }
  const upstreamUrl = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/SaveCustomerLongForm"
  );
  const up = await forwardPassthrough(
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
  const upText = await readUpstreamText(up, readUpstreamTimeoutMs(c.env), true);
  if (routewarePostLooksSuccessful(up.status, upText)) {
    // TOG-6463: a successful routeware-tier save must refresh D1 + evict the
    // data-entity cache, or shadow reads keep serving the pre-save record.
    // Never throws: a local refresh failure must not turn the passthrough 200
    // into a 500 (the save itself succeeded upstream).
    await refreshAfterRoutewareSave(c.env, c.var.sessionStub, "customer", bodyBuffer, upText);
    return up;
  }
  if (up.status >= 200 && up.status < 300) {
    // TOG-8149: the injected token was rejected upstream (silent failure),
    // so drop it from the cache — otherwise the next token-less save replays
    // the same known-rejected token until the TTL window expires. The next
    // save refetches via one modal GET instead of 502-looping.
    evictAntiForgeryTokenCacheForBody(bodyBuffer);
    return problemJsonResponse({
      type: problemType("bad-gateway", c.env),
      title: "Bad Gateway",
      status: 502,
      detail:
        "Upstream save failed: Routeware answered SaveCustomerLongForm with HTTP 200 but the body looks like an HTML error page (silent failure). The save did not succeed. See docs/PROBLEMS.md#bad-gateway.",
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
  return forwardPassthrough(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    upstreamUrl,
    c.var.bodyBuffer,
    establishSession
  );
});

/**
 * Query params the `load-long-modal` edit form sends and the shadow API
 * forwards upstream. Everything else on the client query string is dropped
 * (silently ignored) so unknown params never reach Routeware.
 *
 * `customerID` is the numeric Routeware customer id; unlike the reports probe
 * it is required — a missing or non-numeric value is a 400, never a bare
 * upstream fetch.
 */
export const LOAD_LONG_MODAL_PARAMS = ["customerID"] as const;

const customerLoadLongModalRoute = createRoute({
  method: "get",
  path: "/api/v1/routeware/customer/load-long-modal",
  tags: ["customer"],
  summary: "LoadLongCustomerModal (allowlisted query params forwarded upstream)",
  description:
    "Loads the edit-customer long form HTML/JS for the given `customerID` query parameter. Only `customerID` is forwarded upstream to `GET /Customer/LoadLongCustomerModal`; any other query param is silently dropped. `customerID` is required and must be a positive integer. Documented in `docs/PROBLEMS.md` § query-param allowlist.",
  request: {
    query: z.object({
      customerID: z.string().optional()
    })
  },
  responses: {
    ...upstreamPassthrough200,
    400: {
      description: "Missing/invalid customerID (application/problem+json)"
    }
  }
});

customerRoutes.openapi(customerLoadLongModalRoute, async (c) => {
  const raw = c.req.valid("query").customerID?.trim() ?? "";
  const customerId = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "Query `customerID` is required and must be a positive integer. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.url).pathname
    });
  }
  const upstreamUrl = routewareWebRwUrlWithQueryAllowlist(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/LoadLongCustomerModal",
    c.req.raw,
    LOAD_LONG_MODAL_PARAMS
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
    type: problemType("method-not-allowed", c.env),
    title: "Method Not Allowed",
    status: 405,
    detail:
      "Customer delete is not supported: Routeware does not support deleting customers via HTTP DELETE. Load the customer with GET /api/v1/routeware/customer/load-long-modal?customerID={id}, then POST /api/v1/routeware/customer/save-long-form with the same field set and Enabled=false (or your tenant’s equivalent) to disable the record. See docs/PROBLEMS.md#method-not-allowed.",
    instance: new URL(c.req.url).pathname
  })
);
