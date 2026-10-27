import { z } from "@hono/zod-openapi";

export const snapshotExactNextQuery = z.enum(["true", "false"]).optional().default("false")
  .describe(
    "Opt-in exact next-page signal: exactNext=true fetches limit+1 matching rows in one page SELECT " +
    "(at most 501), returns at most limit rows, and emits nextCursor/Link only if the extra row exists. " +
    "The cursor is the last returned primary ID, not the lookahead row. Default false preserves full " +
    "terminal-page false positives (a Link may lead to an empty page). Works with every list filter, " +
    "order, upperId and fields; includeTotal=false still runs zero COUNTs. countOnly=true takes precedence: " +
    "one COUNT, no lookahead or next Link. No snapshot isolation: " +
    "concurrent inserts/deletes can change later pages. Send exactly one exactNext=true or false, " +
    "or omit it and retry."
  ).openapi({ example: "true" });

type SnapshotListResource = "customer" | "address" | "container";

type SnapshotListQuery = {
  customerId?: number;
  customerNumber?: string;
  subCustomerNumber?: string;
  pickupAddressId?: number;
  containerId?: number;
  containerTypeId?: number;
  ids?: number[];
  serialNumber?: string;
  rfid?: string;
  serviceCode?: string;
  // Container list only; sibling lists omit these keys and keep unfiltered links.
  hasSerialNumber?: "true" | "false" | "any";
  hasRfid?: "true" | "false" | "any";
  materialStream?: string;
  color?: string;
  serviceCodeType?: string;
  serviceCodeInput?: string;
  routeId?: number;
  franchiseId?: string;
  parentRouteId?: number;
  parentFranchiseId?: string;
  parentCity?: string;
  parentState?: string;
  parentZip?: string;
  parentEnabled?: "true" | "false" | "any";
  hasCostShare?: "true" | "false" | "any";
  hasEnclosureDoors?: "true" | "false" | "any";
  zip?: string;
  streetAddress?: string;
  locationAddress?: string;
  city?: string;
  state?: string;
  driverNote?: string;
  lastAuditDate?: string;
  q?: string;
  phone?: string;
  note?: string;
  comments?: string;
  enabled: "true" | "false" | "any";
  // Container-only stored-flag selectors. Optional because the customer and
  // address lists share this query shape without defining these keys.
  onCall?: "true" | "false" | "any";
  gpsLocked?: "true" | "false" | "any";
  // Address list only; sibling lists omit the key and keep unfiltered links.
  extrasAllowed?: "true" | "false" | "any";
  hasContainers?: "true" | "false" | "any";
  hasLastAuditDate?: "true" | "false" | "any";
  parentCustomerEnabled?: "true" | "false" | "any";
  hasAddresses?: "true" | "false" | "any";
  hasCoordinates?: "true" | "false" | "any";
  addressRouteId?: number;
  addressFranchiseId?: string;
  addressEnabled?: "true" | "false" | "any";
  addressCity?: string;
  addressState?: string;
  addressZip?: string;
  addressExtrasAllowed?: "true" | "false" | "any";
  addressLastAuditDate?: string;
  hasPhone1?: "true" | "false" | "any";
  hasPhone2?: "true" | "false" | "any";
  fields?: string[];
  lowerId?: number;
  upperId?: number;
  limit: number;
  // Routes pass order/includeTotal only when the request spelled them out, so
  // default-valued targets stay byte-identical while explicit values round-trip.
  order?: "asc" | "desc";
  includeTotal?: "true" | "false";
  exactNext?: "true" | "false";
  strictQuery?: "true" | "false";
};

const LISTS = {
  customer: { path: "/api/v1/customer-snapshot", selectors: ["customerId", "customerNumber", "subCustomerNumber", "phone", "comments", "addressRouteId", "addressFranchiseId", "addressCity", "addressState", "addressZip", "addressLastAuditDate"] },
  address: { path: "/api/v1/address-snapshot", selectors: ["customerId", "pickupAddressId", "routeId", "franchiseId", "zip", "streetAddress", "city", "state", "driverNote", "lastAuditDate"] },
  container: { path: "/api/v1/container-snapshot", selectors: ["customerId", "pickupAddressId", "containerId", "containerTypeId", "parentRouteId", "parentFranchiseId", "parentCity", "parentState", "parentZip", "serialNumber", "rfid", "serviceCode", "materialStream", "color", "serviceCodeType", "serviceCodeInput", "zip", "locationAddress", "city", "state", "note"] }
} as const;

export const snapshotNextLinkHeader = {
  description:
    'Optional continuation: <relative-target>; rel="next" exactly when nextCursor is non-null. ' +
    "Preserves filters, explicit fields, effective limit, includeTotal=false and strictQuery=true; replaces cursor and omits offset. " +
    "A full terminal page may link to an empty page (no lookahead). Omission means stop. Resolve against the same origin.",
  required: false,
  schema: { type: "string" as const }
};

/** Build only from validated query values, never request URLs/headers or unknown keys. */
export function snapshotNextLink(
  resource: SnapshotListResource,
  query: SnapshotListQuery,
  nextCursor: number | null
): string | null {
  if (nextCursor === null) return null;
  const list = LISTS[resource];
  const params = new URLSearchParams();
  for (const key of list.selectors) {
    if (query[key] !== undefined) params.set(key, String(query[key]));
  }
  // Validated ids are canonical integers, so rejoining reproduces the single
  // canonical selector; unknown keys are still never copied.
  if (query.ids !== undefined) params.set("ids", query.ids.join(","));
  if (query.q !== undefined) params.set("q", query.q);
  if (query.enabled !== "any") params.set("enabled", query.enabled);
  // Non-any stored-flag selectors round-trip; `any`/omission stays canonical
  // by omission, exactly like `enabled=any`.
  if (query.onCall !== undefined && query.onCall !== "any") params.set("onCall", query.onCall);
  if (query.gpsLocked !== undefined && query.gpsLocked !== "any") params.set("gpsLocked", query.gpsLocked);
  // Non-any only, like enabled: any/omission stays out of the canonical target.
  if (query.extrasAllowed !== undefined && query.extrasAllowed !== "any") {
    params.set("extrasAllowed", query.extrasAllowed);
  }
  // Mirrored-container presence (address direct-child, customer grandchild;
  // the container list never sets it): carry only filtering values so
  // any/omitted continuations stay byte-identical.
  if (query.hasContainers !== undefined && query.hasContainers !== "any") {
    params.set("hasContainers", query.hasContainers);
  }
  // Stored audit-date presence (address only): carry only filtering values
  // so any/omitted continuations stay byte-identical.
  if (query.hasLastAuditDate !== undefined && query.hasLastAuditDate !== "any") {
    params.set("hasLastAuditDate", query.hasLastAuditDate);
  }
  // Parent stored-customer state (address only): carry only filtering values
  // so any/omitted continuations stay byte-identical.
  if (resource === "address" && query.parentCustomerEnabled !== undefined && query.parentCustomerEnabled !== "any") {
    params.set("parentCustomerEnabled", query.parentCustomerEnabled);
  }
  if (resource === "customer" && query.hasAddresses !== undefined && query.hasAddresses !== "any") {
    params.set("hasAddresses", query.hasAddresses);
  }
  if (resource !== "customer" && query.hasCoordinates !== undefined && query.hasCoordinates !== "any") {
    params.set("hasCoordinates", query.hasCoordinates);
  }
  if (resource === "customer" && query.addressEnabled !== undefined && query.addressEnabled !== "any") {
    params.set("addressEnabled", query.addressEnabled);
  }
  if (resource === "customer" && query.addressExtrasAllowed !== undefined && query.addressExtrasAllowed !== "any") {
    params.set("addressExtrasAllowed", query.addressExtrasAllowed);
  }
  // Customer-only stored-phone presence: carry only filtering values so
  // any/omitted continuations stay byte-identical.
  if (resource === "customer" && query.hasPhone1 !== undefined && query.hasPhone1 !== "any") {
    params.set("hasPhone1", query.hasPhone1);
  }
  if (resource === "customer" && query.hasPhone2 !== undefined && query.hasPhone2 !== "any") {
    params.set("hasPhone2", query.hasPhone2);
  }
  if (resource === "container" && query.parentEnabled !== undefined && query.parentEnabled !== "any") {
    params.set("parentEnabled", query.parentEnabled);
  }
  // Container-only stored-text presence selectors: carry only filtering
  // values so any/omitted continuations stay byte-identical.
  if (resource === "container" && query.hasCostShare !== undefined && query.hasCostShare !== "any") {
    params.set("hasCostShare", query.hasCostShare);
  }
  if (resource === "container" && query.hasEnclosureDoors !== undefined && query.hasEnclosureDoors !== "any") {
    params.set("hasEnclosureDoors", query.hasEnclosureDoors);
  }
  if (resource === "container" && query.hasSerialNumber !== undefined && query.hasSerialNumber !== "any") {
    params.set("hasSerialNumber", query.hasSerialNumber);
  }
  if (resource === "container" && query.hasRfid !== undefined && query.hasRfid !== "any") {
    params.set("hasRfid", query.hasRfid);
  }
  if (query.fields !== undefined) params.set("fields", query.fields.join(","));
  // Caller-held inclusive window: the next target keeps the same floor and cap
  // so the continuation cannot escape the traversal the caller chose to bound.
  if (query.lowerId !== undefined) params.set("lowerId", String(query.lowerId));
  if (query.upperId !== undefined) params.set("upperId", String(query.upperId));
  params.set("limit", String(query.limit));
  if (query.includeTotal !== undefined) params.set("includeTotal", query.includeTotal);
  if (query.exactNext === "true") params.set("exactNext", "true");
  // Direction travels with the cursor: an explicitly requested order is echoed
  // so desc traversals continue downward; omitted order keeps the asc default.
  if (query.order !== undefined) params.set("order", query.order);
  // Keep opt-in typo detection; false/default must not change legacy targets.
  if (query.strictQuery === "true") params.set("strictQuery", "true");
  // Continuations always seek, even when the first request used an offset.
  params.set("cursor", String(nextCursor));
  return `<${list.path}?${params.toString()}>; rel="next"`;
}
