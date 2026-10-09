import { syncCustomerDetailFullToD1 } from "./detailFullSync";
import { logEvent } from "./logger";
import { invalidateCustomerGraph, invalidateDataEntity } from "./entityDataCache";
import {
  parseCustomerIdFromSaveResponse,
  urlEncodedToObject
} from "./routewarePostResult";

export type RoutewareSaveKind = "customer" | "address" | "container";

/**
 * Post-save refresh shared by the routeware-tier save routes
 * (`save-long-form`, `save-address-form`, `save-container-form`).
 *
 * The `/api/v1/data/*` write tier already refreshes D1 from
 * `GetCustomerDetailFull` and invalidates the customer graph after a
 * successful upstream save; the routeware tier used to forward upstream and
 * return, so a successful save (including the documented
 * `Enabled=false` disable flow) stayed invisible to shadow reads until the
 * next cron sync (TOG-6463).
 *
 * Never throws: the upstream save succeeded, so a local refresh failure must
 * not turn the passthrough 200 into a 500. Failures are logged, and the
 * affected single-entity cache keys are evicted best-effort so the next
 * `GET /api/v1/data/*` re-reads D1 instead of serving the superseded entry.
 */
export async function refreshAfterRoutewareSave(
  env: Env,
  sessionStub: DurableObjectStub,
  kind: RoutewareSaveKind,
  forwardedBody: ArrayBuffer | null,
  upstreamText: string
): Promise<void> {
  try {
    const posted = urlEncodedToObject(forwardedBody);
    const customerId = await resolveCustomerId(env, kind, posted, upstreamText);
    if (customerId === null) {
      return;
    }
    try {
      const g = await syncCustomerDetailFullToD1(env, sessionStub, customerId);
      await invalidateCustomerGraph({
        customerId,
        addressIds: g.addressIds,
        containerIds: g.containerIds
      });
    } catch {
      logEvent({
        level: "error",
        msg: "Post-save snapshot sync failed; evicting affected cache keys",
        route: "routeware.saveRefresh",
        entity: kind
      });
      await invalidateSaveFallback(kind, customerId, posted);
    }
  } catch {
    logEvent({
      level: "error",
      msg: "Post-save refresh failed",
      route: "routeware.saveRefresh",
      kind
    });
  }
}

async function resolveCustomerId(
  env: Env,
  kind: RoutewareSaveKind,
  posted: Record<string, string>,
  upstreamText: string
): Promise<number | null> {
  if (kind === "customer") {
    // Updates carry the id in the form; creates may only reveal it in JSON.
    return parseCustomerIdFromSaveResponse(posted, upstreamText);
  }
  const fromPost = Number.parseInt(posted.CustomerID ?? posted.customerID ?? "0", 10);
  if (Number.isFinite(fromPost) && fromPost > 0) {
    return fromPost;
  }
  if (kind === "address") {
    return null;
  }
  // The container form frequently posts only PickupAddressID: resolve the
  // owning customer from the snapshot (same fallback as handlePostDataContainer).
  const paid = Number.parseInt(posted.PickupAddressID ?? "0", 10);
  if (!Number.isFinite(paid) || paid <= 0) {
    return null;
  }
  const row = await env.CUSTOMER_DB.prepare(
    `SELECT customer_id FROM address_snapshot WHERE pickup_address_id = ?`
  )
    .bind(paid)
    .first<{ customer_id: number }>();
  return row && row.customer_id > 0 ? row.customer_id : null;
}

/**
 * Best-effort eviction when the D1 sync throws: the graph ids are unknown,
 * so evict the customer plus whichever address/container id was posted.
 * Individual failures are logged, never rethrown — the save itself succeeded.
 */
async function invalidateSaveFallback(
  kind: RoutewareSaveKind,
  customerId: number,
  posted: Record<string, string>
): Promise<void> {
  const attempts: Array<Promise<void>> = [];
  attempts.push(
    invalidateDataEntity("customer", customerId).catch(() =>
      logEvent({
        level: "error",
        msg: "Post-save customer cache invalidation failed",
        route: "routeware.saveRefresh.invalidate",
        entity: "customer"
      })
    )
  );
  const extraKey = kind === "address" ? "PickupAddressID" : kind === "container" ? "ContainerID" : null;
  if (extraKey) {
    const extra = Number.parseInt(posted[extraKey] ?? "0", 10);
    if (Number.isFinite(extra) && extra > 0) {
      const entity = kind === "address" ? "address" : "container";
      attempts.push(
        invalidateDataEntity(entity, extra).catch(() =>
          logEvent({
            level: "error",
            msg: "Post-save entity cache invalidation failed",
            route: "routeware.saveRefresh.invalidate",
            entity
          })
        )
      );
    }
  }
  await Promise.all(attempts);
}
