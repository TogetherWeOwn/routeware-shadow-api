type SnapshotListResource = "customer" | "address" | "container";

type SnapshotListQuery = {
  customerId?: number;
  pickupAddressId?: number;
  containerId?: number;
  q?: string;
  enabled: "true" | "false" | "any";
  fields?: string[];
  upperId?: number;
  limit: number;
  includeTotal: "true" | "false";
};

const LISTS = {
  customer: { path: "/api/v1/customer-snapshot", selectors: ["customerId"] },
  address: { path: "/api/v1/address-snapshot", selectors: ["customerId", "pickupAddressId"] },
  container: { path: "/api/v1/container-snapshot", selectors: ["customerId", "pickupAddressId", "containerId"] }
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
  if (query.q !== undefined) params.set("q", query.q);
  if (query.enabled !== "any") params.set("enabled", query.enabled);
  if (query.fields !== undefined) params.set("fields", query.fields.join(","));
  // Caller-held inclusive ceiling: the next target keeps the same cap so the
  // continuation cannot escape the traversal the caller chose to bound.
  if (query.upperId !== undefined) params.set("upperId", String(query.upperId));
  params.set("limit", String(query.limit));
  if (query.includeTotal === "false") params.set("includeTotal", "false");
  // Continuations always seek, even when the first request used an offset.
  params.set("cursor", String(nextCursor));
  return `<${list.path}?${params.toString()}>; rel="next"`;
}
