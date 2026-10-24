import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import app from "../src/app";
import { clearAntiForgeryTokenCache } from "../src/lib/customerSaveAutoToken";
import { mapDetailFullToRows } from "../src/lib/detailFullSync";
import { invalidateDataEntity } from "../src/lib/entityDataCache";
import { upsertAddressSnapshotRows, upsertContainerSnapshotRows, upsertCustomerSnapshotRows } from "../src/lib/snapshot/upsert";
import { ensureD1TestTables } from "./d1TestMigrations";

// Contract-only acceptance: the baseline already returns these outcomes. A
// permissive {} response schema must not let a client mistake a landed write
// for a refreshed graph, or accept arbitrary exception text as a recovery code.
// Run: npx vitest run test/saveOutcomeSchemas.acceptance.test.ts --maxWorkers=2

type Schema = {
  $ref?: string;
  type?: string | string[];
  nullable?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  items?: Schema;
  [key: string]: unknown;
};
type Media = { schema: Schema; example?: unknown; examples?: Record<string, { value?: unknown; summary?: string }> };
type Operation = {
  operationId: string;
  description?: string;
  "x-access": string;
  "x-effect": string;
  responses: Record<string, { description: string; content?: Record<string, Media> }>;
};
type Document = { paths: Record<string, { post: Operation }>; [key: string]: unknown };

const entities = ["customer", "address", "container"] as const;
type Entity = typeof entities[number];
const commonFields = ["ok", "routewareStatus", "customerId", "upstreamBytes", "localSync"];
const fields: Record<Entity, string[]> = {
  customer: commonFields,
  address: [...commonFields, "pickupAddressId"],
  container: [...commonFields, "pickupAddressId", "containerId"]
};
const graph = { done: true, customerId: 5, addressIds: [10], containerIds: [100] };

// Resolve only document-local refs. Zod consumes JSON Schema, not OpenAPI 3.0's
// nullable extension, so normalize that extension if a schema uses it. No
// expected response shape is synthesized by this adapter.
function resolve(value: unknown, doc: Document): unknown {
  if (Array.isArray(value)) return value.map((item) => resolve(item, doc));
  if (value === null || typeof value !== "object") return value;
  const node = value as Schema;
  if (node.$ref) {
    expect(node.$ref.startsWith("#/"), "response schemas must resolve without network").toBe(true);
    const target = node.$ref.slice(2).split("/").reduce<unknown>((part, key) =>
      (part as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
    expect(target, `unresolved schema ${node.$ref}`).toBeDefined();
    const { $ref: _ref, ...siblings } = node;
    return resolve({ ...(target as Schema), ...siblings }, doc);
  }
  const result = Object.fromEntries(Object.entries(node).map(([key, item]) => [key, resolve(item, doc)]));
  if (node.nullable === true) {
    delete result.nullable;
    return { anyOf: [result, { type: "null" }] };
  }
  return result;
}

function validator(schema: Schema, doc: Document) {
  return z.fromJSONSchema(resolve(schema, doc) as Parameters<typeof z.fromJSONSchema>[0]);
}

function shape(schema: Schema, doc: Document): Schema {
  const resolved = resolve(schema, doc) as Schema;
  if (!resolved.allOf) return resolved;
  const parts = resolved.allOf.map((part) => shape(part, doc));
  return {
    ...resolved,
    properties: Object.assign({}, ...parts.map((part) => part.properties), resolved.properties),
    required: [...new Set([...parts.flatMap((part) => part.required ?? []), ...(resolved.required ?? [])])]
  };
}

function operation(doc: Document, entity: Entity): Operation {
  return doc.paths[`/api/v1/data/${entity}`].post;
}

function responseSchema(doc: Document, entity: Entity, status = 200, mediaType = "application/json"): Schema {
  const responses = operation(doc, entity).responses;
  // OpenAPI selects an exact status before default; an undocumented media type
  // on an exact response must not fall through to default (or a 200 outcome).
  const response = responses[String(status)] ?? responses.default;
  const media = response?.content?.[mediaType];
  expect(media, `${entity} ${status} must advertise ${mediaType}`).toBeDefined();
  return media!.schema;
}

// HTTP 200 application/json is `anyOf` the strict live entity outcome and a
// named strict per-entity `*SaveDryRun` schema. Structural assertions must
// select a branch honestly: the live branch is the one WITHOUT a dryRun
// property, the dry-run branch the one WITH it. Selecting by position would
// silently follow a reorder.
function outcomeBranches(doc: Document, entity: Entity): { live: Schema; dryRun: Schema } {
  const root = responseSchema(doc, entity);
  const union = root.anyOf ?? root.oneOf;
  expect(union, `${entity} 200 must be a live/dry-run union, not a single object`).toHaveLength(2);
  const branches = union!.map((branch) => shape(branch, doc));
  const live = branches.find((branch) => branch.properties?.dryRun === undefined);
  const dryRun = branches.find((branch) => branch.properties?.dryRun !== undefined);
  expect(live, `${entity} 200 must keep a live branch without dryRun`).toBeDefined();
  expect(dryRun, `${entity} 200 must carry a dry-run branch`).toBeDefined();
  return { live: live!, dryRun: dryRun! };
}

async function servedDocument(bindings = testEnv): Promise<Document> {
  const response = await app.fetch(new Request("https://worker.test/openapi.json"), bindings);
  expect(response.status).toBe(200);
  return response.json() as Promise<Document>;
}

const sessionStub = {
  fetch: async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/get") return Response.json({ cookieHeader: "session=SYNTHETIC", expiresAtMs: Date.now() + 600_000, refreshing: false });
    if (path === "/throttle/failure" || path === "/throttle/clear") return Response.json({ blocked: false, retryAfterSec: 0 });
    throw new Error(`Unexpected session operation: ${path}`);
  }
} as unknown as DurableObjectStub;
const testEnv = {
  ...env,
  OPENAPI_DOCS_ENABLED: "true",
  TARGET_ORIGIN: "https://save-contract.invalid",
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: "https://save-contract.invalid/WebRW/Account/Login",
  SNAPSHOTS_R2_ENABLED: "false",
  CUSTOMER_SNAPSHOT_SYNC_SECRET: "save-contract-sync",
  SHADOW_API_TOKEN: "save-contract-full",
  SHADOW_API_READ_TOKEN: "save-contract-read",
  AUTH_SESSION: { idFromName: (name: string) => name, get: () => sessionStub }
} as unknown as Env;
// Dry runs fail closed without a stored session cookie; they never log in to
// establish one.
const noSessionStub = {
  fetch: async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/get") return Response.json({ cookieHeader: null, expiresAtMs: null, refreshing: false });
    if (path === "/throttle/failure" || path === "/throttle/clear") return Response.json({ blocked: false, retryAfterSec: 0 });
    throw new Error(`Unexpected session operation: ${path}`);
  }
} as unknown as DurableObjectStub;
const noSessionEnv = {
  ...testEnv,
  AUTH_SESSION: { idFromName: (name: string) => name, get: () => noSessionStub }
} as unknown as Env;
// Blocked outer throttle: the gate's recordAuthFailure sees blocked:true and
// answers 429 before the save handler runs. No login, no upstream, no D1.
const blockedThrottleStub = {
  fetch: async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/get") return Response.json({ cookieHeader: "session=SYNTHETIC", expiresAtMs: Date.now() + 600_000, refreshing: false });
    if (path === "/throttle/failure") return Response.json({ blocked: true, retryAfterSec: 34 });
    if (path === "/throttle/clear") return Response.json({ blocked: false, retryAfterSec: 0 });
    throw new Error(`Unexpected session operation: ${path}`);
  }
} as unknown as DurableObjectStub;
const blockedThrottleEnv = {
  ...testEnv,
  AUTH_SESSION: { idFromName: (name: string) => name, get: () => blockedThrottleStub }
} as unknown as Env;
const db = env.CUSTOMER_DB;
let document: Document;
let unexpectedNetwork: string[] = [];

function denyNetwork(input: RequestInfo | URL): never {
  unexpectedNetwork.push(input instanceof Request ? input.url : String(input));
  throw new Error("Unexpected network: contract fixtures are hermetic");
}

beforeAll(async () => {
  vi.stubGlobal("fetch", denyNetwork);
  await ensureD1TestTables();
  document = await servedDocument();
  expect(unexpectedNetwork).toEqual([]);
});

beforeEach(async () => {
  unexpectedNetwork = [];
  vi.stubGlobal("fetch", denyNetwork);
  clearAntiForgeryTokenCache();
  await db.prepare("DELETE FROM container_snapshot").run();
  await db.prepare("DELETE FROM address_snapshot").run();
  await db.prepare("DELETE FROM customer_snapshot").run();
  await invalidateDataEntity("customer", 5);
  await invalidateDataEntity("address", 10);
  await invalidateDataEntity("container", 100);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpectedNetwork, "no hidden login/provider/network request is permitted").toEqual([]);
});

describe("served entity-save outcome schemas", () => {
  for (const entity of entities) {
    it(`${entity}: publishes each runtime outcome field as required, without submitted fields or HTML`, () => {
      const { live } = outcomeBranches(document, entity);
      expect(live.type, "unknown JSON is not an agent-consumable outcome contract").toBe("object");
      expect(Object.keys(live.properties ?? {}).sort()).toEqual([...fields[entity]].sort());
      expect([...(live.required ?? [])].sort()).toEqual([...fields[entity]].sort());
      expect(live.properties?.dryRun, "live outcomes never carry dryRun").toBeUndefined();
      expect(live.properties?.routewareStatus).toMatchObject({ type: "integer" });
      const op = operation(document, entity);
      expect(op.operationId).toBe(`saveData${entity[0].toUpperCase()}${entity.slice(1)}`);
      expect(op["x-access"]).toBe("sync-secret");
      expect(op["x-effect"]).toBe("upstream-write-local-refresh");
      expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["200", "400", "401", "502", "503", "default"]));
    });

    it(`${entity}: publishes a strict validation-only dry-run branch with null status and fixed not_attempted`, () => {
      const { dryRun } = outcomeBranches(document, entity);
      expect(dryRun.type).toBe("object");
      const expected = [...fields[entity], "dryRun"];
      expect(Object.keys(dryRun.properties ?? {}).sort()).toEqual([...expected].sort());
      expect([...(dryRun.required ?? [])].sort()).toEqual([...expected].sort());
      expect(dryRun.properties?.dryRun).toMatchObject({ type: "boolean", enum: [true] });
      expect(dryRun.properties?.ok).toMatchObject({ type: "boolean", enum: [true] });
      expect(dryRun.properties?.routewareStatus?.type).toBe("null");
      expect(dryRun.properties?.upstreamBytes).toMatchObject({ type: "number", enum: [0] });
      const local = shape(dryRun.properties!.localSync, document);
      expect(local.type).toBe("object");
      expect(Object.keys(local.properties ?? {}).sort()).toEqual(["code", "done"]);
      expect([...(local.required ?? [])].sort()).toEqual(["code", "done"]);
      expect(local.properties?.done).toMatchObject({ type: "boolean", enum: [false] });
      expect(local.properties?.code).toMatchObject({ type: "string", enum: ["not_attempted"] });
      for (const key of fields[entity].filter((field) => field.endsWith("Id"))) {
        expect(dryRun.properties?.[key]?.type, `${key} stays nullable on dry runs`).toEqual(["number", "null"]);
      }
    });

    it(`${entity}: advertises both forwarded JSON and preparation problem schemas for 502`, () => {
      const content = operation(document, entity).responses["502"].content;
      expect(Object.keys(content ?? {}).sort()).toEqual(["application/json", "application/problem+json"]);
      expect(content!["application/json"].schema).toEqual({
        $ref: `#/components/schemas/${entity[0].toUpperCase()}${entity.slice(1)}SaveOutcome`
      });
      const problem = shape(content!["application/problem+json"].schema, document);
      expect(problem.type).toBe("object");
      expect([...(problem.required ?? [])].sort()).toEqual(["status", "title", "type"]);
      expect(problem.properties).toEqual({
        type: { type: "string" }, title: { type: "string" }, status: { type: "integer" },
        detail: { type: "string" }, instance: { type: "string" }, requestId: { type: "string" }
      });
      const validate = validator(content!["application/problem+json"].schema, document);
      const valid = { type: "about:blank", title: "Bad Gateway", status: 502 };
      expect(validate.safeParse(valid).success).toBe(true);
      for (const invalid of [{}, { ...valid, status: "502" }, { ...valid, status: 502.5 }, { ...valid, title: null }]) {
        expect(validate.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
      }
    });

    it(`${entity}: advertises both forwarded JSON and session-precondition problem schemas for 503`, () => {
      const content = operation(document, entity).responses["503"].content;
      expect(Object.keys(content ?? {}).sort()).toEqual(["application/json", "application/problem+json"]);
      expect(content!["application/json"].schema).toEqual({
        $ref: `#/components/schemas/${entity[0].toUpperCase()}${entity.slice(1)}SaveOutcome`
      });
      const problem = shape(content!["application/problem+json"].schema, document);
      expect(problem.type).toBe("object");
      expect([...(problem.required ?? [])].sort()).toEqual(["status", "title", "type"]);
      expect(problem.properties).toEqual({
        type: { type: "string" }, title: { type: "string" }, status: { type: "integer" },
        detail: { type: "string" }, instance: { type: "string" }, requestId: { type: "string" }
      });
      const validate = validator(content!["application/problem+json"].schema, document);
      const valid = { type: "about:blank", title: "Service Unavailable", status: 503 };
      expect(validate.safeParse(valid).success).toBe(true);
      for (const invalid of [{}, { ...valid, status: "503" }, { ...valid, status: 503.5 }, { ...valid, title: null }]) {
        expect(validate.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
      }
    });

    it(`${entity}: advertises both forwarded JSON and local problem schemas for default`, () => {
      const responses = operation(document, entity).responses;
      const content = responses.default?.content;
      expect(Object.keys(content ?? {}).sort()).toEqual(["application/json", "application/problem+json"]);
      expect(content!["application/json"].schema).toEqual({
        $ref: `#/components/schemas/${entity[0].toUpperCase()}${entity.slice(1)}SaveOutcome`
      });
      const problem = shape(content!["application/problem+json"].schema, document);
      expect(problem.type).toBe("object");
      expect([...(problem.required ?? [])].sort()).toEqual(["status", "title", "type"]);
      expect(problem.properties).toEqual({
        type: { type: "string" }, title: { type: "string" }, status: { type: "integer" },
        detail: { type: "string" }, instance: { type: "string" }, requestId: { type: "string" }
      });
      const validate = validator(content!["application/problem+json"].schema, document);
      const valid = { type: "about:blank", title: "Internal Server Error", status: 500 };
      expect(validate.safeParse(valid).success).toBe(true);
      for (const invalid of [{}, { ...valid, status: "500" }, { ...valid, status: 500.5 }, { ...valid, title: null }]) {
        expect(validate.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
      }
      // Default covers two reachable families: forwarded rejections (any
      // undeclared status) and local throttle/unhandled failures.
      expect(responses.default.description).toMatch(/application\/json/);
      expect(responses.default.description).toMatch(/application\/problem\+json/);
      expect(responses.default.description).toMatch(/ok=false/);
      expect(responses.default.description).toMatch(/not_attempted/);
      expect(responses.default.description).toMatch(/429/);
      expect(responses.default.description).toMatch(/500/);
      // 503 is exact (pinned above); undeclared statuses route to default.
      expect(responseSchema(document, entity, 504)).toEqual(content!["application/json"].schema);
      expect(responseSchema(document, entity, 429, "application/problem+json")).toEqual(content!["application/problem+json"].schema);
      expect(responseSchema(document, entity, 500, "application/problem+json")).toEqual(content!["application/problem+json"].schema);
      // JSON outcome and problem are distinct decoders, not interchangeable.
      const jsonValidate = validator(content!["application/json"].schema, document);
      const outcome = {
        ok: false, routewareStatus: 504, customerId: 5, upstreamBytes: 17,
        localSync: { done: false, code: "not_attempted" },
        ...(entity !== "customer" ? { pickupAddressId: 10 } : {}),
        ...(entity === "container" ? { containerId: 100 } : {})
      };
      expect(jsonValidate.safeParse(outcome).success).toBe(true);
      expect(jsonValidate.safeParse(valid).success, "problem is not a save outcome").toBe(false);
      expect(validate.safeParse(outcome).success, "save outcome is not a problem").toBe(false);
    });

    it(`${entity}: advertises both forwarded JSON and local problem schemas for exact 400 and 401`, () => {
      const responses = operation(document, entity).responses;
      for (const status of ["400", "401"] as const) {
        const content = responses[status]?.content;
        expect(Object.keys(content ?? {}).sort(), `${entity} ${status}`).toEqual(["application/json", "application/problem+json"]);
        expect(content!["application/json"].schema).toEqual({
          $ref: `#/components/schemas/${entity[0].toUpperCase()}${entity.slice(1)}SaveOutcome`
        });
        const problem = shape(content!["application/problem+json"].schema, document);
        expect(problem.type, `${entity} ${status} problem`).toBe("object");
        expect([...(problem.required ?? [])].sort()).toEqual(["status", "title", "type"]);
        expect(problem.properties).toEqual({
          type: { type: "string" }, title: { type: "string" }, status: { type: "integer" },
          detail: { type: "string" }, instance: { type: "string" }, requestId: { type: "string" }
        });
        const validate = validator(content!["application/problem+json"].schema, document);
        const valid = { type: "about:blank", title: status === "400" ? "Bad Request" : "Unauthorized", status: Number(status) };
        expect(validate.safeParse(valid).success).toBe(true);
        for (const invalid of [{}, { ...valid, status: String(status) }, { ...valid, status: Number(status) + 0.5 }, { ...valid, title: null }]) {
          expect(validate.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
        }
        if (status === "400") {
          expect(responses[status].description).toMatch(/Local validation/);
          expect(responses[status].description).toMatch(/forwarded/);
          expect(responses[status].description).toMatch(/media type/);
        } else {
          expect(responses[status].description).toMatch(/Local bearer/);
          expect(responses[status].description).toMatch(/forwarded/);
          expect(responses[status].description).toMatch(/bearer is invalid/);
        }
        // Exact selects exact, never default: a forwarded 400/401 outcome
        // must resolve here even though default advertises the same shapes.
        expect(responseSchema(document, entity, Number(status))).toEqual(content!["application/json"].schema);
        expect(responseSchema(document, entity, Number(status), "application/problem+json")).toEqual(content!["application/problem+json"].schema);
        const jsonValidate = validator(content!["application/json"].schema, document);
        const outcome = {
          ok: false, routewareStatus: Number(status), customerId: entity === "container" ? null : 5,
          upstreamBytes: 17, localSync: { done: false, code: "not_attempted" },
          ...(entity !== "customer" ? { pickupAddressId: 10 } : {}),
          ...(entity === "container" ? { containerId: 100 } : {})
        };
        expect(jsonValidate.safeParse(outcome).success, `${entity} ${status} outcome`).toBe(true);
        expect(jsonValidate.safeParse(valid).success, "problem is not a save outcome").toBe(false);
        expect(validate.safeParse(outcome).success, "save outcome is not a problem").toBe(false);
      }
      // Exact entries stay distinct from default (descriptions differ), so
      // exact-before-default selection remains observable in the document.
      expect(responses["400"]).not.toEqual(responses.default);
      expect(responses["401"]).not.toEqual(responses.default);
    });

    it(`${entity}: discovers the shared done-discriminated local refresh contract and exact fixed codes`, () => {
      const envelope = outcomeBranches(document, entity).live;
      expect(envelope.properties?.localSync, "localSync must be typed, not just an example").toBeDefined();
      const local = shape(envelope.properties!.localSync, document);
      const branches = local.oneOf ?? local.anyOf;
      expect(branches, "localSync must describe both done branches").toHaveLength(2);
      const resolved = branches!.map((branch) => shape(branch, document));
      const when = (branch: Schema) => branch.properties?.done?.const ?? branch.properties?.done?.enum?.[0];
      expect(resolved.map(when).sort()).toEqual([false, true]);
      const yes = resolved.find((branch) => when(branch) === true)!;
      const no = resolved.find((branch) => when(branch) === false)!;
      expect(Object.keys(yes.properties ?? {}).sort()).toEqual(["addressIds", "containerIds", "customerId", "done"]);
      expect([...(yes.required ?? [])].sort()).toEqual(["addressIds", "containerIds", "customerId", "done"]);
      expect(Object.keys(no.properties ?? {}).sort()).toEqual(["code", "done"]);
      expect([...(no.required ?? [])].sort()).toEqual(["code", "done"]);
      expect([...(no.properties?.code?.enum ?? [])].sort()).toEqual(["not_attempted", "sync_failed", "unknown_customer_id"]);
      const localValidator = validator(envelope.properties!.localSync, document);
      expect(localValidator.safeParse(graph).success).toBe(true);
      for (const code of ["not_attempted", "unknown_customer_id", "sync_failed"]) {
        expect(localValidator.safeParse({ done: false, code }).success, code).toBe(true);
      }
    });

    it(`${entity}: rejects malformed localSync rather than accepting the unknown-schema default`, () => {
      const validate = validator(responseSchema(document, entity), document);
      const valid = {
        ok: true, routewareStatus: 200, customerId: 5, upstreamBytes: 16, localSync: graph,
        ...(entity !== "customer" ? { pickupAddressId: 10 } : {}),
        ...(entity === "container" ? { containerId: 100 } : {})
      };
      expect(validate.safeParse(valid).success).toBe(true);
      for (const localSync of [
        {}, { done: "true", customerId: 5, addressIds: [10], containerIds: [100] },
        { done: true, customerId: 5, addressIds: [10] },
        { done: true, customerId: "5", addressIds: [10], containerIds: [100] },
        { done: true, customerId: 5, addressIds: ["10"], containerIds: [100] },
        { done: true, customerId: 5, addressIds: [10], containerIds: ["100"] },
        { done: false }, { done: false, code: "upstream HTML/exception" },
        { done: false, code: "" }, { done: false, code: null },
        { code: "sync_failed" }, null
      ]) {
        expect(validate.safeParse({ ...valid, localSync }).success, JSON.stringify(localSync)).toBe(false);
      }
      for (const key of fields[entity]) {
        const missing: Record<string, unknown> = { ...valid };
        delete missing[key];
        expect(validate.safeParse(missing).success, `missing ${key}`).toBe(false);
      }
      for (const [key, value] of [["ok", "true"], ["routewareStatus", "200"], ["upstreamBytes", "16"], ["customerId", "5"]]) {
        expect(validate.safeParse({ ...valid, [key as string]: value }).success, String(key)).toBe(false);
      }
      for (const key of fields[entity].filter((field) => field.endsWith("Id"))) {
        expect(validate.safeParse({ ...valid, [key]: "not-a-resolved-id" }).success, key).toBe(false);
        expect(validate.safeParse({ ...valid, [key]: null }).success, `${key} can be unresolved`).toBe(true);
      }
    });

    it(`${entity}: rejects invalid and mixed dry-run outcomes through the served 200 union`, () => {
      const validate = validator(responseSchema(document, entity), document);
      const dryValid = {
        ok: true, dryRun: true, routewareStatus: null, customerId: 5, upstreamBytes: 0,
        localSync: { done: false, code: "not_attempted" },
        ...(entity !== "customer" ? { pickupAddressId: 10 } : {}),
        ...(entity === "container" ? { containerId: 100 } : {})
      };
      expect(validate.safeParse(dryValid).success).toBe(true);
      // Null-id creates validate: the runtime never resolves ids on dry runs.
      const nullIds = {
        ...dryValid, customerId: null,
        ...(entity !== "customer" ? { pickupAddressId: null } : {}),
        ...(entity === "container" ? { containerId: null } : {})
      };
      expect(validate.safeParse(nullIds).success).toBe(true);
      const liveValid = { ...dryValid, routewareStatus: 200, upstreamBytes: 16, localSync: graph };
      delete (liveValid as Record<string, unknown>).dryRun;
      expect(validate.safeParse(liveValid).success).toBe(true);
      for (const mixed of [
        { ...liveValid, dryRun: true },
        { ...dryValid, dryRun: false },
        { ...dryValid, routewareStatus: 200 },
        { ...dryValid, upstreamBytes: 16 },
        { ...dryValid, ok: false },
        { ...dryValid, localSync: graph },
        { ...dryValid, localSync: { done: false, code: "sync_failed" } },
        // A null live upstream status stays invalid: live needs an integer,
        // dry-run needs the flag plus the fixed singleton fields.
        { ...liveValid, routewareStatus: null },
        { ...dryValid, customerId: "5" }
      ]) {
        expect(validate.safeParse(mixed).success, JSON.stringify(mixed)).toBe(false);
      }
      for (const key of [...fields[entity], "dryRun"]) {
        const missing = { ...dryValid };
        delete (missing as Record<string, unknown>)[key];
        expect(validate.safeParse(missing).success, `dry-run missing ${key}`).toBe(false);
      }
    });

    it(`${entity}: serves schema-valid examples distinguishing landed writes, refresh failure and upstream rejection`, () => {
      const op = operation(document, entity);
      const examples = Object.values(op.responses).flatMap((response) => {
        const media = response.content?.["application/json"];
        if (!media) return [];
        const values = [...(media.example === undefined ? [] : [media.example]),
          ...Object.values(media.examples ?? {}).map((example) => example.value)];
        const validate = validator(media.schema, document);
        for (const value of values) expect(validate.safeParse(value).success, JSON.stringify(value)).toBe(true);
        return values as Array<{ ok?: boolean; localSync?: { done: boolean; code?: string } }>;
      });
      expect(examples.some((value) => value.ok === true && value.localSync?.done === true)).toBe(true);
      for (const code of ["sync_failed", "unknown_customer_id"]) {
        expect(examples.some((value) => value.ok === true && value.localSync?.done === false && value.localSync.code === code), code).toBe(true);
      }
      expect(examples.some((value) => value.ok === false && value.localSync?.done === false && value.localSync.code === "not_attempted"), "upstream rejection is not success").toBe(true);
      const guidance = [op.description, ...Object.values(op.responses).map((response) => response.description)].join(" ");
      expect(guidance).toMatch(/localSync/);
      expect(guidance).toMatch(/(?:best.effort|not guaranteed|does not guarantee|may fail|can fail)/i);
      expect(guidance).toMatch(/(?:do not|never|avoid|must not)[^.\n]*(?:replay|retry)[^.\n]*creat|creat[^.\n]*(?:do not|never|avoid|must not)[^.\n]*(?:replay|retry)/i);
    });

    it(`${entity}: names a synthetic validation-only dry-run example matching only the dry-run branch`, () => {
      const media = operation(document, entity).responses["200"].content?.["application/json"];
      const examples = media?.examples;
      expect(Object.keys(examples ?? {}).sort()).toEqual(
        ["dryRun", "refreshed", "rejected", "syncFailed", "unknownCustomer"].sort()
      );
      expect(examples!.dryRun.summary).toMatch(/synthetic/i);
      const { live, dryRun } = outcomeBranches(document, entity);
      expect(validator(dryRun, document).safeParse(examples!.dryRun.value).success).toBe(true);
      expect(validator(live, document).safeParse(examples!.dryRun.value).success,
        "dry-run example must not validate as a live outcome").toBe(false);
      for (const name of ["refreshed", "syncFailed", "unknownCustomer", "rejected"]) {
        const liveValue = examples![name].value;
        expect(validator(live, document).safeParse(liveValue).success, name).toBe(true);
        expect(validator(dryRun, document).safeParse(liveValue).success,
          `${name} must not validate as a dry-run outcome`).toBe(false);
      }
    });
  }

  it("selects an exact status before default, even when the exact response lacks the requested media type", () => {
    const doc = structuredClone(document);
    const responses = operation(doc, "customer").responses;
    responses["502"] = { description: "Problem only", content: {
      "application/problem+json": { schema: { type: "object" } }
    } };
    responses.default = { description: "Forwarded JSON", content: {
      "application/json": { schema: { type: "string" } }
    } };
    // 504 has no exact response, so it routes to default; 503 is exact and
    // never falls through even though default advertises a different schema.
    expect(responseSchema(doc, "customer", 504)).toEqual({ type: "string" });
    expect(responseSchema(doc, "customer", 503)).toEqual({ $ref: "#/components/schemas/CustomerSaveOutcome" });
    expect(responseSchema(doc, "customer", 502, "application/problem+json")).toEqual({ type: "object" });
    expect(() => responseSchema(doc, "customer", 502)).toThrow("customer 502 must advertise application/json");
  });

  it("refuses an undocumented status rather than borrowing the HTTP 200 outcome schema", () => {
    const doc = structuredClone(document);
    const responses = operation(doc, "customer").responses;
    delete responses.default;
    delete responses["503"];
    expect(responses["200"].content?.["application/json"]).toBeDefined();
    expect(() => responseSchema(doc, "customer", 503)).toThrow("customer 503 must advertise application/json");
  });

  it("describes one equivalent localSync contract for all three consumers", () => {
    const contracts = entities.map((entity) => {
      const live = outcomeBranches(document, entity).live;
      expect(live.properties?.localSync).toBeDefined();
      return resolve(live.properties!.localSync, document);
    });
    expect(contracts[1]).toEqual(contracts[0]);
    expect(contracts[2]).toEqual(contracts[0]);
    const dryContracts = entities.map((entity) =>
      resolve(outcomeBranches(document, entity).dryRun.properties!.localSync, document));
    expect(dryContracts[1]).toEqual(dryContracts[0]);
    expect(dryContracts[2]).toEqual(dryContracts[0]);
  });
});

const savedGraph = {
  currentCustomer: { CustomerID: 5, CompanyName: "Synthetic saved customer" },
  data: [{ PickupAddressID: 10, CustomerID: 5, Containers: [{ ContainerID: 100 }] }]
};
const updateForms: Record<Entity, string> = {
  customer: "CustomerID=5&CompanyName=SYNTHETIC_FORM_ONLY",
  address: "PickupAddressID=10&CustomerID=5&Address=SYNTHETIC_FORM_ONLY",
  // Exercises the existing owner lookup rather than supplying CustomerID.
  container: "ContainerID=100&PickupAddressID=10&SerialNumber=SYNTHETIC_FORM_ONLY"
};
const savePaths: Record<Entity, string> = {
  customer: "/WebRW/Customer/SaveCustomerLongForm",
  address: "/WebRW/PickupAddress/SaveAddressForm",
  container: "/WebRW/Container/SaveContainerForm"
};
const TOKEN = "&__RequestVerificationToken=SYNTHETIC_TOKEN";

type Outcome = {
  ok: boolean;
  routewareStatus: number;
  customerId: number | null;
  pickupAddressId?: number | null;
  containerId?: number | null;
  upstreamBytes: number;
  localSync: unknown;
};
type Scenario = {
  name: string;
  body: string;
  upstreamStatus: number;
  upstreamBody: string;
  status: number;
  ok: boolean;
  customerId: number | null;
  localSync: unknown;
  detailCalls: number;
  failRefresh?: boolean;
  nullableChild?: boolean;
};

async function seedGraph(): Promise<void> {
  const rows = mapDetailFullToRows({
    ...savedGraph,
    currentCustomer: { CustomerID: 5, CompanyName: "Synthetic old customer" }
  });
  await upsertCustomerSnapshotRows(db, [rows.customer], 80, "2000-01-01T00:00:00.000Z");
  await upsertAddressSnapshotRows(db, rows.addresses, 80, "2000-01-01T00:00:00.000Z");
  await upsertContainerSnapshotRows(db, rows.containers, 50, "2000-01-01T00:00:00.000Z");
}

async function localRows(): Promise<unknown[]> {
  return Promise.all(["customer", "address", "container"].map(async (entity) =>
    (await db.prepare(`SELECT * FROM ${entity}_snapshot`).all()).results));
}

function post(entity: Entity, body: string, token: string | null = "save-contract-sync", query = "", bindings = testEnv, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`https://worker.test/api/v1/data/${entity}${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...extraHeaders
    },
    body
  }), bindings));
}

function syntheticUpstream(entity: Entity, scenario: Scenario) {
  const calls: Array<{ path: string; method: string; body: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== testEnv.TARGET_ORIGIN) return denyNetwork(input);
    const body = typeof init?.body === "string" ? init.body
      : init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "";
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body });
    if (url.pathname === savePaths[entity]) {
      return new Response(scenario.upstreamBody, { status: scenario.upstreamStatus, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/WebRW/Customer/GetCustomerDetailFull") {
      expect(JSON.parse(body)).toMatchObject({ customerID: 5 });
      if (scenario.failRefresh) throw new Error("SYNTHETIC_EXCEPTION_NOT_A_PUBLIC_CODE");
      return Response.json(savedGraph);
    }
    return denyNetwork(input);
  });
  return calls;
}

describe("schema vs synthetic mounted save outcomes (unchanged runtime controls)", () => {
  for (const entity of entities) {
    const happy = {
      body: updateForms[entity], upstreamStatus: 200, upstreamBody: '{"success":true}',
      status: 200, ok: true, customerId: 5, localSync: graph, detailCalls: 1
    };
    const scenarios: Scenario[] = [
      { ...happy, name: "landed update and refreshed graph" },
      { ...happy, name: "landed update but failed local refresh", failRefresh: true, localSync: { done: false, code: "sync_failed" } },
      {
        ...happy, name: "landed write with unresolved customer", customerId: null,
        body: entity === "customer" ? "CustomerID=0" : entity === "address" ? "PickupAddressID=10" : "ContainerID=100",
        localSync: { done: false, code: "unknown_customer_id" }, detailCalls: 0
      },
      {
        ...happy, name: "upstream rejection inside HTTP 200 is not a success claim", ok: false,
        upstreamBody: '{"success":false,"message":"SYNTHETIC_UPSTREAM_ONLY"}',
        customerId: entity === "container" ? null : 5,
        localSync: { done: false, code: "not_attempted" }, detailCalls: 0
      },
      {
        ...happy, name: "explicit upstream 502 rejection uses the advertised JSON envelope", ok: false,
        upstreamStatus: 502, status: 502, upstreamBody: "SYNTHETIC_UPSTREAM_ONLY",
        customerId: entity === "container" ? null : 5,
        localSync: { done: false, code: "not_attempted" }, detailCalls: 0
      },
      {
        ...happy, name: "loud upstream rejection preserves its status", ok: false,
        upstreamStatus: 503, status: 503, upstreamBody: "SYNTHETIC_UPSTREAM_ONLY",
        customerId: entity === "container" ? null : 5,
        localSync: { done: false, code: "not_attempted" }, detailCalls: 0
      },
      {
        ...happy, name: "forwarded upstream 400 uses the exact JSON envelope", ok: false,
        upstreamStatus: 400, status: 400, upstreamBody: "SYNTHETIC_UPSTREAM_ONLY",
        customerId: entity === "container" ? null : 5,
        localSync: { done: false, code: "not_attempted" }, detailCalls: 0
      },
      {
        ...happy, name: "forwarded upstream 401 uses the exact JSON envelope, not a bearer denial", ok: false,
        upstreamStatus: 401, status: 401, upstreamBody: "SYNTHETIC_UPSTREAM_ONLY",
        customerId: entity === "container" ? null : 5,
        localSync: { done: false, code: "not_attempted" }, detailCalls: 0
      },
      { ...happy, name: "upstream status remains separate from wrapper status", upstreamStatus: 201 },
      { ...happy, name: "counts UTF-8 upstream bytes without echoing the upstream body", upstreamBody: '{"success":true,"note":"é🔒SYNTHETIC_UPSTREAM_ONLY"}' }
    ];
    if (entity !== "customer") scenarios.push({
      ...happy, name: "unresolved new child ID remains nullable after graph refresh", nullableChild: true,
      // Creates (posted id 0, upstream ok) answer 201; the child id stays null
      // when unresolvable. The generic validator below then checks the payload
      // against the served 201 schema for this entity.
      status: 201,
      body: entity === "address" ? "PickupAddressID=0&CustomerID=5" : "ContainerID=0&PickupAddressID=10&CustomerID=5"
    });

    for (const scenario of scenarios) {
      it(`${entity}: ${scenario.name}`, async () => {
        await seedGraph();
        const before = await localRows();
        const calls = syntheticUpstream(entity, scenario);
        const response = await post(entity, scenario.body + TOKEN);
        expect(response.status).toBe(scenario.status);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(response.headers.get("cache-control")).toBe("no-store");
        const bytes = await response.text();
        const value = JSON.parse(bytes) as Outcome;
        const expected = {
          ok: scenario.ok, routewareStatus: scenario.upstreamStatus, customerId: scenario.customerId,
          upstreamBytes: new TextEncoder().encode(scenario.upstreamBody).length, localSync: scenario.localSync,
          ...(entity !== "customer" ? { pickupAddressId: entity === "container" && scenario.customerId === null && scenario.ok ? null : scenario.nullableChild && entity === "address" ? null : 10 } : {}),
          ...(entity === "container" ? { containerId: scenario.nullableChild ? null : 100 } : {})
        };
        expect(value).toEqual(expected);
        expect(bytes).not.toMatch(/SYNTHETIC_FORM_ONLY|SYNTHETIC_UPSTREAM_ONLY|SYNTHETIC_EXCEPTION|SYNTHETIC_TOKEN/);
        expect(calls.filter((call) => call.path === savePaths[entity])).toEqual([
          { path: savePaths[entity], method: "POST", body: scenario.body + TOKEN }
        ]);
        expect(calls.filter((call) => call.path.endsWith("GetCustomerDetailFull"))).toHaveLength(scenario.detailCalls);
        if (!scenario.ok || scenario.customerId === null || scenario.failRefresh) {
          expect(await localRows(), "a failed/skipped refresh must not mutate the snapshot").toEqual(before);
        } else {
          expect(await db.prepare("SELECT company_name FROM customer_snapshot WHERE customer_id = 5").first()).toEqual({ company_name: "Synthetic saved customer" });
        }
        const mediaType = response.headers.get("content-type")!.split(";")[0].trim();
        // Route-level outcomes correlate by header only: no requestId in the body.
        expect(response.headers.get("x-request-id"), "route responses echo a request id").toBeTruthy();
        expect(value, "route outcomes carry no body requestId").not.toHaveProperty("requestId");
        const validate = validator(responseSchema(document, entity, response.status, mediaType), document);
        expect(validate.safeParse(value).success, bytes).toBe(true);
        if (response.status === 502) {
          const problem = validator(responseSchema(document, entity, 502, "application/problem+json"), document);
          expect(problem.safeParse(value).success, "forwarded rejection is an outcome, not a preparation problem").toBe(false);
        }
        if (response.status === 400 || response.status === 401) {
          // Forwarded 400/401 select the exact status entry, not default.
          const exact = operation(document, entity).responses[String(response.status)].content!["application/json"].schema;
          expect(responseSchema(document, entity, response.status, mediaType)).toEqual(exact);
          const problem = validator(responseSchema(document, entity, response.status, "application/problem+json"), document);
          expect(problem.safeParse(value).success, `forwarded ${response.status} is an outcome, not a local problem`).toBe(false);
        }
      });
    }

    it(`${entity}: preparation failure uses the advertised 502 problem schema without saving or refreshing`, async () => {
      await seedGraph();
      const before = await localRows();
      const modalPaths: Record<Entity, string> = {
        customer: "/WebRW/Customer/LoadLongCustomerModal?customerID=5",
        address: "/WebRW/PickupAddress/LoadAddressModal?PickupAddressID=10",
        container: "/WebRW/Container/LoadContainerModal?ContainerID=100"
      };
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== testEnv.TARGET_ORIGIN || url.pathname + url.search !== modalPaths[entity]) return denyNetwork(input);
        expect(init?.method ?? "GET").toBe("GET");
        calls.push(url.pathname + url.search);
        return new Response("SYNTHETIC_UPSTREAM_ONLY", { status: 500, headers: { "content-type": "text/html" } });
      });
      // No supplied token: exercise the real preparation path, not a stub of it.
      const response = await post(entity, updateForms[entity]);
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const mediaType = response.headers.get("content-type")!.split(";")[0].trim();
      expect(mediaType).toBe("application/problem+json");
      const bytes = await response.text();
      const value = JSON.parse(bytes);
      expect(value).toMatchObject({ title: "Bad Gateway", status: 502, instance: `/api/v1/data/${entity}` });
      expect(value.detail).toContain("HTTP 500");
      expect(value).not.toHaveProperty("localSync");
      expect(bytes).not.toMatch(/SYNTHETIC_FORM_ONLY|SYNTHETIC_UPSTREAM_ONLY|SYNTHETIC_TOKEN/);
      expect(calls).toEqual([modalPaths[entity]]);
      expect(await localRows(), "failed preparation must not mutate any snapshot").toEqual(before);
      const validate = validator(responseSchema(document, entity, response.status, mediaType), document);
      expect(validate.safeParse(value).success, bytes).toBe(true);
      expect(validator(responseSchema(document, entity, 502), document).safeParse(value).success,
        "preparation problem is not a forwarded save outcome").toBe(false);
    });

    for (const token of [null, "invalid-token", "save-contract-read", "save-contract-full"]) {
      it(`${entity}: denies ${token ?? "missing bearer"} before forwarding or D1 mutations`, async () => {
        await seedGraph();
        const before = await localRows();
        const response = await post(entity, updateForms[entity] + TOKEN, token);
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        const mediaType = response.headers.get("content-type")!.split(";")[0].trim();
        expect(mediaType).toBe("application/problem+json");
        const bytes = await response.text();
        const value = JSON.parse(bytes);
        expect(value).toMatchObject({ title: "Unauthorized", status: 401, instance: `/api/v1/data/${entity}` });
        expect(value).not.toHaveProperty("ok");
        expect(value).not.toHaveProperty("localSync");
        expect(bytes).not.toMatch(/SYNTHETIC_FORM_ONLY|SYNTHETIC_TOKEN/);
        if (token !== null) expect(bytes, "401 bodies never echo the submitted bearer").not.toContain(token);
        // Outer gate (missing/invalid/read) carries requestId in body + header;
        // inner sync-secret denial (full token) correlates by header only.
        const headerId = response.headers.get("x-request-id");
        expect(headerId, "401 echoes a request id").toBeTruthy();
        if (token === "save-contract-full") {
          expect(value, "inner denial carries no body requestId").not.toHaveProperty("requestId");
        } else {
          expect(value.requestId, "outer denial joins header and body").toBe(headerId);
        }
        expect(await localRows()).toEqual(before);
        // Exact 401 problem, not the default route and not a forwarded outcome.
        const validate = validator(responseSchema(document, entity, 401, mediaType), document);
        expect(validate.safeParse(value).success, bytes).toBe(true);
        expect(responseSchema(document, entity, 401, mediaType)).toEqual(
          operation(document, entity).responses["401"].content!["application/problem+json"].schema
        );
        expect(validator(responseSchema(document, entity, 401), document).safeParse(value).success,
          "local denial is a problem, not a forwarded save outcome").toBe(false);
      });
    }

    it(`${entity}: empty form stays a no-store 400 without upstream or snapshot side effects`, async () => {
      await seedGraph();
      const before = await localRows();
      const response = await post(entity, "");
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const mediaType = response.headers.get("content-type")!.split(";")[0].trim();
      expect(mediaType).toBe("application/problem+json");
      const bytes = await response.text();
      const value = JSON.parse(bytes);
      expect(value).toMatchObject({ status: 400, instance: `/api/v1/data/${entity}` });
      expect(value.title).toBe("Bad Request");
      expect(value).not.toHaveProperty("ok");
      expect(value).not.toHaveProperty("localSync");
      expect(bytes).not.toMatch(/SYNTHETIC_FORM_ONLY|SYNTHETIC_TOKEN/);
      // Handler-level 400 correlates by header only, like other route bodies.
      expect(response.headers.get("x-request-id"), "400 echoes a request id").toBeTruthy();
      expect(value, "handler 400 carries no body requestId").not.toHaveProperty("requestId");
      expect(await localRows()).toEqual(before);
      const validate = validator(responseSchema(document, entity, 400, mediaType), document);
      expect(validate.safeParse(value).success, bytes).toBe(true);
      expect(responseSchema(document, entity, 400, mediaType)).toEqual(
        operation(document, entity).responses["400"].content!["application/problem+json"].schema
      );
      expect(validator(responseSchema(document, entity, 400), document).safeParse(value).success,
        "local validation failure is a problem, not a forwarded save outcome").toBe(false);
    });

    it(`${entity}: blocked outer auth-throttle 429 validates against the default problem schema`, async () => {
      await seedGraph();
      const before = await localRows();
      const requestId = `save-outcome-429-${entity}-1`;
      const response = await post(entity, updateForms[entity] + TOKEN, "invalid-token", "", blockedThrottleEnv, {
        "X-Request-Id": requestId,
        "CF-Connecting-IP": `198.51.100.${entity === "customer" ? 231 : entity === "address" ? 232 : 233}`
      });
      expect(response.status).toBe(429);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const mediaType = response.headers.get("content-type")!.split(";")[0].trim();
      expect(mediaType).toBe("application/problem+json");
      const retryAfter = response.headers.get("retry-after");
      expect(retryAfter).toMatch(/^\d+$/);
      expect(Number(retryAfter)).toBe(34);
      expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
      expect(response.headers.get("x-request-id")).toBe(requestId);
      const bytes = await response.text();
      const value = JSON.parse(bytes);
      expect(value).toMatchObject({ title: "Too Many Requests", status: 429, instance: `/api/v1/data/${entity}`, requestId });
      expect(value).not.toHaveProperty("ok");
      expect(value).not.toHaveProperty("localSync");
      expect(bytes).not.toMatch(/SYNTHETIC_FORM_ONLY|SYNTHETIC_TOKEN/);
      expect(bytes, "429 bodies never echo the submitted bearer").not.toContain("invalid-token");
      expect(await localRows(), "throttled request must not mutate any snapshot").toEqual(before);
      // 429 has no exact entry: it selects default's problem media.
      const validate = validator(responseSchema(document, entity, 429, mediaType), document);
      expect(validate.safeParse(value).success, bytes).toBe(true);
      expect(responseSchema(document, entity, 429, mediaType)).toEqual(
        operation(document, entity).responses.default.content!["application/problem+json"].schema
      );
      expect(validator(responseSchema(document, entity, 429), document).safeParse(value).success,
        "throttle problem is not a forwarded save outcome").toBe(false);
    });

    it(`${entity}: escaping upstream transport error 500 validates against the default problem schema`, async () => {
      await seedGraph();
      const before = await localRows();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const requestId = `save-outcome-500-${entity}-1`;
      const attempted: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== testEnv.TARGET_ORIGIN) return denyNetwork(input);
        if (url.pathname === savePaths[entity]) {
          expect(init?.method ?? "GET").toBe("POST");
          attempted.push(url.pathname);
          throw new TypeError("SYNTHETIC_TRANSPORT_FAILURE");
        }
        return denyNetwork(input);
      });
      // Explicit token: prep needs no modal fetch, so the throw provably
      // escapes the save forward itself, not preparation.
      const response = await post(entity, updateForms[entity] + TOKEN, undefined, "", testEnv, {
        "X-Request-Id": requestId
      });
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const mediaType = response.headers.get("content-type")!.split(";")[0].trim();
      expect(mediaType).toBe("application/problem+json");
      expect(response.headers.get("x-request-id")).toBe(requestId);
      const bytes = await response.text();
      const value = JSON.parse(bytes);
      expect(value).toMatchObject({ title: "Internal Server Error", status: 500, requestId });
      expect(String(value.type)).toContain("internal");
      expect(String(value.detail)).toContain("PROBLEMS.md#internal");
      expect(value).not.toHaveProperty("ok");
      expect(value).not.toHaveProperty("localSync");
      expect(value).not.toHaveProperty("instance");
      expect(bytes).not.toMatch(/SYNTHETIC_FORM_ONLY|SYNTHETIC_TOKEN|SYNTHETIC_TRANSPORT_FAILURE/);
      expect(attempted, "transport failure escapes the single save forward").toEqual([savePaths[entity]]);
      expect(await localRows(), "unhandled error must not mutate any snapshot").toEqual(before);
      // 500 has no exact entry: it selects default's problem media.
      const validate = validator(responseSchema(document, entity, 500, mediaType), document);
      expect(validate.safeParse(value).success, bytes).toBe(true);
      expect(responseSchema(document, entity, 500, mediaType)).toEqual(
        operation(document, entity).responses.default.content!["application/problem+json"].schema
      );
      expect(validator(responseSchema(document, entity, 500), document).safeParse(value).success,
        "unhandled-error problem is not a forwarded save outcome").toBe(false);
      const logged = errorSpy.mock.calls.map(([event]) => event as { msg?: string; requestId?: string });
      expect(logged.find((event) => event.msg === "Unhandled request error")).toMatchObject({ requestId });
      expect(JSON.stringify(logged)).not.toMatch(/SYNTHETIC_TRANSPORT_FAILURE/);
    });
  }

  it("OpenAPI discovery is repeatable and performs no D1/session/upstream work", async () => {
    const forbidden = () => { throw new Error("OpenAPI discovery attempted application data access"); };
    const isolated = { ...testEnv, CUSTOMER_DB: { prepare: forbidden, batch: forbidden, exec: forbidden }, AUTH_SESSION: { idFromName: forbidden, get: forbidden } } as unknown as Env;
    expect(await servedDocument(isolated)).toEqual(document);
    expect(await servedDocument(isolated)).toEqual(document);
  });
});

describe("dry-run runtime outcomes validate against the served schemas", () => {
  const dryEnvelopes: Record<Entity, Record<string, unknown>> = {
    customer: {
      ok: true, dryRun: true, routewareStatus: null, customerId: 5, upstreamBytes: 0,
      localSync: { done: false, code: "not_attempted" }
    },
    address: {
      ok: true, dryRun: true, routewareStatus: null, customerId: 5, pickupAddressId: 10,
      upstreamBytes: 0, localSync: { done: false, code: "not_attempted" }
    },
    // No CustomerID is posted and dry runs never use the D1 owner fallback.
    container: {
      ok: true, dryRun: true, routewareStatus: null, customerId: null, pickupAddressId: 10,
      containerId: 100, upstreamBytes: 0, localSync: { done: false, code: "not_attempted" }
    }
  };

  for (const entity of entities) {
    it(`${entity}: dry-run 200 envelope matches only the served dry-run branch, with no D1 mutation`, async () => {
      await seedGraph();
      const before = await localRows();
      // Explicit token: prep needs no modal fetch, so the hermetic denyNetwork
      // stub proves zero upstream traffic on its own.
      const response = await post(entity, updateForms[entity] + TOKEN, undefined, "?dryRun=true");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const bytes = await response.text();
      const value = JSON.parse(bytes);
      expect(value).toEqual(dryEnvelopes[entity]);
      expect(Object.keys(value).sort()).toEqual([...fields[entity], "dryRun"].sort());
      expect(bytes).not.toMatch(/SYNTHETIC_FORM_ONLY|SYNTHETIC_TOKEN/);
      expect(await localRows(), "a dry run must not mutate any snapshot").toEqual(before);
      const { live, dryRun } = outcomeBranches(document, entity);
      expect(validator(dryRun, document).safeParse(value).success, bytes).toBe(true);
      expect(validator(live, document).safeParse(value).success, "runtime dry-run is not a live outcome").toBe(false);
      expect(validator(responseSchema(document, entity), document).safeParse(value).success, bytes).toBe(true);
    });

    it(`${entity}: dry-run without a session fails closed 503 validated by the served problem schema`, async () => {
      await seedGraph();
      const before = await localRows();
      const response = await post(entity, updateForms[entity] + TOKEN, undefined, "?dryRun=true", noSessionEnv);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const mediaType = response.headers.get("content-type")!.split(";")[0].trim();
      expect(mediaType).toBe("application/problem+json");
      const bytes = await response.text();
      const value = JSON.parse(bytes);
      expect(value).toMatchObject({ title: "Service Unavailable", status: 503, instance: `/api/v1/data/${entity}` });
      expect(String(value.detail)).toMatch(/session/i);
      expect(bytes).not.toMatch(/SYNTHETIC_FORM_ONLY|SYNTHETIC_TOKEN/);
      expect(await localRows(), "a failed dry run must not mutate any snapshot").toEqual(before);
      const validate = validator(responseSchema(document, entity, 503, mediaType), document);
      expect(validate.safeParse(value).success, bytes).toBe(true);
      expect(validator(responseSchema(document, entity, 503), document).safeParse(value).success,
        "dry-run precondition problem is not a forwarded save outcome").toBe(false);
    });

    it(`${entity}: live upstream 503 forwards JSON validated by the exact 503 schema`, async () => {
      await seedGraph();
      const scenario: Scenario = {
        name: "forwarded live 503",
        body: updateForms[entity], upstreamStatus: 503, upstreamBody: "SYNTHETIC_UPSTREAM_ONLY",
        status: 503, ok: false, customerId: entity === "container" ? null : 5,
        localSync: { done: false, code: "not_attempted" }, detailCalls: 0
      };
      syntheticUpstream(entity, scenario);
      const response = await post(entity, scenario.body + TOKEN);
      expect(response.status).toBe(503);
      const mediaType = response.headers.get("content-type")!.split(";")[0].trim();
      expect(mediaType).toBe("application/json");
      const value = await response.json();
      // Exact 503 JSON is the live outcome envelope, not the default route.
      expect(responseSchema(document, entity, 503)).toEqual({
        $ref: `#/components/schemas/${entity[0].toUpperCase()}${entity.slice(1)}SaveOutcome`
      });
      expect(validator(responseSchema(document, entity, 503, mediaType), document).safeParse(value).success).toBe(true);
      expect(value).toMatchObject({ ok: false, routewareStatus: 503 });
    });
  }
});
