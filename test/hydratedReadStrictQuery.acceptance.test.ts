/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Strict query keys on hydrated single-entity GETs (R21-04 acceptance).
 *
 * The three `GET /api/v1/data/*` query schemas are non-strict `z.object`
 * (src/routes/dataEntity.ts), so `?field=` or `?ids=` strips silently and the
 * handler serves the full PII bundle the caller tried to trim. Invalid VALUES
 * already 400 via anchored schemas — only unknown KEYS bypass.
 *
 * Contract pinned here:
 * - Any query key outside each route's declared set 400s with the existing
 *   value-free `bad-request` problem type BEFORE any cache/D1 work.
 * - The 400 carries fixed guidance naming the allowed keys AT THE
 *   IMPLEMENTATION HEAD and never echoes submitted keys or values. Wording
 *   beyond that is the Builder's; only the contract is pinned (same shape as
 *   the R20-04 strict-POST acceptance on `test/snapshot-post-strict-query-acceptance`).
 * - Sync-secret 401 precedence is preserved: outer-invalid (missing/wrong)
 *   bearer 401s before everything, and inner-invalid (API/read token, not the
 *   sync secret) 401s before the strict unknown-key check. Invalid VALUES
 *   keep their existing validator-first 400; unknown KEYS are checked after
 *   auth. That split is intentional: unknown keys are stripped today (so
 *   inner-invalid 401s), while invalid values already 400.
 * - Valid paths unchanged: omitted selectors serve full bundles, `fields`
 *   projections behave exactly as merged, repeated KNOWN keys keep failing
 *   via the string schema, invalid values keep their anchored 400.
 *
 * Allowed keys enumerate from the implementation head's runtime OpenAPI: at
 * base `ad3873ee` every route declares exactly `id`, its alias and `fields`.
 * If R20-02 (relation fieldsets) or #339 (batch `ids`) merge first, their
 * keys (`fields[customer]`, `fields[address]`, `fields[container]`, `ids`)
 * join the allowed set and the conditional branches below assert acceptance
 * instead of rejection. Anything outside that known universe fails loudly.
 *
 * Builder notes:
 * - Build on this branch, never edit this file.
 * - Enumerate RAW query keys (`new URL(c.req.url).searchParams`), not
 *   `Object.keys(c.req.query())`: Hono drops empty-string keys, so `?=x`
 *   would slip past a `c.req.query()`-based helper while these tests demand
 *   a 400. A trailing bare `&` carries no key and must stay 200.
 * - Wire through one shared strict-query helper in the shared routes module
 *   (same module as R20-04; reuse-or-create, converge by code). If you change
 *   OpenAPI query descriptions, regenerate the openapiContract snapshot; the
 *   hand-written param-name assertions below must keep passing.
 *
 * Status at authoring (base `ad3873ee`):
 * - RED (fail today, must pass after R21-04): every unknown-key, fixed-
 *   guidance, repeated-unknown, empty-key and zero-effects test. Today typos
 *   are ignored and the full bundle serves 200 (or 304 when cached).
 * - GREEN (pass today, Builder must keep green): invalid values, repeated
 *   KNOWN keys, all valid-path preservation, auth precedence, and OpenAPI
 *   param pins.
 *
 * Focused check:
 * npx vitest run test/hydratedReadStrictQuery.acceptance.test.ts \
 *   test/hydratedFields.acceptance.test.ts test/hydratedReadIds.acceptance.test.ts \
 *   test/entityDataCache.test.ts test/snapshotListUnknownParams.test.ts \
 *   test/snapshotAuth.test.ts test/dataEntityEtagRoundTrip.test.ts
 */

const cache = new Map<string, Response>();
const work = { cacheReads: 0, cacheWrites: 0, statements: [] as string[] };
vi.mock("../src/lib/entityDataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/entityDataCache")>();
  return {
    ...actual,
    getCachedDataEntity: async (kind: string, id: number) => {
      work.cacheReads += 1;
      return cache.get(`${kind}:${id}`)?.clone();
    },
    putCachedDataEntity: async (kind: string, id: number, response: Response) => {
      work.cacheWrites += 1;
      cache.set(`${kind}:${id}`, response.clone());
    }
  };
});
const { default: app } = await import("../src/app");
const DB = (env as unknown as Env).CUSTOMER_DB;
const SECRET = "synthetic-strict-query-secret";
const API_TOKEN = "synthetic-api-token";
const READ_TOKEN = "synthetic-read-token";
const ORIGIN = "https://synthetic-strict-client.invalid";
const REQUEST_ID = "synthetic-hydrated-strict-request";
const BAD_REQUEST = `${PROBLEM_TYPE_BASE}bad-request`;
const OUTER_DETAIL =
  "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.";
const INNER_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";

type Row = Record<string, string | number | null>;

const customer: Row = {
  customer_id: 94101, customer_type_id: 2, company_name: "Synthetic strict company",
  first_name: "Synthetic", middle_initial: null, last_name: "Fixture",
  name_suffix: "", customer_number: "SYN-001", sub_customer_number: "SUB-1",
  phone1: "555-0100", phone2: null, comments: "Synthetic customer note",
  enabled: 1, synced_at: "2026-10-01T00:00:00.000Z"
};
const address: Row = {
  pickup_address_id: 94201, customer_id: 94101, route_id: 7,
  address: "1 Synthetic Way", city: "Syntheticville", state: "ZZ", zip: "00000",
  franchise_id: "3", comments: null, extras_allowed: 0, enabled: 1,
  driver_note: null, latitude: "0", longitude: "-10.5",
  last_audit_date: "2026-09-01", synced_at: "2026-10-02T00:00:00.000Z"
};
const secondAddress: Row = { ...address, pickup_address_id: 94202, city: "Second synthetic city" };
const container: Row = {
  container_id: 94301, pickup_address_id: 94201, container_type_id: 4,
  serial_number: "SYNTHETIC-SERIAL-1", rfid: null, oncall: 0, event_code: "SYN",
  gps_locked: 1, latitude: "0", longitude: "-11.5", enabled: 1,
  location_address: "Synthetic enclosure", city: "Syntheticville", state: "ZZ", zip: "00000",
  container_note: null, ud_cost_share_ud: "0", ud_enclosure_doors_ud: "2",
  ud_last_compactor_inspection_ud: null, ud_last_enclosure_inspection_ud: "2026-09-02",
  ud_material_stream_ud: "synthetic-paper", color: "blue", service_code_type: "SYN",
  service_code_input: "SYN-INPUT", service_code: "SYN-CODE", service_date: "2026-10-03",
  route_ids: "7,8", frequency_ids: "1,2", synced_at: "2026-10-03T00:00:00.000Z"
};
const secondContainer: Row = { ...container, container_id: 94302, serial_number: "SYNTHETIC-SERIAL-2" };
const thirdContainer: Row = {
  ...container, container_id: 94303, pickup_address_id: 94202, serial_number: "SYNTHETIC-SERIAL-3"
};

const specs = [
  { kind: "customer", alias: "customerId", key: "customer_id", row: customer,
    first: "company_name", second: "phone1", idValue: "94101", otherId: "94999" },
  { kind: "address", alias: "pickupAddressId", key: "pickup_address_id", row: address,
    first: "city", second: "address", idValue: "94201", otherId: "94999" },
  { kind: "container", alias: "containerId", key: "container_id", row: container,
    first: "serial_number", second: "location_address", idValue: "94301", otherId: "94999" }
] as const;
type Spec = (typeof specs)[number];

/** Keys no planned head declares: always unknown, on every route. */
const NEVER_VALID_KEYS = [
  "field", "feilds", "Fields", "FIELDS", "ID", "Id", "iD",
  "customer_id", "pickup_address_id", "container_id",
  "customerID", "customerid", "CustomerId", "pickupaddressid", "PickupAddressID",
  "containerid", "ContainerID",
  "addresses", "containers", "customer", "address", "container", "include",
  "limit", "offset", "cursor", "q", "enabled", "includeTotal",
  "since", "since_id", "dryRun", "DryRun", "partialProgress",
  "fields.customer", "customer.company_name", "fields[0]", "fields[]", "fields[bogus]",
  "fields[Customer]", "bogus_param", "foo", "SYNTHETIC-MARKER-probe"
];
/** Additive keys owned by unmerged cards: valid only when declared at head. */
const CONDITIONAL_KEYS = ["ids", "fields[customer]", "fields[address]", "fields[container]"];

function fullBundle(spec: Spec): Record<string, unknown> {
  if (spec.kind === "customer") return {
    customer: { ...customer },
    addresses: [
      { ...address, containers: [{ ...container }, { ...secondContainer }] },
      { ...secondAddress, containers: [{ ...thirdContainer }] }
    ]
  };
  if (spec.kind === "address") return {
    address: { ...address }, customer: { ...customer }, containers: [{ ...container }, { ...secondContainer }]
  };
  return { container: { ...container }, address: { ...address }, customer: { ...customer } };
}

function resetWork(): void {
  work.cacheReads = 0;
  work.cacheWrites = 0;
  work.statements.length = 0;
}

function expectNoWork(): void {
  expect(work).toEqual({ cacheReads: 0, cacheWrites: 0, statements: [] });
}

function appEnv(): Env {
  const stub = {
    async fetch(input: RequestInfo | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/throttle/failure") return Response.json({ blocked: false, retryAfterSec: 0 });
      if (url.pathname === "/throttle/clear") return new Response("OK");
      throw new Error("Unexpected auth-session/network operation in strict-query tests");
    }
  };
  return {
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    SHADOW_API_TOKEN: API_TOKEN, SHADOW_API_READ_TOKEN: READ_TOKEN,
    OPENAPI_DOCS_ENABLED: "true",
    CUSTOMER_DB: {
      prepare(sql: string) {
        work.statements.push(sql);
        if (!/^\s*SELECT\b/i.test(sql)) throw new Error("Hydrated GET attempted a database mutation");
        return DB.prepare(sql);
      }
    },
    AUTH_SESSION: { idFromName: (name: string) => name, get: () => stub }
  } as unknown as Env;
}

async function request(path: string, headers: HeadersInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const h = new Headers({ origin: ORIGIN });
  h.set("x-request-id", REQUEST_ID);
  h.set("authorization", `Bearer ${SECRET}`);
  new Headers(headers).forEach((value, key) => h.set(key, value));
  const response = await app.fetch(new Request(`https://synthetic.example.test${path}`, { headers: h }), appEnv(), {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}
  } as ExecutionContext);
  await Promise.all(pending);
  return response;
}

/** Raw query string, not URLSearchParams: empty key names must survive encoding. */
function getRaw(spec: Spec, rawQuery: string, headers: HeadersInit = {}): Promise<Response> {
  return request(`/api/v1/data/${spec.kind}?${rawQuery}`, headers);
}

function get(spec: Spec, pairs: Array<[string, string]>, headers: HeadersInit = {}): Promise<Response> {
  return getRaw(spec, new URLSearchParams(pairs).toString(), headers);
}

async function hashBytes(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tokenPattern(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`);
}

/**
 * The R21-04 strict 400: existing value-free problem type, fixed allowed-keys
 * guidance naming every declared key, PROBLEMS.md anchor, no echo of
 * submitted keys or values, and zero cache/D1 effects. Wording beyond that
 * is the Builder's; only the contract is pinned.
 */
async function expectStrict400(
  response: Response,
  spec: Spec,
  opts: { allowed: string[]; submitted: Array<{ key: string; value: string }> }
): Promise<string> {
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("x-entity-etag")).toBeNull();
  const raw = await response.text();
  const body = JSON.parse(raw) as Record<string, unknown>;
  expect(body).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
  expect(Object.keys(body).filter((key) => key !== "instance").sort())
    .toEqual(["detail", "status", "title", "type"]);
  if (body.instance !== undefined) {
    expect(body.instance).toMatch(/^\/api\/v1\/data\/(?:customer|address|container)$/);
  }
  const detail = String(body.detail ?? "");
  expect(detail).toContain("See docs/PROBLEMS.md#bad-request.");
  for (const key of opts.allowed) {
    // `id` needs token boundaries: a bare substring check would pass on any
    // word containing those letters. Distinctive keys use plain containment.
    if (key === "id") expect(detail).toMatch(/(^|[^A-Za-z0-9_])id($|[^A-Za-z0-9_])/);
    else expect(detail).toContain(key);
  }
  // Submitted keys are matched as tokens: the allowed key `fields` contains
  // the typo `field` as a substring, and that guidance is required, not a leak.
  for (const { key, value } of opts.submitted) {
    if (key !== "") expect(raw).not.toMatch(tokenPattern(key));
    if (value !== "") expect(raw).not.toContain(value);
  }
  expect(raw).not.toMatch(/received|invalid_type|"input"/i);
  expectNoWork();
  expect(detail).not.toContain("SYNTHETIC-MARKER");
  void spec;
  return detail;
}

async function expectUnauthorized(response: Response, gate: string): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ type: `${PROBLEM_TYPE_BASE}unauthorized`, title: "Unauthorized", status: 401,
    detail: gate === "outer" ? OUTER_DETAIL : INNER_DETAIL });
  expectNoWork();
}

async function insert(table: string, row: Row): Promise<void> {
  const keys = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .bind(...Object.values(row)).run();
}

/** Declared query keys per route, read from runtime OpenAPI (the Builder's own declaration). */
let declaredKeys: Record<string, string[]> = {};
async function loadDeclaredKeys(): Promise<void> {
  type Parameter = { name: string; in: string };
  type Operation = { parameters: Parameter[] };
  const response = await request("/openapi.json");
  expect(response.status).toBe(200);
  const doc = await response.json() as { paths: Record<string, { get: Operation }> };
  declaredKeys = {};
  for (const spec of specs) {
    declaredKeys[spec.kind] = doc.paths[`/api/v1/data/${spec.kind}`].get.parameters
      .filter((p) => p.in === "query").map((p) => p.name).sort();
  }
}

const network = vi.fn(() => { throw new Error("Outbound network forbidden in strict-query acceptance"); });
beforeAll(async () => {
  await ensureD1TestTables();
  vi.stubGlobal("fetch", network);
  await loadDeclaredKeys();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  cache.clear();
  network.mockClear();
  vi.stubGlobal("fetch", network);
  await DB.batch([
    DB.prepare("DELETE FROM container_snapshot"), DB.prepare("DELETE FROM address_snapshot"), DB.prepare("DELETE FROM customer_snapshot")
  ]);
  await insert("customer_snapshot", customer);
  await insert("address_snapshot", secondAddress);
  await insert("address_snapshot", address);
  await insert("container_snapshot", thirdContainer);
  await insert("container_snapshot", secondContainer);
  await insert("container_snapshot", container);
  resetWork();
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(network).not.toHaveBeenCalled();
});

describe.each(specs)("$kind strict query keys", (spec) => {
  describe("RED: unknown keys reject before cache/D1", () => {
    it.each(NEVER_VALID_KEYS)("?id=<valid>&%s=<value> 400s with allowed-keys guidance", async (key) => {
      const allowed = declaredKeys[spec.kind]!;
      const detail = await expectStrict400(
        await get(spec, [["id", spec.idValue], [key, "SYNTHETIC-MARKER-value"]]),
        spec, { allowed, submitted: [{ key, value: "SYNTHETIC-MARKER-value" }] });
      expect(detail).toBeTruthy();
    });

    it.each(NEVER_VALID_KEYS)("?alias=<valid>&%s=<value> 400s with allowed-keys guidance", async (key) => {
      const allowed = declaredKeys[spec.kind]!;
      await expectStrict400(
        await get(spec, [[spec.alias, spec.idValue], [key, "1"]]),
        spec, { allowed, submitted: [{ key, value: "1" }] });
    });

    it("?field= (headline typo) 400s on a warm cache without touching it", async () => {
      const allowed = declaredKeys[spec.kind]!;
      const warm = await get(spec, [["id", spec.idValue]]);
      expect(warm.status).toBe(200);
      expect(cache.size).toBe(1);
      const entry = cache.get(`${spec.kind}:${spec.idValue}`)!;
      const before = await entry.clone().text();
      resetWork();
      await expectStrict400(
        await get(spec, [["id", spec.idValue], ["field", spec.first]], {
          "if-none-match": entry.headers.get("etag")!
        }),
        spec, { allowed, submitted: [{ key: "field", value: spec.first }] });
      expect(work.cacheReads).toBe(0);
      expect(await cache.get(`${spec.kind}:${spec.idValue}`)!.clone().text()).toBe(before);
    });

    it("unknown key alongside a valid ?fields= projection 400s", async () => {
      const allowed = declaredKeys[spec.kind]!;
      await expectStrict400(
        await get(spec, [["id", spec.idValue], ["fields", spec.first], ["bogus_param", "1"]]),
        spec, { allowed, submitted: [{ key: "bogus_param", value: "1" }] });
    });

    it("repeated unknown keys 400s", async () => {
      const allowed = declaredKeys[spec.kind]!;
      await expectStrict400(
        await get(spec, [["id", spec.idValue], ["bogus_param", "1"], ["bogus_param", "2"]]),
        spec, { allowed, submitted: [{ key: "bogus_param", value: "1" }] });
    });

    it("empty key name (?id=<valid>&=x) 400s", async () => {
      const allowed = declaredKeys[spec.kind]!;
      // Raw query: URLSearchParams round-trips `=x`, but Hono's c.req.query()
      // drops the empty name — the Builder must enumerate raw query keys.
      await expectStrict400(
        await getRaw(spec, `id=${spec.idValue}&=SYNTHETIC-MARKER-empty`),
        spec, { allowed, submitted: [{ key: "", value: "SYNTHETIC-MARKER-empty" }] });
    });

    it("whitespace-only key name 400s", async () => {
      const allowed = declaredKeys[spec.kind]!;
      await expectStrict400(
        await get(spec, [["id", spec.idValue], [" ", "1"]]),
        spec, { allowed, submitted: [{ key: " ", value: "1" }] });
    });

    it("unknown key with an empty value still 400s as an unknown key", async () => {
      const allowed = declaredKeys[spec.kind]!;
      await expectStrict400(
        await getRaw(spec, `id=${spec.idValue}&bogus_param=`),
        spec, { allowed, submitted: [{ key: "bogus_param", value: "" }] });
    });

    it("guidance is fixed: identical detail across unknown keys, aliases and cache states", async () => {
      const allowed = declaredKeys[spec.kind]!;
      const warm = await get(spec, [["id", spec.idValue]]);
      expect(warm.status).toBe(200);
      const etag = warm.headers.get("etag")!;
      resetWork();
      const details = new Set<string>();
      const probes: Array<{ pairs: Array<[string, string]>; submitted: Array<{ key: string; value: string }>; headers?: HeadersInit }> = [
        { pairs: [["id", spec.idValue], ["field", spec.first]], submitted: [{ key: "field", value: spec.first }] },
        { pairs: [[spec.alias, spec.idValue], ["bogus_param", "1"]], submitted: [{ key: "bogus_param", value: "1" }] },
        { pairs: [["id", spec.idValue], ["fields", spec.first], ["limit", "5"]],
          submitted: [{ key: "limit", value: "5" }] },
        { pairs: [["id", spec.idValue], ["IDs", spec.idValue]], submitted: [{ key: "IDs", value: spec.idValue }],
          headers: { "if-none-match": etag } }
      ];
      for (const probe of probes) {
        details.add(await expectStrict400(
          await get(spec, probe.pairs, probe.headers), spec, { allowed, submitted: probe.submitted }));
        resetWork();
      }
      details.add(await expectStrict400(
        await getRaw(spec, `id=${spec.idValue}&=x`), spec, { allowed, submitted: [{ key: "", value: "x" }] }));
      expect(details.size).toBe(1);
    });
  });

  describe("additive keys owned by unmerged cards", () => {
    it("?ids= follows the implementation head: batch acceptance when declared, strict 400 otherwise", async () => {
      const allowed = declaredKeys[spec.kind]!;
      if (allowed.includes("ids")) {
        // #339 merged first: a valid batch is accepted (its full contract is
        // pinned by its own suite; here only acceptance + strict composition).
        const batch = await get(spec, [["ids", `${spec.idValue},${spec.idValue}`]]);
        expect(batch.status).toBe(200);
        const body = await batch.json() as { entries?: unknown[] };
        expect(Array.isArray(body.entries)).toBe(true);
        expect(body.entries).toHaveLength(2);
        resetWork();
        await expectStrict400(
          await get(spec, [["ids", spec.idValue], ["bogus_param", "1"]]),
          spec, { allowed, submitted: [{ key: "bogus_param", value: "1" }] });
      } else {
        // RED at base: `ids` is just another unknown key until #339 merges.
        await expectStrict400(
          await get(spec, [["id", spec.idValue], ["ids", spec.idValue]]),
          spec, { allowed, submitted: [{ key: "ids", value: spec.idValue }] });
      }
    });

    it.each(["fields[customer]", "fields[address]", "fields[container]"])(
      "%s follows the implementation head: typed acceptance when declared, strict 400 otherwise",
      async (typed) => {
        const allowed = declaredKeys[spec.kind]!;
        if (allowed.includes(typed)) {
          // R20-02 merged first: a valid typed selector is accepted (its full
          // contract is pinned by its own suite; here only acceptance).
          const typedResponse = await get(spec, [["id", spec.idValue], [typed, spec.first]]);
          expect(typedResponse.status).toBe(200);
          resetWork();
          await expectStrict400(
            await get(spec, [["id", spec.idValue], [typed, spec.first], ["bogus_param", "1"]]),
            spec, { allowed, submitted: [{ key: "bogus_param", value: "1" }] });
        } else {
          // RED at base: typed selectors are unknown keys until R20-02 merges.
          await expectStrict400(
            await get(spec, [["id", spec.idValue], [typed, spec.first]]),
            spec, { allowed, submitted: [{ key: typed, value: spec.first }] });
        }
      }
    );
  });

  describe("GREEN: invalid values still 400 without echo or work", () => {
    it.each([
      ["non-numeric id", [["id", "not-an-id-SYNTHETIC-MARKER"]]],
      ["leading-zero id", [["id", "01"]]],
      ["fraction id", [["id", "1.5"]]],
      ["unknown fields column", [["id", spec.idValue], ["fields", "SYNTHETIC-MARKER-column"]]],
      ["empty fields member", [["id", spec.idValue], ["fields", `${spec.first},,${spec.second}`]]],
      ["missing id and alias", []]
    ])("%s rejects 400 value-free before cache/D1", async (_label, pairs) => {
      const response = await get(spec, pairs as Array<[string, string]>);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
      const raw = await response.text();
      expect(raw).toContain("See docs/PROBLEMS.md#bad-request.");
      expect(raw).not.toContain("SYNTHETIC-MARKER");
      expect(JSON.parse(raw)).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
      expectNoWork();
    });

    it.each([["id"], [spec.alias]])("repeated known key %s still 400s", async (parameter) => {
      const response = await get(spec, [[parameter, spec.idValue], [parameter, spec.idValue]]);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("See docs/PROBLEMS.md#bad-request.");
      expectNoWork();
    });

    it("repeated fields keys still 400s", async () => {
      const response = await get(spec, [["id", spec.idValue], ["fields", spec.first], ["fields", spec.second]]);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("See docs/PROBLEMS.md#bad-request.");
      expectNoWork();
    });

    it("unknown key beside an invalid value still 400s without echo or work", async () => {
      // Order between the unknown-key check and value validation is the
      // Builder's; either anchored 400 is acceptable here.
      const response = await get(spec, [["id", "not-an-id-SYNTHETIC-MARKER"], ["bogus_param", "1"]]);
      expect(response.status).toBe(400);
      const raw = await response.text();
      expect(raw).toContain("See docs/PROBLEMS.md#bad-request.");
      expect(raw).not.toContain("SYNTHETIC-MARKER");
      expectNoWork();
    });
  });

  describe("GREEN: valid paths behave exactly as before", () => {
    it("omitted selectors serve the exact full bundle, then warm cache without D1", async () => {
      const cold = await get(spec, [["id", spec.idValue]]);
      expect(cold.status).toBe(200);
      expect(cold.headers.get("cache-control")).toBe("private, max-age=60");
      expect(cold.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      const text = await cold.text();
      expect(JSON.parse(text)).toEqual(fullBundle(spec));
      expect(text).toBe(JSON.stringify(fullBundle(spec)));
      const digest = await hashBytes(text);
      expect(cold.headers.get("etag")).toBe(`"${digest}"`);
      expect(cold.headers.get("x-entity-etag")).toBe(digest);
      expect(work.statements.length).toBeGreaterThan(0);
      expect(work.cacheWrites).toBe(1);
      resetWork();
      const warm = await get(spec, [["id", spec.idValue]]);
      expect(warm.status).toBe(200);
      expect(await warm.text()).toBe(text);
      expect(warm.headers.get("etag")).toBe(`"${digest}"`);
      expect(work.statements).toEqual([]);
    });

    it("alias read serves identical bytes and validators", async () => {
      const canonical = await get(spec, [["id", spec.idValue]]);
      const body = await canonical.text();
      const etag = canonical.headers.get("etag");
      cache.clear();
      resetWork();
      const alias = await get(spec, [[spec.alias, spec.idValue]]);
      expect(alias.status).toBe(200);
      expect(await alias.text()).toBe(body);
      expect(alias.headers.get("etag")).toBe(etag);
    });

    it("valid fields projection still projects only the root", async () => {
      const response = await get(spec, [["id", spec.idValue], ["fields", spec.first]]);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, Record<string, unknown>>;
      expect(body[spec.kind]).toEqual({ [spec.key]: spec.row[spec.key], [spec.first]: spec.row[spec.first] });
      expect(Object.keys(body).sort()).toEqual(Object.keys(fullBundle(spec)).sort());
    });

    it("trailing bare & carries no key and still serves 200", async () => {
      const response = await getRaw(spec, `id=${spec.idValue}&`);
      expect(response.status).toBe(200);
      expect(JSON.parse(await response.text())).toEqual(fullBundle(spec));
    });

    it("valid unknown root id stays a value-free 404", async () => {
      const response = await get(spec, [["id", spec.otherId]]);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toMatchObject({ title: "Not Found", status: 404 });
      expect(cache.size).toBe(0);
    });

    it("matching If-None-Match still 304s with an empty body", async () => {
      const full = await get(spec, [["id", spec.idValue]]);
      const etag = full.headers.get("etag")!;
      resetWork();
      const conditional = await get(spec, [["id", spec.idValue]], { "if-none-match": etag });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
      expect(conditional.headers.get("etag")).toBe(etag);
      expect(work.statements).toEqual([]);
    });
  });

  describe("auth precedence over the strict check", () => {
    it.each([
      ["no bearer", "", "outer"],
      ["wrong bearer", "Bearer synthetic-wrong", "outer"],
      ["API token", `Bearer ${API_TOKEN}`, "inner"],
      ["read token", `Bearer ${READ_TOKEN}`, "inner"]
    ])("%s + unknown key 401s at the %s gate without validation or work", async (_label, authorization, gate) => {
      await loadSeededCache(spec);
      await expectUnauthorized(
        await get(spec, [["id", spec.idValue], ["bogus_param", "1"]], { authorization }),
        gate);
    });

    it.each([
      ["no bearer", "", "outer"],
      ["wrong bearer", "Bearer synthetic-wrong", "outer"],
      ["API token", `Bearer ${API_TOKEN}`, "inner"],
      ["read token", `Bearer ${READ_TOKEN}`, "inner"]
    ])("%s + coercible-invalid id beside an unknown key 401s at the %s gate", async (_label, authorization, gate) => {
      // Both the canonical-ID check and the unknown-key check run after auth.
      await expectUnauthorized(
        await get(spec, [["id", "01"], ["bogus_param", "1"]], { authorization }),
        gate);
    });

    it("sync secret + unknown key is the strict 400, not a 401", async () => {
      const allowed = declaredKeys[spec.kind]!;
      await expectStrict400(
        await get(spec, [["id", spec.idValue], ["bogus_param", "1"]]),
        spec, { allowed, submitted: [{ key: "bogus_param", value: "1" }] });
    });
  });
});

async function loadSeededCache(spec: Spec): Promise<void> {
  const warm = await get(spec, [["id", spec.idValue]]);
  expect(warm.status).toBe(200);
  resetWork();
}

describe("hydrated GET query declarations", () => {
  it("declare id, alias and fields on every route, plus only documented additive keys", async () => {
    type Parameter = { name: string; in: string; required?: boolean };
    type Operation = { operationId: string; parameters: Parameter[]; "x-access": string; "x-effect": string };
    const response = await request("/openapi.json");
    expect(response.status).toBe(200);
    const doc = await response.json() as { paths: Record<string, { get: Operation }> };
    const universe = new Set(["id", "fields", ...CONDITIONAL_KEYS]);
    for (const spec of specs) {
      universe.add(spec.alias);
      const op = doc.paths[`/api/v1/data/${spec.kind}`].get;
      expect(op.operationId).toBe(`getData${spec.kind[0]!.toUpperCase()}${spec.kind.slice(1)}`);
      expect(op["x-access"]).toBe("sync-secret");
      expect(op["x-effect"]).toBe("local-read");
      const names = op.parameters.filter((p) => p.in === "query").map((p) => p.name).sort();
      expect(names).toEqual(expect.arrayContaining(["id", spec.alias, "fields"]));
      for (const name of names) {
        expect(universe.has(name)).toBe(true);
      }
      expect(names).toEqual(declaredKeys[spec.kind]!.slice().sort());
      expectNoWork();
    }
  });
});
