import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import app from "../src/app";
import { APP_VERSION } from "../src/lib/version";
import { ensureD1TestTables } from "./d1TestMigrations";
import { isUpstreamUrl } from "./upstreamHost";

/**
 * Blind runtime contract: BUILD_VERSION is optional deployment metadata on Env,
 * not a package/API version. Its only new wire field is X-Build-Version, exposed
 * through CORS for browser clients. No new endpoint or health/OpenAPI JSON field.
 * A canonical stable UTC YYYY.MDD.P comes only from this binding, never a client
 * or upstream response header. Date examples are literal calendar cases, not an
 * allocator reimplementation. Existing status/body/auth/header posture must stay.
 *
 * All requests use app.fetch, synthetic D1 rows and the existing pool bindings.
 * Every outbound fetch is stubbed; unmatched operations throw without fallback.
 */
const TEST_ENV = env as unknown as Env;
const VERSION = "2026.303.0";
const ORIGIN = "https://browser.example.test";
const ID = 970031;
const NAME = "Synthetic build identity fixture";
const PATH = `/api/v1/customer-snapshot/${ID}?fields=company_name`;
const originalFetch = globalThis.fetch;
let outbound: ReturnType<typeof vi.fn>;
let expectedOutbound = 0;

function bindings(buildVersion?: string): Env {
  const result: Env = { ...TEST_ENV };
  // These operations intentionally also typecheck the optional string binding:
  // a required or undeclared BUILD_VERSION fails the existing TS test config.
  delete result.BUILD_VERSION;
  if (buildVersion !== undefined) result.BUILD_VERSION = buildVersion;
  return result;
}

async function call(path: string, testEnv: Env, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers({
    origin: ORIGIN,
    "x-request-id": "synthetic-build-identity",
    "cf-connecting-ip": "192.0.2.231",
  });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return app.fetch(new Request(`https://worker.example.test${path}`, { ...init, headers }), testEnv);
}
const authorized = { authorization: `Bearer ${TEST_ENV.CUSTOMER_SNAPSHOT_SYNC_SECRET}` };

function posture(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("vary")).toMatch(/origin/i);
  expect(response.headers.get("set-cookie")).toBeNull();
}
function exposed(response: Response): Set<string> {
  return new Set((response.headers.get("access-control-expose-headers") ?? "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  expectedOutbound = 0;
  outbound = vi.fn(async () => { throw new Error("Unexpected outbound fetch in build identity acceptance"); });
  globalThis.fetch = outbound as typeof fetch;
  await TEST_ENV.CUSTOMER_DB.prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(ID).run();
  await TEST_ENV.CUSTOMER_DB.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, '2026-03-03T00:00:00.000Z')"
  ).bind(ID, NAME).run();
});
afterEach(() => {
  try { expect(outbound).toHaveBeenCalledTimes(expectedOutbound); }
  finally { globalThis.fetch = originalFetch; vi.restoreAllMocks(); }
});

describe("operational build identity is separate from the SemVer consumer contract", () => {
  it("keeps APP_VERSION and the exact public health JSON package-driven with or without a build label", async () => {
    expect(packageJson.version).toMatch(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
    expect(packageJson.version).not.toMatch(/^20\d{2}\./);
    expect(APP_VERSION).toBe(packageJson.version);
    for (const version of [undefined, VERSION]) {
      const response = await call("/api/v1/health", bindings(version));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ status: "ok", service: "routeware-shadow-api", version: packageJson.version });
      posture(response);
      expect(response.headers.get("x-build-version")).toBe(version ?? null);
    }
  });

  it("keeps OpenAPI info.version and the health example SemVer rather than deployment CalVer", async () => {
    const response = await call("/openapi.json", { ...bindings(VERSION), OPENAPI_DOCS_ENABLED: "true" });
    expect(response.status).toBe(200);
    const spec = await response.json() as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, { get: { responses: Record<string, { content: Record<string, { example?: unknown }> }> } }>;
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Routeware Shadow API");
    expect(spec.info.version).toBe(packageJson.version);
    expect(spec.paths["/api/v1/health"].get.responses["200"].content["application/json"].example)
      .toEqual({ status: "ok", service: "routeware-shadow-api", version: packageJson.version });
    expect(JSON.stringify(spec)).not.toContain(`"version":"${VERSION}"`);
    expect(response.headers.get("x-build-version")).toBe(VERSION);
  });
});

it.each(["2026.105.0", VERSION, "2026.1001.2", "2026.1231.9", "2024.229.10"])(
  "serves the canonical stable calendar build %s verbatim", async (version) => {
    const response = await call("/api/v1/health", bindings(version));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "routeware-shadow-api", version: packageJson.version });
    expect(response.headers.get("x-build-version")).toBe(version);
  }
);

it.each([
  undefined, "", "not-a-build", "2026.0303.0", "2026.33.0", "2026.303.00",
  "v2026.303.0", "build/v2026.303.0", "2026.303.0-canary.1", "2026.303.0+sha7",
  "2026.229.0", "2026.431.0", "2026.1301.0", "2026.000.0", "2026.303.-1",
  " 2026.303.0", "2026.303.0 ", "2026.303.0\n", "2026.303.0\r\nx-spoof: true",
  "2026.303.9007199254740992",
])("omits missing/noncanonical build %j without inventing a fallback version", async (version) => {
  const response = await call("/api/v1/health", bindings(version));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", service: "routeware-shadow-api", version: packageJson.version });
  posture(response);
  expect(response.headers.get("x-build-version")).toBeNull();
});

const scenarios: Array<{ name: string; path: string; status: number; init?: RequestInit; error?: boolean }> = [
  { name: "public health", path: "/api/v1/health", status: 200 },
  { name: "missing bearer", path: PATH, status: 401 },
  { name: "wrong bearer", path: PATH, status: 401, init: { headers: { authorization: "Bearer synthetic-wrong-token" } } },
  { name: "authorized local success", path: PATH, status: 200, init: { headers: authorized } },
  { name: "preflight before auth", path: PATH, status: 204, init: { method: "OPTIONS", headers: {
    "access-control-request-method": "GET", "access-control-request-headers": "authorization, content-type",
  } } },
  { name: "authorized not found", path: "/api/v1/no-such-build-route", status: 404, init: { headers: authorized } },
  { name: "handler D1 error", path: PATH, status: 500, init: { headers: authorized }, error: true },
];

it.each(scenarios)("adds build identity on $name without changing its status/body/auth/posture", async (scenario) => {
  let reads = 0;
  const brokenDb = { prepare() { reads++; throw new Error("Synthetic D1 build-identity fault"); } } as unknown as D1Database;
  const controlEnv = bindings();
  const versionedEnv = bindings(VERSION);
  if (scenario.error) {
    controlEnv.CUSTOMER_DB = brokenDb;
    versionedEnv.CUSTOMER_DB = brokenDb;
  }
  const control = await call(scenario.path, controlEnv, scenario.init);
  const versioned = await call(scenario.path, versionedEnv, scenario.init);
  expect(control.status).toBe(scenario.status);
  expect(versioned.status).toBe(scenario.status);
  const bytes = await versioned.text();
  expect(bytes).toBe(await control.text());
  expect(versioned.headers.get("content-type")).toBe(control.headers.get("content-type"));
  if (scenario.error) expect(reads).toBe(2); // Prove the handler, not missing middleware bindings, failed.
  if (scenario.status >= 400) {
    expect(versioned.headers.get("content-type")).toContain("application/problem+json");
    expect(JSON.parse(bytes)).toMatchObject({ status: scenario.status });
  }
  if (scenario.name === "authorized local success") expect(JSON.parse(bytes)).toEqual({ customer_id: ID, company_name: NAME });
  if (scenario.status === 204) {
    expect(bytes).toBe("");
    expect(versioned.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(versioned.headers.get("access-control-allow-methods")).toContain("GET");
    expect(versioned.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
    expect(versioned.headers.get("access-control-max-age")).toBe("86400");
  } else {
    posture(versioned);
    const tokens = exposed(versioned);
    for (const header of ["etag", "retry-after", "content-disposition", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-request-id"]) {
      expect(tokens.has(header)).toBe(true);
    }
  }
  expect(control.headers.get("x-build-version")).toBeNull();
  expect(versioned.headers.get("x-build-version")).toBe(VERSION);
});

it("exposes the optional response identity to browsers while retaining existing exposed headers", async () => {
  const response = await call("/api/v1/health", bindings(VERSION));
  expect(response.status).toBe(200);
  await response.text();
  expect(exposed(response).has("x-build-version")).toBe(true);
});

it("keeps the no-token deployment fail-closed, with build metadata unable to bypass authorization", async () => {
  const testEnv = { ...bindings(VERSION), SHADOW_API_TOKEN: undefined, CUSTOMER_SNAPSHOT_SYNC_SECRET: undefined, SHADOW_API_READ_TOKEN: undefined } as unknown as Env;
  const response = await call(PATH, testEnv, { headers: { "x-build-version": VERSION } });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ status: 401 });
  posture(response);
  expect(response.headers.get("x-build-version")).toBe(VERSION);
});

it.each([undefined, "not-a-build", VERSION])("client build header never supplies or overrides binding %j", async (version) => {
  const response = await call("/api/v1/health", bindings(version), { headers: { "X-Build-Version": "2099.1231.9" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", service: "routeware-shadow-api", version: packageJson.version });
  expect(response.headers.get("x-build-version")).toBe(version === VERSION ? VERSION : null);
});

it.each([undefined, "not-a-build", VERSION])("upstream build header never supplies or overrides binding %j", async (version) => {
  expectedOutbound = 1;
  outbound = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (!isUpstreamUrl(url.href) || url.pathname !== "/WebRW/Home/Index" || method !== "GET") {
      throw new Error(`Unexpected outbound operation in build identity acceptance: ${method} ${url.pathname}`);
    }
    return new Response("synthetic-upstream-body", { status: 200, headers: {
      "content-type": "text/plain", "x-build-version": "2099.1231.9", "set-cookie": "synthetic=not-a-session; Secure",
    } });
  });
  globalThis.fetch = outbound as typeof fetch;
  const response = await call("/api/v1/routeware/home/index", bindings(version), { headers: authorized });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("synthetic-upstream-body");
  posture(response);
  expect(response.headers.get("x-build-version")).toBe(version === VERSION ? VERSION : null);
});
