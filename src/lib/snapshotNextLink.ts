type SnapshotListResource = "customer" | "address" | "container";

type SnapshotListQuery = {
  customerId?: number;
  customerNumber?: string;
  subCustomerNumber?: string;
  pickupAddressId?: number;
  containerId?: number;
  ids?: number[];
  serialNumber?: string;
  rfid?: string;
  routeId?: number;
  franchiseId?: string;
  zip?: string;
  city?: string;
  state?: string;
  q?: string;
  phone?: string;
  note?: string;
  enabled: "true" | "false" | "any";
  hasContainers?: "true" | "false" | "any";
  hasAddresses?: "true" | "false" | "any";
  fields?: string[];
  upperId?: number;
  limit: number;
  // Routes pass order/includeTotal only when the request spelled them out, so
  // default-valued targets stay byte-identical while explicit values round-trip.
  order?: "asc" | "desc";
  includeTotal?: "true" | "false";
};

const LISTS = {
  customer: { path: "/api/v1/customer-snapshot", selectors: ["customerId", "customerNumber", "subCustomerNumber", "phone"] },
  address: { path: "/api/v1/address-snapshot", selectors: ["customerId", "pickupAddressId", "routeId", "franchiseId", "zip", "city", "state"] },
  container: { path: "/api/v1/container-snapshot", selectors: ["customerId", "pickupAddressId", "containerId", "serialNumber", "rfid", "zip", "note"] }
} as const;

export const snapshotNextLinkHeader = {
  description:
    'Optional continuation: <relative-target>; rel="next" exactly when nextCursor is non-null. ' +
    "Preserves filters, explicit fields, effective limit and includeTotal=false; replaces cursor and omits offset. " +
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
  // Address-only presence selector (other lists never set it): carry only
  // filtering values so any/omitted continuations stay byte-identical.
  if (query.hasContainers !== undefined && query.hasContainers !== "any") {
    params.set("hasContainers", query.hasContainers);
  }
  if (resource === "customer" && query.hasAddresses !== undefined && query.hasAddresses !== "any") {
    params.set("hasAddresses", query.hasAddresses);
  }
  if (query.fields !== undefined) params.set("fields", query.fields.join(","));
  // Caller-held inclusive ceiling: the next target keeps the same cap so the
  // continuation cannot escape the traversal the caller chose to bound.
  if (query.upperId !== undefined) params.set("upperId", String(query.upperId));
  params.set("limit", String(query.limit));
  if (query.includeTotal !== undefined) params.set("includeTotal", query.includeTotal);
  // Direction travels with the cursor: an explicitly requested order is echoed
  // so desc traversals continue downward; omitted order keeps the asc default.
  if (query.order !== undefined) params.set("order", query.order);
  // Continuations always seek, even when the first request used an offset.
  params.set("cursor", String(nextCursor));
  return `<${list.path}?${params.toString()}>; rel="next"`;
}
