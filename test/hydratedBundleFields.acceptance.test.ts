/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Per-type sparse fieldsets for hydrated single-ID bundles (R20-02).
 *
 * Contract pinned here (JSON:API-style, narrowed to the three snapshot types):
 * - Optional `fields[customer]` / `fields[address]` / `fields[container]` keys
 *   on all three `/api/v1/data/*` GETs. Each reuses its type's existing #333
 *   allowlist with strict parsing identical to flat roots: exact snake_case,
 *   comma-separated, no whitespace, no case folding, no empty segments, no
 *   duplicates, single key each.
 * - Flat `fields=` keeps its exact root-only meaning. `fields[ROOT]` alone
 *   projects the root identically to flat. Flat + `fields[ROOT]` together is
 *   an ambiguous-root 400. Flat + non-root typed keys compose freely.
 * - An omitted `fields[type]` leaves that type full; only listed types project.
 *   Every projected object retains its primary id even when unlisted.
 * - Projection is per relation segment: customer bundles trim `addresses[]`
 *   and nested `containers[]`; address bundles trim `customer` and
 *   `containers[]`; container bundles trim `address` and `customer`. Structure
 *   (keys, order, nesting, the `containers` array key on projected addresses)
 *   is unchanged; only leaf stored columns drop.
 * - ETags hash the served bytes per representation; projected validators never
 *   reuse a full-only validator, the canonical full cache is never overwritten
 *   by a projection, and conditional 304s work per projected representation.
 * - Unknown field names, malformed selectors, repeated typed keys, unknown
 *   `fields[TYPE]` keys and ambiguous flat+typed-root combinations fail with
 *   the existing value-free 400 before cache or D1, preserving sync-secret
 *   auth precedence (including the mixed ID/fields inner-auth gate).
 *
 * Expectations come from synthetic fixtures, not the production field
 * dictionary/projector/hash helper. Real routing, auth, validation, D1
 * hydration, serialization and ETags execute; only the external cache/network
 * boundaries are replaced. No upstream writes.
 *
 * Missing per-type projection/validation is intentionally RED before the paired
 * build. Do not weaken assertions or update these tests from the implementation
 * card. The Builder builds on this branch and never edits this file.
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
const SECRET = "synthetic-bundle-fields-secret";
const ORIGIN = "https://synthetic-bundle-fields-client.invalid";
const PROBLEMS = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md";
type Row = Record<string, string | number | null>;
type Bundle = Record<string, unknown>;

// Every selectable stored column has an independent fixture value (including
// null, zero and empty-string values). This is a test oracle, not a second
// production dictionary. Secondary rows are inserted out of order below.
// IDs are disjoint from hydratedFields (94xxx) and sparseFieldsets (91xx).
const customer: Row = {
  customer_id: 95101, customer_type_id: 2, company_name: "Synthetic bundle company",
  first_name: "Synthetic", middle_initial: null, last_name: "Bundle",
  name_suffix: "", customer_number: "BUN-001", sub_customer_number: "SUB-B1",
  phone1: "555-0150", phone2: null, comments: "Synthetic bundle customer note",
  enabled: 1, synced_at: "2026-10-11T00:00:00.000Z"
};
const address: Row = {
  pickup_address_id: 95201, customer_id: 95101, route_id: 7,
  address: "1 Bundle Way", city: "Bundleville", state: "ZZ", zip: "00001",
  franchise_id: "3", comments: null, extras_allowed: 0, enabled: 1,
  driver_note: null, latitude: "1", longitude: "-10.5",
  last_audit_date: "2026-09-11", synced_at: "2026-10-12T00:00:00.000Z"
};
const secondAddress: Row = { ...address, pickup_address_id: 95202, city: "Second bundle city" };
const container: Row = {
  container_id: 95301, pickup_address_id: 95201, container_type_id: 4,
  serial_number: "BUNDLE-SERIAL-1", rfid: null, oncall: 0, event_code: "BUN",
  gps_locked: 1, latitude: "1", longitude: "-11.5", enabled: 1,
  location_address: "Bundle enclosure", city: "Bundleville", state: "ZZ", zip: "00001",
  container_note: null, ud_cost_share_ud: "1", ud_enclosure_doors_ud: "2",
  ud_last_compactor_inspection_ud: null, ud_last_enclosure_inspection_ud: "2026-09-12",
  ud_material_stream_ud: "bundle-paper", color: "green", service_code_type: "BUN",
  service_code_input: "BUN-INPUT", service_code: "BUN-CODE", service_date: "2026-10-13",
  route_ids: "7,8", frequency_ids: "1,2", synced_at: "2026-10-13T00:00:00.000Z"
};
const secondContainer: Row = { ...container, container_id: 95302, serial_number: "BUNDLE-SERIAL-2" };
const thirdContainer: Row = {
  ...container, container_id: 95303, pickup_address_id: 95202, serial_number: "BUNDLE-SERIAL-3"
};

// Independent oracle allowlists (mirror the route SELECT lists; not imported
// from production so a Builder allowlist regression fails here).
const CUSTOMER_COLUMNS = [
  "customer_id", "customer_type_id", "company_name", "first_name", "middle_initial",
  "last_name", "name_suffix", "customer_number", "sub_customer_number",
  "phone1", "phone2", "comments", "enabled", "synced_at"
];
const ADDRESS_COLUMNS = [
  "pickup_address_id", "customer_id", "route_id", "address", "city", "state", "zip",
  "franchise_id", "comments", "extras_allowed", "enabled", "driver_note",
  "latitude", "longitude", "last_audit_date", "synced_at"
];
const CONTAINER_COLUMNS = [
  "container_id", "pickup_address_id", "container_type_id", "serial_number", "rfid",
  "oncall", "event_code", "gps_locked", "latitude", "longitude", "enabled",
  "location_address", "city", "state", "zip", "container_note",
  "ud_cost_share_ud", "ud_enclosure_doors_ud", "ud_last_compactor_inspection_ud",
  "ud_last_enclosure_inspection_ud", "ud_material_stream_ud", "color",
  "service_code_type", "service_code_input", "service_code", "service_date",
  "route_ids", "frequency_ids", "synced_at"
];
const TYPE_COLUMNS: Record<string, string[]> = {
  customer: CUSTOMER_COLUMNS, address: ADDRESS_COLUMNS, container: CONTAINER_COLUMNS
};
const TYPE_IDS: Record<string, string> = {
  customer: "customer_id", address: "pickup_address_id", container: "container_id"
};

type RouteKind = "customer" | "address" | "container";
const specs = [
  { kind: "customer", alias: "customerId", key: "customer_id", row: customer },
  { kind: "address", alias: "pickupAddressId", key: "pickup_address_id", row: address },
  { kind: "container", alias: "containerId", key: "container_id", row: container }
] as const;
type Spec = (typeof specs)[number];

// Per-type sample selectors with distinct fixture values.
const TYPE_SAMPLES: Record<string, { first: string; second: string; nullable: string; omitted: string; cross: string[] }> = {
  customer: {
    first: "company_name", second: "phone1", nullable: "middle_initial", omitted: "phone2",
    cross: ["pickup_address_id", "container_id", "serial_number", "city"]
  },
  address: {
    first: "city", second: "address", nullable: "driver_note", omitted: "comments",
    cross: ["container_id", "serial_number", "company_name", "phone1"]
  },
  container: {
    first: "serial_number", second: "location_address", nullable: "rfid", omitted: "container_note",
    cross: ["customer_id", "company_name", "address", "phone1"]
  }
};

function fullBundle(kind: RouteKind): Bundle {
  if (kind === "customer") return {
    customer: { ...customer },
    addresses: [
      { ...address, containers: [{ ...container }, { ...secondContainer }] },
      { ...secondAddress, containers: [{ ...thirdContainer }] }
    ]
  };
  if (kind === "address") return {
    address: { ...address }, customer: { ...customer }, containers: [{ ...container }, { ...secondContainer }]
  };
  return { container: { ...container }, address: { ...address }, customer: { ...customer } };
}

/** Test-oracle projector: id leads, selected columns follow in selector order. */
function projectRow(type: string, row: Row, columns: string[]): Row {
  const id = TYPE_IDS[type];
  const out: Row = { [id]: row[id] };
  for (const column of columns) {
    if (column !== id) out[column] = row[column];
  }
  return out;
}

/**
 * Expected bundle for a per-type selection. `selections` maps a type to its
 * selected columns; omitted types stay full. Flat root selection is passed
 * separately and projects only the route root. Typed-root and flat-root must
 * never both be set (the request would be an ambiguous-root 400).
 */
function selectedBundle(
  kind: RouteKind,
  selections: Partial<Record<string, string[]>>,
  flatRoot?: string[],
  canonical: Bundle = fullBundle(kind)
): Bundle {
  const project = (type: string, row: Row): Row =>
    selections[type] ? projectRow(type, row, selections[type]!) : { ...row };
  if (kind === "customer") {
    const c = canonical as { customer: Row; addresses: Array<Row & { containers: Row[] }> };
    const root = flatRoot ? projectRow("customer", c.customer, flatRoot)
      : selections.customer ? projectRow("customer", c.customer, selections.customer) : { ...c.customer };
    return {
      customer: root,
      addresses: c.addresses.map((a) => {
        const { containers, ...addrRow } = a as Row & { containers: Row[] };
        const projectedAddr = selections.address
          ? projectRow("address", addrRow as Row, selections.address) : { ...(addrRow as Row) };
        return {
          ...projectedAddr,
          containers: (containers as Row[]).map((con) =>
            selections.container ? projectRow("container", con, selections.container) : { ...con })
        };
      })
    };
  }
  if (kind === "address") {
    const b = canonical as { address: Row; customer: Row | null; containers: Row[] };
    return {
      address: flatRoot ? projectRow("address", b.address, flatRoot)
        : selections.address ? projectRow("address", b.address, selections.address) : { ...b.address },
      customer: b.customer === null ? null : project("customer", b.customer),
      containers: b.containers.map((con) => project("container", con))
    };
  }
  const b = canonical as { container: Row; address: Row | null; customer: Row | null };
  return {
    container: flatRoot ? projectRow("container", b.container, flatRoot)
      : selections.container ? projectRow("container", b.container, selections.container) : { ...b.container },
    address: b.address === null ? null : project("address", b.address),
    customer: b.customer === null ? null : project("customer", b.customer)
  };
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
      throw new Error("Unexpected auth-session/network operation in bundle-fields tests");
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
  h.set("x-request-id", "synthetic-hydrated-bundle-fields-request");
  h.set("authorization", `Bearer ${SECRET}`);
  new Headers(headers).forEach((value, key) => h.set(key, value));
  const response = await app.fetch(new Request(`https://synthetic.example.test${path}`, { headers: h }), appEnv(), {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}
  } as ExecutionContext);
  await Promise.all(pending);
  return response;
}
function get(spec: Spec, options: {
  fields?: string;
  typed?: Record<string, string>;
  parameter?: string; id?: string; extra?: Array<[string, string]>; headers?: HeadersInit;
} = {}): Promise<Response> {
  const pairs: Array<[string, string]> = [[options.parameter ?? "id", options.id ?? String(spec.row[spec.key])]];
  if (options.fields !== undefined) pairs.push(["fields", options.fields]);
  for (const [type, selector] of Object.entries(options.typed ?? {})) {
    pairs.push([`fields[${type}]`, selector]);
  }
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
async function seedCache(spec: Spec, bundle = fullBundle(spec.kind)): Promise<void> {
  const text = JSON.stringify(bundle);
  const digest = await hashBytes(text);
  cache.set(`${spec.kind}:${spec.row[spec.key]}`, new Response(text, { headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=60",
    etag: `"${digest}"`, "x-entity-etag": digest
  } }));
}
async function expectCanonicalCache(spec: Spec, expected = fullBundle(spec.kind)): Promise<void> {
  // A cold projected read may choose not to cache. If it does, it must store
  // the full representation under the existing canonical key, never projected data.
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
async function expectTyped400(response: Response, expectedKey: string): Promise<void> {
  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({
    type: `${PROBLEMS}#bad-request`, title: "Bad Request", status: 400,
    detail: `Invalid request query (${expectedKey}). See docs/PROBLEMS.md#bad-request.`
  });
  expect(Object.keys(body).filter((key) => key !== "instance").sort()).toEqual(["detail", "status", "title", "type"]);
  if (body.instance !== undefined) expect(body.instance).toMatch(/^\/api\/v1\/data\/(?:customer|address|container)$/);
  expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC-MARKER|received|invalid_type|"input"/i);
  expectNoWork();
}
async function insert(table: string, row: Row): Promise<void> {
  const keys = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .bind(...Object.values(row)).run();
}
const network = vi.fn(() => { throw new Error("Outbound network forbidden in bundle-fields acceptance"); });
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

describe.each(specs)("$kind hydrated bundle fields", (spec) => {
  const others = (["customer", "address", "container"] as const).filter((t) => t !== spec.kind);

  it("omitted selectors preserve exact full bytes, headers, warm cache and full validators", async () => {
    const coldResponse = await get(spec);
    const coldHeaders = allHeaders(coldResponse);
    const cold = await expectServed(coldResponse, fullBundle(spec.kind));
    expect(cold.text).toBe(JSON.stringify(fullBundle(spec.kind)));
    expect(work.statements.length).toBeGreaterThan(0);
    expect(work.cacheWrites).toBe(1);
    expect(cache.size).toBe(1);
    resetWork();
    const warmResponse = await get(spec, { parameter: spec.alias });
    expect(allHeaders(warmResponse)).toEqual(coldHeaders);
    expect(await expectServed(warmResponse, fullBundle(spec.kind))).toEqual(cold);
    expect(work.statements).toEqual([]);
    await expect304(await get(spec, { headers: { "if-none-match": cold.etag } }), cold.etag);
    expect(work.statements).toEqual([]);
  });

  it("flat fields alone keeps its root-only meaning with relations unchanged", async () => {
    const sample = TYPE_SAMPLES[spec.kind];
    const expected = selectedBundle(spec.kind, {}, [sample.first]);
    const served = await expectServed(await get(spec, { fields: sample.first }), expected);
    // Relations are byte-identical to the full bundle.
    const full = fullBundle(spec.kind);
    const body = JSON.parse(served.text) as Bundle;
    for (const key of Object.keys(full)) {
      if (key !== spec.kind) expect(body[key]).toEqual(full[key]);
    }
    await expectCanonicalCache(spec);
  });

  it.each(["customer", "address", "container"] as const)(
    "typed %s alone projects that type everywhere with id retention and omitted-type fullness",
    async (type) => {
      const sample = TYPE_SAMPLES[type];
      const expected = selectedBundle(spec.kind, { [type]: [sample.first] });
      const served = await expectServed(await get(spec, { typed: { [type]: sample.first } }), expected);
      expect(served.etag).not.toBe((await expectServed(await get(spec), fullBundle(spec.kind))).etag);
      await expectCanonicalCache(spec);
    }
  );

  it("typed-root alone projects the root identically to flat fields", async () => {
    const sample = TYPE_SAMPLES[spec.kind];
    const flat = await expectServed(await get(spec, { fields: sample.first }),
      selectedBundle(spec.kind, {}, [sample.first]));
    cache.clear();
    const typed = await expectServed(await get(spec, { typed: { [spec.kind]: sample.first } }),
      selectedBundle(spec.kind, { [spec.kind]: [sample.first] }));
    expect(typed).toEqual(flat);
  });

  it("all three typed keys together trim every level while keeping structure", async () => {
    const selections = {
      customer: [TYPE_SAMPLES.customer.first, TYPE_SAMPLES.customer.nullable],
      address: [TYPE_SAMPLES.address.first],
      container: [TYPE_SAMPLES.container.first, TYPE_SAMPLES.container.second]
    };
    const typed = Object.fromEntries(Object.entries(selections).map(([t, cols]) => [t, cols.join(",")]));
    const expected = selectedBundle(spec.kind, selections);
    await expectServed(await get(spec, { typed }), expected);
    // Structure: same top-level keys as the full bundle; only leaf columns drop.
    expect(Object.keys(expected).sort()).toEqual(Object.keys(fullBundle(spec.kind)).sort());
    await expectCanonicalCache(spec);
  });

  it("flat root plus non-root typed keys compose without widening flat", async () => {
    const rootSample = TYPE_SAMPLES[spec.kind];
    const other = others[0];
    const otherSample = TYPE_SAMPLES[other];
    const expected = selectedBundle(spec.kind, { [other]: [otherSample.first] }, [rootSample.first]);
    await expectServed(
      await get(spec, { fields: rootSample.first, typed: { [other]: otherSample.first } }),
      expected
    );
    await expectCanonicalCache(spec);
  });

  it("flat plus typed-root together is an ambiguous-root value-free 400 before work", async () => {
    const sample = TYPE_SAMPLES[spec.kind];
    const other = sample.second;
    const response = await get(spec, { fields: sample.first, typed: { [spec.kind]: other } });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ type: `${PROBLEMS}#bad-request`, title: "Bad Request", status: 400 });
    expect(String(body.detail)).toMatch(/Invalid request query \(.*fields.*\).*See docs\/PROBLEMS\.md#bad-request\./);
    expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC-MARKER|received|invalid_type|"input"/i);
    expectNoWork();
  });

  it.each(["customer", "address", "container"] as const)(
    "selecting all %s columns retains that type full with the full validator",
    async (type) => {
      const full = await expectServed(await get(spec), fullBundle(spec.kind));
      cache.clear();
      const all = await expectServed(
        await get(spec, { typed: { [type]: TYPE_COLUMNS[type].join(",") } }),
        fullBundle(spec.kind)
      );
      expect(all).toEqual(full);
    }
  );

  describe.each(["customer", "address", "container"] as const)("typed %s allowlist", (type) => {
    const row = type === "customer" ? customer : type === "address" ? address : container;
    it.each(Object.entries(row))("selects allowlisted %s alone, always retaining the primary ID", async (field, value) => {
      // Build the expected bundle via the oracle projector for this single column.
      const expected = selectedBundle(spec.kind, { [type]: [field] });
      // Spot-check the selected value reaches the served bytes.
      const served = await expectServed(await get(spec, { typed: { [type]: field } }), expected);
      expect(served.text).toContain(JSON.stringify(value));
      await expectCanonicalCache(spec);
    });
  });

  it.each(["customer", "address", "container"] as const)(
    "explicit %s primary ID is not duplicated and ID-only selection keeps relations",
    async (type) => {
      const id = TYPE_IDS[type];
      const first = TYPE_SAMPLES[type].first;
      const implicit = await expectServed(await get(spec, { typed: { [type]: first } }),
        selectedBundle(spec.kind, { [type]: [first] }));
      cache.clear();
      const explicit = await expectServed(await get(spec, { typed: { [type]: `${id},${first}` } }),
        selectedBundle(spec.kind, { [type]: [id, first] }));
      expect(explicit).toEqual(implicit);
      await expectServed(await get(spec, { typed: { [type]: id } }),
        selectedBundle(spec.kind, { [type]: [id] }));
    }
  );

  it("typed selection preserves alias addressing with identical bytes", async () => {
    const type = others[0];
    const first = TYPE_SAMPLES[type].first;
    const viaId = await expectServed(await get(spec, { typed: { [type]: first } }),
      selectedBundle(spec.kind, { [type]: [first] }));
    cache.clear();
    const viaAlias = await expectServed(await get(spec, { typed: { [type]: first }, parameter: spec.alias }),
      selectedBundle(spec.kind, { [type]: [first] }));
    expect(viaAlias).toEqual(viaId);
  });

  it("cold typed selection is response shaping, not a different D1 query or a projected canonical cache", async () => {
    await expectServed(await get(spec), fullBundle(spec.kind));
    const sql = [...work.statements];
    cache.clear();
    resetWork();
    const type = others[0];
    const first = TYPE_SAMPLES[type].first;
    await expectServed(await get(spec, { typed: { [type]: first } }),
      selectedBundle(spec.kind, { [type]: [first] }));
    expect(work.statements).toEqual(sql);
    await expectCanonicalCache(spec);
    await expectServed(await get(spec), fullBundle(spec.kind));
  });

  it("warm canonical cache projects non-mutatingly and alternating selectors never contaminate full reads", async () => {
    const full = await expectServed(await get(spec), fullBundle(spec.kind));
    const canonicalText = await cache.get(`${spec.kind}:${spec.row[spec.key]}`)!.clone().text();
    resetWork();
    const type = others[0];
    const samples = TYPE_SAMPLES[type];
    for (const field of [samples.first, samples.second, samples.nullable, samples.first]) {
      await expectServed(await get(spec, { typed: { [type]: field } }),
        selectedBundle(spec.kind, { [type]: [field] }));
      expect(await cache.get(`${spec.kind}:${spec.row[spec.key]}`)!.clone().text()).toBe(canonicalText);
      await expectCanonicalCache(spec);
    }
    // Alternating across types also leaves the canonical entry alone.
    for (const t of ["customer", "address", "container"] as const) {
      await expectServed(await get(spec, { typed: { [t]: TYPE_SAMPLES[t].first } }),
        selectedBundle(spec.kind, { [t]: [TYPE_SAMPLES[t].first] }));
      expect(await cache.get(`${spec.kind}:${spec.row[spec.key]}`)!.clone().text()).toBe(canonicalText);
    }
    expect(await expectServed(await get(spec), fullBundle(spec.kind))).toEqual(full);
    expect(work.statements).toEqual([]);
    expect(work.cacheWrites).toBe(0);
  });

  it.each([false, true])("full-only validator cannot return a typed-projection 304 (warm cache: %s)", async (warm) => {
    const full = await expectServed(await get(spec), fullBundle(spec.kind));
    if (!warm) cache.clear();
    const type = others[0];
    const first = TYPE_SAMPLES[type].first;
    const selected = await expectServed(
      await get(spec, { typed: { [type]: first }, headers: { "if-none-match": full.etag } }),
      selectedBundle(spec.kind, { [type]: [first] }));
    expect(selected.etag).not.toBe(full.etag);
    await expectCanonicalCache(spec);
    await expectServed(await get(spec, { headers: { "if-none-match": selected.etag } }), fullBundle(spec.kind));
  });

  it.each([false, true])("matching typed validators produce empty 304s only for that representation (warm: %s)", async (warm) => {
    const type = others[0];
    const samples = TYPE_SAMPLES[type];
    const selected = await expectServed(await get(spec, { typed: { [type]: samples.first } }),
      selectedBundle(spec.kind, { [type]: [samples.first] }));
    for (const validator of [selected.etag, `W/${selected.etag}`, `"unrelated", ${selected.etag}`, "*"]) {
      if (!warm) cache.clear();
      await expect304(
        await get(spec, { typed: { [type]: samples.first }, headers: { "if-none-match": validator } }),
        selected.etag);
    }
    const alternate = await expectServed(
      await get(spec, { typed: { [type]: samples.second }, headers: { "if-none-match": selected.etag } }),
      selectedBundle(spec.kind, { [type]: [samples.second] }));
    expect(alternate.etag).not.toBe(selected.etag);
  });

  it("distinct typed combinations have distinct validators", async () => {
    const t1 = others[0];
    const t2 = others[1];
    const r1 = await expectServed(await get(spec, { typed: { [t1]: TYPE_SAMPLES[t1].first } }),
      selectedBundle(spec.kind, { [t1]: [TYPE_SAMPLES[t1].first] }));
    cache.clear();
    const r2 = await expectServed(await get(spec, { typed: { [t2]: TYPE_SAMPLES[t2].first } }),
      selectedBundle(spec.kind, { [t2]: [TYPE_SAMPLES[t2].first] }));
    cache.clear();
    const r3 = await expectServed(
      await get(spec, { typed: { [t1]: TYPE_SAMPLES[t1].first, [t2]: TYPE_SAMPLES[t2].first } }),
      selectedBundle(spec.kind, { [t1]: [TYPE_SAMPLES[t1].first], [t2]: [TYPE_SAMPLES[t2].first] }));
    expect(new Set([r1.etag, r2.etag, r3.etag]).size).toBe(3);
  });

  it("changing a selected-out column inside a projected type keeps typed bytes/304 while full rotates", async () => {
    const type = others[0];
    const samples = TYPE_SAMPLES[type];
    const oldFull = await expectServed(await get(spec), fullBundle(spec.kind));
    const oldSelected = await expectServed(await get(spec, { typed: { [type]: samples.first } }),
      selectedBundle(spec.kind, { [type]: [samples.first] }));
    const table = type === "customer" ? "customer_snapshot" : type === "address" ? "address_snapshot" : "container_snapshot";
    // Update every row: the oracle patches all bundle members of this type.
    await DB.prepare(`UPDATE ${table} SET ${samples.omitted} = ?`)
      .bind("Synthetic changed omitted bundle field").run();
    cache.clear();
    const changedCanonical = changedFullWithOmitted(spec.kind, type, samples.omitted);
    // Full validator must rotate; typed bytes stay identical.
    const newFull = await expectServed(await get(spec), changedCanonical);
    expect(newFull.etag).not.toBe(oldFull.etag);
    const newSelected = await expectServed(await get(spec, { typed: { [type]: samples.first } }),
      selectedBundle(spec.kind, { [type]: [samples.first] }, undefined, changedCanonical));
    expect(newSelected).toEqual(oldSelected);
    await expect304(
      await get(spec, { typed: { [type]: samples.first }, headers: { "if-none-match": oldSelected.etag } }),
      oldSelected.etag);
  });

  it("changing a selected typed value invalidates its projected validator", async () => {
    const type = others[0];
    const first = TYPE_SAMPLES[type].first;
    const old = await expectServed(await get(spec, { typed: { [type]: first } }),
      selectedBundle(spec.kind, { [type]: [first] }));
    const table = type === "customer" ? "customer_snapshot" : type === "address" ? "address_snapshot" : "container_snapshot";
    // Update every row: the oracle patches all bundle members of this type.
    await DB.prepare(`UPDATE ${table} SET ${first} = ?`)
      .bind("Synthetic changed selected bundle value").run();
    cache.clear();
    const changedCanonical = fullBundle(spec.kind);
    applyChangedValue(changedCanonical, spec.kind, type, first, "Synthetic changed selected bundle value");
    const changed = await expectServed(
      await get(spec, { typed: { [type]: first }, headers: { "if-none-match": old.etag } }),
      selectedBundle(spec.kind, { [type]: [first] }, undefined, changedCanonical));
    expect(changed.etag).not.toBe(old.etag);
  });

  it("changing an omitted-type (full) value invalidates typed projections that embed it", async () => {
    // Omitted types stay full inside typed representations, so their bytes feed
    // the served-byte hash even when another type is projected.
    const type = others[0];
    const first = TYPE_SAMPLES[type].first;
    const old = await expectServed(await get(spec, { typed: { [type]: first } }),
      selectedBundle(spec.kind, { [type]: [first] }));
    const omittedType = others[1];
    const omittedFirst = TYPE_SAMPLES[omittedType].first;
    const table = omittedType === "customer" ? "customer_snapshot"
      : omittedType === "address" ? "address_snapshot" : "container_snapshot";
    // Update every row: the oracle patches all bundle members of this type.
    await DB.prepare(`UPDATE ${table} SET ${omittedFirst} = ?`)
      .bind("Changed synthetic omitted bundle relation").run();
    cache.clear();
    const changedCanonical = fullBundle(spec.kind);
    applyChangedValue(changedCanonical, spec.kind, omittedType, omittedFirst, "Changed synthetic omitted bundle relation");
    const selected = await expectServed(
      await get(spec, { typed: { [type]: first }, headers: { "if-none-match": old.etag } }),
      selectedBundle(spec.kind, { [type]: [first] }, undefined, changedCanonical));
    expect(selected.etag).not.toBe(old.etag);
  });

  it("preserves cached empty/null related members rather than inventing rows", async () => {
    const canonical: Bundle = spec.kind === "customer" ? { customer: { ...customer }, addresses: [] }
      : spec.kind === "address" ? { address: { ...address }, customer: null, containers: [] }
      : { container: { ...container }, address: null, customer: null };
    await seedCache(spec, canonical);
    const type = others[0];
    const first = TYPE_SAMPLES[type].first;
    await expectServed(await get(spec, { typed: { [type]: first } }),
      selectedBundle(spec.kind, { [type]: [first] }, undefined, canonical));
    await expectCanonicalCache(spec, canonical);
    expect(work.statements).toEqual([]);
  });

  it("a valid typed read of an unknown root stays a value-free 404", async () => {
    const type = others[0];
    const response = await get(spec, { typed: { [type]: TYPE_SAMPLES[type].first }, id: "95999" });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ type: `${PROBLEMS}#not-found`, title: "Not Found", status: 404 });
    expect(work.statements.length).toBeGreaterThan(0);
    expect(cache.size).toBe(0);
  });

  it("typed selectors do not add batch ids support or relax malformed unused-ID validation", async () => {
    const type = others[0];
    const first = TYPE_SAMPLES[type].first;
    for (const pairs of [
      [["ids", "95101,95102"], [`fields[${type}]`, first]],
      [["id", String(spec.row[spec.key])], [spec.alias, "01"], [`fields[${type}]`, first]]
    ]) {
      const response = await request(`/api/v1/data/${spec.kind}?${new URLSearchParams(pairs as Array<[string, string]>)}`);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("See docs/PROBLEMS.md#bad-request.");
      expectNoWork();
    }
  });

  describe.each(["customer", "address", "container"] as const)("malformed typed %s selector", (type) => {
    const sample = TYPE_SAMPLES[type];
    const id = TYPE_IDS[type];
    const invalid = [
      "", ",", `${sample.first},`, `,${sample.first}`, `${sample.first},,${sample.second}`,
      `${sample.first},${sample.first}`, `${id},${id}`, ` ${sample.first}`, `${sample.first} `,
      `${sample.first}, ${sample.second}`, sample.first.toUpperCase(), "*", `${sample.first},*`,
      `${type}.${sample.first}`, "addresses", "containers", "addresses.containers.serial_number",
      "include", "SYNTHETIC-MARKER-column", "rowid", "deleted_at",
      "company_name;DROP TABLE customer_snapshot", "city' OR '1'='1", "__proto__", "constructor",
      "prototype", `${sample.first};--`, `${sample.first}%0d%0aX-Injected`,
      ...sample.cross
    ];
    describe.each([false, true])("warm full cache: %s", (warm) => {
      beforeEach(async () => { if (warm) await seedCache(spec); });
      it.each(invalid)("refuses %j value-free before canonical cache or D1", async (selector) => {
        const cached = cache.get(`${spec.kind}:${spec.row[spec.key]}`);
        await expectTyped400(
          await get(spec, {
            typed: { [type]: selector },
            headers: { "if-none-match": cached?.headers.get("etag") ?? '"unrelated"' }
          }),
          `fields[${type}]`);
        expect(work.cacheWrites).toBe(0);
      });
      it.each([sample.first, sample.second, ""])("refuses repeated typed keys even with second value %j", async (second) => {
        await expectTyped400(
          await get(spec, { typed: { [type]: sample.first }, extra: [[`fields[${type}]`, second]] }),
          `fields[${type}]`);
      });
    });
    it("a valid flat selector does not rescue an invalid typed selector", async () => {
      await expectTyped400(
        await get(spec, { fields: TYPE_SAMPLES[spec.kind].first, typed: { [type]: "SYNTHETIC-MARKER-column" } }),
        `fields[${type}]`);
    });
    it("a valid typed selector does not rescue an invalid flat selector", async () => {
      const response = await get(spec, { fields: "SYNTHETIC-MARKER-column", typed: { [type]: sample.first } });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("See docs/PROBLEMS.md#bad-request.");
      expectNoWork();
    });
  });

  describe("unknown fields[TYPE] keys", () => {
    const unknownTypes = ["foo", "customers", "CUSTOMER", "Addresses", "containers ", " customer", "", "id", "fields", "sync"];
    it.each(unknownTypes)("refuses fields[%s] value-free before cache or D1", async (unknown) => {
      const pairs: Array<[string, string]> = [
        ["id", String(spec.row[spec.key])],
        [`fields[${unknown}]`, TYPE_SAMPLES.customer.first]
      ];
      const response = await request(`/api/v1/data/${spec.kind}?${new URLSearchParams(pairs)}`);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ type: `${PROBLEMS}#bad-request`, title: "Bad Request", status: 400 });
      expect(String(body.detail)).toMatch(/Invalid request query \(.*fields.*\).*See docs\/PROBLEMS\.md#bad-request\./);
      expect(JSON.stringify(body)).not.toMatch(/received|invalid_type|"input"/i);
      expectNoWork();
    });
    it("refuses an unknown TYPE beside valid typed selectors", async () => {
      const type = others[0];
      const pairs: Array<[string, string]> = [
        ["id", String(spec.row[spec.key])],
        [`fields[${type}]`, TYPE_SAMPLES[type].first],
        ["fields[foo]", "city"]
      ];
      const response = await request(`/api/v1/data/${spec.kind}?${new URLSearchParams(pairs)}`);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("See docs/PROBLEMS.md#bad-request.");
      expectNoWork();
    });
  });

  describe.each([
    { label: "no bearer", authorization: "", gate: "SHADOW_API_TOKEN" },
    { label: "wrong bearer", authorization: "Bearer synthetic-wrong", gate: "SHADOW_API_TOKEN" },
    { label: "API token", authorization: "Bearer synthetic-api-token", gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" },
    { label: "read token", authorization: "Bearer synthetic-read-token", gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" }
  ])("$label preserves auth precedence", ({ authorization, gate }) => {
    beforeEach(async () => { await seedCache(spec); });
    it.each([undefined, TYPE_SAMPLES.customer.first, "SYNTHETIC-MARKER-column"])("401s before typed validation for %j", async (selector) => {
      const response = await get(spec, {
        typed: selector === undefined ? { [others[0]]: TYPE_SAMPLES[others[0]].first } : { [others[0]]: selector },
        headers: { authorization }
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ type: `${PROBLEMS}#unauthorized`, status: 401,
        detail: `Send Authorization: Bearer <${gate}>. See docs/PROBLEMS.md#unauthorized.` });
      expectNoWork();
    });
    it("401s before unknown-TYPE validation", async () => {
      const pairs: Array<[string, string]> = [["id", String(spec.row[spec.key])], ["fields[foo]", "city"]];
      const h = new Headers({ origin: ORIGIN, authorization });
      h.set("x-request-id", "synthetic-hydrated-bundle-fields-request");
      const pending: Promise<unknown>[] = [];
      const response = await app.fetch(
        new Request(`https://synthetic.example.test/api/v1/data/${spec.kind}?${new URLSearchParams(pairs)}`, { headers: h }),
        appEnv(),
        { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} } as ExecutionContext);
      await Promise.all(pending);
      expect(response.status).toBe(401);
      expectNoWork();
    });
  });

  describe("mixed ID/typed auth-order regression", () => {
    // Invalid typed selectors must pass the inner auth gate like flat fields:
    // API/read tokens see 401 before any mixed ID/typed 400. With no typed
    // error, preliminary ID-only 400s remain compatible.
    describe("malformed id beside a valid alternative", () => {
      const parameter = "id";
      const other = spec.alias;
      const validId = String(spec.row[spec.key]);
      const type = others[0];
      const first = TYPE_SAMPLES[type].first;
      const invalidSelectors = [
        { label: "unknown typed field", typed: { [type]: "SYNTHETIC-MARKER-column" }, extra: [] as Array<[string, string]> },
        { label: "empty typed CSV member", typed: { [type]: `${first},,${TYPE_SAMPLES[type].second}` }, extra: [] as Array<[string, string]> },
        { label: "repeated typed keys", typed: { [type]: first }, extra: [[`fields[${type}]`, TYPE_SAMPLES[type].second]] as Array<[string, string]> }
      ];
      beforeEach(async () => { await seedCache(spec); });
      function mixedRequest(typed: Record<string, string>, extra: Array<[string, string]>, authorization: string, idValue: string) {
        return get(spec, {
          typed, parameter, id: idValue, extra: [[other, validId], ...extra],
          headers: { authorization, "if-none-match": cache.get(`${spec.kind}:${spec.row[spec.key]}`)!.headers.get("etag")! }
        });
      }
      async function expectUnauthorized(response: Response, gate: string): Promise<void> {
        expectNoWork();
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.json() as Record<string, unknown>;
        expect(body).toMatchObject({ type: `${PROBLEMS}#unauthorized`, title: "Unauthorized", status: 401,
          detail: `Send Authorization: Bearer <${gate}>. See docs/PROBLEMS.md#unauthorized.` });
        expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC-MARKER|received|invalid_type|"input"|\?/i);
      }
      describe.each([
        { label: "API token", authorization: "Bearer synthetic-api-token" },
        { label: "read token", authorization: "Bearer synthetic-read-token" }
      ])("$label", ({ authorization }) => {
        it.each(invalidSelectors)("invalid $label requires inner auth before ID/typed errors", async ({ typed, extra }) => {
          await expectUnauthorized(
            await mixedRequest(typed, extra, authorization, "SYNTHETIC-MARKER-invalid-id"),
            "CUSTOMER_SNAPSHOT_SYNC_SECRET");
        });
        it.each([
          { label: "omitted typed", typed: undefined as unknown as Record<string, string> },
          { label: "valid typed field", typed: { [type]: first } }
        ])("preserves preliminary ID-only 400 with $label", async ({ typed }) => {
          const response = typed === undefined
            ? await get(spec, { parameter, id: "SYNTHETIC-MARKER-invalid-id", extra: [[other, validId]], headers: { authorization } })
            : await mixedRequest(typed, [], authorization, "SYNTHETIC-MARKER-invalid-id");
          expectNoWork();
          expect(response.status).toBe(400);
          const body = await response.json() as Record<string, unknown>;
          expect(body).toMatchObject({ type: `${PROBLEMS}#bad-request`, title: "Bad Request", status: 400 });
          expect(String(body.detail)).toContain("See docs/PROBLEMS.md#bad-request.");
          expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC-MARKER|received|invalid_type|"input"|\?/i);
        });
      });
      describe.each([
        { label: "no bearer", authorization: "" },
        { label: "wrong bearer", authorization: "Bearer synthetic-wrong" }
      ])("$label", ({ authorization }) => {
        it.each(invalidSelectors)("preserves outer auth before mixed ID/$label errors", async ({ typed, extra }) => {
          await expectUnauthorized(
            await mixedRequest(typed, extra, authorization, "SYNTHETIC-MARKER-invalid-id"),
            "SHADOW_API_TOKEN");
        });
      });
    });
  });
});

/** Full bundle with one omitted column changed (for selected-out rotation tests). */
function changedFullWithOmitted(kind: RouteKind, type: string, omitted: string): Bundle {
  const bundle = fullBundle(kind);
  applyChangedValue(bundle, kind, type, omitted, "Synthetic changed omitted bundle field");
  return bundle;
}

/** Mutate every occurrence of `type` in `bundle` to carry `value` for `column`. */
function applyChangedValue(bundle: Bundle, kind: RouteKind, type: string, column: string, value: string): void {
  const patch = (row: Row) => { row[column] = value; };
  if (kind === "customer") {
    const b = bundle as { customer: Row; addresses: Array<Row & { containers: Row[] }> };
    if (type === "customer") patch(b.customer);
    for (const addr of b.addresses) {
      if (type === "address") patch(addr);
      if (type === "container") for (const con of addr.containers) patch(con);
    }
    return;
  }
  if (kind === "address") {
    const b = bundle as { address: Row; customer: Row | null; containers: Row[] };
    if (type === "address") patch(b.address);
    if (type === "customer" && b.customer) patch(b.customer);
    if (type === "container") for (const con of b.containers) patch(con);
    return;
  }
  const b = bundle as { container: Row; address: Row | null; customer: Row | null };
  if (type === "container") patch(b.container);
  if (type === "address" && b.address) patch(b.address);
  if (type === "customer" && b.customer) patch(b.customer);
}

it("runtime OpenAPI exposes per-type bundle selectors, representation validators and no batch selector on all hydrated GETs", async () => {
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
    const queryNames = op.parameters.filter((p) => p.in === "query").map((p) => p.name).sort();
    expect(queryNames).toEqual(
      ["fields", "fields[address]", "fields[container]", "fields[customer]", "id", spec.alias].sort());
    for (const type of ["customer", "address", "container"] as const) {
      const param = op.parameters.find((p) => p.name === `fields[${type}]`);
      expect(param).toMatchObject({ in: "query", required: false, schema: { type: "string" } });
      const selectorDocs = `${param?.description ?? ""} ${param?.schema?.description ?? ""}`;
      expect(selectorDocs).toMatch(/comma/i);
      expect(selectorDocs).toMatch(/allowlist|whitelist/i);
    }
    const flat = op.parameters.find((p) => p.name === "fields");
    const flatDocs = `${flat?.description ?? ""} ${flat?.schema?.description ?? ""} ${op.description ?? ""}`;
    expect(flatDocs).toMatch(/(?:root|\.customer|\.address|\.container)/i);
    const docs = `${op.description ?? ""} ${op.responses["200"]?.description ?? ""}`;
    expect(docs).toMatch(/fields\[/i);
    expect(docs).toMatch(/ETag/i);
    expect(docs).toMatch(/projected|served bytes|representation/i);
    expect(op.responses["400"]?.description).toMatch(/fields/i);
  }
  expectNoWork();
});
