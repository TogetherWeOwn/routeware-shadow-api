import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { createRouteModule } from "../src/routes/shared";
import { recordingDb } from "./snapshotDbFake";

// Policy and exact non-list exemptions: docs/SNAPSHOT-LIST-QUERY-POLICY.md.
// Discover from the mounted router, not this policy map: a new GET must fail
// coverage until its list policy or named non-list exemption is recorded.
type RegisteredRoute = { method: string; path: string };
type ListPolicy = { unknownParams: "ignore"; filteredQuery: string };

const LIST_POLICIES: Record<string, ListPolicy> = {
  "/api/v1/customer-snapshot": {
    unknownParams: "ignore",
    filteredQuery: "customerId=7&q=Synthetic&enabled=true&limit=1&offset=2"
  },
  "/api/v1/address-snapshot": {
    unknownParams: "ignore",
    filteredQuery: "customerId=7&pickupAddressId=11&q=Synthetic&enabled=true&limit=1&offset=2"
  },
  "/api/v1/container-snapshot": {
    unknownParams: "ignore",
    filteredQuery: "customerId=7&pickupAddressId=11&containerId=13&q=Synthetic&enabled=true&limit=1&offset=2"
  },
  // The incremental feed is registered on newer revisions. Probe it whenever
  // present; the three root list routes below remain mandatory on all revisions.
  "/api/v1/customer-snapshot/changes": {
    unknownParams: "ignore",
    filteredQuery: "since=2026-09-01T00%3A00%3A00.000Z&since_id=3&limit=1"
  }
};

const NON_LIST_ROUTES: Record<string, string> = {
  "/api/v1/customer-snapshot/:customerId": "One customer row by primary key",
  "/api/v1/address-snapshot/:pickupAddressId": "One address row by primary key",
  "/api/v1/container-snapshot/:containerId": "One container row by primary key",
  "/api/v1/customer-snapshot/export": "CSV download, not a paginated JSON list",
  "/api/v1/address-snapshot/export": "CSV download, not a paginated JSON list",
  "/api/v1/container-snapshot/export": "CSV download, not a paginated JSON list",
  "/api/v1/data/customer": "Single-customer aggregate selected by id",
  "/api/v1/data/address": "Single-address aggregate selected by id",
  "/api/v1/data/container": "Single-container aggregate selected by id",
  "/api/v1/data-snapshot/orphans": "Integrity report with counts and bounded id samples, not collection pagination",
  "/api/v1/snapshots/:table/:date": "One archived CSV object by table and date",
  "/api/v1/snapshots/:table/latest": "One archived CSV object by table via the latest pointer"
};

function snapshotDataGets(routes: RegisteredRoute[]): string[] {
  return [...new Set(routes
    .filter(({ method, path }) =>
      (method === "GET" || method === "ALL") &&
      /^\/api\/v1\/(?:[^/]*snapshot[^/]*|data)(?:\/|$)/.test(path)
    )
    .map(({ path }) => path))].sort();
}

function assertPolicyCoverage(routes: RegisteredRoute[]): void {
  const missing = snapshotDataGets(routes).filter((path) =>
    !Object.hasOwn(LIST_POLICIES, path) && !Object.hasOwn(NON_LIST_ROUTES, path)
  );
  if (missing.length > 0) {
    throw new Error(`Missing unknown-param policy: ${missing.join(", ")}`);
  }
}

const liveGets = snapshotDataGets(app.routes);
const liveLists = liveGets.filter((path) => !Object.hasOwn(NON_LIST_ROUTES, path));
const SYNTHETIC_ROW = {
  customer_id: 7,
  pickup_address_id: 11,
  container_id: 13,
  company_name: "Synthetic fixture",
  enabled: 1,
  synced_at: "2026-09-02T00:00:00.000Z"
};

async function probe(path: string, query: string) {
  const recording = recordingDb({ allResults: [SYNTHETIC_ROW], firstCounts: [1] });
  // Hono's third app.request argument supplies c.env without a live deployment:
  // https://hono.dev/docs/guides/testing#passing-env-variables
  const response = await app.request(`${path}${query ? `?${query}` : ""}`, {
    headers: { authorization: "Bearer test-sync-secret" }
  }, { ...env, CUSTOMER_DB: recording.db });
  return { response, recording };
}

describe("snapshot/data list unknown-query-param policy", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("Unexpected outbound fetch in snapshot list policy sweep");
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires an explicit policy or named exemption for every registered GET", () => {
    assertPolicyCoverage(app.routes);
    expect(liveLists).toEqual(expect.arrayContaining([
      "/api/v1/customer-snapshot",
      "/api/v1/address-snapshot",
      "/api/v1/container-snapshot"
    ]));
  });

  it.each([
    "/api/v1/widget-snapshot",
    "/api/v1/customer-snapshot/recent",
    "/api/v1/data-snapshot/orphans/recent",
    "/api/v1/data/items",
    "/api/v1/data/:customerId/items"
  ])("fails coverage when an unclassified list is registered at %s", (path) => {
    const newRoutes = createRouteModule();
    newRoutes.get(path, (c) => c.json({ rows: [] }));
    expect(() => assertPolicyCoverage([...app.routes, ...newRoutes.routes]))
      .toThrow(`Missing unknown-param policy: ${path}`);
  });

  it("also rejects an unclassified ALL registration that can serve GET", () => {
    const newRoutes = createRouteModule();
    newRoutes.all("/api/v1/data/uncovered-all", (c) => c.json({ rows: [] }));
    expect(() => assertPolicyCoverage([...app.routes, ...newRoutes.routes]))
      .toThrow("Missing unknown-param policy: /api/v1/data/uncovered-all");
  });

  it.each(liveLists)("%s ignores bogus_param without changing results or D1 queries", async (path) => {
    const policy = LIST_POLICIES[path];
    if (!policy) throw new Error(`Missing unknown-param policy: ${path}`);
    expect(policy.unknownParams).toBe("ignore");

    // Bare, filtered offset, and seek-pagination requests all keep their exact
    // query/bind shape. A nonempty fixture avoids vacuous empty-list equality.
    const queries = ["", policy.filteredQuery];
    if (!path.endsWith("/changes")) queries.push(`${policy.filteredQuery}&cursor=3`);
    for (const query of queries) {
      const baseline = await probe(path, query);
      const unknown = await probe(path, `${query}${query ? "&" : ""}bogus_param=1`);
      expect(baseline.response.status).toBe(200);
      expect(unknown.response.status).toBe(200);
      expect(unknown.response.headers.get("content-type")).toContain("application/json");
      const body = await baseline.response.json();
      expect(body).toMatchObject({ rows: [SYNTHETIC_ROW], total: 1 });
      expect(await unknown.response.json()).toEqual(body);
      expect(baseline.recording.selects.length).toBeGreaterThan(0);
      expect(unknown.recording.selects).toEqual(baseline.recording.selects);
      expect(baseline.recording.runs).toEqual([]);
      expect(baseline.recording.batches).toEqual([]);
      expect(unknown.recording.runs).toEqual([]);
      expect(unknown.recording.batches).toEqual([]);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(liveLists)("%s still rejects an invalid known key before querying D1", async (path) => {
    const { response, recording } = await probe(path, "limit=501&bogus_param=1");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 400, detail: expect.stringContaining("limit") });
    expect(recording.selects).toEqual([]);
    expect(recording.runs).toEqual([]);
    expect(recording.batches).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
