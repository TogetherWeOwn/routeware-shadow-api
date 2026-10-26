/// <reference types="vite/client" />
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Acceptance contract for R15-03 sparse fieldsets (`?fields=`) on entity reads.
 *
 * SCOPE (v1): the six flat snapshot rows only —
 *   lists:  GET /api/v1/customer-snapshot, /address-snapshot, /container-snapshot
 *   details: GET /api/v1/customer-snapshot/{id}, /address-snapshot/{id}, /container-snapshot/{id}
 * Hydrated single-ID aggregates additionally accept root-only `fields` (covered
 * by hydratedFields.acceptance.test.ts); related bundles remain unchanged.
 * Customer changes additionally accepts `fields` without altering composite
 * cursors (customerChangesFields.acceptance.test.ts). CSV exports still ignore
 * `fields`; nested/relationship selection and `include` remain out of scope.
 *
 * SELECTOR: optional `fields=` comma-separated allowlist, strict:
 *   - exact snake_case column names from the route's SELECT list (whitelist);
 *   - no whitespace trimming, no case folding, no empty segments, no duplicates;
 *   - repeated `fields` keys are invalid (array, not a string);
 *   - resource id is ALWAYS present even when omitted from the selector.
 * Response objects contain EXACTLY the requested whitelisted fields plus the id.
 * Lists keep the `{rows,total,nextCursor}` envelope; only each row object is trimmed.
 * Details return the single trimmed row object directly.
 *
 * ERRORS: unknown/empty/duplicate names yield the existing value-free anchored
 * 400 problem+json envelope (hook shape, no submitted values, fixed detail),
 * before any D1 work. Auth (401) still precedes validation; no-store/CORS,
 * pagination, cursor-wins-over-offset, safe-ID and includeTotal=false compose.
 *
 * Existing flat-read assertions remain green. The hydrated extension is RED
 * on its pre-build baseline: a full-only validator must not suppress a selected
 * response. The Builder implements the extension without editing these tests.
 */

const API_TOKEN = "test-api-token";
const READ_TOKEN = "test-read-token";
const SYNC_SECRET = "test-sync-secret";
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://fields-client.invalid";
const BAD_REQUEST_DETAIL = "Invalid request query (fields). See docs/PROBLEMS.md#bad-request.";

type ResourceName = "customer" | "address" | "container";
type Spec = {
  name: ResourceName;
  listPath: string;
  detailPath: (id: number) => string;
  idColumn: string;
  listOperationId: string;
  detailOperationId: string;
  /** Two selectable business columns with distinct synthetic values. */
  sampleFields: [string, string];
  /** Full SELECT whitelist (id + business + synced_at). */
  allColumns: string[];
  /** Columns valid on another resource but NOT on this one. */
  crossProbes: string[];
};

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

const SPECS: Spec[] = [
  {
    name: "customer",
    listPath: "/api/v1/customer-snapshot",
    detailPath: (id) => `/api/v1/customer-snapshot/${id}`,
    idColumn: "customer_id",
    listOperationId: "listCustomerSnapshot",
    detailOperationId: "getCustomerSnapshot",
    sampleFields: ["company_name", "phone1"],
    allColumns: CUSTOMER_COLUMNS,
    crossProbes: ["pickup_address_id", "container_id", "serial_number", "city"]
  },
  {
    name: "address",
    listPath: "/api/v1/address-snapshot",
    detailPath: (id) => `/api/v1/address-snapshot/${id}`,
    idColumn: "pickup_address_id",
    listOperationId: "listAddressSnapshot",
    detailOperationId: "getAddressSnapshot",
    sampleFields: ["city", "address"],
    allColumns: ADDRESS_COLUMNS,
    crossProbes: ["container_id", "serial_number", "company_name", "phone1"]
  },
  {
    name: "container",
    listPath: "/api/v1/container-snapshot",
    detailPath: (id) => `/api/v1/container-snapshot/${id}`,
    idColumn: "container_id",
    listOperationId: "listContainerSnapshot",
    detailOperationId: "getContainerSnapshot",
    sampleFields: ["serial_number", "location_address"],
    allColumns: CONTAINER_COLUMNS,
    crossProbes: ["customer_id", "company_name", "address", "phone1"]
  }
];

// Synthetic primary keys, disjoint from other suites' 1..6 fixtures.
const CUSTOMERS = [9101, 9102, 9103];
const ADDRESSES = [9201, 9202, 9203];
const CONTAINERS = [9301, 9302, 9303];

type Statement = { sql: string; binds: unknown[] };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);

/** Pass-through recorder over the real test D1. */
function spyDb(real: D1Database): { db: D1Database; statements: Statement[] } {
  const statements: Statement[] = [];
  const db = {
    prepare(sql: string) {
      const rec: Statement = { sql, binds: [] };
      statements.push(rec);
      const stmt = real.prepare(sql);
      return {
        bind(...binds: unknown[]) {
          rec.binds = binds;
          return stmt.bind(...binds);
        },
        first: (...a: unknown[]) => (stmt.first as (...x: unknown[]) => unknown)(...a),
        all: () => stmt.all(),
        run: () => stmt.run(),
        raw: () => stmt.raw()
      };
    },
    batch: (...a: unknown[]) => (real.batch as (...x: unknown[]) => unknown)(...a)
  };
  return { db: db as unknown as D1Database, statements };
}

function throwingDb() {
  const prepare = vi.fn(() => {
    throw new Error("Rejected fields selector must not reach D1");
  });
  return { db: { prepare } as unknown as D1Database, prepare };
}

async function get(
  path: string,
  options: { token?: string | null; db?: D1Database; headers?: Record<string, string> } = {}
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN, ...options.headers });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(
    new Request(`http://test.local${path}`, { headers }),
    options.db ? { ...TEST_ENV, CUSTOMER_DB: options.db } : TEST_ENV
  );
}

type ListBody = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

function expectNoStoreCors(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
}

async function expectFields400(
  res: Response,
  prepare: ReturnType<typeof vi.fn>,
  submittedMarker?: string
): Promise<string> {
  expect(res.status).toBe(400);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expectNoStoreCors(res);
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(body).toMatchObject({
    type: problemType("bad-request"),
    title: "Bad Request",
    status: 400,
    detail: BAD_REQUEST_DETAIL
  });
  // Hook shape has no instance; a manual shape may add a pathname-only instance.
  // Either way the envelope is value-free and anchored.
  const keys = Object.keys(body).filter((k) => k !== "instance").sort();
  expect(keys).toEqual(["detail".toLowerCase(), "status", "title", "type"]);
  if (body.instance !== undefined) {
    expect(String(body.instance)).not.toMatch(/\?|fields|%2C|%20/i);
  }
  expect(text).not.toContain("SYNTHETIC-MARKER");
  if (submittedMarker) expect(text).not.toContain(submittedMarker);
  expect(prepare).not.toHaveBeenCalled();
  return String(body.detail);
}

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in sparse-fieldsets test");
  }) as typeof fetch;

  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (let i = 0; i < 3; i++) {
    const cid = CUSTOMERS[i];
    const aid = ADDRESSES[i];
    const coid = CONTAINERS[i];
    await db.batch([
      db
        .prepare(
          "INSERT INTO customer_snapshot (customer_id, company_name, phone1, enabled, synced_at) VALUES (?, ?, ?, 1, '2026-10-01T00:00:00.000Z')"
        )
        .bind(cid, `synthetic-fields-co-${cid}`, `555-${cid}`),
      db
        .prepare(
          "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, city, enabled, synced_at) VALUES (?, ?, ?, ?, 1, '2026-10-01T00:00:00.000Z')"
        )
        .bind(aid, CUSTOMERS[0], `synthetic-fields-addr-${aid}`, `Syntheticville-${aid}`),
      db
        .prepare(
          "INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, location_address, enabled, synced_at) VALUES (?, ?, ?, ?, 1, '2026-10-01T00:00:00.000Z')"
        )
        .bind(coid, ADDRESSES[0], `synthetic-serial-${coid}`, `synthetic-fields-loc-${coid}`)
    ]);
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe.each(SPECS)("$name list: valid selection trims rows, keeps envelope", (spec) => {
  it("bare request returns full rows (preserved default)", async () => {
    const res = await get(spec.listPath);
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    expect.soft(res.headers.get("etag")).toEqual(expect.stringMatching(/^"[0-9a-f]{64}"$/));
    const body = (await res.json()) as ListBody;
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
    expect(body.rows).toHaveLength(3);
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([...spec.allColumns].sort());
    }
    expect(body.total).toBe(3);
  });

  it("all columns are selectable and survive serialization on every row", async () => {
    const res = await get(`${spec.listPath}?fields=${spec.allColumns.join(",")}`);
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    expect.soft(res.headers.get("etag")).toEqual(expect.stringMatching(/^"[0-9a-f]{64}"$/));
    const body = (await res.json()) as ListBody;
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
    expect(body.rows).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(body.nextCursor).toBeNull();
    const ids = spec.name === "customer" ? CUSTOMERS : spec.name === "address" ? ADDRESSES : CONTAINERS;
    expect(body.rows.map((row) => row[spec.idColumn])).toEqual(ids);
    for (const row of body.rows) {
      // Nullable columns must remain keys, not disappear as undefined in JSON.
      expect(Object.keys(row).sort()).toEqual([...spec.allColumns].sort());
    }
  });

  it("single field returns exactly id + that field on every row", async () => {
    const [field] = spec.sampleFields;
    const { db, statements } = spyDb(TEST_ENV.CUSTOMER_DB);
    const res = await get(`${spec.listPath}?fields=${field}`, { db });
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    expect.soft(res.headers.get("etag")).toEqual(expect.stringMatching(/^"[0-9a-f]{64}"$/));
    const body = (await res.json()) as ListBody;
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
    expect(body.rows).toHaveLength(3);
    expect(body.total).toBe(3);
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([spec.idColumn, field].sort());
      expect(row[spec.idColumn]).toEqual(expect.any(Number));
      expect(row[field]).toBeDefined();
    }
    // Valid selectors do D1 work (COUNT + page); invalid selectors do zero (below).
    expect(statements.filter(isCount)).toHaveLength(1);
    expect(statements).toHaveLength(2);
  });

  it("two fields return exactly id + both fields", async () => {
    const [a, b] = spec.sampleFields;
    const res = await get(`${spec.listPath}?fields=${a},${b}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.rows).toHaveLength(3);
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([spec.idColumn, a, b].sort());
    }
  });

  it("id is present even when omitted, and explicit id is not a duplicate", async () => {
    const [field] = spec.sampleFields;
    const omitted = (await (await get(`${spec.listPath}?fields=${field}`)).json()) as ListBody;
    for (const row of omitted.rows) {
      expect(row[spec.idColumn]).toEqual(expect.any(Number));
    }
    const explicit = (await (
      await get(`${spec.listPath}?fields=${spec.idColumn},${field}`)
    ).json()) as ListBody;
    for (const row of explicit.rows) {
      expect(Object.keys(row).sort()).toEqual([spec.idColumn, field].sort());
    }
    expect(explicit.rows).toEqual(omitted.rows);
  });

  it("fields=id alone returns id-only rows", async () => {
    const res = await get(`${spec.listPath}?fields=${spec.idColumn}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.rows).toHaveLength(3);
    for (const row of body.rows) {
      expect(Object.keys(row)).toEqual([spec.idColumn]);
    }
  });

  it("synced_at is selectable (stored column, not hidden)", async () => {
    const res = await get(`${spec.listPath}?fields=synced_at`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([spec.idColumn, "synced_at"].sort());
      expect(row.synced_at).toBe("2026-10-01T00:00:00.000Z");
    }
  });

  it("works with the read-only token and the full API token", async () => {
    const [field] = spec.sampleFields;
    for (const token of [READ_TOKEN, API_TOKEN, SYNC_SECRET]) {
      const res = await get(`${spec.listPath}?fields=${field}`, { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListBody;
      for (const row of body.rows) {
        expect(Object.keys(row).sort()).toEqual([spec.idColumn, field].sort());
      }
    }
  });
});

describe.each(SPECS)("$name detail: valid selection trims the row", (spec) => {
  function detailId(): number {
    return spec.name === "customer" ? CUSTOMERS[0] : spec.name === "address" ? ADDRESSES[0] : CONTAINERS[0];
  }

  it("bare request returns the full row (preserved default)", async () => {
    const res = await get(spec.detailPath(detailId()));
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    expect.soft(res.headers.get("etag")).toEqual(expect.stringMatching(/^"[0-9a-f]{64}"$/));
    const row = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([...spec.allColumns].sort());
    expect(row[spec.idColumn]).toBe(detailId());
  });

  it("all columns are selectable and survive serialization on the detail row", async () => {
    const res = await get(`${spec.detailPath(detailId())}?fields=${spec.allColumns.join(",")}`);
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    expect.soft(res.headers.get("etag")).toEqual(expect.stringMatching(/^"[0-9a-f]{64}"$/));
    const row = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([...spec.allColumns].sort());
    expect(row[spec.idColumn]).toBe(detailId());
  });

  it("single field returns exactly id + that field", async () => {
    const [field] = spec.sampleFields;
    const { db, statements } = spyDb(TEST_ENV.CUSTOMER_DB);
    const res = await get(`${spec.detailPath(detailId())}?fields=${field}`, { db });
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    const row = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([spec.idColumn, field].sort());
    expect(row[spec.idColumn]).toBe(detailId());
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toMatch(/^\s*SELECT\b/i);
  });

  it("id-always-present and explicit-id equivalence hold on details", async () => {
    const [field] = spec.sampleFields;
    const omitted = (await (
      await get(`${spec.detailPath(detailId())}?fields=${field}`)
    ).json()) as Record<string, unknown>;
    expect(omitted[spec.idColumn]).toBe(detailId());
    const explicit = (await (
      await get(`${spec.detailPath(detailId())}?fields=${spec.idColumn},${field}`)
    ).json()) as Record<string, unknown>;
    expect(explicit).toEqual(omitted);
    const idOnly = (await (
      await get(`${spec.detailPath(detailId())}?fields=${spec.idColumn}`)
    ).json()) as Record<string, unknown>;
    expect(idOnly).toEqual({ [spec.idColumn]: detailId() });
  });

  it("unknown detail id stays 404 with valid fields (not 400)", async () => {
    const [field] = spec.sampleFields;
    const res = await get(`${spec.detailPath(999999)}?fields=${field}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expectNoStoreCors(res);
  });
});

describe.each(SPECS)("$name: invalid selectors 400 value-free with zero D1", (spec) => {
  function listUrl(fields: string): string {
    return `${spec.listPath}?fields=${fields}`;
  }
  function detailUrl(fields: string): string {
    const id = spec.name === "customer" ? CUSTOMERS[0] : spec.name === "address" ? ADDRESSES[0] : CONTAINERS[0];
    return `${spec.detailPath(id)}?fields=${fields}`;
  }

  it.each([
    ["unknown single", "no_such_column_xyz"],
    ["unknown with marker", "secret-SYNTHETIC-MARKER-xyz"],
    ["one valid + one unknown", `${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]},no_such_column_xyz`],
    ["empty value", ""],
    ["bare comma", "%2C"],
    ["trailing comma", `${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}%2C`],
    ["leading comma", `%2C${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}`],
    ["empty segment", `${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}%2C%2C${SPECS.find((s) => s.name === spec.name)!.sampleFields[1]}`],
    ["duplicate", `${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}%2C${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}`],
    ["duplicate id", `${SPECS.find((s) => s.name === spec.name)!.idColumn}%2C${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}%2C${SPECS.find((s) => s.name === spec.name)!.idColumn}`],
    ["space after comma", `${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}%2C%20${SPECS.find((s) => s.name === spec.name)!.sampleFields[1]}`],
    ["leading space", `%20${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}`],
    ["trailing space", `${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}%20`],
    ["upper-case", `${SPECS.find((s) => s.name === spec.name)!.sampleFields[0].toUpperCase()}`],
    ["rowid probe", "rowid"],
    ["erasure probe", "erased_at"]
  ])("list rejects %s before D1", async (_label, fields) => {
    const { db, prepare } = throwingDb();
    const res = await get(listUrl(fields), { db });
    await expectFields400(res, prepare, "secret-SYNTHETIC-MARKER-xyz");
  });

  it.each([
    ["unknown single", "no_such_column_xyz"],
    ["empty value", ""],
    ["duplicate", `${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}%2C${SPECS.find((s) => s.name === spec.name)!.sampleFields[0]}`],
    ["rowid probe", "rowid"]
  ])("detail rejects %s before D1", async (_label, fields) => {
    const { db, prepare } = throwingDb();
    const res = await get(detailUrl(fields), { db });
    await expectFields400(res, prepare);
  });

  it("rejects cross-resource columns (valid elsewhere, unknown here)", async () => {
    for (const probe of spec.crossProbes) {
      const listThrow = throwingDb();
      const listRes = await get(listUrl(probe), { db: listThrow.db });
      await expectFields400(listRes, listThrow.prepare);
      const detailThrow = throwingDb();
      const detailRes = await get(detailUrl(probe), { db: detailThrow.db });
      await expectFields400(detailRes, detailThrow.prepare);
    }
  });

  it("rejects a repeated fields key before D1", async () => {
    const [field] = spec.sampleFields;
    const listThrow = throwingDb();
    const listRes = await get(`${spec.listPath}?fields=${field}&fields=${field}`, { db: listThrow.db });
    await expectFields400(listRes, listThrow.prepare);
    const id = spec.name === "customer" ? CUSTOMERS[0] : spec.name === "address" ? ADDRESSES[0] : CONTAINERS[0];
    const detailThrow = throwingDb();
    const detailRes = await get(`${spec.detailPath(id)}?fields=${field}&fields=${field}`, {
      db: detailThrow.db
    });
    await expectFields400(detailRes, detailThrow.prepare);
  });

  it("keeps the 400 detail fixed when rejected input changes", async () => {
    const firstThrow = throwingDb();
    const first = await expectFields400(
      await get(listUrl("not-a-field-SYNTHETIC-MARKER"), { db: firstThrow.db }),
      firstThrow.prepare
    );
    const secondThrow = throwingDb();
    const second = await expectFields400(
      await get(listUrl("different-SYNTHETIC-MARKER"), { db: secondThrow.db }),
      secondThrow.prepare
    );
    expect(second).toBe(first);
    expect(second).toBe(BAD_REQUEST_DETAIL);
  });

  it("rejects invalid fields with the read-only token as well (not 401)", async () => {
    const { db, prepare } = throwingDb();
    const res = await get(listUrl("no_such_column_xyz"), { db, token: READ_TOKEN });
    await expectFields400(res, prepare);
  });
});

describe.each(SPECS)("$name: pagination, precedence and filters compose with fields", (spec) => {
  it("keeps rows/total/nextCursor identical to the untrimmed page, only keys shrink", async () => {
    const [field] = spec.sampleFields;
    const queries = ["?limit=2", "?limit=2&offset=1", "?limit=2&cursor=0", "?limit=1&offset=2"];
    for (const q of queries) {
      const plain = (await (await get(`${spec.listPath}${q}`)).json()) as ListBody;
      const trimmed = (await (await get(`${spec.listPath}${q}&fields=${field}`)).json()) as ListBody;
      expect(trimmed.rows).toHaveLength(plain.rows.length);
      expect(trimmed.rows.map((r) => r[spec.idColumn])).toEqual(
        plain.rows.map((r) => r[spec.idColumn])
      );
      expect(trimmed.total).toBe(plain.total);
      expect(trimmed.nextCursor).toBe(plain.nextCursor);
      for (const row of trimmed.rows) {
        expect(Object.keys(row).sort()).toEqual([spec.idColumn, field].sort());
      }
    }
  });

  it("cursor still wins over offset when fields is present", async () => {
    const [field] = spec.sampleFields;
    const firstId = spec.name === "customer" ? CUSTOMERS[0] : spec.name === "address" ? ADDRESSES[0] : CONTAINERS[0];
    const res = await get(`${spec.listPath}?limit=1&cursor=${firstId}&offset=0&fields=${field}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    // Cursor seeks past firstId; offset=0 would have returned firstId if honored.
    expect(body.rows.map((r) => r[spec.idColumn])).not.toContain(firstId);
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([spec.idColumn, field].sort());
    }
  });

  it("composes with includeTotal=false: total null, zero COUNT, trimmed rows", async () => {
    const [field] = spec.sampleFields;
    const { db, statements } = spyDb(TEST_ENV.CUSTOMER_DB);
    const res = await get(`${spec.listPath}?limit=2&includeTotal=false&fields=${field}`, { db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
    expect(body.total).toBeNull();
    expect(body.rows).toHaveLength(2);
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([spec.idColumn, field].sort());
    }
    expect(statements.filter(isCount)).toEqual([]);
    expect(statements).toHaveLength(1);
  });

  it("composes with enabled and q filters without changing matches", async () => {
    const [field] = spec.sampleFields;
    const plain = (await (await get(`${spec.listPath}?enabled=true&q=synthetic-fields`)).json()) as ListBody;
    const trimmed = (await (
      await get(`${spec.listPath}?enabled=true&q=synthetic-fields&fields=${field}`)
    ).json()) as ListBody;
    expect(trimmed.rows.map((r) => r[spec.idColumn])).toEqual(plain.rows.map((r) => r[spec.idColumn]));
    expect(trimmed.total).toBe(plain.total);
    for (const row of trimmed.rows) {
      expect(Object.keys(row).sort()).toEqual([spec.idColumn, field].sort());
    }
  });

  it("invalid fields + invalid limit still 400s value-free with zero D1", async () => {
    const { db, prepare } = throwingDb();
    const res = await get(`${spec.listPath}?limit=501&fields=no_such_column_xyz`, { db });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expectNoStoreCors(res);
    const text = await res.text();
    expect(text).not.toContain("no_such_column_xyz");
    expect(text).toContain("See docs/PROBLEMS.md#bad-request.");
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe.each(SPECS)("$name: auth ordering and safe-ID preserved with fields", (spec) => {
  it("401s before validating fields when the bearer is missing or wrong", async () => {
    for (const token of [null, "wrong-token", ""]) {
      const { db, statements } = spyDb(TEST_ENV.CUSTOMER_DB);
      const bad = await get(`${spec.listPath}?fields=no_such_column_xyz`, {
        token: token as string | null,
        db
      });
      const good = await get(
        `${spec.listPath}?fields=${spec.sampleFields[0]}`,
        { token: token as string | null, db }
      );
      for (const res of [bad, good]) {
        expect(res.status).toBe(401);
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        expectNoStoreCors(res);
      }
      expect(statements).toEqual([]);
    }
  });

  it("detail with a malformed id 400s before D1 even with valid fields", async () => {
    const [field] = spec.sampleFields;
    for (const badId of ["01", "0", "-1", "1.5", "abc", "1e2"]) {
      const { db, prepare } = throwingDb();
      const path = spec.detailPath(1).replace("/1", `/${encodeURIComponent(badId)}`);
      const res = await get(`${path}?fields=${field}`, { db });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expectNoStoreCors(res);
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it("Detail with a valid id and invalid fields 400s on fields with zero D1", async () => {
    const id = spec.name === "customer" ? CUSTOMERS[0] : spec.name === "address" ? ADDRESSES[0] : CONTAINERS[0];
    const { db, prepare } = throwingDb();
    const res = await get(`${spec.detailPath(id)}?fields=no_such_column_xyz`, { db });
    await expectFields400(res, prepare);
  });
});

describe("hydrated extension and non-scope reads", () => {
  it("hydrated reads project only the requested root and validate its own ETag", async () => {
    for (const spec of SPECS) {
      const id = spec.name === "customer" ? CUSTOMERS[0] : spec.name === "address" ? ADDRESSES[0] : CONTAINERS[0];
      const path = `http://test.local/api/v1/data/${spec.name}?id=${id}`;
      const headers = { authorization: `Bearer ${SYNC_SECRET}` };
      const plain = await app.fetch(new Request(path, { headers }), TEST_ENV);
      expect(plain.status).toBe(200);
      const etag = plain.headers.get("etag")!;
      const body = await plain.json() as Record<string, Record<string, unknown>>;
      const field = spec.sampleFields[0];
      const selectedPath = `${path}&fields=${field}`;
      const selected = await app.fetch(new Request(selectedPath, {
        headers: { ...headers, "if-none-match": etag }
      }), TEST_ENV);
      expect(selected.status).toBe(200);
      expect(await selected.json()).toEqual({
        ...body, [spec.name]: { [spec.idColumn]: id, [field]: body[spec.name][field] }
      });
      const projectedEtag = selected.headers.get("etag")!;
      expect(projectedEtag).not.toBe(etag);
      for (const [url, validator] of [[path, etag], [selectedPath, projectedEtag]]) {
        const notModified = await app.fetch(new Request(url, {
          headers: { ...headers, "if-none-match": validator }
        }), TEST_ENV);
        expect(notModified.status).toBe(304);
        expect(await notModified.text()).toBe("");
        expect(notModified.headers.get("etag")).toBe(validator);
      }
    }
  });

  it("CSV exports ignore fields and keep ETag/304", async () => {
    for (const spec of SPECS) {
      const path = `${spec.listPath}/export`;
      const headers = { authorization: `Bearer ${SYNC_SECRET}` };
      const plain = await app.fetch(new Request(`http://test.local${path}`, { headers }), TEST_ENV);
      expect(plain.status).toBe(200);
      const etag = plain.headers.get("etag");
      expect(etag).toBeTruthy();
      const plainText = await plain.text();
      const withFields = await app.fetch(
        new Request(`http://test.local${path}?fields=no_such_column_xyz`, { headers }),
        TEST_ENV
      );
      expect(withFields.status).toBe(200);
      expect(await withFields.text()).toBe(plainText);
      const notModified = await app.fetch(
        new Request(`http://test.local${path}?fields=no_such_column_xyz`, {
          headers: { ...headers, "if-none-match": etag as string }
        }),
        TEST_ENV
      );
      expect(notModified.status).toBe(304);
      expect(await notModified.text()).toBe("");
    }
  });

  it("customer changes recognizes fields without changing page ids, total or composite cursor", async () => {
    const plain = await get("/api/v1/customer-snapshot/changes?limit=2");
    expect(plain.status).toBe(200);
    const plainBody = await plain.json() as { rows: Array<Record<string, unknown>>; total: number; nextCursor: unknown };
    const withFields = await get("/api/v1/customer-snapshot/changes?limit=2&fields=company_name&unknown=ignored");
    expect(withFields.status).toBe(200);
    expectNoStoreCors(withFields);
    expect(await withFields.json()).toEqual({
      ...plainBody,
      rows: plainBody.rows.map((row) => ({ customer_id: row.customer_id, company_name: row.company_name }))
    });
  });

  it("customer changes rejects invalid fields before D1 instead of ignoring them", async () => {
    const { db, prepare } = throwingDb();
    const response = await get("/api/v1/customer-snapshot/changes?fields=no_such_column_xyz", { db });
    await expectFields400(response, prepare, "no_such_column_xyz");
  });
});

describe("OpenAPI publishes fields on flat reads and keeps export exclusions", () => {
  type Param = {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { type?: unknown; description?: string };
  };
  type Operation = {
    operationId?: string;
    parameters?: Param[];
    responses?: Record<string, { description?: string }>;
    [k: string]: unknown;
  };
  type Doc = { paths: Record<string, Record<string, Operation>> };

  async function openApi(): Promise<Doc> {
    const res = await exports.default.fetch("http://test.local/openapi.json");
    expect(res.status).toBe(200);
    return (await res.json()) as Doc;
  }

  it.each(SPECS.map((s) => [s.listPath, s.listOperationId] as const))(
    "%s publishes optional fields query + 400 mention, keeps operation metadata",
    async (path, operationId) => {
      const doc = await openApi();
      const op = doc.paths[path]?.get;
      expect(op?.operationId).toBe(operationId);
      expect(op?.["x-access"]).toBe("read");
      expect(op?.["x-effect"]).toBe("local-read");
      const param = op?.parameters?.find((p) => p.name === "fields");
      expect(param).toMatchObject({ in: "query", required: false });
      expect(param?.schema?.type).toBe("string");
      const description = `${param?.description ?? ""} ${param?.schema?.description ?? ""}`;
      expect(description).toMatch(/comma/i);
      expect(description).toMatch(/allowlist|whitelist|field names/i);
      expect(op?.responses?.["400"]?.description ?? "").toMatch(/fields/);
    }
  );

  it.each([
    ["/api/v1/customer-snapshot/{customerId}", "getCustomerSnapshot"],
    ["/api/v1/address-snapshot/{pickupAddressId}", "getAddressSnapshot"],
    ["/api/v1/container-snapshot/{containerId}", "getContainerSnapshot"]
  ] as const)("%s publishes optional fields query + 400 mention, keeps operation metadata", async (path, operationId) => {
    const doc = await openApi();
    const op = doc.paths[path]?.get;
    expect(op?.operationId).toBe(operationId);
    expect(op?.["x-access"]).toBe("read");
    expect(op?.["x-effect"]).toBe("local-read");
    const param = op?.parameters?.find((p) => p.name === "fields");
    expect(param).toMatchObject({ in: "query", required: false });
    expect(param?.schema?.type).toBe("string");
    expect(op?.responses?.["400"]?.description ?? "").toMatch(/fields/);
  });

  it("does not add fields to export operations", async () => {
    const doc = await openApi();
    for (const path of [
      "/api/v1/customer-snapshot/export",
      "/api/v1/address-snapshot/export",
      "/api/v1/container-snapshot/export"
    ]) {
      const names = (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).not.toContain("fields");
    }
  });
});
