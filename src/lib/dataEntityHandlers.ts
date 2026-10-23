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
  var: { bodyBuffer: ArrayBuffer | null; sessionStub: DurableObjectStub };
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

/**
 * Parsed per-type selections for one hydrated read: flat-root columns plus the
 * `fields[TYPE]` columns per type. The route rejects flat + typed-root
 * together, so at most one root selector is set; omitted types stay full.
 */
export type BundleFieldSelection = {
  flatRoot?: string[];
  typed?: Partial<Record<SnapshotFieldsetResource, string[]>>;
};

type BundleRow = Record<string, unknown>;

function hasBundleSelection(selection?: BundleFieldSelection): boolean {
  if (!selection) return false;
  if (selection.flatRoot !== undefined) return true;
  const typed = selection.typed;
  return typed !== undefined &&
    (typed.customer !== undefined || typed.address !== undefined || typed.container !== undefined);
}

/**
 * Effective per-type columns for a route serving `root`: the flat selector
 * projects the root, each typed selector projects its type everywhere.
 */
function effectiveBundleColumns(
  root: SnapshotFieldsetResource,
  selection: BundleFieldSelection
): Partial<Record<SnapshotFieldsetResource, string[]>> {
  const typed = selection.typed ?? {};
  return { ...typed, [root]: selection.flatRoot ?? typed[root] };
}

function projectCustomerBundle(
  bundle: BundleRow,
  columns: Partial<Record<SnapshotFieldsetResource, string[]>>
): BundleRow {
  const out: BundleRow = { ...bundle };
  if (columns.customer !== undefined) {
    out.customer = projectSnapshotRow("customer", bundle.customer as BundleRow, columns.customer);
  }
  if (columns.address !== undefined || columns.container !== undefined) {
    out.addresses = (bundle.addresses as Array<BundleRow & { containers: BundleRow[] }>).map((entry) => {
      const { containers, ...rest } = entry;
      const projected = columns.address !== undefined
        ? projectSnapshotRow("address", rest, columns.address)
        : rest;
      const projectedContainers = columns.container !== undefined
        ? (containers ?? []).map((con) => projectSnapshotRow("container", con, columns.container as string[]))
        : containers;
      // The `containers` key keeps its trailing position so an all-columns
      // selection stays byte-identical to the full representation.
      return { ...projected, containers: projectedContainers };
    });
  }
  return out;
}

function projectAddressBundle(
  bundle: BundleRow,
  columns: Partial<Record<SnapshotFieldsetResource, string[]>>
): BundleRow {
  const out: BundleRow = { ...bundle };
  if (columns.address !== undefined) {
    out.address = projectSnapshotRow("address", bundle.address as BundleRow, columns.address);
  }
  if (columns.customer !== undefined && bundle.customer !== null) {
    out.customer = projectSnapshotRow("customer", bundle.customer as BundleRow, columns.customer);
  }
  if (columns.container !== undefined) {
    out.containers = (bundle.containers as BundleRow[]).map((con) =>
      projectSnapshotRow("container", con, columns.container as string[]));
  }
  return out;
}

function projectContainerBundle(
  bundle: BundleRow,
  columns: Partial<Record<SnapshotFieldsetResource, string[]>>
): BundleRow {
  const out: BundleRow = { ...bundle };
  if (columns.container !== undefined) {
    out.container = projectSnapshotRow("container", bundle.container as BundleRow, columns.container);
  }
  if (columns.address !== undefined && bundle.address !== null) {
    out.address = projectSnapshotRow("address", bundle.address as BundleRow, columns.address);
  }
  if (columns.customer !== undefined && bundle.customer !== null) {
    out.customer = projectSnapshotRow("customer", bundle.customer as BundleRow, columns.customer);
  }
  return out;
}

/** Derive a representation without storing selected bodies or validating against full-only ETags. */
async function projectedDataEntityResponse(
  c: DataEntityCtx,
  project: (bundle: BundleRow) => unknown,
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
  const bundle = await full.json() as BundleRow;
  const body = bundleJsonString(project(bundle));
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
  columns?: string[],
  typed?: Partial<Record<SnapshotFieldsetResource, string[]>>
): Promise<Response> {
  const selection: BundleFieldSelection = { flatRoot: columns, typed };
  if (hasBundleSelection(selection)) {
    const effective = effectiveBundleColumns("customer", selection);
    return projectedDataEntityResponse(c,
      (bundle) => projectCustomerBundle(bundle, effective),
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
  columns?: string[],
  typed?: Partial<Record<SnapshotFieldsetResource, string[]>>
): Promise<Response> {
  const selection: BundleFieldSelection = { flatRoot: columns, typed };
  if (hasBundleSelection(selection)) {
    const effective = effectiveBundleColumns("address", selection);
    return projectedDataEntityResponse(c,
      (bundle) => projectAddressBundle(bundle, effective),
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
  columns?: string[],
  typed?: Partial<Record<SnapshotFieldsetResource, string[]>>
): Promise<Response> {
  const selection: BundleFieldSelection = { flatRoot: columns, typed };
  if (hasBundleSelection(selection)) {
    const effective = effectiveBundleColumns("container", selection);
    return projectedDataEntityResponse(c,
      (bundle) => projectContainerBundle(bundle, effective),
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

