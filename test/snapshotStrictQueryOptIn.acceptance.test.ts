/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import problemsDoc from "../docs/PROBLEMS.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned contract, written from the card spec without reading any
 * implementation diff. Run:
 *   npx vitest run --maxWorkers=2 test/snapshotStrictQueryOptIn.acceptance.test.ts
 *
 * Contract under test (three ordinary flat list GETs ONLY):
 * - `strictQuery=true|false`, default false. Omitted/false keeps the
 *   documented ignore-unknown-names behavior byte/query-for-query.
 * - `strictQuery=true` rejects ANY decoded raw query key the mounted
 *   resource's own query schema does not declare (strictQuery itself
 *   included in the declared set), after authentication and before any D1
 *   or conditional (ETag/304) evaluation.
 * - Rejection is the fixed established value-free bad-request problem: it
 *   never echoes submitted names or values in the body or app logs, carries
 *   no dynamic unknown-key list, and its correction action tells the caller
 *   to use the supported names from the mounted OpenAPI operation, remove
 *   the unknown keys, or set `strictQuery=false`.
 * - Invalid/empty/repeated `strictQuery` (including percent-encoded
 *   duplicate keys) fails before D1 even when another occurrence is false.
 * - Validated `strictQuery=true` travels in relative next Links;
 *   false/default is omitted from them.
 *
 * Hand-derived fixture oracle (all synthetic, real local D1): IDs 101..104
 * in every snapshot table, row 102 disabled, the rest enabled; every label
 * carries the "synthetic" needle so `enabled=true&q=synthetic` selects
 * [101, 103, 104] on each list. Address/container parent ids line up 1:1.
 * Container service codes: 101/103 = SVC-1, 102 = SVC-10, 104 = NULL.
 *
 * Mutations caught: strict mode ignored or made default; allowlist copied
 * from a sibling resource or missing a merged selector; raw (undecoded)
 * key comparison that lets encoded duplicates/typos through; rejection
 * after a COUNT/page query or after a 304; submitted names/values reflected
 * into problems, logs or Links; strictQuery dropped from continuations;
 * strictQuery leaking onto changes/by-id/hydrated operations.
 *
 * Fetch and R2 are denied; the recording D1 wrapper refuses non-SELECT
 * execution, so a passing run also proves zero writes. No production,
 * staging, live credentials or real PII. GET is an idempotent local read;
 * CLI --dry-run is not applicable.
 * Intentional RED handoff: the Builder consumes this commit without
 * editing this file. Oracle corrections belong to the Test Author.
 */
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://strict-query.invalid";
const TOKEN = "test-read-token";
const PROBLEM_TYPE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const MARKER = "secret-marker-xyz";
const STAMP = "2026-09-01T00:00:00.000Z";
const IDS = [101, 102, 103, 104];

type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Spec = {
  name: "customer" | "address" | "container";
  path: string;
  id: string;
  field: string;
  /** Declared query names for this list, per the query-policy inventory
   *  plus the new strictQuery control itself. */
  allowed: string[];
  /** Raw `name=value` pairs declared only on a sibling resource. */
  cross: string[];
};

const SPECS: Spec[] = [
  {
    name: "customer",
    path: "/api/v1/customer-snapshot",
    id: "customer_id",
    field: "company_name",
    allowed: [
      "customerId", "ids", "customerNumber", "subCustomerNumber", "q", "phone", "comments",
      "enabled", "hasAddresses", "addressRouteId", "addressFranchiseId", "addressEnabled", "addressCity", "addressState", "addressZip", "addressExtrasAllowed", "addressLastAuditDate", "hasPhone1", "hasPhone2", "hasContainers", "limit", "offset", "cursor", "lowerId", "upperId", "includeTotal",
      "exactNext", "countOnly", "order", "fields", "strictQuery"
    ],
    cross: [
      "pickupAddressId=101", "containerId=101", "routeId=7", "franchiseId=F-1", "zip=02139",
      "city=Riverton", "state=ST", "lastAuditDate=2026-01-15", "hasLastAuditDate=true", "parentCustomerEnabled=true", "serialNumber=SN-1", "rfid=RF-1",
      "locationAddress=Loc-1", "serviceCode=SVC-1", "containerTypeId=7"
    ]
  },
  {
    name: "address",
    path: "/api/v1/address-snapshot",
    id: "pickup_address_id",
    field: "address",
    allowed: [
      "customerId", "pickupAddressId", "ids", "routeId", "franchiseId", "zip", "streetAddress", "city", "state",
      "driverNote", "q", "enabled", "extrasAllowed", "hasContainers", "lastAuditDate", "hasLastAuditDate", "hasCoordinates", "parentCustomerEnabled", "owningCustomerNumber", "owningSubCustomerNumber", "limit", "offset", "cursor", "lowerId", "upperId", "includeTotal",
      "exactNext", "countOnly", "order", "fields", "strictQuery"
    ],
    cross: [
      "containerId=101", "customerNumber=N-1", "subCustomerNumber=S-1", "phone=555",
      "comments=note", "hasAddresses=true", "addressRouteId=7", "addressFranchiseId=F-1", "addressEnabled=true", "hasPhone1=true", "hasPhone2=false", "serialNumber=SN-1", "rfid=RF-1",
      "locationAddress=Loc-1", "serviceCode=SVC-1", "containerTypeId=7"
    ]
  },
  {
    name: "container",
    path: "/api/v1/container-snapshot",
    id: "container_id",
    field: "location_address",
    allowed: [
      "containerTypeId",
      "customerId", "pickupAddressId", "containerId", "ids", "parentRouteId", "parentFranchiseId", "parentEnabled", "customerEnabled", "parentCity", "parentState", "parentZip", "serialNumber", "rfid",
      "hasSerialNumber", "hasRfid", "hasCompactorInspection", "hasEnclosureInspection",
      "materialStream", "color", "serviceCode", "serviceCodeType", "serviceCodeInput", "zip", "locationAddress", "city", "state", "q", "note", "enabled", "hasCoordinates", "onCall", "gpsLocked", "syncedSince", "limit", "offset", "cursor", "lowerId", "upperId", "includeTotal", "exactNext", "countOnly", "order",
      "fields", "strictQuery"
    ],
    cross: [
      "customerNumber=N-1", "subCustomerNumber=S-1", "phone=555", "comments=note",
      "hasAddresses=true", "addressRouteId=7", "addressFranchiseId=F-1", "addressEnabled=true", "hasPhone1=true", "hasPhone2=false", "routeId=7", "franchiseId=F-1",
      "hasContainers=true", "lastAuditDate=2026-01-15", "hasLastAuditDate=true", "parentCustomerEnabled=true"
    ]
  }
];

/** One schema-valid sample value per declared name (fields=enabled exists
 *  on all three resources). A sample may filter to an empty page; the probe
 *  only proves the name is not rejected as unknown under strict mode. */
const SAMPLES: Record<string, string> = {
  customerId: "101", pickupAddressId: "101", containerId: "101", containerTypeId: "7", ids: "101,102",
  customerNumber: "N-1", subCustomerNumber: "S-1", owningCustomerNumber: "N-1", owningSubCustomerNumber: "S-1", q: "synthetic", phone: "555",
  comments: "note", driverNote: "access", note: "gate", enabled: "true", onCall: "true", gpsLocked: "true", syncedSince: "2026-08-31T00:00:00.000Z", extrasAllowed: "any", hasAddresses: "any", hasContainers: "any", hasPhone1: "any", hasPhone2: "any",
  lastAuditDate: "2026-01-15", hasLastAuditDate: "any", hasCoordinates: "any", parentCustomerEnabled: "true",
  routeId: "7", franchiseId: "F-1", zip: "02139", streetAddress: "Synthetic street", city: "Riverton", state: "ST",
  parentCity: "Riverton", parentState: "ST", parentZip: "02139",
  parentRouteId: "7", parentFranchiseId: "F-1", parentEnabled: "true", customerEnabled: "true",
  addressRouteId: "7", addressFranchiseId: "F-1", addressEnabled: "true",
  addressCity: "Riverton", addressState: "ST", addressZip: "02139", addressExtrasAllowed: "any", addressLastAuditDate: "synthetic-audit",
  serialNumber: "SN-1", rfid: "RF-1", hasSerialNumber: "any", hasRfid: "any", hasCompactorInspection: "true", hasEnclosureInspection: "true", materialStream: "Synthetic stream", color: "Synthetic color",
  serviceCodeType: "T-001", serviceCodeInput: "IN-01",
  locationAddress: "Synthetic location", serviceCode: "SVC-1",
  limit: "2", offset: "0", cursor: "101",
  lowerId: "101", upperId: "104", includeTotal: "false", exactNext: "true", countOnly: "true", order: "asc", fields: "enabled",
  strictQuery: "true"
};

function recordDb() {
  const statements: Statement[] = [];
  function wrap(real: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(real, {
      get(target, member) {
        const value = Reflect.get(target, member, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (member === "bind") return wrap(Reflect.apply(value, target, args), sql, args);
          statements.push({ sql, binds, method: String(member) });
          if (!["first", "all", "raw"].includes(String(member)) || !/^\s*SELECT\b/i.test(sql)) {
            throw new Error("Snapshot lists must only execute SELECT reads");
          }
          return Reflect.apply(value, target, args);
        };
      }
    });
  }
  const db = {
    prepare: (sql: string) => wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []),
    batch: () => { throw new Error("List must not hide D1 work in batch"); },
    exec: () => { throw new Error("List must not exec D1 work"); }
  } as unknown as D1Database;
  return { db, statements };
}

function forbiddenDb() {
  const calls: string[] = [];
  const db = new Proxy({}, {
    get(_target, member) {
      return () => { calls.push(String(member)); throw new Error("Rejected request touched D1"); };
    }
  }) as D1Database;
  return { db, calls };
}

const r2Calls: string[] = [];
const deniedR2 = new Proxy({}, {
  get(_target, member) {
    return () => { r2Calls.push(String(member)); throw new Error("Local list touched R2"); };
  }
}) as R2Bucket;

const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const idsOf = (spec: Spec, body: Body) => body.rows.map((row) => row[spec.id]);

async function request(rawPath: string, options: {
  token?: string | null; headers?: Record<string, string>; db?: D1Database;
} = {}) {
  const recorder = recordDb();
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(new URL(rawPath, ORIGIN), { headers }), {
    ...TEST_ENV, CUSTOMER_DB: options.db ?? recorder.db, SNAPSHOTS: deniedR2
  });
  return { response, recorder };
}

async function validator(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

async function page(spec: Spec, search: string) {
  const result = await request(search ? `${spec.path}?${search}` : spec.path);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.clone().text();
  expect(result.response.headers.get("etag")).toBe(await validator(bytes));
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = new URLSearchParams(search).get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body, bytes };
}

/** Fixed value-free problem: exact envelope keys, correction guidance, and
 *  no submitted name/value anywhere in the serialized body. */
async function expectBadQuery(response: Response, forbiddenEchoes: string[]) {
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("link")).toBeNull();
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
  expect(body).toMatchObject({ type: PROBLEM_TYPE, title: "Bad Request", status: 400 });
  expect(body.detail).toEqual(expect.any(String));
  expect(String(body.detail)).toContain("docs/PROBLEMS.md#bad-request");
  expect(text).not.toContain(MARKER);
  expect(text).not.toContain(TOKEN);
  for (const echo of forbiddenEchoes) expect(text).not.toContain(echo);
  return String(body.detail);
}

function silence() {
  return (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m));
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  r2Calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in strict-query acceptance");
  }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const id of IDS) {
    const enabled = id === 102 ? 0 : 1;
    await db.batch([
      db.prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, comments, phone1, customer_number, sub_customer_number, enabled, synced_at) VALUES (?, ?, 'synthetic note', '555-0100', 'N-1', 'S-1', ?, ?)"
      ).bind(id, `Synthetic company ${id}`, enabled, STAMP),
      db.prepare(
        "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, city, state, zip, route_id, franchise_id, enabled, synced_at) VALUES (?, ?, ?, 'Riverton', 'ST', '02139', 7, 'F-1', ?, ?)"
      ).bind(id, id, `Synthetic site ${id}`, enabled, STAMP),
      db.prepare(
        "INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, rfid, city, zip, service_code, enabled, synced_at) VALUES (?, ?, ?, 'SN-1', 'RF-1', 'Riverton', '02139', ?, ?, ?)"
      ).bind(id, id, `Synthetic site ${id}`, id === 104 ? null : id === 102 ? "SVC-10" : "SVC-1", enabled, STAMP)
    ]);
  }
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(r2Calls).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(SPECS)("$name list: default and strictQuery=false parity", (spec) => {
  it("omitted, false, and unknown keys in either lenient mode are byte- and SQL-identical", async () => {
    const base = `fields=${spec.field}&limit=2`;
    const omitted = await page(spec, base);
    const explicitFalse = await page(spec, `${base}&strictQuery=false`);
    const omittedBogus = await page(spec, `${base}&bogus_param=${MARKER}`);
    const falseBogus = await page(spec, `${base}&strictQuery=false&bogus_param=${MARKER}&custmerId=999`);
    for (const other of [explicitFalse, omittedBogus, falseBogus]) {
      expect(other.bytes).toBe(omitted.bytes);
      expect(other.recorder.statements).toEqual(omitted.recorder.statements);
      expect(other.response.headers.get("etag")).toBe(omitted.response.headers.get("etag"));
      // Continuations omit false/default strictQuery and every unknown key.
      expect(other.response.headers.get("link")).toBe(omitted.response.headers.get("link"));
      expect(other.response.headers.get("link")).not.toMatch(/strictQuery|bogus|custmer|secret-marker/);
    }
    expect(idsOf(spec, omitted.body)).toEqual([101, 102]);
    expect(omitted.body.total).toBe(4);
    expect(omitted.body.nextCursor).toBe(102);
  });

  it("control: strictQuery=true with only declared names serves the same envelope and SQL as omitted", async () => {
    const omitted = await page(spec, "");
    const strict = await page(spec, "strictQuery=true");
    expect(strict.bytes).toBe(omitted.bytes);
    expect(strict.recorder.statements).toEqual(omitted.recorder.statements);
    expect(idsOf(spec, strict.body)).toEqual(IDS);
  });
});

describe.each(SPECS)("$name list: strict mode accepts its own declared names", (spec) => {
  it("accepts every declared name individually with a valid sample value", async () => {
    for (const name of spec.allowed) {
      const pair = `${name}=${SAMPLES[name]}`;
      const search = name === "strictQuery" ? pair : `strictQuery=true&${pair}`;
      const { response } = await request(`${spec.path}?${search}`);
      expect(response.status, `${spec.path}?${search}`).toBe(200);
      await response.text();
    }
  });

  it("strict count-only preserves the filtered total without rows, paging or a Link", async () => {
    const { response, recorder } = await request(
      `${spec.path}?strictQuery=true&countOnly=true&enabled=true&q=synthetic&fields=${spec.field}&limit=1&offset=1`);
    expect(response.status).toBe(200);
    const bytes = await response.text();
    // IDs 101, 103 and 104 match; limit/offset must not truncate the count.
    expect(JSON.parse(bytes)).toEqual({ rows: [], total: 3, nextCursor: null });
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements.filter(isCount)).toHaveLength(1);
    expect(response.headers.get("link")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBe(await validator(bytes));
  });

  it("count-only cannot bypass strict unknown-name rejection before D1", async () => {
    const denied = forbiddenDb();
    const logs = silence();
    const { response } = await request(
      `${spec.path}?strictQuery=true&countOnly=true&bogus_param=${MARKER}`, { db: denied.db });
    const detail = await expectBadQuery(response, ["bogus_param"]);
    expect(detail).toMatch(/unknown/i);
    expect(detail).toMatch(/supported|OpenAPI/i);
    expect(detail).toMatch(/remove/i);
    expect(detail).toContain("strictQuery=false");
    expect(denied.calls).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("composes strict mode with filters, sparse fields and count-free paging", async () => {
    const result = await page(spec,
      `strictQuery=true&enabled=true&q=synthetic&fields=${spec.field}&limit=2&includeTotal=false`);
    expect(idsOf(spec, result.body)).toEqual([101, 103]);
    expect(result.body.total).toBeNull();
    expect(result.body.nextCursor).toBe(103);
    for (const row of result.body.rows) {
      expect(Object.keys(row).sort()).toEqual([spec.id, spec.field].sort());
    }
  });
});

describe("container list: serviceCode under strict mode", () => {
  it("filters exact stored codes identically with strict mode omitted, false or true", async () => {
    const spec = SPECS.find((s) => s.name === "container")!;
    const search = "serviceCode=SVC-1&fields=location_address";
    const omitted = await page(spec, search);
    // SVC-10 (102) and NULL (104) do not match the exact stored SVC-1.
    expect(idsOf(spec, omitted.body)).toEqual([101, 103]);
    expect(omitted.body.total).toBe(2);
    expect(omitted.body.nextCursor).toBeNull();
    for (const strictQuery of ["false", "true"]) {
      const result = await page(spec, `${search}&strictQuery=${strictQuery}`);
      expect(result.bytes).toBe(omitted.bytes);
      expect(result.recorder.statements).toEqual(omitted.recorder.statements);
    }
  });
});

describe("address list: strictQuery and driverNote compose", () => {
  it("filters both a strict page and count-only by the recognized stored note", async () => {
    await TEST_ENV.CUSTOMER_DB.prepare(
      "UPDATE address_snapshot SET driver_note = 'Synthetic access note' WHERE pickup_address_id IN (101, 104)"
    ).run();
    const spec = SPECS.find((s) => s.name === "address")!;
    const search = "strictQuery=true&driverNote=access&enabled=true&fields=address";
    const listed = await page(spec, search);
    expect(idsOf(spec, listed.body)).toEqual([101, 104]);
    expect(listed.body.total).toBe(2);
    const counted = await request(`${spec.path}?${search}&countOnly=true&limit=1&offset=1`);
    expect(counted.response.status).toBe(200);
    expect(await counted.response.json()).toEqual({ rows: [], total: 2, nextCursor: null });
    expect(counted.recorder.statements).toHaveLength(1);
    expect(counted.recorder.statements.filter(isCount)).toHaveLength(1);
    expect(counted.response.headers.get("link")).toBeNull();
  });

  it.each([
    `driverNote=${"x".repeat(101)}`,
    "driverNote=access&driverNote=access",
    "driverNote=access&%64riverNote=access"
  ])("rejects invalid driverNote under strict mode before D1: %s", async (fragment) => {
    for (const suffix of ["", "&countOnly=true"]) {
      const denied = forbiddenDb();
      const logs = silence();
      const { response } = await request(
        `/api/v1/address-snapshot?strictQuery=true&${fragment}${suffix}`, { db: denied.db });
      const detail = await expectBadQuery(response, ["access", "x".repeat(101)]);
      expect(detail).toContain("driverNote");
      expect(detail).not.toMatch(/unknown/i);
      expect(denied.calls).toEqual([]);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    }
  });
});

describe.each(SPECS)("$name list: strict mode rejects unknown names value-free", (spec) => {
  const unknownFragments: Array<[string, string, string[]]> = [
    ["plain typo", "custmerId=101", ["custmerId"]],
    ["unknown with marker value", `bogus_param=${MARKER}`, ["bogus_param"]],
    ["empty name", `=${MARKER}`, []],
    ["percent-encoded typo", "%62ogus_param=1", ["bogus_param", "%62"]],
    ["encoded unicode name", "caf%C3%A9=1", ["café", "caf%C3%A9"]],
    ["unicode name", "%E9%A9%AC=1", ["马"]],
    ["NUL-prefixed name", "%00bogus=1", ["bogus", "%00"]],
    ["newline in name", "bogus%0Aname=1", ["bogus", "%0A"]],
    ["space-only name", "%20=1", ["%20"]],
    ["case-variant of a known name", "Limit=2", ["Limit"]],
    ["typo of strictQuery itself", "stricQuery=true", ["stricQuery"]],
    ["hydrated per-type fields key", "fields%5Bcustomer%5D=enabled", ["fields[customer]"]]
  ];
  it.each(unknownFragments)("rejects %s before D1 without echo or logs", async (_label, fragment, echoes) => {
    const denied = forbiddenDb();
    const logs = silence();
    const { response } = await request(`${spec.path}?strictQuery=true&${fragment}`, { db: denied.db });
    const detail = await expectBadQuery(response, echoes);
    // Fixed correction action: supported/OpenAPI names, remove the unknown
    // keys, or turn strict mode off. No dynamic list of submitted keys.
    expect(detail).toMatch(/unknown/i);
    expect(detail).toMatch(/supported|OpenAPI/i);
    expect(detail).toMatch(/remove/i);
    expect(detail).toContain("strictQuery=false");
    expect(denied.calls).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("rejects sibling-only selectors (no allowlist leakage between resources)", async () => {
    for (const pair of spec.cross) {
      const denied = forbiddenDb();
      const { response } = await request(`${spec.path}?strictQuery=true&${pair}`, { db: denied.db });
      const detail = await expectBadQuery(response, [pair.split("=")[0]]);
      expect(detail).toContain("strictQuery=false");
      expect(denied.calls, pair).toEqual([]);
    }
  });

  it("control: the same sibling-only selectors stay ignored without strict mode", async () => {
    for (const pair of spec.cross.slice(0, 3)) {
      const result = await page(spec, pair);
      expect(idsOf(spec, result.body), pair).toEqual(IDS);
    }
  });
});

describe("container list: strict containerTypeId validation", () => {
  const spec = SPECS.find((s) => s.name === "container")!;

  it.each(["0", "7", "9007199254740991"])(
    "accepts exact safe-integer %s under strict mode without matching null stored types", async (value) => {
      const result = await page(spec, `strictQuery=true&containerTypeId=${value}`);
      // All four fixture rows have a NULL container_type_id, never literal zero.
      expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
      expect(result.response.headers.get("link")).toBeNull();
    }
  );

  it.each([
    "containerTypeId=", "containerTypeId=00", "containerTypeId=-1",
    "containerTypeId=1.0", "containerTypeId=1e0", "containerTypeId=%2B7",
    "containerTypeId=%207", "containerTypeId=7%20", "containerTypeId=%D9%A7",
    "containerTypeId=9007199254740992", `containerTypeId=${MARKER}`,
    "containerTypeId=7&containerTypeId=7", "containerTypeId=7&%63ontainerTypeId=7"
  ])("rejects malformed or repeated %s value-free before D1 in strict mode", async (fragment) => {
    const denied = forbiddenDb();
    const logs = silence();
    const { response } = await request(`${spec.path}?strictQuery=true&${fragment}`, { db: denied.db });
    await expectBadQuery(response, ["%2B7", "%207", "7%20", "%D9%A7"]);
    expect(denied.calls).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe.each(SPECS)("$name list: strictQuery value validation", (spec) => {
  const invalid = [
    "strictQuery", "strictQuery=", "strictQuery=TRUE", "strictQuery=True",
    "strictQuery=1", "strictQuery=0", "strictQuery=yes", "strictQuery=%20true",
    "strictQuery=true%20", "strictQuery=true%2Cfalse", `strictQuery=${MARKER}`,
    "strictQuery=true&strictQuery=true", "strictQuery=false&strictQuery=false",
    "strictQuery=true&strictQuery=false", "strictQuery=false&strictQuery=true",
    `strictQuery=false&strictQuery=${MARKER}`, `strictQuery=${MARKER}&strictQuery=false`,
    "%73trictQuery=true&strictQuery=false", "strictQuery=true&%73trict%51uery=false"
  ];
  it.each(invalid)("rejects %s before D1, naming only strictQuery", async (search) => {
    const denied = forbiddenDb();
    const logs = silence();
    const { response } = await request(`${spec.path}?${search}`, { db: denied.db });
    const detail = await expectBadQuery(response, ["TRUE", "True", "yes", "%20", "%2C"]);
    expect(detail).toContain("strictQuery");
    expect(denied.calls).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["limit=501", "fields=not_a_column_marker"])(
    "known invalid %s stays invalid in omitted, false and true modes, before D1",
    async (bad) => {
      for (const suffix of ["", "&strictQuery=false", "&strictQuery=true"]) {
        const denied = forbiddenDb();
        const { response } = await request(
          `${spec.path}?${bad}&bogus_param=${MARKER}${suffix}`, { db: denied.db });
        await expectBadQuery(response, ["bogus_param", "not_a_column_marker"]);
        expect(denied.calls, `${bad}${suffix}`).toEqual([]);
      }
    }
  );
});

describe.each(SPECS)("$name list: auth and conditional precedence", (spec) => {
  it.each([
    "strictQuery=true&bogus_param=1", `strictQuery=${MARKER}`, "strictQuery=true",
    "strictQuery=true&containerTypeId=0", `strictQuery=true&containerTypeId=${MARKER}`
  ])("auth precedes strict validation for %s", async (search) => {
    for (const token of [null, "synthetic-wrong-token"]) {
      const denied = forbiddenDb();
      const { response } = await request(`${spec.path}?${search}`, { token, db: denied.db });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.text()).not.toContain(MARKER);
      expect(denied.calls).toEqual([]);
    }
  });

  it("strict replay 304s only for a fully valid strict request", async () => {
    const search = `strictQuery=true&fields=${spec.field}&limit=2&includeTotal=false`;
    const first = await page(spec, search);
    const tag = first.response.headers.get("etag")!;
    const replay = await request(`${spec.path}?${search}`, { headers: { "if-none-match": tag } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
    expect(replay.response.headers.get("etag")).toBe(tag);
    expect(replay.response.headers.get("cache-control")).toBe("no-store");
    expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));

    // An unknown key beside a matching validator is a 400 before either D1
    // or conditional evaluation — never a 304.
    const denied = forbiddenDb();
    const tainted = await request(`${spec.path}?${search}&bogus_param=${MARKER}`, {
      headers: { "if-none-match": tag }, db: denied.db
    });
    await expectBadQuery(tainted.response, ["bogus_param"]);
    expect(denied.calls).toEqual([]);

    const denied2 = forbiddenDb();
    const badValue = await request(`${spec.path}?strictQuery=yes&fields=${spec.field}`, {
      headers: { "if-none-match": tag }, db: denied2.db
    });
    await expectBadQuery(badValue.response, ["yes"]);
    expect(denied2.calls).toEqual([]);
  });
});

describe.each(SPECS)("$name list: strict next-link traversal", (spec) => {
  function nextSearch(response: Response): string {
    const link = response.headers.get("link");
    expect(link).toMatch(/^<[^<>\s]*>; rel="next"$/);
    expect(link?.startsWith(`<${spec.path}?`)).toBe(true);
    const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
    expect(raw).not.toMatch(/https?:|secret-marker|test-read-token/);
    return raw;
  }

  it.each([
    ["asc", "", [101, 102, 103, 104]],
    ["desc", "&order=desc", [104, 103, 102, 101]]
  ] as const)("walks %s by returned relative links carrying strictQuery=true", async (_dir, order, want) => {
    let current = await page(spec,
      `strictQuery=true&fields=${spec.field}&limit=2&includeTotal=false${order}`);
    const seen: unknown[] = [];
    for (let step = 0; step < 3; step++) {
      const expectedRows = step < 2 ? want.slice(step * 2, step * 2 + 2) : [];
      expect(idsOf(spec, current.body)).toEqual(expectedRows);
      expect(current.body.total).toBeNull();
      seen.push(...idsOf(spec, current.body));
      if (step < 2) {
        expect(current.body.nextCursor).toBe(expectedRows[1]);
        const target = nextSearch(current.response);
        const params = new URLSearchParams(target.split("?")[1]);
        expect(params.getAll("strictQuery")).toEqual(["true"]);
        expect(params.get("cursor")).toBe(String(expectedRows[1]));
        expect(params.get("fields")).toBe(spec.field);
        expect(params.get("limit")).toBe("2");
        expect(params.get("includeTotal")).toBe("false");
        if (order) expect(params.get("order")).toBe("desc");
        expect(params.has("offset")).toBe(false);
        // Follow the server's link verbatim; it must itself pass strict mode.
        current = await page(spec, target.split("?")[1]);
      } else {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      }
    }
    expect(seen).toEqual([...want]);
    expect(new Set(seen).size).toBe(4);
  });

  it("counted strict links keep cursor-relative totals and drop unknown keys", async () => {
    const first = await page(spec, "strictQuery=true&limit=3");
    expect(idsOf(spec, first.body)).toEqual([101, 102, 103]);
    expect(first.body.total).toBe(4);
    const params = new URLSearchParams(nextSearch(first.response).split("?")[1]);
    expect(params.getAll("strictQuery")).toEqual(["true"]);
    const second = await page(spec, nextSearch(first.response).split("?")[1]);
    expect(idsOf(spec, second.body)).toEqual([104]);
    expect(second.body.total).toBe(1);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe("strictQuery stays off non-list operations", () => {
  it("changes feed keeps its documented ignore policy for strictQuery and unknown names", async () => {
    const bare = await request("/api/v1/customer-snapshot/changes");
    const withStrict = await request("/api/v1/customer-snapshot/changes?strictQuery=true&bogus_param=1");
    expect(bare.response.status).toBe(200);
    expect(withStrict.response.status).toBe(200);
    expect(await withStrict.response.text()).toBe(await bare.response.text());
  });

  it("by-id reads keep ignoring strictQuery and unknown names", async () => {
    const bare = await request("/api/v1/customer-snapshot/101");
    const withStrict = await request("/api/v1/customer-snapshot/101?strictQuery=true&bogus_param=1");
    expect(bare.response.status).toBe(200);
    expect(withStrict.response.status).toBe(200);
    expect(await withStrict.response.text()).toBe(await bare.response.text());
  });
});

describe("strictQuery mounted discovery", () => {
  type Param = {
    name: string; in: string; required?: boolean; description?: string;
    example?: unknown; schema?: { description?: string; example?: unknown; [key: string]: unknown };
  };
  type Operation = { operationId?: string; parameters?: Param[]; responses?: Record<string, { description?: string }> };
  async function openApi() {
    const response = await exports.default.fetch("http://test.local/openapi.json");
    expect(response.status).toBe(200);
    return (await response.json()) as { paths: Record<string, { get?: Operation }> };
  }

  it.each(SPECS.map((s) => [s.path] as const))(
    "%s publishes strictQuery as an optional exact true|false query enum, default false",
    async (path) => {
      const doc = await openApi();
      const operation = doc.paths[path]?.get;
      const params = (operation?.parameters ?? []).filter((p) => p.name === "strictQuery");
      expect(params).toHaveLength(1);
      expect(params[0]).toMatchObject({
        in: "query", required: false,
        schema: { type: "string", enum: ["true", "false"], default: "false" }
      });
      const prose = `${params[0].description ?? ""} ${params[0].schema?.description ?? ""}`;
      expect(prose).toMatch(/unknown/i);
      expect(prose).toMatch(/reject|400|fail/i);
      expect(prose).toMatch(/omit|default/i);
      expect(operation?.responses?.["400"]?.description ?? "").toMatch(/strictQuery/);
    }
  );

  it("mounted parameter inventory equals the runtime allowlist for every list", async () => {
    const doc = await openApi();
    for (const spec of SPECS) {
      const names = (doc.paths[spec.path]?.get?.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name);
      expect([...names].sort(), spec.path).toEqual([...spec.allowed].sort());
    }
  });

  it("keeps strictQuery off changes, by-id and hydrated operations", async () => {
    const doc = await openApi();
    for (const path of [
      "/api/v1/customer-snapshot/changes",
      "/api/v1/customer-snapshot/{customerId}",
      "/api/v1/address-snapshot/{pickupAddressId}",
      "/api/v1/container-snapshot/{containerId}",
      "/api/v1/data/customer", "/api/v1/data/address", "/api/v1/data/container"
    ]) {
      const names = (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).not.toContain("strictQuery");
    }
  });

  it("provides a schema-valid strictQuery example an agent can replay", async () => {
    const doc = await openApi();
    for (const spec of SPECS) {
      const param = doc.paths[spec.path]?.get?.parameters?.find((p) => p.name === "strictQuery");
      const example = param?.example ?? param?.schema?.example;
      expect(["true", "false"], spec.path).toContain(example);
      const result = await page(spec, `strictQuery=${String(example)}`);
      expect(idsOf(spec, result.body)).toEqual(IDS);
    }
  });
});

describe("strictQuery agent guidance", () => {
  it("inventories strictQuery only on the three ordinary lists and links this oracle", () => {
    const row = (path: string) =>
      policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    for (const spec of SPECS) expect(row(spec.path), spec.path).toContain("`strictQuery`");
    expect(row("/api/v1/customer-snapshot/changes")).not.toContain("strictQuery");
    expect(policyDoc).toContain("test/snapshotStrictQueryOptIn.acceptance.test.ts");
  });

  it("documents default-ignore compatibility and the fixed correction action", () => {
    const guidance = policyDoc.split(/^#{1,6} /m)
      .filter((section) => section.includes("strictQuery")).join("\n");
    expect(guidance).toMatch(/strictQuery=true/);
    expect(guidance).toMatch(/strictQuery=false/);
    expect(guidance).toMatch(/default/i);
    expect(guidance).toMatch(/ignor/i);
    expect(guidance).toMatch(/unknown/i);
    expect(guidance).toMatch(/OpenAPI/);
    expect(guidance).toMatch(/remove/i);
    expect(problemsDoc).toContain("strictQuery");
    expect(problemsDoc).toMatch(/strictQuery=false/);
  });

  it("publishes a local synthetic strict-mode recipe and a changelog entry", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    const recipe = blocks.find((b) => b.includes("strictQuery=true"));
    expect(recipe, "strict-mode recipe").toBeDefined();
    expect(recipe).toMatch(/\/api\/v1\/(customer|address|container)-snapshot/);
    expect(recipe).toContain("localhost:8787");
    expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    expect(changelog.split(/^## /m)[1]).toContain("strictQuery");
  });

  it("exposes a named local-only focused check that includes this acceptance suite", () => {
    const scripts = packageJson.scripts as Record<string, string>;
    const command = scripts["check:snapshot-strict-query"];
    expect(command).toEqual(expect.any(String));
    expect(command).toMatch(/vitest\s+run/);
    expect(command).toContain("test/snapshotStrictQueryOptIn.acceptance.test.ts");
    expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
  });
});
