import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";

/**
 * Independent archive problem-base oracle. Omitting the request environment
 * from any archive error branch must fail the custom-base rows below. Expected
 * URLs and bodies are literals, never computed with the problem helpers.
 *
 * Storage is synthetic; routing, auth, correlation and CSV encoding are real.
 * No deployed origin, real bucket, D1, KV or upstream access is permitted.
 * The Builder consumes this oracle unchanged and supplies the runtime fix.
 */
const DEFAULT_BASE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";
const CUSTOM_BASE = "https://archive-errors.example.invalid/problems#";
const CONFIGS = [
  { name: "custom fragment", value: CUSTOM_BASE, want: CUSTOM_BASE },
  {
    name: "custom padded path",
    value: "  https://other-errors.example.invalid/types/  ",
    want: "https://other-errors.example.invalid/types/"
  },
  { name: "absent", value: undefined, want: DEFAULT_BASE },
  { name: "empty", value: "", want: DEFAULT_BASE },
  { name: "whitespace", value: " \t\n ", want: DEFAULT_BASE }
];
const DATE = "2026-09-27";
const ROOT = "/api/v1/snapshots";
const REQUEST_ID = "archive-identity-oracle.17";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE = "SYNTHETIC_BUCKET_CONTENT_MUST_NOT_ESCAPE";
const SYNC_SECRET = "synthetic-archive-sync-secret";
const API_TOKEN = "synthetic-archive-api-token";
const READ_TOKEN = "synthetic-archive-read-token";
const CSV = 'Id,Name\n101,"=1+1"\n';
const SAFE_CSV = 'Id,Name,_shadow_csv_encoding\n101,"\'=1+1",1\n';
const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type Table = "customer" | "address" | "container";
type Endpoint = "date" | "latest" | "dates";
type Fault = "missing" | "object-missing" | "disappeared" | "replaced" |
  "malformed" | "invalid" | "list-error" | "read-error" | "unbound";
type Scenario = {
  endpoint: Endpoint;
  fault: Fault;
  status: number;
  slug: string;
  title: string;
};
const SCENARIOS: Scenario[] = [
  { endpoint: "date", fault: "missing", status: 404, slug: "not-found", title: "Not Found" },
  { endpoint: "date", fault: "disappeared", status: 404, slug: "not-found", title: "Not Found" },
  { endpoint: "date", fault: "replaced", status: 409, slug: "conflict", title: "Conflict" },
  { endpoint: "latest", fault: "missing", status: 404, slug: "not-found", title: "Not Found" },
  { endpoint: "latest", fault: "object-missing", status: 404, slug: "not-found", title: "Not Found" },
  { endpoint: "latest", fault: "disappeared", status: 404, slug: "not-found", title: "Not Found" },
  { endpoint: "latest", fault: "replaced", status: 409, slug: "conflict", title: "Conflict" },
  { endpoint: "latest", fault: "malformed", status: 500, slug: "internal", title: "Internal Server Error" },
  { endpoint: "latest", fault: "invalid", status: 500, slug: "internal", title: "Internal Server Error" },
  { endpoint: "dates", fault: "list-error", status: 500, slug: "internal", title: "Internal Server Error" },
  { endpoint: "dates", fault: "read-error", status: 500, slug: "internal", title: "Internal Server Error" },
  { endpoint: "dates", fault: "malformed", status: 500, slug: "internal", title: "Internal Server Error" },
  { endpoint: "dates", fault: "invalid", status: 500, slug: "internal", title: "Internal Server Error" },
  { endpoint: "date", fault: "unbound", status: 503, slug: "misconfigured", title: "Service Unavailable" },
  { endpoint: "latest", fault: "unbound", status: 503, slug: "misconfigured", title: "Service Unavailable" },
  { endpoint: "dates", fault: "unbound", status: 503, slug: "misconfigured", title: "Service Unavailable" }
];

function pathFor(endpoint: Endpoint, table: Table): string {
  return `${ROOT}/${table}${endpoint === "date" ? `/${DATE}` : endpoint === "latest" ? "/latest" : ""}`;
}

function detailFor(scenario: Scenario, table: Table): string {
  if (scenario.fault === "unbound") {
    return "R2 snapshot archive is not configured (SNAPSHOTS binding unbound). See docs/PROBLEMS.md#misconfigured.";
  }
  if (scenario.endpoint === "dates") {
    return `Snapshot archive date listing for table=${table} is unreadable. ` +
      "Re-run the table sync to republish it. See docs/PROBLEMS.md#internal.";
  }
  if (scenario.status === 500) {
    return `Snapshot latest pointer for table=${table} is unreadable. ` +
      "Re-run the table sync to republish it. See docs/PROBLEMS.md#internal.";
  }
  const selector = `table=${table}${scenario.endpoint === "date" ? ` date=${DATE}` : ""}`;
  return scenario.status === 409
    ? `The snapshot archive for ${selector} was replaced during the download. Retry the download. See docs/PROBLEMS.md#conflict.`
    : `No snapshot archive for ${selector}. See docs/PROBLEMS.md#not-found.`;
}

function manifest(table: Table, key: string): string {
  return JSON.stringify({
    version: 1,
    date: DATE,
    files: { [`${table}.csv`]: { key, sha256: "a".repeat(64), bytes: new TextEncoder().encode(CSV).byteLength } }
  });
}

// Each read returns a fresh, consumable body; conditional failures mirror R2's
// null (deleted) or metadata-only (replaced) response. No timing/sleep oracle.
function objectFor(key: string, text: string): R2ObjectBody {
  const response = new Response(text);
  const contentType = key.endsWith(".csv") ? "text/csv; charset=utf-8" : "application/json";
  return {
    key,
    version: "synthetic-v1",
    etag: "synthetic-etag",
    httpEtag: '"synthetic-etag"',
    size: new TextEncoder().encode(text).byteLength,
    uploaded: new Date(`${DATE}T00:00:00.000Z`),
    checksums: { toJSON: () => ({}) },
    httpMetadata: { contentType },
    customMetadata: {},
    storageClass: "Standard",
    writeHttpMetadata(headers: Headers) { headers.set("content-type", contentType); },
    body: response.body,
    get bodyUsed() { return response.bodyUsed; },
    text: () => response.text(),
    json: () => response.json(),
    arrayBuffer: () => response.arrayBuffer(),
    blob: () => response.blob()
  } as unknown as R2ObjectBody;
}

function fixture(endpoint: Endpoint, table: Table, fault?: Fault) {
  const csvKey = endpoint === "latest"
    ? `snapshot-history/${DATE}/${PRIVATE}/${table}.csv`
    : `snapshots/${DATE}/${table}.csv`;
  const pointerKey = `snapshot-latest/${table}.json`;
  const manifestKey = `snapshots/${DATE}.manifest.json`;
  const gets: Array<{ key: string; options?: R2GetOptions }> = [];
  const lists: R2ListOptions[] = [];
  const bucket = {
    async list(options: R2ListOptions = {}) {
      lists.push(options);
      if (fault === "list-error") throw new Error(PRIVATE);
      return { objects: [{ key: manifestKey }], truncated: false, delimitedPrefixes: [] };
    },
    async get(key: string, options?: R2GetOptions) {
      gets.push({ key, options });
      if (key === pointerKey || key === manifestKey) {
        if (fault === "missing") return null;
        if (fault === "read-error") throw new Error(PRIVATE);
        return objectFor(key, fault === "malformed" ? `{${PRIVATE}` :
          fault === "invalid" ? JSON.stringify({ version: 1, date: DATE, files: { [PRIVATE]: {} } }) :
            manifest(table, csvKey));
      }
      if (key !== csvKey) throw new Error(`Unexpected synthetic key: ${key}`);
      if (fault === "missing" || fault === "object-missing") return null;
      if (options?.onlyIf) {
        if (fault === "disappeared") return null;
        if (fault === "replaced") {
          const { body: _body, ...metadata } = objectFor(key, PRIVATE);
          return metadata;
        }
      }
      return objectFor(key, CSV);
    }
  } as unknown as R2Bucket;
  return { bucket: fault === "unbound" ? undefined : bucket, csvKey, pointerKey, manifestKey, gets, lists };
}

let ip = 0;
function testEnv(bucket: R2Bucket | undefined, base?: string): Env {
  const result = {
    ...env,
    SHADOW_API_TOKEN: API_TOKEN,
    SHADOW_API_READ_TOKEN: READ_TOKEN,
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC_SECRET,
    SNAPSHOTS: bucket,
    PROBLEM_TYPE_BASE: base,
    CUSTOMER_DB: new Proxy({}, { get() { throw new Error("Archive must not access D1"); } })
  } as unknown as Env;
  if (base === undefined) delete (result as unknown as { PROBLEM_TYPE_BASE?: string }).PROBLEM_TYPE_BASE;
  return result;
}

function get(path: string, bindings: Env, token: string | null = SYNC_SECRET, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`http://test.local${path}`, {
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "CF-Connecting-IP": `198.51.100.${1 + ip++ % 250}`,
      "X-Request-Id": REQUEST_ID,
      ...headers
    }
  }), bindings, CTX);
}

function expectHeaders(response: Response, status: number, requestId = REQUEST_ID) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toBe(requestId);
}

function expectAccess(f: ReturnType<typeof fixture>, scenario: Scenario) {
  if (scenario.fault === "unbound") {
    expect(f.gets).toEqual([]);
    expect(f.lists).toEqual([]);
    return;
  }
  if (scenario.endpoint === "dates") {
    expect(f.lists).toEqual([{ prefix: "snapshots/" }]);
    expect(f.gets.map(({ key }) => key)).toEqual(scenario.fault === "list-error" ? [] : [f.manifestKey]);
    return;
  }
  expect(f.lists).toEqual([]);
  const pointer = scenario.endpoint === "latest" ? [f.pointerKey] : [];
  const pointerOnly = scenario.endpoint === "latest" && ["missing", "malformed", "invalid"].includes(scenario.fault);
  const keys = pointerOnly ? pointer : [...pointer, f.csvKey];
  if (["disappeared", "replaced"].includes(scenario.fault)) keys.push(f.csvKey);
  expect(f.gets.map(({ key }) => key)).toEqual(keys);
  if (["disappeared", "replaced"].includes(scenario.fault)) {
    expect(f.gets.at(-1)?.options).toEqual({ onlyIf: { etagMatches: "synthetic-etag" } });
  }
}

describe("archive problem identities", () => {
  let outbound: ReturnType<typeof vi.fn>;
  let logs: unknown[][];
  beforeEach(() => {
    outbound = vi.fn(async () => { throw new Error("Unexpected outbound archive request"); });
    vi.stubGlobal("fetch", outbound);
    logs = [];
    for (const method of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => { logs.push(args); });
    }
  });
  afterEach(() => {
    try {
      expect(outbound).not.toHaveBeenCalled();
      const serialized = JSON.stringify(logs);
      for (const secret of [PRIVATE, SYNC_SECRET, API_TOKEN, READ_TOKEN, CSV]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  describe.each(CONFIGS)("$name base", ({ value, want }) => {
    it.each(SCENARIOS)("$endpoint $fault retains its contract except type base", async (scenario) => {
      // Different table names exercise selector-specific messages, not one hardcoded table.
      const table: Table = scenario.endpoint === "date" ? "address" : scenario.endpoint === "latest" ? "customer" : "container";
      const f = fixture(scenario.endpoint, table, scenario.fault);
      const path = pathFor(scenario.endpoint, table);
      const response = await get(`${path}?limit=2&opaque=${PRIVATE}`, testEnv(f.bucket, value));
      expectHeaders(response, scenario.status);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(response.headers.get("etag")).toBeNull();
      expectAccess(f, scenario);
      const body = await response.json() as Record<string, unknown>;
      // Check unchanged fields before the intentional RED assertion, so a type
      // mismatch cannot hide an accidental status/body/header regression.
      const { type, ...unchanged } = body;
      expect(unchanged).toEqual({
        title: scenario.title,
        status: scenario.status,
        detail: detailFor(scenario, table),
        instance: path
      });
      for (const hidden of [PRIVATE, SYNC_SECRET, API_TOKEN, READ_TOKEN, f.pointerKey, f.csvKey, f.manifestKey]) {
        expect(JSON.stringify(body)).not.toContain(hidden);
      }
      expect(type).toBe(`${want}${scenario.slug}`);
    });
  });

  it.each(["date", "latest", "dates"] as const)("%s rejects non-sync tokens before any bucket work", async (endpoint) => {
    for (const token of [null, API_TOKEN, READ_TOKEN, "synthetic-wrong-token"]) {
      const f = fixture(endpoint, "customer");
      const path = pathFor(endpoint, "customer");
      const response = await get(`${path}?opaque=${PRIVATE}`, testEnv(f.bucket, CUSTOM_BASE), token);
      expectHeaders(response, 401);
      expect(f.gets).toEqual([]);
      expect(f.lists).toEqual([]);
      const body = await response.json() as Record<string, unknown>;
      expect(body.type).toBe(`${CUSTOM_BASE}unauthorized`);
      if (token === API_TOKEN || token === READ_TOKEN) {
        expect(body).toEqual({
          type: `${CUSTOM_BASE}unauthorized`, title: "Unauthorized", status: 401,
          detail: "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.",
          instance: path
        });
      } else {
        expect(body.detail).toContain("SHADOW_API_TOKEN");
      }
      expect(JSON.stringify(body)).not.toContain(PRIVATE);
    }
  });

  it.each(["date", "latest", "dates"] as const)("%s validates before bucket access with a custom base", async (endpoint) => {
    const f = fixture(endpoint, "customer");
    const path = endpoint === "date" ? `${ROOT}/customer/not-a-date` :
      endpoint === "latest" ? `${ROOT}/bogus/latest` : `${ROOT}/customer?limit=0`;
    const response = await get(path, testEnv(f.bucket, CUSTOM_BASE));
    expectHeaders(response, 400);
    expect((await response.json() as { type: string }).type).toBe(`${CUSTOM_BASE}bad-request`);
    expect(f.gets).toEqual([]);
    expect(f.lists).toEqual([]);
  });

  it.each([undefined, "not a request id"])("mints correlation for missing/invalid id %s without changing the problem body", async (requestId) => {
    const f = fixture("latest", "customer", "missing");
    const bindings = testEnv(f.bucket, CUSTOM_BASE);
    const headers = new Headers({ authorization: `Bearer ${SYNC_SECRET}` });
    if (requestId !== undefined) headers.set("x-request-id", requestId);
    const response = await app.fetch(new Request(`http://test.local${ROOT}/customer/latest`, { headers }), bindings, CTX);
    expect(response.headers.get("x-request-id")).toMatch(UUID_RE);
    expectHeaders(response, 404, response.headers.get("x-request-id")!);
    const { type, ...body } = await response.json() as Record<string, unknown>;
    expect(body).toEqual({
      title: "Not Found", status: 404,
      detail: "No snapshot archive for table=customer. See docs/PROBLEMS.md#not-found.",
      instance: `${ROOT}/customer/latest`
    });
    expect(type).toBe(`${CUSTOM_BASE}not-found`);
  });

  it.each(["date", "latest", "dates"] as const)("%s success and conditional requests ignore problem-base configuration", async (endpoint) => {
    let baseline: { text: string; headers: Record<string, string> } | undefined;
    for (const base of [undefined, CUSTOM_BASE]) {
      const f = fixture(endpoint, "customer");
      const bindings = testEnv(f.bucket, base);
      const path = pathFor(endpoint, "customer");
      const response = await get(path, bindings);
      expectHeaders(response, 200);
      const text = await response.text();
      if (endpoint === "dates") {
        expect(JSON.parse(text)).toEqual({ table: "customer", dates: [
          { date: DATE, bytes: new TextEncoder().encode(CSV).byteLength, sha256: "a".repeat(64) }
        ], truncated: false });
        expect(f.gets.map(({ key }) => key)).toEqual([f.manifestKey]);
      } else {
        expect(text).toBe(SAFE_CSV);
        expect(response.headers.get("content-length")).toBe(String(new TextEncoder().encode(SAFE_CSV).byteLength));
        expect(response.headers.get("content-disposition")).toBe(`attachment; filename="customer-${endpoint === "date" ? DATE : "latest"}.csv"`);
      }
      const etag = response.headers.get("etag");
      expect(etag).toMatch(/^"fnv64-[0-9a-f]{16}"$/);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      const actual = { text, headers };
      if (baseline === undefined) baseline = actual;
      else expect(actual).toEqual(baseline);
      for (const conditional of [etag!, "*"]) {
        const cached = await get(path, bindings, SYNC_SECRET, { "if-none-match": conditional });
        expectHeaders(cached, 304);
        expect(cached.headers.get("etag")).toBe(etag);
        expect(await cached.text()).toBe("");
      }
    }
  });
});
