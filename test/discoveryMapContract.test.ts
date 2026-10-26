/// <reference types="vite/client" />
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import routeMapJson from "../tools/api-discovery/route-map.json";
import {
  assertExactUpstreamCall,
  installUpstreamStub,
  shadowRequestFor,
  type RouteMapEntry,
  type UpstreamCall
} from "./discoveryForwardingHarness";

/**
 * Mounted-operation + exact-forwarding contract for the discovery route map
 * (roadmap R12-04). Counterpart of tools/api-discovery/route-map-validation
 * .test.mjs (`node --test`), which pins the library/CLI behavior on synthetic
 * maps. This file runs under workerd and checks the REAL route map against
 * the REAL Worker:
 *
 * - every mapped shadow method + path resolves to an operation the Worker
 *   publishes at /openapi.json (no operationId involved), through the SAME
 *   shared validation library the CLI and artifact scripts use
 *   (tools/api-discovery/lib/routeMapValidation.mjs, built by the paired
 *   build; this file never edits it);
 * - the Worker forwards each mapped route to exactly the mapped upstream
 *   method + pathname + intended query, and refuses lookalike, wrong-method
 *   and unmapped shadow targets WITHOUT any upstream call;
 * - the stub throws on any unexpected outbound fetch (nothing is recorded or
 *   replayed against the real tenant).
 */

const routeMap = routeMapJson as RouteMapEntry[];
const API_TOKEN = "test-api-token";

type ValidationLib = {
  validateRouteMap: (
    map: unknown,
    opts?: { mountedOperations?: string[] }
  ) => { ok: boolean; findings: Array<{ code: string; checkId: string }>; checks: Array<{ id: string; status: string }> };
  mountedOperationsFromOpenApi: (doc: unknown) => string[];
};

const libModules = import.meta.glob("../tools/api-discovery/lib/routeMapValidation.mjs");

async function validationLib(): Promise<ValidationLib> {
  const load = libModules["../tools/api-discovery/lib/routeMapValidation.mjs"];
  if (!load) {
    throw new Error("tools/api-discovery/lib/routeMapValidation.mjs must exist (shared route-map validation library)");
  }
  return (await load()) as ValidationLib;
}

async function openApiDocument(): Promise<unknown> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return res.json();
}

describe("route map → published operations (shared validator)", () => {
  it("every mapped shadow method+path is a mounted, documented operation", async () => {
    const { validateRouteMap, mountedOperationsFromOpenApi } = await validationLib();
    const mountedOperations = mountedOperationsFromOpenApi(await openApiDocument());
    expect(mountedOperations.length).toBeGreaterThan(0);

    const result = validateRouteMap(routeMap, { mountedOperations });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === "route-map.mounted-operation")?.status).toBe("pass");
  });

  it("a map entry pointing at an unpublished shadow route is reported against the live document", async () => {
    const { validateRouteMap, mountedOperationsFromOpenApi } = await validationLib();
    const mountedOperations = mountedOperationsFromOpenApi(await openApiDocument());

    const bogus = [
      ...routeMap,
      {
        method: "POST",
        upstreamPath: "/WebRW/Synthetic/NotMounted",
        shadowPath: "/api/v1/routeware/synthetic/not-mounted"
      }
    ];
    const result = validateRouteMap(bogus, { mountedOperations });

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual(["SHADOW_OPERATION_NOT_MOUNTED"]);
  });

  it("the real map has no duplicate upstream identity or conflicting shadow mapping", async () => {
    const { validateRouteMap } = await validationLib();
    const result = validateRouteMap(routeMap);
    expect(result.findings).toEqual([]);
  });
});

describe("shadow Worker refuses what the map does not name (no upstream call)", () => {
  let upstream: ReturnType<typeof installUpstreamStub>;

  beforeEach(() => {
    upstream = installUpstreamStub(routeMap);
  });

  afterEach(() => {
    upstream.restore();
  });

  async function call(method: string, path: string): Promise<Response> {
    return exports.default.fetch(`http://test.local${path}`, {
      method,
      headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
      body: method === "GET" ? undefined : "{}"
    });
  }

  const first = routeMap[0];

  const LOOKALIKES: Array<[string, string, string]> = [
    ["suffix lookalike", first.method, `${first.shadowPath}x`],
    ["prefix lookalike", first.method, `/x${first.shadowPath}`],
    ["extra trailing segment", first.method, `${first.shadowPath}/extra`],
    ["nonexistent shadow target", first.method, "/api/v1/routeware/customer/not-a-mapped-route"]
  ];
  for (const [name, method, path] of LOOKALIKES) {
    it(`${name} (${method} ${path}) is a 404 and never reaches the upstream`, async () => {
      const res = await call(method, path);
      expect(res.status).toBe(404);
      expect(upstream.calls).toEqual([]);
    });
  }

  for (const route of routeMap) {
    const wrong = route.method === "GET" ? "DELETE" : "GET";
    const allowedHere = routeMap.some((r) => r.shadowPath === route.shadowPath && r.method === wrong);
    if (allowedHere) continue;
    it(`${wrong} ${route.shadowPath} (mapped as ${route.method}) is refused and never reaches the upstream`, async () => {
      const res = await call(wrong, route.shadowPath);
      expect([404, 405]).toContain(res.status);
      expect(upstream.calls).toEqual([]);
    });
  }
});

describe("exact forwarding assertion (hermetic)", () => {
  const route: RouteMapEntry = {
    method: "POST",
    upstreamPath: "/WebRW/Customer/CustomersRead",
    shadowPath: "/api/v1/routeware/customer/customers-read"
  };
  const call = (over: Partial<UpstreamCall>): UpstreamCall => ({
    method: "POST",
    url: "https://killeen.routeware.com/WebRW/Customer/CustomersRead",
    internalToken: false,
    ...over
  });

  it("accepts the exact method, pathname and no query", () => {
    expect(() => assertExactUpstreamCall([call({})], route)).not.toThrow();
  });

  it("ignores the Worker's own anti-forgery token prefetch but still needs the one forwarded call", () => {
    const token = call({
      method: "GET",
      url: "https://killeen.routeware.com/WebRW/Customer/AddNewLong",
      internalToken: true
    });
    expect(() => assertExactUpstreamCall([token, call({})], route)).not.toThrow();
    expect(() => assertExactUpstreamCall([token], route)).toThrow(/exactly one forwarded upstream call/);
  });

  const BAD: Array<[string, Partial<UpstreamCall>]> = [
    ["suffix lookalike path", { url: "https://killeen.routeware.com/WebRW/Customer/CustomersReadX" }],
    ["prefix lookalike path", { url: "https://killeen.routeware.com/Evil/WebRW/Customer/CustomersRead" }],
    ["different letter case", { url: "https://killeen.routeware.com/webrw/customer/customersread" }],
    ["extra trailing slash", { url: "https://killeen.routeware.com/WebRW/Customer/CustomersRead/" }],
    ["unintended query", { url: "https://killeen.routeware.com/WebRW/Customer/CustomersRead?customerID=1" }],
    ["wrong method", { method: "GET" }]
  ];
  for (const [name, over] of BAD) {
    it(`rejects ${name}`, () => {
      expect(() => assertExactUpstreamCall([call(over)], route)).toThrow();
    });
  }

  it("requires the intended GET query to be forwarded exactly", () => {
    const get: RouteMapEntry = {
      method: "GET",
      upstreamPath: "/WebRW/Customer/LoadLongCustomerModal",
      shadowPath: "/api/v1/routeware/customer/load-long-modal",
      exampleQuery: "customerID=345734"
    };
    const base = "https://killeen.routeware.com/WebRW/Customer/LoadLongCustomerModal";
    expect(() =>
      assertExactUpstreamCall([call({ method: "GET", url: `${base}?customerID=345734` })], get)
    ).not.toThrow();
    expect(() => assertExactUpstreamCall([call({ method: "GET", url: base })], get)).toThrow(/query/);
    expect(() =>
      assertExactUpstreamCall([call({ method: "GET", url: `${base}?customerID=1` })], get)
    ).toThrow(/query/);
  });
});

describe("upstream stub is a tripwire, not a recorder", () => {
  let upstream: ReturnType<typeof installUpstreamStub>;
  beforeEach(() => {
    upstream = installUpstreamStub(routeMap);
  });
  afterEach(() => {
    upstream.restore();
  });

  it("throws on a non-upstream host", async () => {
    await expect(fetch("https://example.invalid/anything")).rejects.toThrow(/Unexpected outbound fetch/);
  });

  it("throws on an upstream path or method the map does not contain", async () => {
    await expect(fetch("https://killeen.routeware.com/WebRW/Customer/NotMapped", { method: "POST" })).rejects.toThrow(
      /Unexpected upstream fetch/
    );
    await expect(
      fetch("https://killeen.routeware.com/WebRW/Customer/CustomersRead", { method: "DELETE" })
    ).rejects.toThrow(/Unexpected upstream fetch/);
  });

  it("every mapped route forwards through the stub with one exact call", async () => {
    for (const route of routeMap) {
      upstream.calls.length = 0;
      const { url, init } = shadowRequestFor(route);
      const res = await exports.default.fetch(url, init);
      expect(res.status).toBe(200);
      assertExactUpstreamCall(upstream.calls, route);
    }
  });
});

describe("one shared implementation", () => {
  const sources = import.meta.glob("../tools/api-discovery/*.mjs", {
    query: "?raw",
    import: "default",
    eager: true
  }) as Record<string, string>;

  for (const script of ["route-map-validation", "route-gap", "export-curl-examples", "suggest-routes"]) {
    it(`${script}.mjs imports the shared routeMapValidation library`, () => {
      const src = sources[`../tools/api-discovery/${script}.mjs`];
      expect(src, `${script}.mjs must exist`).toBeTypeOf("string");
      const imports = /from\s*["']\.\/lib\/routeMapValidation\.mjs["']/.test(src);
      expect(imports, `${script}.mjs must import ./lib/routeMapValidation.mjs`).toBe(true);
    });
  }
});
