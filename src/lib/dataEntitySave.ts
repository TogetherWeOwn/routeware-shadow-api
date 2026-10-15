import { prepareSaveAddressFormBody, prepareSaveContainerFormBody } from "./addressContainerSaveForm";
import {
  evictAntiForgeryTokenCacheForBody,
  prepareSaveCustomerLongFormBody
} from "./customerSaveAutoToken";
import type { DataEntityCtx } from "./dataEntityHandlers";
import { syncCustomerDetailFullToD1 } from "./detailFullSync";
import { errorKind, logEvent } from "./logger";
import {
  invalidateCustomerGraphWithRetry,
  invalidateDataEntity
} from "./entityDataCache";
import { forwardWithSessionRetry } from "./forwardWithSessionRetry";
import { establishSession } from "./establishSession";
import { problemJsonResponse, problemType } from "./problem";
import { readSessionState } from "./sessionState";
import { readUpstreamText } from "./upstreamBody";
import { readUpstreamTimeoutMs } from "./upstreamTimeout";
import {
  parseCustomerIdFromSaveResponse,
  routewarePostLooksSuccessful,
  urlEncodedToObject
} from "./routewarePostResult";
import { routewareWebRwUrl } from "./upstreamUrl";

/**
 * TOG-6533: invalidate the posted entity id(s) after a successful upstream
 * write whose graph id is unresolvable (no sync possible, so the graph ids are
 * unknown). Without this the write succeeds upstream while the edge cache keeps
 * serving the pre-edit bundle — stale customer PII.
 *
 * Ids only (never request/response bodies); `invalidateDataEntity` propagates
 * failures so a failed invalidation is loud, matching the sync-throw path.
 */
async function invalidatePostedIds(
  entries: Array<{ entity: "customer" | "address" | "container"; id: number | null }>
): Promise<void> {
  for (const { entity, id } of entries) {
    if (id !== null) {
      await invalidateDataEntity(entity, id);
    }
  }
}

/**
 * TOG-6535: local-sync outcome codes. Fixed strings only — never exception
 * text, which previously reached clients verbatim inside `localSync.reason`
 * and could carry upstream PII/HTML.
 */
export type LocalSyncCode = "not_attempted" | "unknown_customer_id" | "sync_failed";

export type LocalSyncSummary =
  | { done: false; code: LocalSyncCode }
  | {
      done: true;
      customerId: number;
      addressIds: number[];
      containerIds: number[];
    };

function syncFailed(): LocalSyncSummary {
  return { done: false, code: "sync_failed" };
}

function notAttempted(): LocalSyncSummary {
  return { done: false, code: "not_attempted" };
}

function unknownCustomerId(): LocalSyncSummary {
  return { done: false, code: "unknown_customer_id" };
}

/** Byte length of an upstream body — a count, never its content. */
function upstreamBytes(t: string): number {
  return new TextEncoder().encode(t).length;
}

/** Positive-int id from a posted form field, or null when absent/unusable. */
function postedId(v: string | undefined): number | null {
  if (v === undefined) {
    return null;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function handlePostDataCustomer(c: DataEntityCtx): Promise<Response> {
  const buf = c.var.bodyBuffer;
  if (!buf || buf.byteLength === 0) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "POST application/x-www-form-urlencoded (SaveCustomerLongForm fields). See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.raw.url).pathname
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
      { sessionStub: c.var.sessionStub, establishSession }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return problemJsonResponse({
      type: problemType("bad-gateway", c.env),
      title: "Bad Gateway",
      status: 502,
      detail: `${msg} See docs/PROBLEMS.md#bad-gateway.`,
      instance: new URL(c.req.raw.url).pathname
    });
  }
  if (!bodyBuffer) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "Request body was empty after anti-forgery preparation. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.raw.url).pathname
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
  const upText = await readUpstreamText(up, readUpstreamTimeoutMs(c.env));
  // TOG-6535: `posted` is parsed for ids only and never echoed — the full
  // form map is customer PII and must not leave the handler.
  const posted = urlEncodedToObject(buf);
  const ok = routewarePostLooksSuccessful(up.status, upText);
  const customerId = parseCustomerIdFromSaveResponse(posted, upText);
  if (!ok && up.status >= 200 && up.status < 300) {
    // TOG-8149: same silent-failure eviction as the save-long-form route —
    // a rejected token must not be replayed on the next token-less save.
    evictAntiForgeryTokenCacheForBody(bodyBuffer);
  }
  let localSync: LocalSyncSummary = notAttempted();
  if (ok) {
    if (customerId !== null) {
      try {
        const g = await syncCustomerDetailFullToD1(c.env, c.var.sessionStub, customerId);
        localSync = { done: true, customerId, addressIds: g.addressIds, containerIds: g.containerIds };
        // TOG-6534: retry the whole graph on a mid-graph throw (cache deletes
        // are idempotent) so a transient delete failure cannot leave sibling
        // address/container PII stale while the customer row was rewritten.
        await invalidateCustomerGraphWithRetry({
          customerId,
          addressIds: g.addressIds,
          containerIds: g.containerIds
        });
      } catch (syncErr) {
        logEvent({
          level: "error",
          msg: "Local customer snapshot sync failed",
          route: "POST /api/v1/data/customer",
          kind: errorKind(syncErr)
        });
        localSync = syncFailed();
        await invalidateDataEntity("customer", customerId);
      }
    } else {
      localSync = unknownCustomerId();
      // TOG-6533: no sync is possible without the graph id, but the upstream
      // write succeeded — invalidate the posted customer id (if any) instead
      // of serving the pre-edit cached bundle. `parseCustomerIdFromSaveResponse`
      // only returns null when the posted form carried no usable id, so this is
      // usually a no-op; it guards future parse drift, not today's shape.
      await invalidatePostedIds([
        { entity: "customer", id: postedId(posted.CustomerID ?? posted.customerID) }
      ]);
    }
  }
  return new Response(
    JSON.stringify({
      ok,
      routewareStatus: up.status,
      customerId,
      upstreamBytes: upstreamBytes(upText),
      localSync
    }),
    {
      status: ok ? 200 : up.status,
      headers: { "content-type": "application/json; charset=utf-8" }
    }
  );
}

export async function handlePostDataAddress(c: DataEntityCtx): Promise<Response> {
  const buf = c.var.bodyBuffer;
  if (!buf || buf.byteLength === 0) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "POST application/x-www-form-urlencoded (SaveAddressForm fields). See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.raw.url).pathname
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
      c.req.raw.headers.get("content-type"),
      { sessionStub: c.var.sessionStub, establishSession }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "New address requires CustomerID in POST body") {
      return problemJsonResponse({
        type: problemType("bad-request", c.env),
        title: "Bad Request",
        status: 400,
        detail: `${msg}. See docs/PROBLEMS.md#bad-request.`,
        instance: new URL(c.req.raw.url).pathname
      });
    }
    return problemJsonResponse({
      type: problemType("bad-gateway", c.env),
      title: "Bad Gateway",
      status: 502,
      detail: `${msg} See docs/PROBLEMS.md#bad-gateway.`,
      instance: new URL(c.req.raw.url).pathname
    });
  }
  if (!bodyBuffer) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "Request body was empty after anti-forgery preparation. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.raw.url).pathname
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
  const upText = await readUpstreamText(up, readUpstreamTimeoutMs(c.env));
  // TOG-6535: `posted` is parsed for ids only and never echoed.
  const posted = urlEncodedToObject(buf);
  const ok = routewarePostLooksSuccessful(up.status, upText);
  const custRaw = Number.parseInt(posted.CustomerID ?? posted.customerID ?? "0", 10);
  const customerId = Number.isFinite(custRaw) && custRaw > 0 ? custRaw : null;
  const paidRaw = Number.parseInt(posted.PickupAddressID ?? "0", 10);
  const pickupAddressId = Number.isFinite(paidRaw) && paidRaw > 0 ? paidRaw : null;
  let localSync: LocalSyncSummary = notAttempted();
  if (ok) {
    if (customerId !== null) {
      try {
        const g = await syncCustomerDetailFullToD1(c.env, c.var.sessionStub, customerId);
        localSync = {
          done: true,
          customerId,
          addressIds: g.addressIds,
          containerIds: g.containerIds
        };
        // TOG-6534: retry the whole graph on a mid-graph throw (cache deletes
        // are idempotent) so a transient delete failure cannot leave sibling
        // address/container PII stale while the customer row was rewritten.
        await invalidateCustomerGraphWithRetry({
          customerId,
          addressIds: g.addressIds,
          containerIds: g.containerIds
        });
      } catch (syncErr) {
        logEvent({
          level: "error",
          msg: "Local address snapshot sync failed",
          route: "POST /api/v1/data/address",
          kind: errorKind(syncErr)
        });
        localSync = syncFailed();
        await invalidateDataEntity("customer", customerId);
        if (pickupAddressId !== null) {
          await invalidateDataEntity("address", pickupAddressId);
        }
      }
    } else {
      localSync = unknownCustomerId();
      // TOG-6533: the upstream write succeeded but there is no usable
      // CustomerID to sync on — still invalidate the posted address id so the
      // pre-edit cached bundle is not served as current.
      await invalidatePostedIds([
        { entity: "address", id: postedId(posted.PickupAddressID) }
      ]);
    }
  }
  return new Response(
    JSON.stringify({
      ok,
      routewareStatus: up.status,
      customerId,
      pickupAddressId,
      upstreamBytes: upstreamBytes(upText),
      localSync
    }),
    { status: ok ? 200 : up.status, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

export async function handlePostDataContainer(c: DataEntityCtx): Promise<Response> {
  const buf = c.var.bodyBuffer;
  if (!buf || buf.byteLength === 0) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "POST application/x-www-form-urlencoded (SaveContainerForm fields). See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.raw.url).pathname
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
      c.req.raw.headers.get("content-type"),
      { sessionStub: c.var.sessionStub, establishSession }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "New container requires PickupAddressID in POST body") {
      return problemJsonResponse({
        type: problemType("bad-request", c.env),
        title: "Bad Request",
        status: 400,
        detail: `${msg}. See docs/PROBLEMS.md#bad-request.`,
        instance: new URL(c.req.raw.url).pathname
      });
    }
    return problemJsonResponse({
      type: problemType("bad-gateway", c.env),
      title: "Bad Gateway",
      status: 502,
      detail: `${msg} See docs/PROBLEMS.md#bad-gateway.`,
      instance: new URL(c.req.raw.url).pathname
    });
  }
  if (!bodyBuffer) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "Request body was empty after anti-forgery preparation. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.raw.url).pathname
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
  const upText = await readUpstreamText(up, readUpstreamTimeoutMs(c.env));
  // TOG-6535: `posted` is parsed for ids only and never echoed.
  const posted = urlEncodedToObject(buf);
  const ok = routewarePostLooksSuccessful(up.status, upText);
  const postedCustomerId = postedId(posted.CustomerID ?? posted.customerID);
  const postedPickupAddressId = postedId(posted.PickupAddressID);
  const postedContainerId = postedId(posted.ContainerID);
  let customerId: number | null = postedCustomerId;
  let localSync: LocalSyncSummary = notAttempted();
  if (ok) {
    if (customerId === null && postedPickupAddressId !== null) {
      const row = await c.env.CUSTOMER_DB.prepare(
        `SELECT customer_id FROM address_snapshot WHERE pickup_address_id = ?`
      )
        .bind(postedPickupAddressId)
        .first<{ customer_id: number }>();
      if (row) {
        customerId = row.customer_id;
      }
    }
    if (customerId !== null) {
      try {
        const g = await syncCustomerDetailFullToD1(c.env, c.var.sessionStub, customerId);
        localSync = {
          done: true,
          customerId,
          addressIds: g.addressIds,
          containerIds: g.containerIds
        };
        // TOG-6534: retry the whole graph on a mid-graph throw (cache deletes
        // are idempotent) so a transient delete failure cannot leave sibling
        // address/container PII stale while the customer row was rewritten.
        await invalidateCustomerGraphWithRetry({
          customerId,
          addressIds: g.addressIds,
          containerIds: g.containerIds
        });
      } catch (syncErr) {
        logEvent({
          level: "error",
          msg: "Local container snapshot sync failed",
          route: "POST /api/v1/data/container",
          kind: errorKind(syncErr)
        });
        localSync = syncFailed();
        await invalidateDataEntity("customer", customerId);
        if (postedContainerId !== null) {
          await invalidateDataEntity("container", postedContainerId);
        }
      }
    } else {
      localSync = unknownCustomerId();
      // TOG-6533: the upstream write succeeded but no owning customer could be
      // resolved (neither posted nor via the address-snapshot fallback) — still
      // invalidate the posted address/container ids so pre-edit cached bundles
      // are not served as current.
      await invalidatePostedIds([
        { entity: "address", id: postedId(posted.PickupAddressID) },
        { entity: "container", id: postedId(posted.ContainerID) }
      ]);
    }
  }
  return new Response(
    JSON.stringify({
      ok,
      routewareStatus: up.status,
      customerId,
      pickupAddressId: postedPickupAddressId,
      containerId: postedContainerId,
      upstreamBytes: upstreamBytes(upText),
      localSync
    }),
    { status: ok ? 200 : up.status, headers: { "content-type": "application/json; charset=utf-8" } }
  );
}
