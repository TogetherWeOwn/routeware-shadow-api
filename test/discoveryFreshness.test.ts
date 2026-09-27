/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import routeMapJson from "../tools/api-discovery/route-map.json";
import {
  stubBlock,
  suggestShadowPath,
} from "../tools/api-discovery/lib/stubNaming.mjs";

type RouteMapEntry = {
  method: string;
  upstreamPath: string;
  shadowPath: string;
  exampleFile?: string;
  exampleQuery?: string;
  exampleContentType?: string;
};

const routeMap = routeMapJson as RouteMapEntry[];

// Same ?raw-bundling pattern as problemsAnchorCoverage.test.ts: the suite runs
// inside the workers pool (no node:fs), so repo text is read through Vite.
const srcModules = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const exampleModules = import.meta.glob(
  "../tools/api-discovery/examples/*",
  {
    query: "?raw",
    import: "default",
    eager: true,
  }
) as Record<string, string>;

function liveShadowPaths(): Set<string> {
  const out = new Set<string>();
  const re = /path:\s*"([^"]+)"/g;
  for (const text of Object.values(srcModules)) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.add(m[1]);
    }
  }
  return out;
}

describe("route-map freshness (TOG-7088)", () => {
  it("has the 8 known entries", () => {
    expect(routeMap).toHaveLength(8);
  });

  it("every route-map shadowPath maps to a live createRoute path", () => {
    const live = liveShadowPaths();
    expect(live.size).toBeGreaterThan(0);
    for (const entry of routeMap) {
      expect(
        live.has(entry.shadowPath),
        `${entry.method} ${entry.upstreamPath} → ${entry.shadowPath} has no createRoute`
      ).toBe(true);
    }
  });

  it("every route-map exampleFile exists", () => {
    const available = new Set(
      Object.keys(exampleModules).map((k) => k.replace(/^\.\.\/tools\/api-discovery\//, ""))
    );
    const withFiles = routeMap.filter((e) => e.exampleFile);
    expect(withFiles.length).toBeGreaterThan(0);
    for (const entry of withFiles) {
      expect(
        available.has(entry.exampleFile!),
        `missing example file ${entry.exampleFile}`
      ).toBe(true);
    }
  });
});

describe("stub generator naming (TOG-7088, pure, no browser)", () => {
  it("maps upstream paths to shadow paths deterministically", () => {
    expect(suggestShadowPath("/WebRW/Customer/CustomersRead")).toBe(
      "/api/v1/routeware/customer/customers-read"
    );
    expect(suggestShadowPath("/WebRW/Customer/CustomerTypesRead")).toBe(
      "/api/v1/routeware/customer/customer-types-read"
    );
    expect(suggestShadowPath("/WebRW/Data/appSettingsGet")).toBe(
      "/api/v1/routeware/data/app-settings-get"
    );
    expect(suggestShadowPath("/WebRW/Reports/QueryRequestIsComplete")).toBe(
      "/api/v1/routeware/reports/query-request-is-complete"
    );
  });

  it("pins the full generator output for every current route-map upstream path", () => {
    const expected: Record<string, string> = {
      "/WebRW/Customer/CustomersRead":
        "/api/v1/routeware/customer/customers-read",
      "/WebRW/Customer/GetCustomerDetailFull":
        "/api/v1/routeware/customer/get-customer-detail-full",
      "/WebRW/Customer/CustomerTypesRead":
        "/api/v1/routeware/customer/customer-types-read",
      "/WebRW/Customer/SaveCustomerLongForm":
        "/api/v1/routeware/customer/save-customer-long-form",
      "/WebRW/Customer/AddNewLong": "/api/v1/routeware/customer/add-new-long",
      "/WebRW/Customer/LoadLongCustomerModal":
        "/api/v1/routeware/customer/load-long-customer-modal",
      "/WebRW/Data/appSettingsGet": "/api/v1/routeware/data/app-settings-get",
      "/WebRW/Reports/QueryRequestIsComplete":
        "/api/v1/routeware/reports/query-request-is-complete",
    };
    for (const entry of routeMap) {
      expect(suggestShadowPath(entry.upstreamPath)).toBe(
        expected[entry.upstreamPath]
      );
    }
  });

  it("emits a createRoute hint block per gap", () => {
    const lines = stubBlock({
      method: "POST",
      upstreamPath: "/WebRW/Customer/CustomersRead",
      count: 12,
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("// 12x  POST /WebRW/Customer/CustomersRead");
    expect(lines[1]).toContain(
      'shadowPath "/api/v1/routeware/customer/customers-read"'
    );
    expect(lines[2]).toBe(
      '// → createRoute method: "post", path: "/api/v1/routeware/customer/customers-read"'
    );
    expect(lines[3]).toBe("");
  });
});
