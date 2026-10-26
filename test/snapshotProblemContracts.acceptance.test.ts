import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import baseline from "./fixtures/snapshotProblemContracts.baseline.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test-Author oracle: typed EXISTING flat snapshot GET problems.
 * No implementation imports beyond the mounted app; local D1 and synthetic data
 * only. RED = missing discovery contract. Controls = observed baseline wire and
 * pre-existing success/304/selector contracts; declaration work must not move them.
 *
 * Mutation targets: omit one of nine problem media schemas; inline divergent
 * shapes; require instance/requestId; invent diagnostics fields or closed type
 * origins; change error serialization, auth order, validators or cache posture;
 * erase existing selector guidance or success contracts. No speculative 401/500
 * schema requirement: those middleware contracts are NOT this slice.
 *
 * Builder consumes immutable tests, never edits them. Run:
 * npx vitest run --maxWorkers=2 test/snapshotProblemContracts.acceptance.test.ts
 */
const TEST_ENV = env as unknown as Env;
const TOKEN = "test-read-token";
const ORIGIN = "https://problem-client.invalid";
const TYPE_BASE = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";
const CUSTOM_BASE = "https://synthetic-problem-docs.invalid/problems#";
const MISSING_ID = "999999937";
const VALUE_MARKER = "SYNTHETIC-QUERY-VALUE";
const PROBLEM_MEDIA = "application/problem+json";
const SPECS = [
  { name: "customer", param: "customerId", column: "customer_id", noun: "snapshot" },
  { name: "address", param: "pickupAddressId", column: "pickup_address_id", noun: "address" },
  { name: "container", param: "containerId", column: "container_id", noun: "container" }
] as const;
type Spec = typeof SPECS[number];
type Json = Record<string, unknown>;
type Schema = Json & {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
};
type Media = { schema?: Schema; example?: unknown; examples?: Record<string, { value?: unknown }> };
type Operation = {
  operationId: string;
  parameters: Array<{ in: string; name: string; required?: boolean }>;
  responses: Record<string, { description: string; content?: Record<string, Media> }>;
};
type Document = { paths: Record<string, { get: Operation }>; components: { schemas: Record<string, Schema> } };
const listPath = (s: Spec) => `/api/v1/${s.name}-snapshot`;
const detailPath = (s: Spec) => `${listPath(s)}/{${s.param}}`;

// Hand-derived expected bodies, independently checked against the baseline local
// inventory. ID failures intentionally retain their existing instance fragment;
// this is not permission to expand echoing or a broad redaction-policy change.
function cases(s: Spec) {
  const base = listPath(s);
  return [
    { label: "list validator", url: `${base}?limit=0`, mounted: base, status: 400,
      detail: "Invalid request query (limit). See docs/PROBLEMS.md#bad-request." },
    { label: "list fields validator", url: `${base}?fields=${VALUE_MARKER}`, mounted: base, status: 400,
      detail: "Invalid request query (fields). See docs/PROBLEMS.md#bad-request." },
    { label: "list strict unknown key", url: `${base}?strictQuery=true&syntheticUnknown=${VALUE_MARKER}`,
      mounted: base, status: 400,
      detail: "Unknown query parameter. Use supported query names from this mounted OpenAPI operation, remove unknown keys, or set strictQuery=false. See docs/PROBLEMS.md#bad-request." },
    { label: "by-ID fields validator", url: `${base}/1?fields=${VALUE_MARKER}`, mounted: detailPath(s), status: 400,
      detail: "Invalid request query (fields). See docs/PROBLEMS.md#bad-request." },
    { label: "by-ID invalid ID", url: `${base}/0`, mounted: detailPath(s), status: 400,
      detail: `${s.param} must be a positive integer. See docs/PROBLEMS.md#bad-request.`,
      instance: `${base}/0#${s.param}=0` },
    { label: "by-ID missing row", url: `${base}/${MISSING_ID}`, mounted: detailPath(s), status: 404,
      detail: `No ${s.noun} row for ${s.column}=${MISSING_ID}. See docs/PROBLEMS.md#not-found.`,
      instance: `${base}/${MISSING_ID}#${s.column}=${MISSING_ID}` }
  ];
}
type Case = ReturnType<typeof cases>[number];
function expectedBody(c: Case, typeBase = TYPE_BASE): Json {
  return {
    type: `${typeBase}${c.status === 400 ? "bad-request" : "not-found"}`,
    title: c.status === 400 ? "Bad Request" : "Not Found",
    status: c.status,
    detail: c.detail,
    ...("instance" in c ? { instance: c.instance } : {})
  };
}

let outbound: ReturnType<typeof vi.fn>;
let forbiddenDb: ReturnType<typeof vi.fn>;
let noDb: D1Database;
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  outbound = vi.fn(async () => { throw new Error("No outbound fetch allowed in problem-contract oracle"); });
  vi.stubGlobal("fetch", outbound);
  forbiddenDb = vi.fn(() => { throw new Error("Invalid input/auth must reject before D1"); });
  noDb = { prepare: forbiddenDb, batch: forbiddenDb, exec: forbiddenDb } as unknown as D1Database;
  // Real isolated local D1, empty by construction. No upstream/R2 fixtures.
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
});
afterEach(() => {
  try {
    expect(outbound).not.toHaveBeenCalled();
    expect(forbiddenDb).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

async function get(url: string, options: {
  requestId?: string; token?: string | null; db?: D1Database; typeBase?: string;
} = {}) {
  const headers = new Headers({ origin: ORIGIN, "if-none-match": "*" });
  if (options.requestId !== undefined) headers.set("x-request-id", options.requestId);
  if (options.token !== null) headers.set("authorization", `Bearer ${options.token ?? TOKEN}`);
  return app.fetch(new Request(`http://test.local${url}`, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: options.db ?? TEST_ENV.CUSTOMER_DB,
    ...(options.typeBase === undefined ? {} : { PROBLEM_TYPE_BASE: options.typeBase })
  });
}
async function document(): Promise<Document> {
  const res = await get("/openapi.json");
  expect(res.status).toBe(200);
  return await res.json() as Document;
}
function operation(doc: Document, path: string): Operation {
  const op = doc.paths[path]?.get;
  expect(op, `${path}: mounted GET`).toBeDefined();
  return op;
}
function resolve(doc: Document, schema: Schema, seen: string[] = []): Schema {
  if (!schema.$ref) return schema;
  expect(schema.$ref).toMatch(/^#\/components\/schemas\//);
  expect(seen).not.toContain(schema.$ref);
  const target = doc.components.schemas[schema.$ref.slice("#/components/schemas/".length)];
  expect(target, `resolve ${schema.$ref}`).toBeDefined();
  return resolve(doc, target, [...seen, schema.$ref]);
}
function problemMedia(doc: Document, path: string, status: number): Media {
  const response = operation(doc, path).responses[String(status)];
  expect(response, `${path}: ${status} response`).toBeDefined();
  expect(Object.keys(response.content ?? {}), `${path}: ${status} has problem media, not JSON success`).toEqual([PROBLEM_MEDIA]);
  const media = response.content?.[PROBLEM_MEDIA];
  expect(media?.schema, `${path}: ${status} discoverable body schema`).toBeDefined();
  return media!;
}

// Deliberately small JSON-schema consumer for this six-field object contract.
// Resolves mounted refs/unions and checks constraints on actual wire values;
// expectations never import the serializer/type/schema under test.
function conforms(doc: Document, declared: Schema, value: unknown): boolean {
  const s = resolve(doc, declared);
  if (s.allOf && !s.allOf.every((arm) => conforms(doc, arm, value))) return false;
  if (s.anyOf && !s.anyOf.some((arm) => conforms(doc, arm, value))) return false;
  if (s.oneOf && s.oneOf.filter((arm) => conforms(doc, arm, value)).length !== 1) return false;
  if (s["enum"] && !(s["enum"] as unknown[]).includes(value)) return false;
  if ("const" in s && s["const"] !== value) return false;
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  if (types.length && !types.some((t) => t === "null" ? value === null :
    t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) :
    t === "integer" ? typeof value === "number" && Number.isInteger(value) : typeof value === t)) return false;
  if (typeof value === "string") {
    if (typeof s["minLength"] === "number" && [...value].length < s["minLength"]) return false;
    if (typeof s["maxLength"] === "number" && [...value].length > s["maxLength"]) return false;
    if (typeof s["pattern"] === "string" && !new RegExp(s["pattern"]).test(value)) return false;
    if (s["format"] === "uri") { try { new URL(value); } catch { return false; } }
  }
  if (typeof value === "number") {
    if (typeof s["minimum"] === "number" && value < s["minimum"]) return false;
    if (typeof s["maximum"] === "number" && value > s["maximum"]) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const body = value as Json;
    if ((s.required ?? []).some((key) => !(key in body))) return false;
    if (s["additionalProperties"] === false && Object.keys(body).some((key) => !s.properties?.[key])) return false;
    for (const [key, prop] of Object.entries(s.properties ?? {})) {
      if (key in body && !conforms(doc, prop, body[key])) return false;
    }
  }
  return true;
}

// Stable, sorted JSON digest: bounded fixture pins complete success/304 and
// transitive success schemas without duplicating their large worked examples.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const REQUEST_IDS = [undefined, "Problem-client-123", "bad/id"];
describe.each(SPECS)("$name observed local error controls", (spec) => {
  describe.each(cases(spec))("$label", (c) => {
    it.each(REQUEST_IDS)("preserves exact bytes and optional omissions, request ID=%s", async (requestId) => {
      const res = await get(c.url, { requestId, db: c.status === 404 ? TEST_ENV.CUSTOMER_DB : noDb });
      expect(res.status).toBe(c.status);
      expect(res.headers.get("content-type")).toBe(PROBLEM_MEDIA);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const correlation = res.headers.get("x-request-id");
      if (requestId === "Problem-client-123") expect(correlation).toBe(requestId);
      else {
        expect(correlation).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
        expect(correlation).not.toBe("bad/id");
      }
      const bytes = await res.text();
      expect(bytes).toBe(JSON.stringify(expectedBody(c)));
      expect(bytes).not.toContain(VALUE_MARKER);
      expect(JSON.parse(bytes)).not.toHaveProperty("requestId");
    });
  });

  it("auth precedes query/ID validation and carries requestId only on the existing 401 body", async () => {
    for (const url of [`${listPath(spec)}?limit=0`, `${listPath(spec)}/0?fields=${VALUE_MARKER}`]) {
      const res = await get(url, { token: null, db: noDb, requestId: "Problem-auth-control" });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe(PROBLEM_MEDIA);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ status: 401, requestId: "Problem-auth-control" });
    }
  });

  it("existing type identity honors a synthetic deployment base without changing optional fields", async () => {
    for (const c of cases(spec)) {
      const res = await get(c.url, { typeBase: CUSTOM_BASE, db: c.status === 404 ? TEST_ENV.CUSTOMER_DB : noDb });
      expect(res.status).toBe(c.status);
      expect(await res.text()).toBe(JSON.stringify(expectedBody(c, CUSTOM_BASE)));
    }
  });
});

describe("mounted error discovery contract", () => {
  const contracts = SPECS.flatMap((s) => [
    { path: listPath(s), status: 400 }, { path: detailPath(s), status: 400 }, { path: detailPath(s), status: 404 }
  ]);
  it.each(contracts)("RED: $path $status publishes the existing six-field reusable problem shape", async ({ path, status }) => {
    const doc = await document();
    const schema = problemMedia(doc, path, status).schema!;
    expect(schema.$ref, "reusable component, not a competing inline shape").toMatch(/^#\/components\/schemas\//);
    const body = resolve(doc, schema);
    expect(body.type).toBe("object");
    expect([...(body.required ?? [])].sort()).toEqual(["status", "title", "type"]);
    expect(Object.keys(body.properties ?? {}).sort()).toEqual(["detail", "instance", "requestId", "status", "title", "type"]);
    for (const key of ["type", "title", "detail", "instance", "requestId"]) {
      expect(resolve(doc, body.properties![key]).type, key).toBe("string");
    }
    expect(["integer", "number"]).toContain(resolve(doc, body.properties!.status).type);
    const type = resolve(doc, body.properties!.type);
    expect(type).not.toHaveProperty("enum");
    expect(type).not.toHaveProperty("const");
    expect(conforms(doc, schema, { type: CUSTOM_BASE + "bad-request", title: "Bad Request", status: 400 })).toBe(true);
    expect(conforms(doc, schema, { type: CUSTOM_BASE + "not-found", title: "Not Found", status: 404,
      detail: "Synthetic problem", instance: "/synthetic", requestId: "Synthetic-correlation" })).toBe(true);
    for (const key of ["type", "title", "status"]) {
      const minimal: Json = { type: CUSTOM_BASE + "bad-request", title: "Bad Request", status: 400 };
      delete minimal[key];
      expect(conforms(doc, schema, minimal), `missing required ${key}`).toBe(false);
    }
  });

  it("RED: all nine error responses share exactly one component reference", async () => {
    const doc = await document();
    const refs = contracts.map(({ path, status }) => problemMedia(doc, path, status).schema!.$ref);
    expect(refs).toHaveLength(9);
    expect(refs.every((ref) => typeof ref === "string")).toBe(true);
    expect(new Set(refs).size).toBe(1);
  });

  it.each(SPECS)("RED: $name observed bodies conform to their mounted media schema, including omissions", async (s) => {
    const doc = await document();
    for (const c of cases(s)) {
      const schema = problemMedia(doc, c.mounted, c.status).schema!;
      const res = await get(c.url, { requestId: "Problem-body-schema", typeBase: CUSTOM_BASE });
      expect(res.status).toBe(c.status);
      const body = await res.json();
      expect(body).toEqual(expectedBody(c, CUSTOM_BASE));
      expect(conforms(doc, schema, body), `${c.label}: actual body allowed by mounted schema`).toBe(true);
    }
  });

  it.each(contracts)("RED: $path $status has value-free examples that conform and fixed correction guidance", async ({ path, status }) => {
    const doc = await document();
    const media = problemMedia(doc, path, status);
    const examples = media.example === undefined ? Object.values(media.examples ?? {}).map((entry) => entry.value) : [media.example];
    expect(examples.length, "machine-discoverable synthetic example").toBeGreaterThan(0);
    for (const example of examples) {
      expect(conforms(doc, media.schema!, example)).toBe(true);
      expect(example).toMatchObject({ status, title: status === 400 ? "Bad Request" : "Not Found" });
      const body = example as Json;
      expect(String(body.type)).toMatch(status === 400 ? /#bad-request$/ : /#not-found$/);
      const text = JSON.stringify(example);
      expect(text).not.toMatch(/TOG-\d+|Bearer\s+\S+|@|\b(?:customer_id|pickup_address_id|container_id)=\d+/);
      expect(text).not.toContain(VALUE_MARKER);
    }
    // Guidance belongs to the contract, not a new wire extension or new code.
    const description = operation(doc, path).responses[String(status)].description;
    expect(description).toMatch(/correct|retry|check|verify|omit|remove/i);
  });
});

describe("pre-existing contract preservation controls", () => {
  it.each(Object.entries(baseline.operations))("%s retains parameter/response inventories, success and 304 contracts", async (path, pinned) => {
    const doc = await document();
    const op = operation(doc, path);
    expect(op.operationId).toBe(pinned.operationId);
    expect(op.parameters.map((p) => ({ in: p.in, name: p.name, required: p.required ?? false }))).toEqual(pinned.parameters);
    expect(Object.keys(op.responses)).toEqual(pinned.responseStatuses);
    for (const [status, hash] of Object.entries(pinned.successResponses)) {
      expect(await digest(op.responses[status]), `${path} ${status}: complete schema/examples/headers`).toBe(hash);
    }
    for (const [status, description] of Object.entries(pinned.errorDescriptions)) {
      expect(op.responses[status].description.startsWith(description), "existing selector constraints retained verbatim; append guidance if needed").toBe(true);
    }
    expect(Object.keys(op.responses["304"].content ?? {})).toEqual([]);
  });

  it("retains complete transitive success row/envelope component contracts", async () => {
    const doc = await document();
    for (const [name, hash] of Object.entries(baseline.successSchemas)) {
      expect(await digest(doc.components.schemas[name]), name).toBe(hash);
    }
  });
});
