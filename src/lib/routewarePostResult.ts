export function urlEncodedToObject(buf: ArrayBuffer | null): Record<string, string> {
  if (!buf || buf.byteLength === 0) {
    return {};
  }
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const o: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    o[k] = v;
  }
  return o;
}

/** Heuristic: HTTP 2xx and not an explicit `success: false` JSON. */
export function routewarePostLooksSuccessful(status: number, bodyText: string): boolean {
  if (status < 200 || status >= 300) {
    return false;
  }
  const t = bodyText.trim();
  if (!t) {
    return true;
  }
  if (t.startsWith("<!") || t.toLowerCase().includes("<html")) {
    return false;
  }
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    if (j.success === false || (j as { Success?: boolean }).Success === false) {
      return false;
    }
    if (j.error && typeof j.error === "string") {
      return false;
    }
  } catch {
    // plain text success message
  }
  return true;
}

/**
 * Resolves the Routeware customer id after save (update uses posted id; create may only appear in JSON).
 */
export function parseCustomerIdFromSaveResponse(
  posted: Record<string, string>,
  upstreamText: string
): number | null {
  const fromPost = Number.parseInt(posted.CustomerID ?? posted.customerID ?? "0", 10);
  if (Number.isFinite(fromPost) && fromPost > 0) {
    return fromPost;
  }
  try {
    const j = JSON.parse(upstreamText) as Record<string, unknown>;
    const data = (typeof j.data === "object" && j.data !== null
      ? j.data
      : j) as Record<string, unknown>;
    const id = Number(
      data.CustomerID ?? data.customerID ?? j.CustomerID ?? j.customerId ?? 0
    );
    if (Number.isFinite(id) && id > 0) {
      return id;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Resolves the Routeware address id after save (update uses posted id; create may only appear in JSON).
 *
 * Address analogue of `parseCustomerIdFromSaveResponse`: the upstream field is
 * `data.PickupAddressID` (positive numbers only). When upstream carries no id,
 * callers fall back to the post-refresh D1 diff instead of probing further.
 */
export function parseAddressIdFromSaveResponse(
  posted: Record<string, string>,
  upstreamText: string
): number | null {
  const fromPost = Number.parseInt(posted.PickupAddressID ?? posted.pickupAddressID ?? "0", 10);
  if (Number.isFinite(fromPost) && fromPost > 0) {
    return fromPost;
  }
  try {
    const j = JSON.parse(upstreamText) as Record<string, unknown>;
    const data = (typeof j.data === "object" && j.data !== null
      ? j.data
      : j) as Record<string, unknown>;
    const id = Number(
      data.PickupAddressID ?? data.pickupAddressID ?? j.PickupAddressID ?? j.pickupAddressId ?? 0
    );
    if (Number.isFinite(id) && id > 0) {
      return id;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Resolves the Routeware container id after save (update uses posted id; create may only appear in JSON).
 *
 * Container analogue of `parseCustomerIdFromSaveResponse`: the upstream field
 * is `data.ContainerID` (positive numbers only). When upstream carries no id,
 * callers fall back to the post-refresh D1 diff instead of probing further.
 */
export function parseContainerIdFromSaveResponse(
  posted: Record<string, string>,
  upstreamText: string
): number | null {
  const fromPost = Number.parseInt(posted.ContainerID ?? posted.containerID ?? "0", 10);
  if (Number.isFinite(fromPost) && fromPost > 0) {
    return fromPost;
  }
  try {
    const j = JSON.parse(upstreamText) as Record<string, unknown>;
    const data = (typeof j.data === "object" && j.data !== null
      ? j.data
      : j) as Record<string, unknown>;
    const id = Number(
      data.ContainerID ?? data.containerID ?? j.ContainerID ?? j.containerId ?? 0
    );
    if (Number.isFinite(id) && id > 0) {
      return id;
    }
  } catch {
    // ignore
  }
  return null;
}
