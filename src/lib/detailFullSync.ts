import { establishSession } from "./establishSession";
import { INVALIDATE_GRAPH_MAX_ATTEMPTS } from "./entityDataCache";
import { logEvent } from "./logger";
import type { AddressSnapshotRow } from "./csvAddressSnapshot";
import type { ContainerSnapshotRow } from "./csvContainerSnapshot";
import type { CustomerSnapshotRow } from "./csvCustomerSnapshot";
import {
  upsertAddressSnapshotRows,
  upsertContainerSnapshotRows,
  upsertCustomerSnapshotRows
} from "./d1SnapshotSync";
import { isLoginRedirect } from "./loginRedirect";
import { readSessionState } from "./sessionState";
import { reconcileCustomerChildren } from "./snapshot/upsert";
import { readUpstreamText } from "./upstreamBody";
import { forwardToUpstream } from "./upstreamForward";
import { readUpstreamTimeoutMs } from "./upstreamTimeout";
import { routewareWebRwUrl } from "./upstreamUrl";

export type GetCustomerDetailFullJson = {
  data?: unknown[];
  currentCustomer?: Record<string, unknown>;
};

/**
 * Size guards for the per-customer unbounded fetch.
 *
 * Upstream `GetCustomerDetailFull` takes no paging parameters, so one customer
 * always arrives as one response. The byte cap bounds the isolate before
 * parsing. The D1 op budget bounds write fan-out and the cache-invalidation
 * budget bounds the per-id `caches.default.delete` fan-out every caller runs
 * after the sync — both are checked before the first write, so a graph past
 * either budget degrades to "D1 refresh skipped" with D1 untouched.
 */
export const DETAIL_FULL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Workers Paid allows ~1000 D1 ops per invocation; keep headroom for the request's own cache I/O. */
export const DETAIL_FULL_MAX_D1_OPS = 900;
/**
 * Cloudflare Workers Paid allows 1,000 Cache API calls per request,
 * sharing the 10,000-subrequest quota
 * (https://developers.cloudflare.com/workers/platform/limits/). Every caller
 * of `syncCustomerDetailFullToD1` invalidates one cache entry per graph id
 * (customer + addresses + containers), so the pre-write guard budgets a single
 * full-graph pass and keeps headroom for the request's own non-graph cache
 * I/O (fallback single-id evictions, anti-forgery token eviction). A retry
 * pass is never reserved up front — it is best-effort from the headroom (see
 * `detailFullInvalidateAttempts`) — so a graph that fits one pass is never
 * refused for a second pass that only runs after the first has thrown.
 *
 * Reconciliation can still enlarge the invalidation set past the guard: ids
 * of rows deleted upstream come back from `reconcileCustomerChildren`
 * (unbounded `DELETE ... RETURNING`) after the guard ran. If that pushes the
 * request past the Cache API limit the invalidation throws, the handler logs
 * it and reports `sync_failed`, and the un-evicted entries expire via the
 * shared entity-data TTL — stale for seconds, not served indefinitely.
 */
export const DETAIL_FULL_CACHE_API_LIMIT = 1000;
const DETAIL_FULL_CACHE_HEADROOM = 50;
export const DETAIL_FULL_MAX_CACHE_INVALIDATIONS =
  DETAIL_FULL_CACHE_API_LIMIT - DETAIL_FULL_CACHE_HEADROOM;
const DETAIL_FULL_BATCH = { customer: 80, address: 80, container: 50 } as const;

export function detailFullD1Ops(addressCount: number, containerCount: number): number {
  const batches = (rows: number, size: number) => Math.ceil(rows / size);
  // customer, address and container upsert batches, then the reconcile batch.
  // Each `db.batch()` call counts once (one subrequest per call) — keep this
  // in lockstep with the real upsert fan-out; `test/detailFullOpModel.test.ts`
  // pins the model against real upserts on a counting fake D1.
  return (
    1 +
    batches(addressCount, DETAIL_FULL_BATCH.address) +
    batches(containerCount, DETAIL_FULL_BATCH.container) +
    1
  );
}

export function detailFullCacheInvalidations(
  addressCount: number,
  containerCount: number
): number {
  // One delete per graph id (customer + addresses + containers): a single
  // full-graph pass. Cache deletes are idempotent, so a mid-graph failure
  // re-attempts the whole graph — but that retry is best-effort from the
  // headroom (see `detailFullInvalidateAttempts`), never reserved up front.
  return 1 + addressCount + containerCount;
}

/**
 * Best-effort retry passes for `invalidateCustomerGraphWithRetry`, derived
 * from the Cache API calls left after one full-graph pass: always at least
 * one attempt, at most `INVALIDATE_GRAPH_MAX_ATTEMPTS`, and a single attempt
 * when the graph leaves no room for a full second pass. Small graphs keep the
 * transient-failure retry; large graphs fail fast to the handler's
 * log-and-`sync_failed` path instead of spending quota on a doomed re-pass.
 */
export function detailFullInvalidateAttempts(
  addressCount: number,
  containerCount: number
): number {
  const ids = 1 + addressCount + containerCount;
  const remaining = DETAIL_FULL_CACHE_API_LIMIT - DETAIL_FULL_CACHE_HEADROOM - ids;
  return Math.max(
    1,
    Math.min(INVALIDATE_GRAPH_MAX_ATTEMPTS, 1 + Math.floor(remaining / ids))
  );
}

function n(v: unknown): number | null {
  if (v === null || v === undefined) {
    return null;
  }
  const x = typeof v === "string" ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : null;
}

function invalidGraph(field: string): never {
  // Only fixed graph/field names reach this diagnostic, never upstream values.
  throw new Error(`GetCustomerDetailFull invalid ${field}; skipping D1 refresh`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function graphIdentity(
  item: Record<string, unknown>,
  aliases: readonly [string, string],
  field: string,
  inherited?: number
): number {
  let identity: number | undefined;
  for (const alias of aliases) {
    if (!Object.hasOwn(item, alias)) continue;
    const value = item[alias];
    // Do not use the tolerant mapper's n(): every supplied alias must be a
    // complete decimal identity, including aliases shadowed by another spelling.
    const parsed = typeof value === "number" ? value :
      typeof value === "string" && value.length > 0 && !/[^0-9]/.test(value)
        ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0 ||
        (identity !== undefined && identity !== parsed)) {
      invalidGraph(field);
    }
    identity = parsed;
  }
  return identity ?? inherited ?? invalidGraph(field);
}

/** Validate raw identities before the read-only mapper can discard ambiguity. */
function validateDetailFullGraph(full: unknown, customerId: number): void {
  if (!isRecord(full) || !isRecord(full.currentCustomer)) {
    invalidGraph("customer.currentCustomer");
  }
  const customerAliases = ["CustomerID", "customerID"] as const;
  const addressAliases = ["PickupAddressID", "pickupAddressID"] as const;
  const containerAliases = ["ContainerID", "containerID"] as const;
  if (graphIdentity(full.currentCustomer, customerAliases, "customer.CustomerID") !== customerId) {
    invalidGraph("customer.CustomerID");
  }
  if (!Array.isArray(full.data)) invalidGraph("address.data");
  const addressIds = new Set<number>();
  const containerIds = new Set<number>();
  for (const address of full.data) {
    if (!isRecord(address)) invalidGraph("address.item");
    const addressId = graphIdentity(address, addressAliases, "address.PickupAddressID");
    if (addressIds.has(addressId)) invalidGraph("address.duplicate");
    addressIds.add(addressId);
    if (graphIdentity(address, customerAliases, "address.CustomerID") !== customerId) {
      invalidGraph("address.CustomerID");
    }
    // An absent collection retains the existing empty-child behavior, but a
    // supplied malformed collection (including null) cannot prove deletion.
    if (!Object.hasOwn(address, "Containers")) continue;
    if (!Array.isArray(address.Containers)) invalidGraph("container.Containers");
    for (const container of address.Containers) {
      if (!isRecord(container)) invalidGraph("container.item");
      const containerId = graphIdentity(container, containerAliases, "container.ContainerID");
      if (containerIds.has(containerId)) invalidGraph("container.duplicate");
      containerIds.add(containerId);
      if (graphIdentity(container, addressAliases, "container.PickupAddressID", addressId) !== addressId) {
        invalidGraph("container.PickupAddressID");
      }
    }
  }
}

function s(v: unknown): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  const t = String(v).trim();
  return t === "" ? null : t;
}

function b(v: unknown): boolean {
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "number") {
    return v !== 0;
  }
  if (typeof v === "string") {
    return /^(1|true|yes)$/i.test(v);
  }
  return false;
}

export function mapCurrentCustomerToRow(cc: Record<string, unknown>): CustomerSnapshotRow {
  const id = n(cc.CustomerID) ?? n(cc.customerID);
  if (id === null) {
    throw new Error("currentCustomer missing CustomerID");
  }
  return {
    customerId: id,
    customerTypeId: n(cc.CustomerTypeID),
    companyName: s(cc.CompanyName),
    firstName: s(cc.NameFirst),
    middleInitial: s(cc.NameMI),
    lastName: s(cc.NameLast),
    nameSuffix: s(cc.NameSuffix),
    customerNumber: s(cc.CustomerNumber),
    subCustomerNumber: s(cc.SubCustomerNumber),
    phone1: s(cc.Phone1),
    phone2: s(cc.Phone2),
    comments: s(cc.Comments),
    // Absent Enabled defaults to true, matching the cron CSV
    // path (`parseBoolDefaultTrue`), the address/container guards below,
    // and the D1 `DEFAULT 1` — coercing undefined yields false and would
    // flap the same customer disabled (POST) / enabled (cron).
    enabled: cc.Enabled !== undefined ? b(cc.Enabled) : true
  };
}

function mapAddressItem(
  a: Record<string, unknown>,
  driverNoteFallback: string | null
): AddressSnapshotRow {
  const pa = n(a.PickupAddressID) ?? n(a.pickupAddressID);
  const cid = n(a.CustomerID) ?? n(a.customerID);
  if (pa === null || cid === null) {
    throw new Error("address item missing PickupAddressID or CustomerID");
  }
  return {
    pickupAddressId: pa,
    customerId: cid,
    routeId: n(a.RouteID) ?? n(a.routeID),
    address: s(a.Address),
    city: s(a.City),
    state: s(a.State),
    zip: s(a.Zip),
    franchiseId: s(a.FranchiseID),
    comments: s(a.Comments),
    extrasAllowed: a.ExtrasAllowed !== undefined ? b(a.ExtrasAllowed) : true,
    enabled: a.Enabled !== undefined ? b(a.Enabled) : true,
    driverNote: s(a.DriverNote) ?? driverNoteFallback,
    latitude: s(a.Latitude),
    longitude: s(a.Longitude),
    lastAuditDate: s(a.LastAuditDate)
  };
}

function mapContainerItem(
  c: Record<string, unknown>,
  pickupAddressId: number
): ContainerSnapshotRow {
  const cid = n(c.ContainerID) ?? n(c.containerID);
  if (cid === null) {
    throw new Error("container missing ContainerID");
  }
  const pick = n(c.PickupAddressID) ?? n(c.pickupAddressID);
  const p = pick !== null ? pick : pickupAddressId;
  const routes = Array.isArray(c.Routes) ? (c.Routes as Record<string, unknown>[]) : [];
  const routeIds = routes
    .map((r) => n(r.RouteID))
    .filter((x): x is number => x !== null);
  const freq = routes
    .map((r) => n(r.FrequencyID))
    .filter((x): x is number => x !== null);
  return {
    containerId: cid,
    pickupAddressId: p,
    containerTypeId: n(c.ContainerTypeID) ?? n(c.containerTypeID),
    serialNumber: s(c.SerialNumber),
    rfid: s(c.RFID),
    onCall: b(c.OnCall),
    eventCode: s(c.EventCode),
    gpsLocked: c.GPSLocked !== undefined ? b(c.GPSLocked) : false,
    latitude: s(c.Latitude),
    longitude: s(c.Longitude),
    enabled: c.Enabled !== undefined ? b(c.Enabled) : true,
    locationAddress: s(c.LocationAddress) ?? s(c.Address),
    city: s(c.City),
    state: s(c.State),
    zip: s(c.Zip),
    containerNote: s(c.Note) ?? s(c.ContainerNotes),
    udCostShareUd: null,
    udEnclosureDoorsUd: null,
    udLastCompactorInspectionUd: null,
    udLastEnclosureInspectionUd: null,
    udMaterialStreamUd: null,
    color: s(c.Color),
    serviceCodeType: null,
    serviceCodeInput: null,
    serviceCode: s(c.ChangeCode) ?? s(c.FrequencyCode),
    serviceDate: null,
    routeIds: routeIds.length ? routeIds.join(",") : null,
    frequencyIds: freq.length ? freq.join(",") : null
  };
}

/**
 * Map Routeware `GetCustomerDetailFull` JSON into D1 upsert row shapes.
 * Walks `data` addresses and nested `Containers` arrays.
 */
export function mapDetailFullToRows(json: GetCustomerDetailFullJson): {
  customer: CustomerSnapshotRow;
  addresses: AddressSnapshotRow[];
  containers: ContainerSnapshotRow[];
} {
  const cc = json.currentCustomer;
  if (!cc) {
    throw new Error("GetCustomerDetailFull missing currentCustomer");
  }
  const customer = mapCurrentCustomerToRow(cc);
  const data = Array.isArray(json.data) ? json.data : [];
  const addresses: AddressSnapshotRow[] = [];
  const containers: ContainerSnapshotRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const a = raw as Record<string, unknown>;
    const addr = mapAddressItem(
      a,
      s(a.DriverNote) ?? s(a["driver note"]) ?? null
    );
    addresses.push(addr);
    const cons = a.Containers;
    if (Array.isArray(cons)) {
      for (const c of cons) {
        if (c && typeof c === "object") {
          containers.push(mapContainerItem(c as Record<string, unknown>, addr.pickupAddressId));
        }
      }
    }
  }
  return { customer, addresses, containers };
}

export async function fetchGetCustomerDetailFull(
  env: Env,
  sessionStub: DurableObjectStub,
  customerId: number,
  showDisabled: boolean
): Promise<GetCustomerDetailFullJson> {
  const bodyStr = JSON.stringify({ customerID: customerId, showDisabled });
  const buf = new TextEncoder().encode(bodyStr).buffer;
  const url = routewareWebRwUrl(
    env.TARGET_ORIGIN,
    env.TARGET_BASE_PATH,
    "/Customer/GetCustomerDetailFull"
  );
  const makeReq = () =>
    new Request("http://internal/gcdf", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=UTF-8",
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        referer: `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/Customer/Customers`
      },
      body: bodyStr
    });

  let session = await readSessionState(sessionStub);
  // Interactive budget honoring UPSTREAM_TIMEOUT_MS: the forwarder
  // default alone would ignore the per-deploy override.
  const timeoutMs = readUpstreamTimeoutMs(env);
  let resp = await forwardToUpstream(makeReq(), url, session, buf, { timeoutMs });
  if (resp.status !== 200 || isLoginRedirect(resp)) {
    await establishSession(env, sessionStub, env.LOGIN_URL);
    session = await readSessionState(sessionStub);
    resp = await forwardToUpstream(makeReq(), url, session, buf, { timeoutMs });
  }
  if (!resp.ok) {
    // The body is upstream-controlled HTML/JSON and may carry customer PII —
    // never embed it in the message: this error is logged server-side and
    // POST /api/v1/data/* maps sync failures to a fixed `localSync.code`
    // while keeping the upstream 200.
    throw new Error(`GetCustomerDetailFull failed: HTTP ${resp.status}`);
  }
  // Pre-check: refuse to buffer a graph that would threaten the isolate before
  // paying for the full body. Absent header (chunked) falls through to the
  // exact byte check below.
  const declared = resp.headers.get("content-length");
  if (
    declared !== null &&
    Number.isFinite(Number(declared)) &&
    Number(declared) > DETAIL_FULL_MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      `GetCustomerDetailFull customer ${customerId} response too large ` +
        `(${declared} bytes declared > ${DETAIL_FULL_MAX_RESPONSE_BYTES} byte limit); ` +
        `skipping D1 refresh`
    );
  }
  const text = await readUpstreamText(resp, timeoutMs);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > DETAIL_FULL_MAX_RESPONSE_BYTES) {
    throw new Error(
      `GetCustomerDetailFull customer ${customerId} response too large ` +
        `(${bytes} bytes > ${DETAIL_FULL_MAX_RESPONSE_BYTES} byte limit); ` +
        `skipping D1 refresh`
    );
  }
  return JSON.parse(text) as GetCustomerDetailFullJson;
}

/**
 * Fetches a complete customer graph and reconciles its D1 children.
 * Returns fresh and deleted ids so neither can remain in the entity cache.
 */
export async function syncCustomerDetailFullToD1(
  env: Env,
  sessionStub: DurableObjectStub,
  customerId: number
): Promise<{ addressIds: number[]; containerIds: number[] }> {
  const syncedAt = new Date().toISOString();
  const full = await fetchGetCustomerDetailFull(env, sessionStub, customerId, true);
  validateDetailFullGraph(full, customerId);
  const { customer, addresses, containers } = mapDetailFullToRows(full);
  const addressIds = addresses.map((a) => a.pickupAddressId);
  const ops = detailFullD1Ops(addresses.length, containers.length);
  if (ops > DETAIL_FULL_MAX_D1_OPS) {
    throw new Error(
      `GetCustomerDetailFull customer ${customerId} too large ` +
        `(${ops} D1 ops > ${DETAIL_FULL_MAX_D1_OPS} budget); skipping D1 refresh`
    );
  }
  const invalidations = detailFullCacheInvalidations(addresses.length, containers.length);
  if (invalidations > DETAIL_FULL_MAX_CACHE_INVALIDATIONS) {
    throw new Error(
      `GetCustomerDetailFull customer ${customerId} too large ` +
        `(${invalidations} cache invalidations > ${DETAIL_FULL_MAX_CACHE_INVALIDATIONS} budget); skipping D1 refresh`
    );
  }
  await upsertCustomerSnapshotRows(env.CUSTOMER_DB, [customer], DETAIL_FULL_BATCH.customer, syncedAt);
  if (addresses.length) {
    await upsertAddressSnapshotRows(env.CUSTOMER_DB, addresses, DETAIL_FULL_BATCH.address, syncedAt);
  }
  if (containers.length) {
    await upsertContainerSnapshotRows(env.CUSTOMER_DB, containers, DETAIL_FULL_BATCH.container, syncedAt);
  }
  const deleted = await reconcileCustomerChildren(env.CUSTOMER_DB, customerId, syncedAt);
  // One utilization line per successful run so operators
  // can see D1 op-budget headroom. Emitted after the writes, so it fires
  // exactly once per run that refreshed D1; the over-budget throws above
  // stay throw-only (fail-closed, no line).
  logEvent({
    level: "info",
    msg: "Detail-full sync D1 op-budget utilization",
    route: "sync.detailFull",
    customerId,
    addressCount: addresses.length,
    containerCount: containers.length,
    d1Ops: ops,
    d1OpsBudget: DETAIL_FULL_MAX_D1_OPS,
    cacheInvalidations: invalidations,
    cacheInvalidationBudget: DETAIL_FULL_MAX_CACHE_INVALIDATIONS
  });
  return {
    addressIds: [...new Set([...addressIds, ...deleted.addressIds])],
    containerIds: [...new Set([...containers.map((c) => c.containerId), ...deleted.containerIds])]
  };
}
