import { establishSession } from "./establishSession";
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
import { forwardToUpstream } from "./upstreamForward";
import { routewareWebRwUrl } from "./upstreamUrl";

export type GetCustomerDetailFullJson = {
  data?: unknown[];
  currentCustomer?: Record<string, unknown>;
};

function n(v: unknown): number | null {
  if (v === null || v === undefined) {
    return null;
  }
  const x = typeof v === "string" ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : null;
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
    enabled: b(cc.Enabled)
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
  let resp = await forwardToUpstream(makeReq(), url, session, buf);
  if (resp.status !== 200 || isLoginRedirect(resp)) {
    await establishSession(env, sessionStub, env.LOGIN_URL);
    session = await readSessionState(sessionStub);
    resp = await forwardToUpstream(makeReq(), url, session, buf);
  }
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`GetCustomerDetailFull HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  return (await resp.json()) as GetCustomerDetailFullJson;
}

/**
 * Fetches `GetCustomerDetailFull` and upserts customer, addresses, and containers into D1.
 * Returns all involved ids (for cache invalidation).
 */
export async function syncCustomerDetailFullToD1(
  env: Env,
  sessionStub: DurableObjectStub,
  customerId: number
): Promise<{ addressIds: number[]; containerIds: number[] }> {
  const full = await fetchGetCustomerDetailFull(env, sessionStub, customerId, true);
  const { customer, addresses, containers } = mapDetailFullToRows(full);
  await upsertCustomerSnapshotRows(env.CUSTOMER_DB, [customer]);
  if (addresses.length) {
    await upsertAddressSnapshotRows(env.CUSTOMER_DB, addresses);
  }
  if (containers.length) {
    await upsertContainerSnapshotRows(env.CUSTOMER_DB, containers);
  }
  return {
    addressIds: addresses.map((a) => a.pickupAddressId),
    containerIds: containers.map((c) => c.containerId)
  };
}
