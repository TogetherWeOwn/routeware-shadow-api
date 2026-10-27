import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import app from "../src/app";

/**
 * Characterization tests for the app's public surface.
 *
 * These exist to make the `app.ts` -> `routes/*` split provably behavior
 * preserving. They assert the *contract*, not any implementation detail, so
 * they stay meaningful long after that refactor:
 *
 *  - the generated OpenAPI document (full snapshot),
 *  - the exact set of published operations (hand-written, so it cannot be
 *    silently re-recorded with `vitest -u` the way a snapshot can),
 *  - the router's registered surface, and
 *  - the invariant that both `/api/v1/*` middlewares are registered *before*
 *    every route, which is what makes the auth gate unskippable.
 *
 * `@hono/zod-openapi` merges a sub-app's `openAPIRegistry` into the parent in
 * `OpenAPIHono.route()`, but only when the sub-app is `instanceof OpenAPIHono`.
 * Mounting a plain `Hono` still serves traffic while silently dropping every
 * route from the published document — a failure no other test in this suite
 * would catch. That is the specific regression these tests exist to fail on.
 */

type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  tags?: Array<{ name: string; description?: string }>;
  security?: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

type RegisteredRoute = { method: string; path: string };

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/** Every operation the Worker publishes, as `METHOD path`. */
const EXPECTED_OPERATIONS = [
  "DELETE /api/v1/customer-snapshot/{customerId}",
  "DELETE /api/v1/routeware/customer",
  "GET /api/v1/address-snapshot",
  "GET /api/v1/address-snapshot/export",
  "GET /api/v1/address-snapshot/{pickupAddressId}",
  "GET /api/v1/container-snapshot",
  "GET /api/v1/container-snapshot/export",
  "GET /api/v1/container-snapshot/{containerId}",
  "GET /api/v1/customer-snapshot",
  "GET /api/v1/customer-snapshot/changes",
  "GET /api/v1/customer-snapshot/export",
  "GET /api/v1/customer-snapshot/{customerId}",
  "GET /api/v1/data-snapshot/orphans",
  "GET /api/v1/data/address",
  "GET /api/v1/data/container",
  "GET /api/v1/data/customer",
  "GET /api/v1/health",
  "GET /api/v1/readiness",
  "GET /api/v1/routeware/account/login-page",
  "GET /api/v1/routeware/customer/add-new-long",
  "GET /api/v1/routeware/customer/load-long-modal",
  "GET /api/v1/routeware/home/index",
  "GET /api/v1/routeware/reports/query-request-is-complete",
  "GET /api/v1/shadow/health",
  "GET /api/v1/snapshots/{table}",
  "GET /api/v1/snapshots/{table}/latest",
  "GET /api/v1/snapshots/{table}/{date}",
  "POST /api/v1/address-snapshot/import",
  "POST /api/v1/address-snapshot/sync",
  "POST /api/v1/container-snapshot/import",
  "POST /api/v1/container-snapshot/sync",
  "POST /api/v1/customer-snapshot/import",
  "POST /api/v1/customer-snapshot/sync",
  "POST /api/v1/data-snapshot/sync",
  "POST /api/v1/data/address",
  "POST /api/v1/data/container",
  "POST /api/v1/data/customer",
  "POST /api/v1/routeware/address/save-address-form",
  "POST /api/v1/routeware/container/save-container-form",
  "POST /api/v1/routeware/customer/customer-types-read",
  "POST /api/v1/routeware/customer/customers-read",
  "POST /api/v1/routeware/customer/detail-full",
  "POST /api/v1/routeware/customer/save-long-form",
  "POST /api/v1/routeware/data/app-settings-get"
];

/** Declared tag order in the document, which drives Scalar's sidebar order. */
const EXPECTED_TAGS = [
  "meta",
  "shadow",
  "routeware",
  "customer",
  "address",
  "container",
  "data",
  "reports",
  "customer-snapshot",
  "address-snapshot",
  "container-snapshot",
  "data-snapshot",
  "data-entity"
];

/**
 * Projection without agent metadata pinned in `openapiAgentMetadata.test.ts`
 * and fieldset catalogs/modes owned by the flat and hydrated discovery oracles.
 * Only those extensions on supported selectors move; schema/prose/defaults and
 * unrelated parameter extensions stay frozen.
 */
function withoutAgentMetadata(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc) as unknown as Record<string, unknown> & OpenApiDocument;
  for (const key of Object.keys(copy)) {
    if (key.startsWith("x-")) delete copy[key];
  }
  for (const [path, item] of Object.entries(copy.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method.toLowerCase())) continue;
      const op = operation as Record<string, unknown>;
      delete op["operationId"];
      for (const key of Object.keys(op)) {
        if (key.startsWith("x-")) delete op[key];
      }
      if (Array.isArray(op["security"]) && op["security"].length === 0) delete op["security"];
      if (Array.isArray(op.parameters)) {
        for (const param of op.parameters as Array<Record<string, unknown>>) {
          const hydratedGet = method.toLowerCase() === "get" &&
            ["/api/v1/data/customer", "/api/v1/data/address", "/api/v1/data/container"].includes(path);
          const typed = hydratedGet && ["fields[customer]", "fields[address]", "fields[container]"].includes(String(param.name));
          if (param.in !== "query" || (param.name !== "fields" && !typed)) continue;
          const schema = param.schema as Record<string, unknown> | undefined;
          delete param["x-snapshot-fieldset"];
          if (schema) delete schema["x-snapshot-fieldset"];
          if (hydratedGet) {
            delete param["x-snapshot-fieldset-mode"];
            if (schema) delete schema["x-snapshot-fieldset-mode"];
          }
        }
      }
    }
  }
  const bearer = copy.components?.securitySchemes?.["bearerAuth"] as
    | Record<string, unknown>
    | undefined;
  if (bearer) delete bearer["description"];
  return copy;
}

async function fetchOpenApiDocument(): Promise<OpenApiDocument> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiDocument;
}

/**
 * Copy of the document with the free-text `description`/`example` of the
 * `includeTotal` query parameter and of each `*SnapshotList.total` removed.
 * Conditional list declarations are owned by the behavioral/structured oracle
 * in snapshotListConditional.acceptance.test.ts, not this pre-feature snapshot.
 * Only its three new header params, 200 ETags and bodyless 304 declarations are
 * projected out. The optional lowerId/upperId queries on these same three lists
 * are pinned independently by snapshotLowerId.acceptance.test.ts and
 * snapshotUpperId.acceptance.test.ts. The changes operation/400
 * descriptions are asserted semantically in customerChangesFields.acceptance.test.ts,
 * so only those two strings are excluded here. Its fields schema and all
 * cursor/limit/response structure stay snapshot-frozen, as does every unrelated
 * parameter, response, header, schema and operation. countOnly's three query
 * declarations and new mode examples are owned by snapshotCountOnly.acceptance;
 * named examples normalize back to the SAME old nonempty counted example.
 */
function withoutDedicatedListMetadata(doc: OpenApiDocument): unknown {
  const copy = structuredClone(doc) as {
    paths?: Record<string, Record<string, {
      description?: string;
      parameters?: Array<Record<string, unknown>>;
      responses?: Record<string, {
        description?: string;
        headers?: Record<string, unknown>;
        content?: Record<string, {
          example?: unknown;
          examples?: Record<string, { value?: { rows?: unknown[]; total?: number | null } }>;
        }>;
      }>;
    }>>;
    components?: { schemas?: Record<string, { properties?: Record<string, Record<string, unknown>> }> };
  };
  for (const item of Object.values(copy.paths ?? {})) {
    for (const operation of Object.values(item)) {
      for (const param of operation.parameters ?? []) {
        if (param.name !== "includeTotal") continue;
        delete param.description;
        delete param.example;
        const schema = param.schema as Record<string, unknown> | undefined;
        if (schema) {
          delete schema.description;
          delete schema.example;
        }
      }
    }
  }
  for (const envelope of ["CustomerSnapshotList", "AddressSnapshotList", "ContainerSnapshotList"]) {
    const total = copy.components?.schemas?.[envelope]?.properties?.total;
    if (total) delete total.description;
  }
  const changes = copy.paths?.["/api/v1/customer-snapshot/changes"]?.get;
  if (changes) {
    delete changes.description;
    const badRequest = changes.responses?.["400"];
    if (badRequest) delete badRequest.description;
  }
  for (const path of [
    "/api/v1/customer-snapshot",
    "/api/v1/address-snapshot",
    "/api/v1/container-snapshot"
  ]) {
    const operation = copy.paths?.[path]?.get;
    if (!operation) continue;
    if (operation.parameters) {
      operation.parameters = operation.parameters.filter((param) =>
        !(param.in === "header" && String(param.name).toLowerCase() === "if-none-match") &&
        !(param.in === "query" && ["lowerId", "upperId", "countOnly"].includes(String(param.name)))
      );
    }
    if (operation.responses) delete operation.responses["304"];
    const media = operation.responses?.["200"]?.content?.["application/json"];
    if (media?.examples) {
      const countedPages = Object.values(media.examples).map((entry) => entry.value)
        .filter((value) => value && (value.rows?.length ?? 0) > 0 && typeof value.total === "number");
      expect(countedPages, `${path}: preserve one legacy counted full-page example`).toHaveLength(1);
      media.example = countedPages[0];
      delete media.examples;
    }
    const headers = operation.responses?.["200"]?.headers;
    if (headers) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "etag") delete headers[name];
      }
      if (Object.keys(headers).length === 0) delete operation.responses!["200"].headers;
    }
  }
  return copy;
}

/**
 * Failure declarations are owned by combinedSyncFailureOpenapi.acceptance.
 * Permit only their reachable new component schemas, not arbitrary additions.
 * Inline those refs before removing them so a shared completed-count definition
 * can be reused by the existing 200 schema without re-recording its contract.
 * The 200 response, query params and all unrelated operations stay frozen.
 */
function withoutDedicatedSyncFailureMetadata(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/data-snapshot/sync"]?.post as {
    responses?: Record<string, unknown>;
  } | undefined;
  const schemas = copy.components?.schemas ?? {};
  const legacySchemas = new Set([
    "AddressSaveDryRun", "AddressSaveOutcome", "ContainerSaveDryRun",
    "ContainerSaveOutcome", "CustomerSaveDryRun", "CustomerSaveOutcome",
    "CustomerSnapshotChanges", "CustomerSnapshotChangesRow", "CustomerSnapshotList",
    "DataSnapshotSyncResult",
    "HealthResponse", "LocalSyncCode", "LocalSyncSummary",
    "ReadinessResponse", "ShadowHealthResponse",
    "SnapshotOrphanReport", "SnapshotOrphanSample"
  ]);
  const owned = new Set<string>();
  function collect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const node = value as Record<string, unknown>;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/components/schemas/")) {
      const name = node.$ref.slice("#/components/schemas/".length);
      if (!legacySchemas.has(name) && !owned.has(name)) {
        owned.add(name);
        collect(schemas[name]);
      }
    }
    Object.values(node).forEach(collect);
  }
  for (const status of ["400", "401", "500", "503"]) collect(operation?.responses?.[status]);
  function inline(value: unknown, seen: string[] = []): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((entry) => inline(entry, seen));
    const node = value as Record<string, unknown>;
    const ref = node.$ref;
    if (typeof ref === "string" && owned.has(ref.slice("#/components/schemas/".length))) {
      expect(seen, "combined-sync schema refs must not cycle").not.toContain(ref);
      const name = ref.slice("#/components/schemas/".length);
      expect(schemas[name], `missing combined-sync schema ${name}`).toBeDefined();
      const { $ref: _ref, ...siblings } = node;
      return { ...inline(schemas[name], [...seen, ref]) as object, ...inline(siblings, seen) as object };
    }
    return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, inline(entry, seen)]));
  }
  const result = inline(copy) as OpenApiDocument;
  for (const name of owned) delete result.components!.schemas![name];
  const responses = (result.paths["/api/v1/data-snapshot/sync"]?.post as typeof operation)?.responses;
  if (responses) {
    delete responses["400"];
    delete responses["500"];
    delete responses["503"];
    // This response was description-only before the dedicated failure oracle.
    if (responses["401"]) responses["401"] = { description: "Unauthorized" };
  }
  return result;
}

/**
 * The bounded `ids` extension has independent behavioral/schema assertions in
 * snapshotIdSelection.acceptance.test.ts. Project out only its new parameter
 * and the three evolving 400 descriptions; freeze all pre-existing structure.
 */
function withoutIdSelectionExtension(doc: unknown): unknown {
  const copy = structuredClone(doc) as {
    paths: Record<string, { get?: { parameters?: Param[]; responses?: Record<string, { description?: string }> } }>;
  };
  type Param = { name?: string };
  for (const resource of ["customer", "address", "container"]) {
    const get = copy.paths[`/api/v1/${resource}-snapshot`]?.get;
    if (!get) continue;
    if (get.parameters) get.parameters = get.parameters.filter((p) => p.name !== "ids");
    if (get.responses?.["400"]) delete get.responses["400"].description;
  }
  return copy;
}

/**
 * The comments query contract is owned by customerCommentsSearch.acceptance.
 * Exclude only that new query parameter; all legacy prose, parameters, responses
 * and unrelated endpoints remain frozen. Put new guidance on the new parameter.
 */
function withoutCustomerCommentsParameter(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/customer-snapshot"]?.get as
    | { parameters?: Array<{ name?: string; in?: string }> }
    | undefined;
  if (operation?.parameters) {
    operation.parameters = operation.parameters.filter((p) => p.in !== "query" || p.name !== "comments");
  }
  return copy;
}

/** Only the new customer-list query parameters move to the independent
 * customerPhonePresence oracle; all legacy schemas/prose/endpoints stay frozen. */
function withoutCustomerPhonePresenceParameters(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/customer-snapshot"]?.get as
    | { parameters?: Array<{ name?: string; in?: string }> }
    | undefined;
  if (operation?.parameters) {
    operation.parameters = operation.parameters.filter((p) =>
      p.in !== "query" || !["hasPhone1", "hasPhone2"].includes(p.name ?? ""));
  }
  return copy;
}

/** Only the new customer-list query parameter moves to the independent
 * customerContainerPresence oracle; all legacy schemas/prose/endpoints stay frozen. */
function withoutCustomerContainerPresence(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/customer-snapshot"]?.get as
    | { parameters?: Array<{ name?: string; in?: string }> }
    | undefined;
  if (operation?.parameters) {
    operation.parameters = operation.parameters.filter((p) =>
      p.in !== "query" || p.name !== "hasContainers");
  }
  return copy;
}

/**
 * Customer child-cohort schemas, examples, single-list scope and outcomes are
 * independently owned by customerAddressCohorts.acceptance.test.ts and
 * customerAddressServicePolicy.acceptance.test.ts. Remove only these cohort
 * query parameters; preserve every existing golden contract.
 */
function withoutCustomerAddressCohortParameters(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/customer-snapshot"]?.get as
    | { parameters?: Array<{ name?: string; in?: string }> }
    | undefined;
  if (operation?.parameters) {
    operation.parameters = operation.parameters.filter(p => p.in !== "query" ||
      !["addressRouteId", "addressFranchiseId", "addressEnabled", "addressExtrasAllowed", "addressLastAuditDate"].includes(p.name ?? ""));
  }
  return copy;
}

/**
 * The opt-in exact next-page signal (`exactNext`) is owned by
 * snapshotExactNext.acceptance.test.ts: its schema, mounted position,
 * description guidance and absence from every other operation are pinned
 * there. Exclude only that new query parameter from the three ordinary
 * lists; put new guidance on the new parameter, not on frozen prose.
 */
function withoutExactNextParameter(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  for (const resource of ["customer", "address", "container"]) {
    const operation = copy.paths[`/api/v1/${resource}-snapshot`]?.get as
      | { parameters?: Array<{ name?: string; in?: string }> }
      | undefined;
    if (operation?.parameters) {
      operation.parameters = operation.parameters.filter((p) => p.in !== "query" || p.name !== "exactNext");
    }
  }
  return copy;
}

/**
 * Scope parameters and the address list's evolving filter/recovery prose have
 * semantic checks in addressScopeFilters.acceptance.test.ts, with the stored-zip
 * selector covered by addressZipFilter.acceptance.test.ts, exact stored
 * streets by addressStreetExact.acceptance.test.ts, city/state by
 * addressCityStateFilters.acceptance.test.ts and driverNote by
 * addressDriverNoteSearch.acceptance.test.ts. Keep all existing parameter
 * schemas, responses, tags and other operations in the legacy golden.
 */
function withoutAddressScopeContract(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/address-snapshot"].get as {
    description?: string;
    parameters: Array<{ name: string; in: string }>;
    responses: Record<string, { description?: string }>;
  };
  delete operation.description;
  delete operation.responses["400"].description;
  operation.parameters = operation.parameters.filter(parameter =>
    parameter.in !== "query" || !["routeId", "franchiseId", "zip", "streetAddress", "city", "state", "driverNote"].includes(parameter.name));
  return copy;
}

/**
 * The stored extras-allowed selector has semantic checks in
 * addressExtrasAllowed.acceptance.test.ts. Project out only its new parameter;
 * address filter/recovery prose is already owned by
 * withoutAddressScopeContract. Keep all existing parameter schemas in the
 * legacy golden.
 */
function withoutAddressExtrasAllowedContract(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/address-snapshot"].get as {
    parameters: Array<{ name: string; in: string }>;
  };
  operation.parameters = operation.parameters.filter(parameter =>
    parameter.in !== "query" || parameter.name !== "extrasAllowed");
  return copy;
}

// Mirrored-child presence selection (`hasContainers`) has semantic checks in
// the Test Author-owned addressContainerPresence.acceptance.test.ts, not
// frozen as a speculative parameter position. The address description and 400
// prose are already projected out above; only the new selector moves to
// behavioral ownership here. All legacy parameters stay frozen.
function withoutAddressContainerPresence(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/address-snapshot"]?.get as
    | { parameters?: Array<{ name?: string; in?: string }> }
    | undefined;
  if (operation?.parameters) {
    operation.parameters = operation.parameters.filter((parameter) =>
      parameter.in !== "query" || parameter.name !== "hasContainers"
    );
  }
  return copy;
}

// The independent coordinate-presence oracle owns only this new query enum on
// the two list GETs. All unrelated parameters remain in the legacy golden.
function withoutCoordinatePresence(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  for (const resource of ["address", "container"]) {
    const operation = copy.paths[`/api/v1/${resource}-snapshot`]?.get as
      | { parameters?: Array<{ name?: string; in?: string }> }
      | undefined;
    if (operation?.parameters) {
      operation.parameters = operation.parameters.filter((parameter) =>
        parameter.in !== "query" || parameter.name !== "hasCoordinates");
    }
  }
  return copy;
}

// Stored last-audit-date exact and presence selection has semantic checks in
// the Test Author-owned addressLastAuditDate.acceptance.test.ts, not frozen
// as speculative parameter positions. The address description and 400 prose
// are already projected out above; only the two new selectors move to
// behavioral ownership here. All legacy parameters stay frozen.
function withoutAddressLastAuditDate(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/address-snapshot"]?.get as
    | { parameters?: Array<{ name?: string; in?: string }> }
    | undefined;
  if (operation?.parameters) {
    operation.parameters = operation.parameters.filter((parameter) =>
      parameter.in !== "query" || !["lastAuditDate", "hasLastAuditDate"].includes(parameter.name ?? "")
    );
  }
  return copy;
}

// Parent-customer enabled selection has semantic checks in the Test
// Author-owned addressParentCustomerEnabled.acceptance.test.ts, not frozen
// as a speculative parameter position. The address description and 400 prose
// are already projected out above; only the new selector moves to behavioral
// ownership here. All legacy parameters stay frozen.
function withoutAddressParentCustomerEnabled(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/address-snapshot"]?.get as
    | { parameters?: Array<{ name?: string; in?: string }> }
    | undefined;
  if (operation?.parameters) {
    operation.parameters = operation.parameters.filter((parameter) =>
      parameter.in !== "query" || parameter.name !== "parentCustomerEnabled"
    );
  }
  return copy;
}

// Exact identifiers, stored labels, installation/city selectors, parent scopes and
// service-code entry parts, serial/RFID presence and stored-flag selectors
// supersede this route's old query/error narrative. Their schemas,
// composition and error discovery are asserted independently in
// containerIdentifierFilters.acceptance.test.ts,
// containerServiceCode.acceptance.test.ts,
// containerMaterialColorFilters.acceptance.test.ts,
// containerExactLocation.acceptance.test.ts,
// containerCityFilter.acceptance.test.ts,
// containerParentScopes.acceptance.test.ts and
// containerServiceCodeParts.acceptance.test.ts,
// containerSerialRfidPresence.acceptance.test.ts,
// containerOnCallGpsLocked.acceptance.test.ts and
// containerRouteFrequencyExact.acceptance.test.ts, not frozen as speculative
// prose or parameter position. All legacy parameters and unrelated operations
// remain frozen.
function withoutContainerIdentifierAdditions(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/container-snapshot"]?.get as
    | {
      description?: string;
      parameters?: Array<{ name?: string; in?: string }>;
      responses?: Record<string, { description?: string }>;
    }
    | undefined;
  if (operation) {
    delete operation.description;
    if (operation.responses?.["400"]) delete operation.responses["400"].description;
    if (operation.parameters) {
      operation.parameters = operation.parameters.filter((parameter) =>
        parameter.in !== "query" || !["serialNumber", "rfid", "serviceCode", "hasSerialNumber", "hasRfid", "routeIdsExact", "frequencyIdsExact", "hasRouteIds", "hasFrequencyIds", "onCall", "gpsLocked", "materialStream", "color", "serviceCodeType", "serviceCodeInput", "locationAddress", "city", "state", "parentRouteId", "parentFranchiseId", "parentEnabled"].includes(parameter.name ?? "")
      );
    }
  }
  return copy;
}

// The stored-type selector's facet, strict validation and composition are
// asserted independently in containerTypeFilter.acceptance.test.ts, not frozen
// as parameter position here. All legacy parameters stay frozen.
function withoutContainerTypeFilter(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/container-snapshot"]?.get as
    | {
      parameters?: Array<{ name?: string; in?: string }>;
    }
    | undefined;
  if (operation?.parameters) {
    operation.parameters = operation.parameters.filter((parameter) =>
      parameter.in !== "query" || parameter.name !== "containerTypeId"
    );
  }
  return copy;
}

/**
 * The interval's parameter/prose is owned by customerChangesUntil.acceptance:
 * it checks the served schema and HTTP behavior without freezing new wording.
 * Keep every pre-existing schema, response and unrelated query parameter pinned.
 */
function withoutDedicatedChangesIntervalMetadata(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const get = copy.paths["/api/v1/customer-snapshot/changes"]?.get as {
    description?: string;
    summary?: string;
    parameters?: Array<{ name?: string; in?: string; description?: string; schema?: Record<string, unknown> }>;
    responses?: Record<string, { description?: string }>;
  } | undefined;
  if (!get) return copy;
  delete get.description;
  delete get.summary;
  if (get.parameters) {
    get.parameters = get.parameters.filter((param) => !(param.in === "query" && param.name === "until"));
    for (const param of get.parameters) {
      if (param.name !== "since") continue;
      delete param.description;
      if (param.schema) delete param.schema.description;
    }
  }
  if (get.responses?.["400"]) delete get.responses["400"].description;
  return copy;
}

// The typed hydrated oracle owns ONLY these GET 200 schemas/examples and their
// component closure. Other statuses, POSTs, parameters and unrelated components
// remain golden-pinned. Shared components used by another operation stay pinned.
function withoutHydratedBundleDeclarations(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const components = copy.components?.schemas ?? {};
  const refs = (value: unknown, found = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) {
      for (const item of value) refs(item, found);
    } else if (value !== null && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (typeof node.$ref === "string" && node.$ref.startsWith("#/components/schemas/")) {
        const name = node.$ref.slice("#/components/schemas/".length).replace(/~1/g, "/").replace(/~0/g, "~");
        if (!found.has(name)) {
          found.add(name);
          refs(components[name], found);
        }
      }
      for (const child of Object.values(node)) refs(child, found);
    }
    return found;
  };
  const owned = new Set<string>();
  for (const kind of ["customer", "address", "container"]) {
    const get = copy.paths[`/api/v1/data/${kind}`].get as {
      responses: Record<string, { content?: Record<string, Record<string, unknown>> }>;
    };
    const media = get.responses["200"].content?.["application/json"];
    refs(media, owned);
    if (media) {
      media.schema = {};
      delete media.example;
      delete media.examples;
    }
  }
  const shared = refs(copy.paths);
  for (const name of owned) if (!shared.has(name)) delete components[name];
  return copy;
}

// Customer name-search supersedes this route's old company-only query narrative.
// Its operation description and q parameter/schema descriptions are asserted
// semantically in customerNameSearch.acceptance.test.ts (substring wording plus
// company/first/last/any), not frozen as speculative prose here. The q schema
// shape, all other parameters, responses and unrelated operations remain frozen.
function withoutCustomerNameSearchContract(doc: OpenApiDocument): OpenApiDocument {
  const copy = structuredClone(doc);
  const operation = copy.paths["/api/v1/customer-snapshot"]?.get as
    | {
      description?: string;
      parameters?: Array<{
        name?: string;
        in?: string;
        description?: string;
        schema?: Record<string, unknown>;
      }>;
    }
    | undefined;
  if (operation) {
    delete operation.description;
    for (const parameter of operation.parameters ?? []) {
      if (parameter.name !== "q" || parameter.in !== "query") continue;
      delete parameter.description;
      const schema = parameter.schema as Record<string, unknown> | undefined;
      if (schema) delete schema.description;
    }
  }
  return copy;
}

function operationIds(doc: OpenApiDocument): string[] {
  const ops: string[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method.toLowerCase())) {
        ops.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return ops.sort();
}

// `routes` is public API on Hono's base class (`routes: RouterRoute[]`), so no
// cast is needed. Going through `unknown` would suppress structural checking and
// keep compiling if Hono ever renamed a field.
function registeredRoutes(): RegisteredRoute[] {
  return app.routes;
}

describe("published OpenAPI document", () => {
  it("publishes exactly the expected set of operations", async () => {
    // Arrange
    const doc = await fetchOpenApiDocument();

    // Act
    const ops = operationIds(doc);

    // Assert
    expect(ops).toEqual(EXPECTED_OPERATIONS);
  });

  it("declares the tags, shared schemas and bearer security scheme", async () => {
    // Arrange
    const doc = withoutDedicatedSyncFailureMetadata(await fetchOpenApiDocument());

    // Assert
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Routeware Shadow API");
    // Single-sourced from package.json: bumping
    // package.json#version must move the spec version with no other edit.
    expect(doc.info.version).toBe(packageJson.version);
    expect(doc.tags?.map((t) => t.name)).toEqual(EXPECTED_TAGS);
    // Registered once each: every snapshot list has its own typed envelope
    // (`*SnapshotList`) whose rows resolve to its own reusable row schema
    // (`*SnapshotRow`), and `CustomerSnapshotChanges` carries the composite
    // `{since, since_id}` cursor instead of the integer primary-key cursor.
    // `CustomerSnapshotChangesRow` types its delta rows with storage-faithful
    // integer/text/null columns.
    expect(Object.keys(withoutHydratedBundleDeclarations(doc).components?.schemas ?? {}).sort()).toEqual([
      "AddressSaveDryRun",
      "AddressSaveOutcome",
      "AddressSnapshotList",
      "AddressSnapshotRow",
      "ContainerSaveDryRun",
      "ContainerSaveOutcome",
      "ContainerSnapshotList",
      "ContainerSnapshotRow",
      "CustomerSaveDryRun",
      "CustomerSaveOutcome",
      "CustomerSnapshotChanges",
      "CustomerSnapshotChangesRow",
      "CustomerSnapshotList",
      "CustomerSnapshotRow",
      "DataSnapshotSyncResult",
      "HealthResponse",
      "LocalSyncCode",
      "LocalSyncSummary",
      "ReadinessResponse",
      "ShadowHealthResponse",
      "SnapshotOrphanReport",
      "SnapshotOrphanSample"
    ]);
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["bearerAuth"]);
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("documents 400 on snapshot imports, lists, changes and the orphan audit", async () => {
    // Arrange — imports return 400 on an empty body and lists
    // return 400 on out-of-range query params, but neither branch was in the
    // document, so generated clients never surfaced them. The changes feed
    // returns 400 on an invalid composite cursor before any D1 read.
    const doc = await fetchOpenApiDocument();

    // Act
    const operations = [
      "POST /api/v1/customer-snapshot/import",
      "POST /api/v1/address-snapshot/import",
      "POST /api/v1/container-snapshot/import",
      "GET /api/v1/customer-snapshot",
      "GET /api/v1/customer-snapshot/changes",
      "GET /api/v1/address-snapshot",
      "GET /api/v1/container-snapshot",
      "GET /api/v1/data-snapshot/orphans"
    ];
    const missing = operations.filter((op) => {
      const [method, path] = op.split(" ");
      const responses = (
        doc.paths[path]?.[method.toLowerCase()] as
          | { responses?: Record<string, unknown> }
          | undefined
      )?.responses;
      return !responses || !("400" in responses);
    });

    // Assert — hand-written (not a snapshot) so `vitest -u` cannot silently
    // re-record a regression away.
    expect(missing).toEqual([]);
  });

  it("pins the changes feed's UTC millisecond and decimal cursor schema", async () => {
    // Arrange — the changes feed validates its composite cursor losslessly:
    // `since` accepts only UTC Z with seconds or 1–3 fractional digits
    // (normalized to milliseconds, never rounded), and `since_id` accepts only
    // exact unpadded ASCII decimal safe-integers. Both patterns must be visible
    // so generated clients offer the same spelling.
    const doc = await fetchOpenApiDocument();

    // Act
    const get = doc.paths["/api/v1/customer-snapshot/changes"]?.["get"] as
      | {
          parameters?: Array<{
            in?: string;
            name?: string;
            description?: string;
            schema?: Record<string, unknown>;
          }>;
        }
      | undefined;
    const byName = Object.fromEntries(
      (get?.parameters ?? [])
        .filter((p) => p.in === "query")
        .map((p) => [p.name ?? "", p])
    );
    const since = byName["since"];
    const sinceId = byName["since_id"];

    // Assert — hand-written (not a snapshot) so `vitest -u` cannot silently
    // re-record a regression away.
    expect(since?.schema).toMatchObject({
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?Z$",
      example: "2025-12-31T00:00:00.000Z"
    });
    expect(since?.schema).not.toHaveProperty("format");
    expect(since?.description).toContain("UTC");
    expect(since?.description).toContain("millisecond");
    expect(sinceId?.schema).toMatchObject({
      type: "string",
      pattern: "^(0|[1-9][0-9]*)$",
      example: "345733"
    });
    expect(sinceId?.description).toContain("decimal");
    expect(sinceId?.description).toContain("unpadded");
  });

  it("publishes the orphan audit's invalid-sampleLimit problem+json schema", async () => {
    const doc = await fetchOpenApiDocument();
    const operation = doc.paths["/api/v1/data-snapshot/orphans"]?.get as {
      responses: Record<string, unknown>;
    };

    expect(operation.responses["400"]).toMatchObject({
      content: {
        "application/problem+json": {
          schema: {
            type: "object",
            required: ["type", "title", "status", "detail"],
            properties: {
              type: { type: "string" },
              title: { type: "string" },
              status: { type: "number", enum: [400] },
              detail: { type: "string" }
            }
          }
        }
      }
    });
  });

  it("documents the id alias on all three data-entity GETs", async () => {
    // Arrange — customer GET accepted `id|customerId` while address
    // and container accepted only `id`. The alias must be visible on all three
    // so generated clients offer the same spelling. The batch `ids` param
    // rides the same query contract (see the batch acceptance suite).
    const doc = await fetchOpenApiDocument();

    // Act
    const paramsOf = (path: string): string[] => {
      const get = doc.paths[path]?.["get"] as
        | { parameters?: Array<{ in?: string; name?: string }> }
        | undefined;
      return (get?.parameters ?? [])
        .filter((p) => p.in === "query")
        .map((p) => p.name ?? "");
    };

    // Assert — hand-written (not a snapshot) so `vitest -u` cannot silently
    // re-record a regression away. Per-type bundle selectors (R20-02) ride on
    // every data-entity GET alongside the flat root-only `fields`.
    const bundleFields = ["fields[address]", "fields[container]", "fields[customer]"];
    expect(paramsOf("/api/v1/data/customer").sort()).toEqual(["customerId", "fields", "id", "ids", ...bundleFields].sort());
    expect(paramsOf("/api/v1/data/address").sort()).toEqual(["fields", "id", "ids", "pickupAddressId", ...bundleFields].sort());
    expect(paramsOf("/api/v1/data/container").sort()).toEqual(["containerId", "fields", "id", "ids", ...bundleFields].sort());
  });

  it("tags the routeware meta routes and documents their 401", async () => {
    // Arrange — login-page/home-index carried no 401 docs despite
    // sitting behind the `/api/v1/*` bearer gate.
    const doc = await fetchOpenApiDocument();

    // Act
    const operations = [
      "GET /api/v1/routeware/account/login-page",
      "GET /api/v1/routeware/home/index"
    ];
    const problems = operations.filter((op) => {
      const [method, path] = op.split(" ");
      const operation = doc.paths[path]?.[method.toLowerCase()] as
        | { responses?: Record<string, unknown>; tags?: string[] }
        | undefined;
      return (
        !operation?.tags?.includes("routeware") ||
        !operation?.responses ||
        !("401" in operation.responses)
      );
    });

    // Assert — hand-written (not a snapshot) so `vitest -u` cannot silently
    // re-record a regression away.
    expect(problems).toEqual([]);
  });

  it.each(["customer", "address", "container"])(
    "documents the pre-CSV query-budget 503 on the %s snapshot export",
    async (table) => {
      const doc = await fetchOpenApiDocument();
      const operation = doc.paths[`/api/v1/${table}-snapshot/export`]?.get as {
        responses: Record<string, { description?: string }>;
      };

      // Keep the refusal and its remedy visible to clients even if someone
      // updates the full-document snapshot after dropping a response entry.
      expect(operation.responses["503"]).toEqual({
        description:
          "Snapshot export query budget exceeded before CSV starts (application/problem+json, snapshot-export-query-budget). Review SNAPSHOT_EXPORT_PAGE_SIZE using CUSTOMER_SNAPSHOT.md#csv-export-page-sizing."
      });
    }
  );

  it("matches the recorded document byte for byte", async () => {
    // Arrange / Act
    const doc = withoutCustomerAddressCohortParameters(withoutExactNextParameter(withoutCustomerPhonePresenceParameters(withoutCustomerContainerPresence(withoutCustomerCommentsParameter(withoutDedicatedSyncFailureMetadata(await fetchOpenApiDocument()))))));

    // Assert — full-document freeze: descriptions, parameters, response
    // schemas and per-operation tags all have to survive the refactor. The
    // wording of the includeTotal prose is pinned by hand-written assertions in
    // `test/snapshotCountFreePagination.test.ts`; only its structure (name,
    // location, enum, default, nullable total) is frozen here.
    // The agent-metadata layer (operationId, x-* extensions, the empty `security`
    // on the public probe, the bearer role description) is owned by
    // `test/openapiAgentMetadata.test.ts`, so it is projected out here and
    // enriching it never re-records this frozen document. The flat/typed
    // x-snapshot-fieldset catalogs and hydrated x-snapshot-fieldset-mode guidance
    // are pinned by the discovery oracles; no other selector property moves.
    // Conditional list
    // If-None-Match, 200 ETag and 304 declarations are separately pinned by
    // `test/snapshotListConditional.acceptance.test.ts` and projected out here.
    // Only ids schema/400 prose moves to the independent acceptance contract.
    // Only the two new scope selectors and address filter/recovery prose move
    // to behavioral/semantic ownership; the container exact-identifier
    // additions move to containerIdentifierFilters.acceptance.test.ts; the three
    // parent selectors move to containerParentScopes.acceptance.test.ts; the two
    // serial/RFID presence selectors move to
    // containerSerialRfidPresence.acceptance.test.ts.
    // Typed hydrated GET 200 declarations/examples move to the seeded semantic
    // oracle in typedHydratedBundles.acceptance.test.ts, not this old golden.
    // Interval-only query/prose moves to customerChangesUntil.acceptance.test.ts;
    // its since schema and all unrelated golden contracts stay pinned.
    // Only customer name-search operation/q prose additionally moves to its
    // semantic oracle; unrelated golden contracts stay pinned.
    // Only the three ordinary lists' upperId query parameters are also projected
    // out: their bounds, strict validation, scope and authority are independently
    // pinned in `test/snapshotUpperId.acceptance.test.ts`. Order remains frozen.
    // Only the container list's containerTypeId query parameter is also
    // projected out: its facet, strict validation and composition are
    // independently pinned in `test/containerTypeFilter.acceptance.test.ts`.
    // Only the customer list's hasContainers query parameter is also
    // projected out: its schema, presence semantics and composition are
    // independently pinned in
    // `test/customerContainerPresence.acceptance.test.ts`; the address list's
    // own single-level hasContainers stays separately projected via
    // withoutAddressContainerPresence above.
    // Only the address stored-extras selector additionally moves to
    // addressExtrasAllowed ownership; last-audit-date exact/presence moves to
    // addressLastAuditDate ownership; parent-customer enabled moves to
    // addressParentCustomerEnabled ownership; all other golden contracts stay pinned.
    expect(withoutIdSelectionExtension(withoutDedicatedListMetadata(withoutAgentMetadata(withoutAddressScopeContract(withoutAddressExtrasAllowedContract(withoutContainerTypeFilter(withoutContainerIdentifierAdditions(withoutAddressContainerPresence(withoutCoordinatePresence(withoutAddressLastAuditDate(withoutAddressParentCustomerEnabled(withoutHydratedBundleDeclarations(withoutCustomerNameSearchContract(withoutDedicatedChangesIntervalMetadata(doc))))))))))))))).toMatchSnapshot();
  });
});

describe("router surface", () => {
  it("registers the same routes the document advertises", () => {
    // Arrange
    const routes = registeredRoutes();

    // Act — the router uses Hono param syntax (`:id`); the document uses
    // OpenAPI syntax (`{id}`). Normalize before comparing, and drop the
    // middleware entries (method ALL) plus the non-`/api/v1` doc endpoints.
    const routed = new Set(
      routes
        .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/v1"))
        .map((r) => `${r.method} ${r.path.replace(/:([^/]+)/g, "{$1}")}`)
    );

    // Assert
    expect([...routed].sort()).toEqual(EXPECTED_OPERATIONS);
  });

  it("registers both /api/v1/* middlewares ahead of every route", () => {
    // Arrange
    const routes = registeredRoutes();

    // Act
    const firstRouteIndex = routes.findIndex((r) => r.method !== "ALL");
    const gateIndexes = routes
      .map((r, i) => (r.method === "ALL" && r.path === "/api/v1/*" ? i : -1))
      .filter((i) => i >= 0);

    // Assert — the client auth gate and the body-buffer/session middleware must
    // both precede every route, or an unauthenticated request could reach a
    // handler. See docs/CONVENTIONS.md § 3.
    expect(gateIndexes).toEqual([0, 1]);
    expect(firstRouteIndex).toBeGreaterThan(1);
  });

  it("still serves the docs endpoints", () => {
    // Arrange
    const paths = registeredRoutes().map((r) => `${r.method} ${r.path}`);

    // Assert
    expect(paths).toContain("GET /openapi.json");
    expect(paths.filter((p) => p === "ALL /docs")).toHaveLength(2);
  });
});
