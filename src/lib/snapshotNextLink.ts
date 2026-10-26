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
  // Container list only; sibling lists omit these keys and keep unfiltered links.
  hasSerialNumber?: "true" | "false" | "any";
  hasRfid?: "true" | "false" | "any";
  materialStream?: string;
  color?: string;
  routeId?: number;
  franchiseId?: string;
  parentRouteId?: number;
  parentFranchiseId?: string;
  parentEnabled?: "true" | "false" | "any";
  zip?: string;
  locationAddress?: string;
  city?: string;
  state?: string;
  driverNote?: string;
  q?: string;
  phone?: string;
  comments?: string;
  enabled: "true" | "false" | "any";
  // Address list only; sibling lists omit the key and keep unfiltered links.
  extrasAllowed?: "true" | "false" | "any";
  hasContainers?: "true" | "false" | "any";
  hasAddresses?: "true" | "false" | "any";
  fields?: string[];
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
  customer: { path: "/api/v1/customer-snapshot", selectors: ["customerId", "customerNumber", "subCustomerNumber", "phone", "comments"] },
  address: { path: "/api/v1/address-snapshot", selectors: ["customerId", "pickupAddressId", "routeId", "franchiseId", "zip", "city", "state", "driverNote"] },
  container: { path: "/api/v1/container-snapshot", selectors: ["customerId", "pickupAddressId", "containerId", "containerTypeId", "parentRouteId", "parentFranchiseId", "serialNumber", "rfid", "materialStream", "color", "zip", "locationAddress", "state"] }
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
  // Non-any only, like enabled: any/omission stays out of the canonical target.
  if (query.extrasAllowed !== undefined && query.extrasAllowed !== "any") {
    params.set("extrasAllowed", query.extrasAllowed);
  }
  // Address-only presence selector (other lists never set it): carry only
  // filtering values so any/omitted continuations stay byte-identical.
  if (query.hasContainers !== undefined && query.hasContainers !== "any") {
    params.set("hasContainers", query.hasContainers);
  }
  if (resource === "customer" && query.hasAddresses !== undefined && query.hasAddresses !== "any") {
    params.set("hasAddresses", query.hasAddresses);
  }
  if (resource === "container" && query.parentEnabled !== undefined && query.parentEnabled !== "any") {
    params.set("parentEnabled", query.parentEnabled);
  }
  // Container-only stored-text presence selectors: carry only filtering
  // values so any/omitted continuations stay byte-identical.
  if (resource === "container" && query.hasSerialNumber !== undefined && query.hasSerialNumber !== "any") {
    params.set("hasSerialNumber", query.hasSerialNumber);
  }
  if (resource === "container" && query.hasRfid !== undefined && query.hasRfid !== "any") {
    params.set("hasRfid", query.hasRfid);
  }
  if (query.fields !== undefined) params.set("fields", query.fields.join(","));
  // Caller-held inclusive ceiling: the next target keeps the same cap so the
  // continuation cannot escape the traversal the caller chose to bound.
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
