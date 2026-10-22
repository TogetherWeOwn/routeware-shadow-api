/**
 * Shared route-map validation library (roadmap R12-04).
 *
 * Pure: no I/O and no imports, so the same implementation runs in plain
 * `node` (route-map-validation.mjs, route-gap.mjs, export-curl-examples.mjs,
 * suggest-routes.mjs) and under workerd (test/discoveryMapContract.test.ts).
 *
 * A route map is an array of `{ method, upstreamPath, shadowPath }` entries
 * (extra keys such as `exampleFile` are ignored). Validation runs seven
 * checks in a fixed order; an entry that fails an early per-entry check is
 * excluded from the later ones, so one root cause yields one finding and a
 * rejected value never cascades into another check's output:
 *
 *   route-map.shape                ROUTE_MAP_NOT_ARRAY, ENTRY_FIELD_INVALID
 *   route-map.method               METHOD_UNSUPPORTED
 *   route-map.upstream-path        UPSTREAM_PATH_INVALID
 *   route-map.shadow-path          SHADOW_PATH_INVALID
 *   route-map.duplicate-upstream   DUPLICATE_UPSTREAM_IDENTITY
 *   route-map.conflicting-shadow   CONFLICTING_SHADOW_MAPPING
 *   route-map.mounted-operation    SHADOW_OPERATION_NOT_MOUNTED
 *
 * The `method` / `upstreamPath` / `shadowPath` fields of a finding echo a
 * value ONLY when that value passed validation; a rejected value (which may
 * carry a token) is never echoed anywhere in the result, including
 * `nextAction`. Finding ids are content-derived (`<CODE>-<hash12>`), unique
 * within a result, and independent of entry order.
 *
 * Upstream identity is `METHOD` + case-folded path (the upstream host is
 * case-insensitive); shadow identity is `METHOD` + exact path. A mounted
 * `{param}` segment resolves exactly one concrete segment.
 */

export const SCHEMA_VERSION = 1;

export const SUPPORTED_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const CHECK_IDS = Object.freeze([
  "route-map.shape",
  "route-map.method",
  "route-map.upstream-path",
  "route-map.shadow-path",
  "route-map.duplicate-upstream",
  "route-map.conflicting-shadow",
  "route-map.mounted-operation",
]);

/**
 * Closed finding vocabulary. The last three codes are emitted only by the
 * CLI (route-map-validation.mjs), never by `validateRouteMap` itself.
 */
export const FINDING_CODES = Object.freeze([
  "ROUTE_MAP_NOT_ARRAY",
  "ENTRY_FIELD_INVALID",
  "METHOD_UNSUPPORTED",
  "UPSTREAM_PATH_INVALID",
  "SHADOW_PATH_INVALID",
  "DUPLICATE_UPSTREAM_IDENTITY",
  "CONFLICTING_SHADOW_MAPPING",
  "SHADOW_OPERATION_NOT_MOUNTED",
  "ROUTE_MAP_UNREADABLE",
  "MOUNTED_OPERATIONS_UNAVAILABLE",
  "UNKNOWN_FLAG",
]);

const SHAPE_FIELDS = ["method", "upstreamPath", "shadowPath"];

// OpenAPI method keys (lowercase per spec); anything else at path level
// (`parameters`, `summary`, `servers`, ...) is not an operation.
const OPENAPI_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/**
 * cyrb53 content hash, pure JS (no node:crypto: this module also runs under
 * workerd). 12 hex chars of a 53-bit digest; findings additionally go
 * through a deterministic de-duplication pass, so ids are unique even if a
 * digest ever collided.
 */
function shortHash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const digest = (h2 >>> 0) * 4294967296 + (h1 >>> 0);
  return digest.toString(16).padStart(14, "0").slice(0, 12);
}

function shapeReason(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { canon: "shape:not-object", action: "Replace it with a { method, upstreamPath, shadowPath } object." };
  }
  for (const field of SHAPE_FIELDS) {
    const value = entry[field];
    if (typeof value !== "string" || value.length === 0) {
      return {
        canon: `shape:field:${field}`,
        action: `Set a non-empty string "${field}" on it.`,
      };
    }
  }
  return null;
}

/**
 * Absolute-path shape shared by upstream and shadow paths: leading `/`, no
 * query, fragment, whitespace, backslashes, empty segments (double or
 * trailing slashes) or dot segments (literal or percent-encoded).
 * Returns a reason string, or null when the shape is valid.
 */
function pathShapeReason(value) {
  if (!value.startsWith("/")) {
    return 'must be an absolute path starting with "/"';
  }
  if (/[\s\\]/.test(value)) {
    return "must not contain whitespace or backslashes";
  }
  if (value.includes("?") || value.includes("#")) {
    return "must not contain a query string or fragment";
  }
  if (value.includes("//")) {
    return "must not contain empty segments";
  }
  const segments = value.split("/");
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "") {
      return "must not end with a trailing slash";
    }
    if (segment === "." || segment === "..") {
      return "must not contain dot segments";
    }
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return "contains invalid percent-encoding";
    }
    const folded = decoded.toLowerCase();
    if (folded === "." || folded === "..") {
      return "must not contain dot segments";
    }
  }
  return null;
}

function upstreamIdentity(method, upstreamPath) {
  return `${method}\n${upstreamPath.toLowerCase()}`;
}

function shadowIdentity(method, shadowPath) {
  return `${method}\n${shadowPath}`;
}

function parseMountedOperation(text) {
  const space = text.indexOf(" ");
  if (space <= 0) {
    return { method: text, template: "" };
  }
  return { method: text.slice(0, space), template: text.slice(space + 1) };
}

function templateMatches(template, concretePath) {
  const wanted = template.split("/");
  const actual = concretePath.split("/");
  if (wanted.length !== actual.length) {
    return false;
  }
  return wanted.every((segment, i) => segment === actual[i] || /^\{[^/{}]+\}$/.test(segment));
}

function entryList(indexes) {
  return indexes.join(", ");
}

/**
 * Validate a route map. `options.mountedOperations` is an optional list of
 * `"METHOD /path"` strings (OpenAPI `{param}` segments match exactly one
 * concrete segment); without it the mounted-operation check reports
 * `skipped` instead of `pass`.
 *
 * `options.onlyChecks` is an optional subset of check ids to enforce. It
 * exists for consumers whose input domain is wider than the executable
 * contract: export-curl-examples.mjs renders non-executable documentation
 * for any method/path, so it enforces only the structural checks (shape,
 * duplicate-upstream, conflicting-shadow) and leaves method/path-shape to
 * the CLI. Skipped checks report `skipped` and pass their entries through
 * to the later checks, so a skipped rejection never hides an ambiguity.
 */
export function validateRouteMap(routeMap, options = {}) {
  const findings = [];
  const push = (finding) => {
    findings.push({ severity: "error", ...finding });
  };
  const onlyChecks = options?.onlyChecks;
  const run = (checkId) => !Array.isArray(onlyChecks) || onlyChecks.includes(checkId);

  if (!Array.isArray(routeMap)) {
    push({
      checkId: "route-map.shape",
      code: "ROUTE_MAP_NOT_ARRAY",
      entryIndexes: [],
      nextAction: "Replace the route map with a JSON array of { method, upstreamPath, shadowPath } entries.",
      canon: "map:not-array",
    });
    return buildResult(0, findings, options);
  }

  // Shape: group defective entries by reason so identical defects share one
  // finding with every affected index.
  const shapeOk = [];
  const shapeGroups = new Map();
  for (let i = 0; i < routeMap.length; i++) {
    const reason = shapeReason(routeMap[i]);
    if (reason === null) {
      shapeOk.push(i);
    } else {
      const group = shapeGroups.get(reason.canon) ?? { reason, indexes: [] };
      group.indexes.push(i);
      shapeGroups.set(reason.canon, group);
    }
  }
  const shapeFindings = run("route-map.shape") ? [...shapeGroups.values()] : [];
  for (const { reason, indexes } of shapeFindings) {
    push({
      checkId: "route-map.shape",
      code: "ENTRY_FIELD_INVALID",
      entryIndexes: [...indexes].sort((a, b) => a - b),
      nextAction: `Fix route-map ${indexes.length === 1 ? "entry" : "entries"} ${entryList([...indexes].sort((a, b) => a - b))}: ${reason.action}`,
      canon: reason.canon,
    });
  }

  // Method: only entries that passed shape; grouped by the rejected value.
  const methodOk = [];
  const methodGroups = new Map();
  for (const i of shapeOk) {
    const method = routeMap[i].method;
    if (!run("route-map.method") || SUPPORTED_METHODS.includes(method)) {
      methodOk.push(i);
    } else {
      const group = methodGroups.get(method) ?? { indexes: [] };
      group.indexes.push(i);
      methodGroups.set(method, group);
    }
  }
  for (const [method, { indexes }] of methodGroups) {
    const sorted = [...indexes].sort((a, b) => a - b);
    push({
      checkId: "route-map.method",
      code: "METHOD_UNSUPPORTED",
      entryIndexes: sorted,
      nextAction: `Set "method" to one of GET, POST, PUT, PATCH, DELETE (uppercase, no padding) on route-map ${sorted.length === 1 ? "entry" : "entries"} ${entryList(sorted)}.`,
      canon: `method:${method}`,
    });
  }

  // Paths: an entry drops out at its first failing per-entry check, so a
  // rejected path never echoes into a later finding.
  const upstreamOk = [];
  const upstreamGroups = new Map();
  for (const i of methodOk) {
    const upstreamPath = routeMap[i].upstreamPath;
    if (!run("route-map.upstream-path") || pathShapeReason(upstreamPath) === null) {
      upstreamOk.push(i);
    } else {
      const group = upstreamGroups.get(upstreamPath) ?? { indexes: [] };
      group.indexes.push(i);
      upstreamGroups.set(upstreamPath, group);
    }
  }
  for (const [upstreamPath, { indexes }] of upstreamGroups) {
    const sorted = [...indexes].sort((a, b) => a - b);
    push({
      checkId: "route-map.upstream-path",
      code: "UPSTREAM_PATH_INVALID",
      entryIndexes: sorted,
      method: routeMap[sorted[0]].method,
      nextAction: `Set "upstreamPath" to an absolute path (leading "/", no query, fragment, whitespace, dot segments or trailing slash) on route-map ${sorted.length === 1 ? "entry" : "entries"} ${entryList(sorted)}.`,
      canon: `upstream-path:${upstreamPath}`,
    });
  }

  const shadowOk = [];
  const shadowGroups = new Map();
  for (const i of upstreamOk) {
    const shadowPath = routeMap[i].shadowPath;
    if (!run("route-map.shadow-path") || pathShapeReason(shadowPath) === null) {
      shadowOk.push(i);
    } else {
      const group = shadowGroups.get(shadowPath) ?? { indexes: [] };
      group.indexes.push(i);
      shadowGroups.set(shadowPath, group);
    }
  }
  for (const [shadowPath, { indexes }] of shadowGroups) {
    const sorted = [...indexes].sort((a, b) => a - b);
    push({
      checkId: "route-map.shadow-path",
      code: "SHADOW_PATH_INVALID",
      entryIndexes: sorted,
      method: routeMap[sorted[0]].method,
      nextAction: `Set "shadowPath" to an absolute path (leading "/", no query, fragment, whitespace, dot segments or trailing slash) on route-map ${sorted.length === 1 ? "entry" : "entries"} ${entryList(sorted)}.`,
      canon: `shadow-path:${shadowPath}`,
    });
  }

  // Duplicate upstream identities (case-folded): one finding per group.
  const upstreamGroups2 = new Map();
  for (const i of shadowOk) {
    const key = upstreamIdentity(routeMap[i].method, routeMap[i].upstreamPath);
    const group = upstreamGroups2.get(key) ?? { indexes: [] };
    group.indexes.push(i);
    upstreamGroups2.set(key, group);
  }
  for (const [key, { indexes }] of run("route-map.duplicate-upstream") ? upstreamGroups2 : []) {
    if (indexes.length < 2) {
      continue;
    }
    const sorted = [...indexes].sort((a, b) => a - b);
    const first = routeMap[sorted[0]];
    push({
      checkId: "route-map.duplicate-upstream",
      code: "DUPLICATE_UPSTREAM_IDENTITY",
      entryIndexes: sorted,
      method: first.method,
      upstreamPath: first.upstreamPath,
      nextAction: `Merge route-map entries ${entryList(sorted)} into a single mapping for the duplicated upstream operation, or delete the stale one.`,
      canon: `duplicate-upstream:${key}`,
    });
  }

  // Conflicting shadow mappings: one shadow method+path claimed by two or
  // more DISTINCT upstream operations. Exact duplicate entries share one
  // upstream identity, so they are duplicates, not conflicts.
  const shadowGroups2 = new Map();
  for (const i of shadowOk) {
    const key = shadowIdentity(routeMap[i].method, routeMap[i].shadowPath);
    const group = shadowGroups2.get(key) ?? { indexes: [] };
    group.indexes.push(i);
    shadowGroups2.set(key, group);
  }
  for (const [key, { indexes }] of run("route-map.conflicting-shadow") ? shadowGroups2 : []) {
    if (indexes.length < 2) {
      continue;
    }
    const distinctUpstreams = new Set(
      indexes.map((i) => upstreamIdentity(routeMap[i].method, routeMap[i].upstreamPath))
    );
    if (distinctUpstreams.size < 2) {
      continue;
    }
    const sorted = [...indexes].sort((a, b) => a - b);
    const first = routeMap[sorted[0]];
    push({
      checkId: "route-map.conflicting-shadow",
      code: "CONFLICTING_SHADOW_MAPPING",
      entryIndexes: sorted,
      method: first.method,
      shadowPath: first.shadowPath,
      nextAction: `Give route-map entries ${entryList(sorted)} distinct shadow method+path targets, or merge them into one mapping.`,
      canon: `conflicting-shadow:${key}`,
    });
  }

  // Mounted operations: every surviving shadow method+path must resolve.
  const mountedOperations = options?.mountedOperations;
  if (run("route-map.mounted-operation") && Array.isArray(mountedOperations)) {
    const matchers = mountedOperations
      .filter((text) => typeof text === "string")
      .map(parseMountedOperation);
    const unmounted = new Map();
    for (const i of shadowOk) {
      const { method, shadowPath } = routeMap[i];
      const mounted = matchers.some(
        (m) => m.method === method && templateMatches(m.template, shadowPath)
      );
      if (!mounted) {
        const key = shadowIdentity(method, shadowPath);
        const group = unmounted.get(key) ?? { indexes: [] };
        group.indexes.push(i);
        unmounted.set(key, group);
      }
    }
    for (const [key, { indexes }] of unmounted) {
      const sorted = [...indexes].sort((a, b) => a - b);
      const first = routeMap[sorted[0]];
      push({
        checkId: "route-map.mounted-operation",
        code: "SHADOW_OPERATION_NOT_MOUNTED",
        entryIndexes: sorted,
        method: first.method,
        shadowPath: first.shadowPath,
        nextAction: `Mount the shadow operation in src/ via createRoute so /openapi.json documents it, or remove route-map entries ${entryList(sorted)}.`,
        canon: `unmounted:${key}`,
      });
    }
  }

  return buildResult(routeMap.length, findings, options);
}

function buildResult(entries, findings, options) {
  const order = new Map(CHECK_IDS.map((id, index) => [id, index]));
  const minIndex = (finding) => (finding.entryIndexes.length === 0 ? Number.MAX_SAFE_INTEGER : finding.entryIndexes[0]);
  findings.sort(
    (a, b) =>
      order.get(a.checkId) - order.get(b.checkId) ||
      minIndex(a) - minIndex(b) ||
      (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0)
  );
  for (const finding of findings) {
    finding.id = `${finding.code}-${shortHash(finding.canon)}`;
  }
  // Defensive uniqueness: content-derived ids collide only if the digest
  // does. Suffix in id-sorted order so the assignment is itself
  // order-independent.
  const seen = new Map();
  for (const finding of [...findings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const count = seen.get(finding.id) ?? 0;
    seen.set(finding.id, count + 1);
    if (count > 0) {
      finding.id = `${finding.id}-${count + 1}`;
    }
  }

  const failed = new Set(findings.map((finding) => finding.checkId));
  const mountedSupplied = Array.isArray(options?.mountedOperations);
  const only = options?.onlyChecks;
  const ran = (id) => !Array.isArray(only) || only.includes(id);
  const checks = CHECK_IDS.map((id) => ({
    id,
    status:
      id === "route-map.mounted-operation" && !mountedSupplied
        ? "skipped"
        : !ran(id)
          ? "skipped"
          : failed.has(id)
            ? "fail"
            : "pass",
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    ok: findings.length === 0,
    checks,
    findings: findings.map(({ id, checkId, code, severity, entryIndexes, method, upstreamPath, shadowPath, nextAction }) => {
      const finding = { id, checkId, code, severity, entryIndexes };
      if (method !== undefined) {
        finding.method = method;
      }
      if (upstreamPath !== undefined) {
        finding.upstreamPath = upstreamPath;
      }
      if (shadowPath !== undefined) {
        finding.shadowPath = shadowPath;
      }
      finding.nextAction = nextAction;
      return finding;
    }),
    summary: { entries, errors: findings.length },
  };
}

/**
 * Turn an OpenAPI document into the sorted unique `"METHOD /path"` list
 * `validateRouteMap` consumes. Path-level non-operation keys are ignored.
 */
export function mountedOperationsFromOpenApi(doc) {
  const paths = doc && typeof doc === "object" && !Array.isArray(doc) ? doc.paths : undefined;
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    return [];
  }
  const operations = new Set();
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    for (const [key, operation] of Object.entries(item)) {
      if (!OPENAPI_METHODS.has(key.toLowerCase())) {
        continue;
      }
      if (!operation || typeof operation !== "object") {
        continue;
      }
      operations.add(`${key.toUpperCase()} ${path}`);
    }
  }
  return [...operations].sort();
}
