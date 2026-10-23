/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Root-only sparse fields for hydrated single-ID reads. Expectations come from
 * synthetic fixtures, not the production field dictionary/projector/hash helper.
 * Real routing, auth, validation, D1 hydration, serialization and ETags execute;
 * only the external cache/network boundaries are replaced. No upstream writes.
 *
 * Missing projection/validation is intentionally RED before the paired build.
 * Do not weaken assertions or update these tests from the implementation card.
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
const SECRET = "synthetic-root-fields-secret";
const ORIGIN = "https://synthetic-fields-client.invalid";
const PROBLEMS = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md";
const FIELD_ERROR = "Invalid request query (fields). See docs/PROBLEMS.md#bad-request.";
type Row = Record<string, string | number | null>;
type Bundle = Record<string, unknown>;

// Every selectable stored column has an independent fixture value (including
// null, zero and empty-string values). This is a test oracle, not a second
// production dictionary. Secondary rows are inserted out of order below.
const customer: Row = {
  customer_id: 94101, customer_type_id: 2, company_name: "Synthetic root company",
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
    first: "company_name", second: "phone1", nullable: "middle_initial", omitted: "phone2",
    cross: ["pickup_address_id", "container_id", "serial_number", "city"] },
  { kind: "address", alias: "pickupAddressId", key: "pickup_address_id", row: address,
    first: "city", second: "address", nullable: "driver_note", omitted: "comments",
    cross: ["container_id", "serial_number", "company_name", "phone1"] },
  { kind: "container", alias: "containerId", key: "container_id", row: container,
    first: "serial_number", second: "location_address", nullable: "rfid", omitted: "container_note",
    cross: ["customer_id", "company_name", "address", "phone1"] }
] as const;
type Spec = (typeof specs)[number];

function fullBundle(spec: Spec): Bundle {
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
function selectedBundle(spec: Spec, selected: Row, canonical = fullBundle(spec)): Bundle {
  return { ...canonical, [spec.kind]: selected };
}
function resetWork(): void {
  work.cacheReads = 0;
  work.cacheWrites = 0;
  work.statements.length = 0;
}
function appEnv(): Env {
  const stub = {
    async fetch(input: RequestInfo | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/throttle/failure") return Response.json({ blocked: false, retryAfterSec: 0 });
      if (url.pathname === "/throttle/clear") return new Response("OK");
      throw new Error("Unexpected auth-session/network operation in root-fields tests");
    }
  };
  return {
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    SHADOW_API_TOKEN: "synthetic-api-token", SHADOW_API_READ_TOKEN: "synthetic-read-token",
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
  // Keep full cold/warm header comparisons strict despite per-request ID stamping.
  h.set("x-request-id", "synthetic-hydrated-fields-request");
  h.set("authorization", `Bearer ${SECRET}`);
  new Headers(headers).forEach((value, key) => h.set(key, value));
  const response = await app.fetch(new Request(`https://synthetic.example.test${path}`, { headers: h }), appEnv(), {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}
  } as ExecutionContext);
  await Promise.all(pending);
  return response;
}
function get(spec: Spec, fields?: string, options: {
  parameter?: string; id?: string; extra?: Array<[string, string]>; headers?: HeadersInit;
} = {}): Promise<Response> {
  const pairs: Array<[string, string]> = [[options.parameter ?? "id", options.id ?? String(spec.row[spec.key])]];
  if (fields !== undefined) pairs.push(["fields", fields]);
  pairs.push(...(options.extra ?? []));
  return request(`/api/v1/data/${spec.kind}?${new URLSearchParams(pairs)}`, options.headers);
}
async function hashBytes(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function expectServed(response: Response, expected: Bundle): Promise<{ text: string; etag: string }> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, max-age=60");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual(expected);
  const digest = await hashBytes(text);
  expect(response.headers.get("etag")).toBe(`"${digest}"`);
  expect(response.headers.get("x-entity-etag")).toBe(digest);
  return { text, etag: `"${digest}"` };
}
async function expect304(response: Response, etag: string): Promise<void> {
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(response.headers.get("etag")).toBe(etag);
  expect(response.headers.get("cache-control")).toBe("private, max-age=60");
}
function allHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return headers;
}
async function seedCache(spec: Spec, bundle = fullBundle(spec)): Promise<void> {
  const text = JSON.stringify(bundle);
  const digest = await hashBytes(text);
  cache.set(`${spec.kind}:${spec.row[spec.key]}`, new Response(text, { headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=60",
    etag: `"${digest}"`, "x-entity-etag": digest
  } }));
}
async function expectCanonicalCache(spec: Spec, expected = fullBundle(spec)): Promise<void> {
  // A cold selected read may choose not to cache. If it does, it must store the
  // full representation under the existing canonical key, never selected data.
  for (const [key, response] of cache) {
    expect(key).toBe(`${spec.kind}:${spec.row[spec.key]}`);
    const text = await response.clone().text();
    expect(JSON.parse(text)).toEqual(expected);
    expect(response.headers.get("etag")).toBe(`"${await hashBytes(text)}"`);
  }
}
function expectNoWork(): void {
  expect(work).toEqual({ cacheReads: 0, cacheWrites: 0, statements: [] });
}
async function expectFields400(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ type: `${PROBLEMS}#bad-request`, title: "Bad Request", status: 400, detail: FIELD_ERROR });
  expect(Object.keys(body).filter((key) => key !== "instance").sort()).toEqual(["detail", "status", "title", "type"]);
  if (body.instance !== undefined) expect(body.instance).toMatch(/^\/api\/v1\/data\/(?:customer|address|container)$/);
  expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC-MARKER|received|invalid_type|"input"|\?fields/i);
  expectNoWork();
}
async function insert(table: string, row: Row): Promise<void> {
  const keys = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .bind(...Object.values(row)).run();
}
const network = vi.fn(() => { throw new Error("Outbound network forbidden in root-fields acceptance"); });
beforeAll(async () => { await ensureD1TestTables(); });
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

describe.each(specs)("$kind root-only hydrated fields", (spec) => {
  it("omitted fields preserves exact full bytes, headers, warm cache and full validators", async () => {
    const coldResponse = await get(spec);
    const coldHeaders = allHeaders(coldResponse);
    const cold = await expectServed(coldResponse, fullBundle(spec));
    expect(cold.text).toBe(JSON.stringify(fullBundle(spec)));
    expect(work.statements.length).toBeGreaterThan(0);
    expect(work.cacheWrites).toBe(1);
    expect(cache.size).toBe(1);
    resetWork();
    const warmResponse = await get(spec, undefined, { parameter: spec.alias });
    expect(allHeaders(warmResponse)).toEqual(coldHeaders);
    expect(await expectServed(warmResponse, fullBundle(spec))).toEqual(cold);
    expect(work.statements).toEqual([]);
    await expect304(await get(spec, undefined, { headers: { "if-none-match": cold.etag } }), cold.etag);
    expect(work.statements).toEqual([]);
  });

  it.each(Object.entries(spec.row))("selects allowlisted %s alone, always retaining the primary ID", async (field, value) => {
    const expected = { [spec.key]: spec.row[spec.key], [field]: value };
    await expectServed(await get(spec, field), selectedBundle(spec, expected));
    await expectCanonicalCache(spec);
  });

  it("all allowlisted fields retain the full representation and its validator", async () => {
    const full = await expectServed(await get(spec), fullBundle(spec));
    cache.clear();
    const all = await expectServed(await get(spec, Object.keys(spec.row).join(",")), fullBundle(spec));
    expect(all).toEqual(full);
  });

  it.each(["id", spec.alias])("%s selection preserves every relation, array order, null and falsey value", async (parameter) => {
    const root = { [spec.key]: spec.row[spec.key], [spec.first]: spec.row[spec.first], [spec.nullable]: null };
    await expectServed(await get(spec, `${spec.first},${spec.nullable}`, { parameter }), selectedBundle(spec, root));
  });

  it("explicit primary ID is not duplicated and ID-only selection retains the related bundle", async () => {
    const root = { [spec.key]: spec.row[spec.key], [spec.first]: spec.row[spec.first] };
    const implicit = await expectServed(await get(spec, spec.first), selectedBundle(spec, root));
    cache.clear();
    const explicit = await expectServed(await get(spec, `${spec.key},${spec.first}`), selectedBundle(spec, root));
    expect(explicit).toEqual(implicit);
    await expectServed(await get(spec, spec.key), selectedBundle(spec, { [spec.key]: spec.row[spec.key] }));
  });

  it("cold selection is response shaping, not a different D1 query or a selected-body canonical cache", async () => {
    await expectServed(await get(spec), fullBundle(spec));
    const sql = [...work.statements];
    cache.clear();
    resetWork();
    const root = { [spec.key]: spec.row[spec.key], [spec.first]: spec.row[spec.first] };
    await expectServed(await get(spec, spec.first), selectedBundle(spec, root));
    expect(work.statements).toEqual(sql);
    await expectCanonicalCache(spec);
    await expectServed(await get(spec), fullBundle(spec));
  });

  it("warm canonical cache projects non-mutatingly and alternating selectors never contaminate full reads", async () => {
    const full = await expectServed(await get(spec), fullBundle(spec));
    const canonicalText = await cache.get(`${spec.kind}:${spec.row[spec.key]}`)!.clone().text();
    resetWork();
    for (const field of [spec.first, spec.second, spec.nullable, spec.first]) {
      await expectServed(await get(spec, field), selectedBundle(spec, { [spec.key]: spec.row[spec.key], [field]: spec.row[field] }));
      expect(await cache.get(`${spec.kind}:${spec.row[spec.key]}`)!.clone().text()).toBe(canonicalText);
      await expectCanonicalCache(spec);
    }
    expect(await expectServed(await get(spec), fullBundle(spec))).toEqual(full);
    expect(work.statements).toEqual([]);
    expect(work.cacheWrites).toBe(0);
  });

  it.each([false, true])("full-only validator cannot return a projected 304 (warm cache: %s)", async (warm) => {
    const full = await expectServed(await get(spec), fullBundle(spec));
    if (!warm) cache.clear();
    const root = { [spec.key]: spec.row[spec.key], [spec.first]: spec.row[spec.first] };
    const selected = await expectServed(await get(spec, spec.first, { headers: { "if-none-match": full.etag } }), selectedBundle(spec, root));
    expect(selected.etag).not.toBe(full.etag);
    await expectCanonicalCache(spec);
    await expectServed(await get(spec, undefined, { headers: { "if-none-match": selected.etag } }), fullBundle(spec));
  });

  it.each([false, true])("matching projected validators produce empty 304s only for that representation (warm: %s)", async (warm) => {
    const root = { [spec.key]: spec.row[spec.key], [spec.first]: spec.row[spec.first] };
    const selected = await expectServed(await get(spec, spec.first), selectedBundle(spec, root));
    for (const validator of [selected.etag, `W/${selected.etag}`, `"unrelated", ${selected.etag}`, "*"]) {
      if (!warm) cache.clear();
      await expect304(await get(spec, spec.first, { headers: { "if-none-match": validator } }), selected.etag);
    }
    const alternate = await expectServed(await get(spec, spec.second, { headers: { "if-none-match": selected.etag } }),
      selectedBundle(spec, { [spec.key]: spec.row[spec.key], [spec.second]: spec.row[spec.second] }));
    expect(alternate.etag).not.toBe(selected.etag);
  });

  it("changing a selected-out root field changes the full validator but not selected bytes/304", async () => {
    const oldFull = await expectServed(await get(spec), fullBundle(spec));
    const root = { [spec.key]: spec.row[spec.key], [spec.first]: spec.row[spec.first] };
    const oldSelected = await expectServed(await get(spec, spec.first), selectedBundle(spec, root));
    await DB.prepare(`UPDATE ${spec.kind}_snapshot SET ${spec.omitted} = ? WHERE ${spec.key} = ?`)
      .bind("Synthetic changed omitted field", spec.row[spec.key]).run();
    cache.clear(); // Simulates normal expiry/invalidation, not a mutation endpoint.
    const changed = fullBundle(spec);
    changed[spec.kind] = { ...spec.row, [spec.omitted]: "Synthetic changed omitted field" };
    const newFull = await expectServed(await get(spec), changed);
    expect(newFull.etag).not.toBe(oldFull.etag);
    const newSelected = await expectServed(await get(spec, spec.first), selectedBundle(spec, root, changed));
    expect(newSelected).toEqual(oldSelected);
    await expect304(await get(spec, spec.first, { headers: { "if-none-match": oldSelected.etag } }), oldSelected.etag);
  });

  it("changing a selected root value invalidates its projected validator", async () => {
    const root = { [spec.key]: spec.row[spec.key], [spec.first]: spec.row[spec.first] };
    const old = await expectServed(await get(spec, spec.first), selectedBundle(spec, root));
    await DB.prepare(`UPDATE ${spec.kind}_snapshot SET ${spec.first} = ? WHERE ${spec.key} = ?`)
      .bind("Synthetic changed selected value", spec.row[spec.key]).run();
    cache.clear();
    const changed = await expectServed(await get(spec, spec.first, { headers: { "if-none-match": old.etag } }),
      selectedBundle(spec, { ...root, [spec.first]: "Synthetic changed selected value" }));
    expect(changed.etag).not.toBe(old.etag);
  });

  it("related data remains in the served-byte hash even when the root is ID-only", async () => {
    const root = { [spec.key]: spec.row[spec.key] };
    const old = await expectServed(await get(spec, spec.key), selectedBundle(spec, root));
    const changed = fullBundle(spec);
    if (spec.kind === "customer") {
      await DB.prepare("UPDATE address_snapshot SET city = 'Changed synthetic relation' WHERE pickup_address_id = 94202").run();
      (changed.addresses as Row[])[1] = { ...(changed.addresses as Row[])[1], city: "Changed synthetic relation" };
    } else {
      await DB.prepare("UPDATE customer_snapshot SET company_name = 'Changed synthetic relation' WHERE customer_id = 94101").run();
      changed.customer = { ...customer, company_name: "Changed synthetic relation" };
    }
    cache.clear();
    const selected = await expectServed(await get(spec, spec.key, { headers: { "if-none-match": old.etag } }), selectedBundle(spec, root, changed));
    expect(selected.etag).not.toBe(old.etag);
  });

  it("preserves cached empty/null related members rather than inventing rows or projecting parents", async () => {
    const canonical: Bundle = spec.kind === "customer" ? { customer: { ...customer }, addresses: [] }
      : spec.kind === "address" ? { address: { ...address }, customer: null, containers: [] }
      : { container: { ...container }, address: null, customer: null };
    await seedCache(spec, canonical);
    const root = { [spec.key]: spec.row[spec.key], [spec.first]: spec.row[spec.first] };
    await expectServed(await get(spec, spec.first), selectedBundle(spec, root, canonical));
    await expectCanonicalCache(spec, canonical);
    expect(work.statements).toEqual([]);
  });

  it("a valid selected read of an unknown root stays a value-free 404", async () => {
    const response = await get(spec, spec.first, { id: "94999" });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ type: `${PROBLEMS}#not-found`, title: "Not Found", status: 404 });
    expect(work.statements.length).toBeGreaterThan(0);
    expect(cache.size).toBe(0);
  });

  it("fields does not add batch ids support or relax malformed unused-ID validation", async () => {
    for (const pairs of [
      [["ids", "94101,94102"], ["fields", spec.first]],
      [["id", String(spec.row[spec.key])], [spec.alias, "01"], ["fields", spec.first]]
    ]) {
      const response = await request(`/api/v1/data/${spec.kind}?${new URLSearchParams(pairs)}`);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("See docs/PROBLEMS.md#bad-request.");
      expectNoWork();
    }
  });

  const invalid = [
    "", ",", `${spec.first},`, `,${spec.first}`, `${spec.first},,${spec.second}`,
    `${spec.first},${spec.first}`, `${spec.key},${spec.key}`, ` ${spec.first}`, `${spec.first} `,
    `${spec.first}, ${spec.second}`, spec.first.toUpperCase(), "*", `${spec.first},*`,
    `${spec.kind}.${spec.first}`, `fields[${spec.first}]`, "customer.company_name", "addresses", "containers",
    "addresses.containers.serial_number", "include", "SYNTHETIC-MARKER-column", "rowid", "deleted_at",
    ...spec.cross
  ];
  describe.each([false, true])("malformed selector (warm full cache: %s)", (warm) => {
    beforeEach(async () => { if (warm) await seedCache(spec); });
    it.each(invalid)("refuses %j value-free before canonical cache or D1", async (fields) => {
      const cached = cache.get(`${spec.kind}:${spec.row[spec.key]}`);
      await expectFields400(await get(spec, fields, { headers: { "if-none-match": cached?.headers.get("etag") ?? '"unrelated"' } }));
      expect(work.cacheWrites).toBe(0);
    });
    it.each([spec.first, spec.second, ""])("refuses repeated fields keys even with second value %j", async (second) => {
      await expectFields400(await get(spec, spec.first, { extra: [["fields", second]] }));
    });
  });

  describe.each([
    { label: "no bearer", authorization: "", gate: "SHADOW_API_TOKEN" },
    { label: "wrong bearer", authorization: "Bearer synthetic-wrong", gate: "SHADOW_API_TOKEN" },
    { label: "API token", authorization: "Bearer synthetic-api-token", gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" },
    { label: "read token", authorization: "Bearer synthetic-read-token", gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" }
  ])("$label preserves auth precedence", ({ authorization, gate }) => {
    beforeEach(async () => { await seedCache(spec); });
    it.each([undefined, spec.first, "SYNTHETIC-MARKER-column"])("401s before fields validation for %j", async (fields) => {
      const response = await get(spec, fields, { headers: { authorization } });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ type: `${PROBLEMS}#unauthorized`, status: 401,
        detail: `Send Authorization: Bearer <${gate}>. See docs/PROBLEMS.md#unauthorized.` });
      expectNoWork();
    });
  });

  describe("mixed ID/fields auth-order regression", () => {
    // Invalid fields must not expose preliminary ID errors to ordinary tokens.
    // With no fields error, those same preliminary ID-only 400s remain compatible.
    describe.each(["id", spec.alias])("invalid %s beside a valid alternative", (parameter) => {
      describe.each(["malformed", "repeated"] as const)("%s ID", (shape) => {
        const validId = String(spec.row[spec.key]);
        const other = parameter === "id" ? spec.alias : "id";
        const id = shape === "malformed" ? "SYNTHETIC-MARKER-invalid-id" : validId;
        const idPairs: Array<[string, string]> = [[other, validId]];
        if (shape === "repeated") idPairs.push([parameter, validId]);
        const invalidSelectors = [
          { label: "unknown field", fields: "SYNTHETIC-MARKER-column", extra: [] },
          { label: "empty CSV member", fields: `${spec.first},,${spec.second}`, extra: [] },
          { label: "repeated fields keys", fields: spec.first, extra: [["fields", spec.second]] }
        ] satisfies Array<{ label: string; fields: string; extra: Array<[string, string]> }>;

        beforeEach(async () => { await seedCache(spec); });
        function mixedRequest(fields: string | undefined, extra: Array<[string, string]>, authorization: string) {
          return get(spec, fields, { parameter, id, extra: [...idPairs, ...extra], headers: {
            authorization, "if-none-match": cache.get(`${spec.kind}:${validId}`)!.headers.get("etag")!
          } });
        }
        async function expectUnauthorized(response: Response, gate: string): Promise<void> {
          expectNoWork();
          expect(response.status).toBe(401);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
          expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
          expect(response.headers.get("etag")).toBeNull();
          expect(response.headers.get("x-entity-etag")).toBeNull();
          const body = await response.json() as Record<string, unknown>;
          const { instance, requestId, ...problem } = body;
          if (requestId !== undefined) expect(requestId).toBe("synthetic-hydrated-fields-request");
          expect(problem).toEqual({ type: `${PROBLEMS}#unauthorized`, title: "Unauthorized", status: 401,
            detail: `Send Authorization: Bearer <${gate}>. See docs/PROBLEMS.md#unauthorized.` });
          if (instance !== undefined) expect(instance).toBe(`/api/v1/data/${spec.kind}`);
          expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC-MARKER|received|invalid_type|"input"|\?/i);
        }

        describe.each([
          { label: "API token", authorization: "Bearer synthetic-api-token" },
          { label: "read token", authorization: "Bearer synthetic-read-token" }
        ])("$label", ({ authorization }) => {
          it.each(invalidSelectors)("invalid $label requires inner auth before ID/fields errors", async ({ fields, extra }) => {
            await expectUnauthorized(await mixedRequest(fields, extra, authorization), "CUSTOMER_SNAPSHOT_SYNC_SECRET");
          });

          it.each([
            { label: "omitted fields", fields: undefined },
            { label: "valid selected field", fields: spec.first },
            { label: "valid primary-ID selection", fields: spec.key }
          ])("preserves preliminary ID-only 400 with $label", async ({ fields }) => {
            const response = await mixedRequest(fields, [], authorization);
            expectNoWork();
            expect(response.status).toBe(400);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
            expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
            const body = await response.json() as Record<string, unknown>;
            expect(body).toMatchObject({ type: `${PROBLEMS}#bad-request`, title: "Bad Request", status: 400 });
            expect(Object.keys(body).filter((key) => key !== "instance").sort()).toEqual(["detail", "status", "title", "type"]);
            expect(body.detail).toEqual(expect.any(String));
            expect(String(body.detail)).toContain(parameter);
            expect(String(body.detail)).toContain("See docs/PROBLEMS.md#bad-request.");
            if (body.instance !== undefined) expect(body.instance).toBe(`/api/v1/data/${spec.kind}`);
            expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC-MARKER|received|invalid_type|"input"|\?/i);
          });
        });

        describe.each([
          { label: "no bearer", authorization: "" },
          { label: "wrong bearer", authorization: "Bearer synthetic-wrong" }
        ])("$label", ({ authorization }) => {
          it.each(invalidSelectors)("preserves outer auth before mixed ID/$label errors", async ({ fields, extra }) => {
            await expectUnauthorized(await mixedRequest(fields, extra, authorization), "SHADOW_API_TOKEN");
          });
        });
      });
    });
  });
});

it("runtime OpenAPI exposes root-only fields, representation validators and no batch selector on all hydrated GETs", async () => {
  type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: { type?: string; description?: string } };
  type Operation = { operationId: string; description?: string; parameters: Parameter[];
    responses: Record<string, { description?: string }>; "x-access": string; "x-effect": string };
  const response = await request("/openapi.json");
  expect(response.status).toBe(200);
  const doc = await response.json() as { paths: Record<string, { get: Operation }> };
  for (const spec of specs) {
    const op = doc.paths[`/api/v1/data/${spec.kind}`].get;
    expect(op.operationId).toBe(`getData${spec.kind[0].toUpperCase()}${spec.kind.slice(1)}`);
    expect(op["x-access"]).toBe("sync-secret");
    expect(op["x-effect"]).toBe("local-read");
    // Per-type bundle selectors (R20-02) ride on every data-entity GET; flat
    // `fields` below keeps its root-only meaning with relations unchanged.
    expect(op.parameters.filter((p) => p.in === "query").map((p) => p.name).sort()).toEqual(
      ["fields", "fields[address]", "fields[container]", "fields[customer]", "id", spec.alias].sort());
    const fields = op.parameters.find((p) => p.name === "fields");
    expect(fields).toMatchObject({ in: "query", required: false, schema: { type: "string" } });
    const selectorDocs = `${fields?.description ?? ""} ${fields?.schema?.description ?? ""}`;
    expect(selectorDocs).toMatch(/comma/i);
    expect(selectorDocs).toMatch(/allowlist|whitelist/i);
    const docs = `${selectorDocs} ${op.description ?? ""} ${op.responses["200"]?.description ?? ""}`;
    expect(docs).toMatch(new RegExp(`(?:root|\\.${spec.kind})`, "i"));
    expect(docs).toMatch(/relat(?:ed|ion).*unchanged|unchanged.*relat(?:ed|ion)/i);
    expect(docs).toMatch(/ETag/i);
    expect(docs).toMatch(/projected|served bytes|representation/i);
    expect(op.responses["400"]?.description).toMatch(/fields/i);
  }
  expectNoWork();
});
