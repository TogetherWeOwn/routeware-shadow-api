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

async function fetchOpenApiDocument(): Promise<OpenApiDocument> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiDocument;
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
    const doc = await fetchOpenApiDocument();

    // Assert
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Routeware Shadow API");
    // Single-sourced from package.json (TOG-5840): bumping
    // package.json#version must move the spec version with no other edit.
    expect(doc.info.version).toBe(packageJson.version);
    expect(doc.tags?.map((t) => t.name)).toEqual(EXPECTED_TAGS);
    // Registered once each: `CustomerSnapshotList` is shared by the customer,
    // address and container snapshot list routes, and `CustomerSnapshotChanges`
    // (TOG-8877) carries the composite `{since, since_id}` cursor instead of
    // the integer primary-key cursor.
    expect(Object.keys(doc.components?.schemas ?? {}).sort()).toEqual([
      "CustomerSnapshotChanges",
      "CustomerSnapshotList",
      "DataSnapshotSyncResult",
      "HealthResponse",
      "ReadinessResponse",
      "ShadowHealthResponse"
    ]);
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["bearerAuth"]);
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("documents 400 on all snapshot imports and lists", async () => {
    // Arrange — TOG-6522: imports return 400 on an empty body and lists
    // return 400 on out-of-range query params, but neither branch was in the
    // document, so generated clients never surfaced them.
    const doc = await fetchOpenApiDocument();

    // Act
    const operations = [
      "POST /api/v1/customer-snapshot/import",
      "POST /api/v1/address-snapshot/import",
      "POST /api/v1/container-snapshot/import",
      "GET /api/v1/customer-snapshot",
      "GET /api/v1/address-snapshot",
      "GET /api/v1/container-snapshot"
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

  it("documents the id alias on all three data-entity GETs", async () => {
    // Arrange — TOG-6525: customer GET accepted `id|customerId` while address
    // and container accepted only `id`. The alias must be visible on all three
    // so generated clients offer the same spelling.
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
    // re-record a regression away.
    expect(paramsOf("/api/v1/data/customer").sort()).toEqual(["customerId", "id"]);
    expect(paramsOf("/api/v1/data/address").sort()).toEqual(["id", "pickupAddressId"]);
    expect(paramsOf("/api/v1/data/container").sort()).toEqual(["containerId", "id"]);
  });

  it("tags the routeware meta routes and documents their 401", async () => {
    // Arrange — TOG-6525: login-page/home-index carried no 401 docs despite
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

  it("matches the recorded document byte for byte", async () => {
    // Arrange / Act
    const doc = await fetchOpenApiDocument();

    // Assert — full-document freeze: descriptions, parameters, response
    // schemas and per-operation tags all have to survive the refactor.
    expect(doc).toMatchSnapshot();
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
