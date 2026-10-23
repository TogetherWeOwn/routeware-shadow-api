import {
  getAddressBundleFromD1,
  getContainerBundleFromD1,
  getCustomerBundleFromD1,
  bundleJsonString
} from "./dataEntityRead";
import {
  entityDataCacheControlValue,
  getCachedDataEntity,
  putCachedDataEntity,
  sha256Etag
} from "./entityDataCache";
import { problemJsonResponse, problemType } from "./problem";
import { projectSnapshotRow, type SnapshotFieldsetResource } from "./sparseFieldsets";

export type DataEntityCtx = {
  env: Env;
  // `requestId` flows from `c.var` when the route passes the full request var;
  // optional so direct/pre-middleware callers omit save-path correlation
  // instead of crashing.
  var: {
    bodyBuffer: ArrayBuffer | null;
    sessionStub: DurableObjectStub;
    requestId?: string;
  };
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

/** Derive a representation without storing selected bodies or validating against full-only ETags. */
async function projectedDataEntityResponse(
  c: DataEntityCtx,
  resource: SnapshotFieldsetResource,
  columns: string[],
  getFull: (fullContext: DataEntityCtx) => Promise<Response>
): Promise<Response> {
  // Reuse the canonical read/cache path, but never let its full validator return
  // a 304 before we have the bytes of this selected representation.
  const full = await getFull({
    ...c,
    req: {
      raw: c.req.raw,
      header: (name) => name.toLowerCase() === "if-none-match" ? undefined : c.req.header(name)
    }
  });
  if (full.status !== 200) return full;
  const bundle = await full.json() as Record<string, unknown>;
  const body = bundleJsonString({
    ...bundle,
    [resource]: projectSnapshotRow(resource, bundle[resource] as Record<string, unknown>, columns)
  });
  const etag = await sha256Etag(body);
  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etagHeader(etag), "Cache-Control": entityDataCacheControlValue() }
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ETag: etagHeader(etag),
      "Cache-Control": entityDataCacheControlValue(),
      "X-Entity-ETag": etag
    }
  });
}

export async function handleGetDataCustomer(
  c: DataEntityCtx,
  customerId: number,
  columns?: string[]
): Promise<Response> {
  if (columns !== undefined) {
    return projectedDataEntityResponse(c, "customer", columns,
      (fullContext) => handleGetDataCustomer(fullContext, customerId));
  }
  const ifNone = c.req.header("if-none-match");
  const cached = await getCachedDataEntity("customer", customerId);
  if (cached) {
    const ce = cached.headers.get("X-Entity-ETag");
    if (ifNone && ce && matchesIfNoneMatch(ifNone, ce)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etagHeader(ce), "Cache-Control": entityDataCacheControlValue() }
      });
    }
    if (!ifNone) {
      return cached;
    }
  }
  const bundle = await getCustomerBundleFromD1(c.env.CUSTOMER_DB, customerId);
  if (!bundle) {
    return problemJsonResponse({
      type: problemType("not-found", c.env),
      title: "Not Found",
      status: 404,
      detail: `No snapshot data for customer_id=${customerId} (import/sync first). See docs/PROBLEMS.md#not-found.`,
      instance: `${new URL(c.req.raw.url).pathname}?id=${customerId}`
    });
  }
  const body = bundleJsonString(bundle);
  const etag = await sha256Etag(body);
  if (matchesIfNoneMatch(ifNone, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etagHeader(etag), "Cache-Control": entityDataCacheControlValue() }
    });
  }
  const res = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ETag: etagHeader(etag),
      "Cache-Control": entityDataCacheControlValue(),
      "X-Entity-ETag": etag
    }
  });
  await putCachedDataEntity("customer", customerId, res);
  return res;
}

export async function handleGetDataAddress(
  c: DataEntityCtx,
  pickupAddressId: number,
  columns?: string[]
): Promise<Response> {
  if (columns !== undefined) {
    return projectedDataEntityResponse(c, "address", columns,
      (fullContext) => handleGetDataAddress(fullContext, pickupAddressId));
  }
  const ifNone = c.req.header("if-none-match");
  const cached = await getCachedDataEntity("address", pickupAddressId);
  if (cached) {
    const ce = cached.headers.get("X-Entity-ETag");
    if (ifNone && ce && matchesIfNoneMatch(ifNone, ce)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etagHeader(ce), "Cache-Control": entityDataCacheControlValue() }
      });
    }
    if (!ifNone) {
      return cached;
    }
  }
  const bundle = await getAddressBundleFromD1(c.env.CUSTOMER_DB, pickupAddressId);
  if (!bundle || !bundle.address) {
    return problemJsonResponse({
      type: problemType("not-found", c.env),
      title: "Not Found",
      status: 404,
      detail: `No snapshot for pickup_address_id=${pickupAddressId}. See docs/PROBLEMS.md#not-found.`,
      instance: `${new URL(c.req.raw.url).pathname}?id=${pickupAddressId}`
    });
  }
  const body = bundleJsonString(bundle);
  const etag = await sha256Etag(body);
  if (matchesIfNoneMatch(ifNone, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etagHeader(etag), "Cache-Control": entityDataCacheControlValue() }
    });
  }
  const res = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ETag: etagHeader(etag),
      "Cache-Control": entityDataCacheControlValue(),
      "X-Entity-ETag": etag
    }
  });
  await putCachedDataEntity("address", pickupAddressId, res);
  return res;
}

export async function handleGetDataContainer(
  c: DataEntityCtx,
  containerId: number,
  columns?: string[]
): Promise<Response> {
  if (columns !== undefined) {
    return projectedDataEntityResponse(c, "container", columns,
      (fullContext) => handleGetDataContainer(fullContext, containerId));
  }
  const ifNone = c.req.header("if-none-match");
  const cached = await getCachedDataEntity("container", containerId);
  if (cached) {
    const ce = cached.headers.get("X-Entity-ETag");
    if (ifNone && ce && matchesIfNoneMatch(ifNone, ce)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etagHeader(ce), "Cache-Control": entityDataCacheControlValue() }
      });
    }
    if (!ifNone) {
      return cached;
    }
  }
  const bundle = await getContainerBundleFromD1(c.env.CUSTOMER_DB, containerId);
  if (!bundle || !bundle.container) {
    return problemJsonResponse({
      type: problemType("not-found", c.env),
      title: "Not Found",
      status: 404,
      detail: `No snapshot for container_id=${containerId}. See docs/PROBLEMS.md#not-found.`,
      instance: `${new URL(c.req.raw.url).pathname}?id=${containerId}`
    });
  }
  const body = bundleJsonString(bundle);
  const etag = await sha256Etag(body);
  if (matchesIfNoneMatch(ifNone, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etagHeader(etag), "Cache-Control": entityDataCacheControlValue() }
    });
  }
  const res = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ETag: etagHeader(etag),
      "Cache-Control": entityDataCacheControlValue(),
      "X-Entity-ETag": etag
    }
  });
  await putCachedDataEntity("container", containerId, res);
  return res;
}

// POST save handlers live in `./dataEntitySave`; re-exported here
// so existing imports keep working. New code should import from
// `./dataEntitySave` directly.
export {
  handlePostDataAddress,
  handlePostDataContainer,
  handlePostDataCustomer
} from "./dataEntitySave";
export type { LocalSyncCode, LocalSyncSummary } from "./dataEntitySave";

