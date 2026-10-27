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

function stableJson(value: unknown): string {
  const sortKeys = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sortKeys);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sortKeys((item as Record<string, unknown>)[key])])
      );
    }
    return item;
  };

  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

async function fetchOpenApiDocument(): Promise<OpenApiDocument> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiDocument;
}

/**
 * The shared-schema inventory below excludes components owned by the dedicated
 * combined-sync failure oracle. Inline their references before removing them
 * so shared success definitions still resolve. The full JSON record is not
 * projected: every declaration remains frozen by the file snapshot.
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

// Exclude the dedicated hydrated GET component closure only from the shared-
// schema inventory below. Shared components used by another operation stay in
// that inventory; the full JSON file snapshot still records every component.
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
    // package.json#version updates the live spec; regenerate docs/openapi.json too.
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

  it("matches the recorded document after stable JSON formatting", async () => {
    const doc = await fetchOpenApiDocument();

    // Preserve the old projection's hand-written counted-example guard even
    // when -u deliberately regenerates the now-complete document record.
    for (const resource of ["customer", "address", "container"]) {
      const path = `/api/v1/${resource}-snapshot`;
      const operation = doc.paths[path]?.get as {
        responses: Record<string, { content?: Record<string, {
          examples?: Record<string, { value?: { rows?: unknown[]; total?: number | null } }>;
        }> }>;
      };
      const examples = operation.responses["200"].content?.["application/json"].examples;
      if (examples) {
        const countedPages = Object.values(examples).map((entry) => entry.value)
          .filter((value) => value && (value.rows?.length ?? 0) > 0 && typeof value.total === "number");
        expect(countedPages, `${path}: preserve one legacy counted full-page example`).toHaveLength(1);
      }
    }

    // Freeze the full published contract, including extensions and declarations
    // also covered by dedicated semantic tests. Do not publish a projection.
    await expect(
      stableJson(doc),
      "Regenerate with `npx vitest run test/openapiContract.test.ts -u`."
    ).toMatchFileSnapshot("../docs/openapi.json");
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
