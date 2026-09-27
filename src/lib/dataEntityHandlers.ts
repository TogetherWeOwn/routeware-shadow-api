import { prepareSaveAddressFormBody, prepareSaveContainerFormBody } from "./addressContainerSaveForm";
import { prepareSaveCustomerLongFormBody } from "./customerSaveAutoToken";
import {
  getAddressBundleFromD1,
  getContainerBundleFromD1,
  getCustomerBundleFromD1,
  bundleJsonString
} from "./dataEntityRead";
import { syncCustomerDetailFullToD1 } from "./detailFullSync";
import {
  getCachedDataEntity,
  invalidateCustomerGraph,
  invalidateDataEntity,
  putCachedDataEntity,
  sha256Etag
} from "./entityDataCache";
import { forwardWithSessionRetry } from "./forwardWithSessionRetry";
import { establishSession } from "./establishSession";
import { problemJsonResponse, problemType } from "./problem";
import { readSessionState } from "./sessionState";
import {
  parseCustomerIdFromSaveResponse,
  routewarePostLooksSuccessful,
  urlEncodedToObject
} from "./routewarePostResult";
import { routewareWebRwUrl } from "./upstreamUrl";

export type DataEntityCtx = {
  env: Env;
  var: { bodyBuffer: ArrayBuffer | null; sessionStub: DurableObjectStub };
  req: { raw: Request; header: (n: string) => string | undefined };
};

function etagHeader(etag: string): string {
  return `"${etag}"`;
}

/** Strip an optional weak-validator prefix and surrounding quotes from an ETag token. */
function normalizeEtagToken(token: string): string {
  return token
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"(.*)"$/, "$1");
}

/**
 * RFC 7232 If-None-Match: a comma-separated list of ETag tokens, or `*`.
 * Compares parsed tokens exactly rather than substring-matching, which could
 * otherwise produce false 304s.
 */
function matchesIfNoneMatch(h: string | undefined, etag: string): boolean {
  if (!h) {
    return false;
  }
  const want = normalizeEtagToken(etag);
  return h
    .split(",")
    .map(normalizeEtagToken)
    .some((token) => token === "*" || token === want);
}

export async function handleGetDataCustomer(c: DataEntityCtx, customerId: number): Promise<Response> {
  const ifNone = c.req.header("if-none-match");
  const cached = await getCachedDataEntity("customer", customerId);
  if (cached) {
    const ce = cached.headers.get("X-Entity-ETag");
    if (ifNone && ce && matchesIfNoneMatch(ifNone, ce)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etagHeader(ce), "Cache-Control": "private, max-age=60" }
      });
    }
    if (!ifNone) {
      return cached;
    }
  }
  const bundle = await getCustomerBundleFromD1(c.env.CUSTOMER_DB, customerId);
  if (!bundle) {
    return problemJsonResponse({
      type: problemType("not-found"),
      title: "Not found",
      status: 404,
      detail: `No snapshot data for customer_id=${customerId} (import/sync first).`
    });
  }
  const body = bundleJsonString(bundle);
  const etag = await sha256Etag(body);
  if (matchesIfNoneMatch(ifNone, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etagHeader(etag), "Cache-Control": "private, max-age=60" }
    });
  }
  const res = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ETag: etagHeader(etag),
      "Cache-Control": "private, max-age=60",
      "X-Entity-ETag": etag
    }
  });
  await putCachedDataEntity("customer", customerId, res);
  return res;
}

export async function handleGetDataAddress(
  c: DataEntityCtx,
  pickupAddressId: number
): Promise<Response> {
  const ifNone = c.req.header("if-none-match");
  const cached = await getCachedDataEntity("address", pickupAddressId);
  if (cached) {
    const ce = cached.headers.get("X-Entity-ETag");
    if (ifNone && ce && matchesIfNoneMatch(ifNone, ce)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etagHeader(ce), "Cache-Control": "private, max-age=60" }
      });
    }
    if (!ifNone) {
      return cached;
    }
  }
  const bundle = await getAddressBundleFromD1(c.env.CUSTOMER_DB, pickupAddressId);
  if (!bundle || !bundle.address) {
    return problemJsonResponse({
      type: problemType("not-found"),
      title: "Not found",
      status: 404,
      detail: `No snapshot for pickup_address_id=${pickupAddressId}.`
    });
  }
  const body = bundleJsonString(bundle);
  const etag = await sha256Etag(body);
  if (matchesIfNoneMatch(ifNone, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etagHeader(etag), "Cache-Control": "private, max-age=60" }
    });
  }
  const res = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ETag: etagHeader(etag),
      "Cache-Control": "private, max-age=60",
      "X-Entity-ETag": etag
    }
  });
  await putCachedDataEntity("address", pickupAddressId, res);
  return res;
}

export async function handleGetDataContainer(
  c: DataEntityCtx,
  containerId: number
): Promise<Response> {
  const ifNone = c.req.header("if-none-match");
  const cached = await getCachedDataEntity("container", containerId);
  if (cached) {
    const ce = cached.headers.get("X-Entity-ETag");
    if (ifNone && ce && matchesIfNoneMatch(ifNone, ce)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etagHeader(ce), "Cache-Control": "private, max-age=60" }
      });
    }
    if (!ifNone) {
      return cached;
    }
  }
  const bundle = await getContainerBundleFromD1(c.env.CUSTOMER_DB, containerId);
  if (!bundle || !bundle.container) {
    return problemJsonResponse({
      type: problemType("not-found"),
      title: "Not found",
      status: 404,
      detail: `No snapshot for container_id=${containerId}.`
    });
  }
  const body = bundleJsonString(bundle);
  const etag = await sha256Etag(body);
  if (matchesIfNoneMatch(ifNone, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etagHeader(etag), "Cache-Control": "private, max-age=60" }
    });
  }
  const res = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ETag: etagHeader(etag),
      "Cache-Control": "private, max-age=60",
      "X-Entity-ETag": etag
    }
  });
  await putCachedDataEntity("container", containerId, res);
  return res;
}

export async function handlePostDataCustomer(c: DataEntityCtx): Promise<Response> {
  const buf = c.var.bodyBuffer;
  if (!buf || buf.byteLength === 0) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Empty body",
      status: 400,
      detail: "POST application/x-www-form-urlencoded (SaveCustomerLongForm fields)."
    });
  }
  const session = await readSessionState(c.var.sessionStub);
  let bodyBuffer: ArrayBuffer | null = buf;
  try {
    bodyBuffer = await prepareSaveCustomerLongFormBody(
      c.env,
      session,
      c.req.raw,
      buf,
      c.req.raw.headers.get("content-type"),
      {},
      { sessionStub: c.var.sessionStub, establishSession }
    );
  } catch (e) {
    return problemJsonResponse({
      type: problemType("bad-gateway"),
      title: "Anti-forgery preparation failed",
      status: 502,
      detail: e instanceof Error ? e.message : String(e)
    });
  }
  if (!bodyBuffer) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Empty body",
      status: 400
    });
  }
  const url = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Customer/SaveCustomerLongForm"
  );
  const up = await forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    url,
    bodyBuffer,
    establishSession
  );
  const upText = await up.text();
  const posted = urlEncodedToObject(buf);
  const ok = routewarePostLooksSuccessful(up.status, upText);
  let localSync: { done: false; reason?: string } | { done: true; customerId: number; addressIds: number[]; containerIds: number[] } = { done: false, reason: "not attempted" };
  if (ok) {
    const customerId = parseCustomerIdFromSaveResponse(posted, upText);
    if (customerId !== null) {
      try {
        const g = await syncCustomerDetailFullToD1(c.env, c.var.sessionStub, customerId);
        localSync = { done: true, customerId, addressIds: g.addressIds, containerIds: g.containerIds };
        await invalidateCustomerGraph({
          customerId,
          addressIds: g.addressIds,
          containerIds: g.containerIds
        });
      } catch (e) {
        console.error("syncCustomerDetailFullToD1", e);
        localSync = { done: false, reason: e instanceof Error ? e.message : String(e) };
        await invalidateDataEntity("customer", customerId);
      }
    } else {
      localSync = { done: false, reason: "could not determine CustomerID from response" };
    }
  }
  let upstreamJson: unknown = upText;
  try {
    upstreamJson = JSON.parse(upText);
  } catch {
    // keep string
  }
  return new Response(
    JSON.stringify({
      ok,
      routewareStatus: up.status,
      upstream: upstreamJson,
      posted,
      localSync
    }),
    {
      status: ok ? 200 : up.status,
      headers: { "content-type": "application/json; charset=utf-8" }
    }
  );
}

function parseJsonMaybe(t: string): unknown {
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return t;
  }
}

export async function handlePostDataAddress(c: DataEntityCtx): Promise<Response> {
  const buf = c.var.bodyBuffer;
  if (!buf || buf.byteLength === 0) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Empty body",
      status: 400
    });
  }
  const session = await readSessionState(c.var.sessionStub);
  let bodyBuffer: ArrayBuffer | null = buf;
  try {
    bodyBuffer = await prepareSaveAddressFormBody(
      c.env,
      session,
      c.req.raw,
      buf,
      c.req.raw.headers.get("content-type")
    );
  } catch (e) {
    return problemJsonResponse({
      type: problemType("bad-gateway"),
      title: "Anti-forgery preparation failed",
      status: 502,
      detail: e instanceof Error ? e.message : String(e)
    });
  }
  if (!bodyBuffer) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Empty body",
      status: 400
    });
  }
  const url = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/PickupAddress/SaveAddressForm"
  );
  const up = await forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    url,
    bodyBuffer,
    establishSession
  );
  const upText = await up.text();
  const posted = urlEncodedToObject(buf);
  const ok = routewarePostLooksSuccessful(up.status, upText);
  if (ok) {
    const cust = Number.parseInt(posted.CustomerID ?? posted.customerID ?? "0", 10);
    if (Number.isFinite(cust) && cust > 0) {
      try {
        const g = await syncCustomerDetailFullToD1(c.env, c.var.sessionStub, cust);
        await invalidateCustomerGraph({
          customerId: cust,
          addressIds: g.addressIds,
          containerIds: g.containerIds
        });
      } catch (e) {
        console.error("post address sync", e);
        await invalidateDataEntity("customer", cust);
        const paid = Number.parseInt(posted.PickupAddressID ?? "0", 10);
        if (Number.isFinite(paid) && paid > 0) {
          await invalidateDataEntity("address", paid);
        }
      }
    }
  }
  return new Response(
    JSON.stringify({
      ok,
      routewareStatus: up.status,
      upstream: parseJsonMaybe(upText),
      posted
    }),
    { status: ok ? 200 : up.status, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

export async function handlePostDataContainer(c: DataEntityCtx): Promise<Response> {
  const buf = c.var.bodyBuffer;
  if (!buf || buf.byteLength === 0) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Empty body",
      status: 400
    });
  }
  const session = await readSessionState(c.var.sessionStub);
  let bodyBuffer: ArrayBuffer | null = buf;
  try {
    bodyBuffer = await prepareSaveContainerFormBody(
      c.env,
      session,
      c.req.raw,
      buf,
      c.req.raw.headers.get("content-type")
    );
  } catch (e) {
    return problemJsonResponse({
      type: problemType("bad-gateway"),
      title: "Anti-forgery preparation failed",
      status: 502,
      detail: e instanceof Error ? e.message : String(e)
    });
  }
  if (!bodyBuffer) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Empty body",
      status: 400
    });
  }
  const url = routewareWebRwUrl(
    c.env.TARGET_ORIGIN,
    c.env.TARGET_BASE_PATH,
    "/Container/SaveContainerForm"
  );
  const up = await forwardWithSessionRetry(
    c.env,
    c.var.sessionStub,
    c.req.raw,
    url,
    bodyBuffer,
    establishSession
  );
  const upText = await up.text();
  const posted = urlEncodedToObject(buf);
  const ok = routewarePostLooksSuccessful(up.status, upText);
  if (ok) {
    let customerId: number | null = Number.parseInt(
      posted.CustomerID ?? posted.customerID ?? "0",
      10
    );
    if (!Number.isFinite(customerId) || customerId <= 0) {
      const paid = Number.parseInt(posted.PickupAddressID ?? "0", 10);
      if (Number.isFinite(paid) && paid > 0) {
        const row = await c.env.CUSTOMER_DB.prepare(
          `SELECT customer_id FROM address_snapshot WHERE pickup_address_id = ?`
        )
          .bind(paid)
          .first<{ customer_id: number }>();
        if (row) {
          customerId = row.customer_id;
        }
      }
    }
    if (customerId !== null && customerId > 0) {
      try {
        const g = await syncCustomerDetailFullToD1(c.env, c.var.sessionStub, customerId);
        await invalidateCustomerGraph({
          customerId,
          addressIds: g.addressIds,
          containerIds: g.containerIds
        });
      } catch (e) {
        console.error("post container sync", e);
        await invalidateDataEntity("customer", customerId);
      }
    }
  }
  return new Response(
    JSON.stringify({
      ok,
      routewareStatus: up.status,
      upstream: parseJsonMaybe(upText),
      posted
    }),
    { status: ok ? 200 : up.status, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}
