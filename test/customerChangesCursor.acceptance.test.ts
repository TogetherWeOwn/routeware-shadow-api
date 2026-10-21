import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

// Public HTTP boundary + migrated local D1; no sync, upstream, or real PII.
// These fixtures distinguish lexical timestamp comparison from instant comparison,
// strict whole-run replay from composite resume, and tuple order from id order.
const PATH = "/api/v1/customer-snapshot/changes";
const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const ORIGIN = "https://cursor-client.invalid";
const PROBLEM_BASE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";
const ZERO = "2026-09-01T00:00:00.000Z";
const TENTH = "2026-09-01T00:00:00.100Z";
const HALF = "2026-09-01T00:00:00.500Z";
const NEXT = "2026-09-01T00:00:01.000Z";
const FIXTURES = [
  [8406, HALF], [8403, ZERO], [8408, NEXT], [8407, TENTH],
  [8401, ZERO], [8405, NEXT], [8404, HALF], [8402, TENTH]
] as const;
const ORDERED_IDS = [8401, 8403, 8402, 8407, 8404, 8406, 8405, 8408];
const ORDERED_STAMPS = [ZERO, ZERO, TENTH, TENTH, HALF, HALF, NEXT, NEXT];
const ROW_COLUMNS = [
  "customer_id", "customer_type_id", "company_name", "first_name",
  "middle_initial", "last_name", "name_suffix", "customer_number",
  "sub_customer_number", "phone1", "phone2", "comments", "enabled", "synced_at"
];
type Cursor = { since: string; since_id: number };
type ChangesBody = {
  rows: Array<Record<string, unknown>>;
  total: number;
  nextCursor: Cursor | null;
};

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function getChanges(
  search = "",
  options: { db?: D1Database; token?: string | null } = {}
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(
    new Request(`http://test.local${PATH}${search ? `?${search}` : ""}`, { headers }),
    { ...TEST_ENV, CUSTOMER_DB: options.db ?? TEST_ENV.CUSTOMER_DB }
  );
}

async function page(search = ""): Promise<ChangesBody> {
  const response = await getChanges(search);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const body = await response.json() as ChangesBody;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  expect(body.total).toBe(body.rows.length);
  for (const row of body.rows) {
    expect(Object.keys(row).sort()).toEqual([...ROW_COLUMNS].sort());
  }
  return body;
}

// Observe every D1 entry point without substituting SQL results or interpreting
// predicates in a fake. The valid-request control proves this observer is live.
function observedDb() {
  const calls = vi.fn<(method: string) => void>();
  const db = new Proxy(TEST_ENV.CUSTOMER_DB, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls(String(property));
        return Reflect.apply(value, target, args);
      };
    }
  });
  return { db, calls };
}

async function expectInvalid(search: string): Promise<Record<string, unknown>> {
  const observed = observedDb();
  const response = await getChanges(search, { db: observed.db });
  // Soft checks keep both the boundary status and forbidden D1 work visible on RED.
  expect.soft(observed.calls.mock.calls, "invalid cursor must do zero D1 work").toEqual([]);
  expect.soft(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const body = await response.json() as Record<string, unknown>;
  expect(body).toEqual({
    type: `${PROBLEM_BASE}bad-request`,
    title: "Bad Request",
    status: 400,
    detail: expect.stringMatching(
      /^Invalid request query \((?:since|since_id|query)(?:, (?:since|since_id|query))*\)\. See docs\/PROBLEMS\.md#bad-request\.$/
    )
  });
  return body;
}

beforeAll(async () => {
  await ensureD1TestTables();
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch(FIXTURES.map(([id, stamp]) => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, ?)"
  ).bind(id, `Synthetic cursor fixture ${id}`, stamp)));
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in customer changes cursor acceptance test");
  }));
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("customer changes cursor: timestamp precision", () => {
  it.each([
    ["seconds", "2026-09-01T00:00:00Z", [8402, 8407, 8404, 8406, 8405, 8408]],
    ["one zero digit", "2026-09-01T00:00:00.0Z", [8402, 8407, 8404, 8406, 8405, 8408]],
    ["two zero digits", "2026-09-01T00:00:00.00Z", [8402, 8407, 8404, 8406, 8405, 8408]],
    ["three zero digits", ZERO, [8402, 8407, 8404, 8406, 8405, 8408]],
    ["one tenth digit", "2026-09-01T00:00:00.1Z", [8404, 8406, 8405, 8408]],
    ["two tenth digits", "2026-09-01T00:00:00.10Z", [8404, 8406, 8405, 8408]],
    ["three tenth digits", TENTH, [8404, 8406, 8405, 8408]],
    ["one half digit", "2026-09-01T00:00:00.5Z", [8405, 8408]],
    ["two half digits", "2026-09-01T00:00:00.50Z", [8405, 8408]],
    ["three half digits", HALF, [8405, 8408]]
  ] as const)("bare since uses strict instant comparison for %s", async (_name, since, ids) => {
    const body = await page(query({ since }));
    expect(body.rows.map((row) => row.customer_id)).toEqual(ids);
    expect(body.nextCursor).toBeNull();
  });

  it.each([
    ["2026-09-01T00:00:00Z", "8401", ZERO, [8403, 8402, 8407, 8404, 8406, 8405, 8408]],
    ["2026-09-01T00:00:00.0Z", "8401", ZERO, [8403, 8402, 8407, 8404, 8406, 8405, 8408]],
    ["2026-09-01T00:00:00.00Z", "8401", ZERO, [8403, 8402, 8407, 8404, 8406, 8405, 8408]],
    [ZERO, "8401", ZERO, [8403, 8402, 8407, 8404, 8406, 8405, 8408]],
    ["2026-09-01T00:00:00.1Z", "8402", TENTH, [8407, 8404, 8406, 8405, 8408]],
    ["2026-09-01T00:00:00.10Z", "8402", TENTH, [8407, 8404, 8406, 8405, 8408]],
    [TENTH, "8402", TENTH, [8407, 8404, 8406, 8405, 8408]],
    ["2026-09-01T00:00:00.5Z", "8404", HALF, [8406, 8405, 8408]],
    ["2026-09-01T00:00:00.50Z", "8404", HALF, [8406, 8405, 8408]],
    [HALF, "8404", HALF, [8406, 8405, 8408]]
  ] as const)("resumes %s + %s without dropping the millisecond tie", async (since, since_id, canonical, ids) => {
    const body = await page(query({ since, since_id }));
    expect(body.rows.map((row) => row.customer_id)).toEqual(ids);
    const first = await page(query({ since, since_id, limit: "1" }));
    expect(first.rows.map((row) => row.customer_id)).toEqual([ids[0]]);
    expect(first.nextCursor).toEqual({ since: canonical, since_id: ids[0] });
  });

  it.each(["2026-09-01T00:00:00.099Z", "2026-09-01T00:00:00.499Z"])(
    "does not round %s up to the next stored millisecond",
    async (since) => {
      const body = await page(query({ since }));
      expect(body.rows.map((row) => row.customer_id)).toEqual(
        since.endsWith("099Z") ? [8402, 8407, 8404, 8406, 8405, 8408] : [8404, 8406, 8405, 8408]
      );
    }
  );
});

describe("customer changes cursor: pagination and initial-page controls", () => {
  it.each([undefined, ""])("keeps initial-page behavior for since=%j without since_id", async (since) => {
    const body = await page(since === undefined ? "" : query({ since }));
    expect(body.rows.map((row) => row.customer_id)).toEqual(ORDERED_IDS);
    expect(body.rows.map((row) => row.synced_at)).toEqual(ORDERED_STAMPS);
    expect(body.nextCursor).toBeNull();
  });

  it.each([1, 2, 3, 500])("walks the complete tuple order exactly once with limit=%i", async (limit) => {
    const ids: unknown[] = [];
    let search = query({ limit: String(limit) });
    // At most eight nonempty pages plus the terminal empty page; never poll.
    for (let attempt = 0; attempt <= ORDERED_IDS.length; attempt++) {
      const body = await page(search);
      expect(body.rows.length).toBeLessThanOrEqual(limit);
      const offset = ids.length;
      expect(body.rows.map((row) => row.customer_id)).toEqual(ORDERED_IDS.slice(offset, offset + limit));
      expect(body.rows.map((row) => row.synced_at)).toEqual(ORDERED_STAMPS.slice(offset, offset + limit));
      ids.push(...body.rows.map((row) => row.customer_id));
      if (body.rows.length < limit) {
        expect(body.nextCursor).toBeNull();
        expect(ids).toEqual(ORDERED_IDS);
        return;
      }
      const last = ids.length - 1;
      expect(body.nextCursor).toEqual({ since: ORDERED_STAMPS[last], since_id: ORDERED_IDS[last] });
      const cursor = body.nextCursor as Cursor;
      search = query({ since: cursor.since, since_id: String(cursor.since_id), limit: String(limit) });
    }
    throw new Error("Cursor walk did not terminate within fixture-sized bound");
  });

  it("accepts zero as the composite boundary sentinel", async () => {
    const body = await page(query({ since: ZERO, since_id: "0" }));
    expect(body.rows.map((row) => row.customer_id)).toEqual(ORDERED_IDS);
  });

  it("accepts the maximum safe integer without affecting later timestamps", async () => {
    const body = await page(query({ since: TENTH, since_id: "9007199254740991" }));
    expect(body.rows.map((row) => row.customer_id)).toEqual([8404, 8406, 8405, 8408]);
  });

  it("observes D1 reads on a valid read-role request", async () => {
    const observed = observedDb();
    const response = await getChanges(query({ since: HALF }), { db: observed.db });
    expect(response.status).toBe(200);
    expect((await response.json() as ChangesBody).rows.map((row) => row.customer_id)).toEqual([8405, 8408]);
    expect(observed.calls.mock.calls.flat()).toContain("prepare");
  });
});

describe("customer changes cursor: value-free rejection before D1", () => {
  describe.each(["bare", "composite"])("%s timestamp precision", (form) => {
    it.each([
      "2026-09-01T00:00:00.0000Z",
      "2026-09-01T00:00:00.1000Z",
      "2026-09-01T00:00:00.1001Z",
      "2026-09-01T00:00:00.4999Z",
      "2026-09-01T00:00:00.9999Z",
      "2026-09-01T00:00:00.123456789Z"
    ])("rejects precision beyond milliseconds rather than truncate/round: %s", async (since) => {
      await expectInvalid(query(form === "bare" ? { since } : { since, since_id: "8402" }));
    });
  });

  it.each([
    "2026-09-01T00:00:00+00:00", "2026-09-01T01:00:00+01:00",
    "2026-09-01T00:00:00", "2026-09-01", "2026-09-01 00:00:00Z", "not-a-date"
  ])("does not widen the UTC datetime format contract: %s", async (since) => {
    await expectInvalid(query({ since, since_id: "0" }));
  });

  it.each([undefined, "", " "])("rejects an unpaired since_id when since=%j", async (since) => {
    await expectInvalid(query(since === undefined ? { since_id: "0" } : { since, since_id: "0" }));
  });

  // Canonical decimal spelling: zero or an unpadded positive decimal integer.
  // Number()/parseInt() coercion would accept or lose information in these cases.
  it.each([
    "", " ", "\t", "-1", "-0", "+8401", "00", "08401", "8401.0", "8401.5",
    "8.401e3", "0x20d1", "8401suffix", "NaN", "Infinity",
    "9007199254740992", "9007199254740993", "999999999999999999999999"
  ])("rejects a non-exact safe decimal since_id=%j", async (since_id) => {
    await expectInvalid(query({ since: ZERO, since_id }));
  });

  it.each([
    `${query({ since: ZERO })}&since_id=8401&since_id=8403`,
    `${query({ since_id: "8401" })}&since=${encodeURIComponent(ZERO)}&since=${encodeURIComponent(TENTH)}`
  ])("rejects ambiguous repeated cursor keys: %s", async (search) => {
    await expectInvalid(search);
  });

  it("uses identical fixed correction guidance for different rejected values", async () => {
    const first = await expectInvalid(query({ since: "2026-09-01T00:00:00.1234Z" }));
    const second = await expectInvalid(query({ since: "2026-10-02T03:04:05.9876Z" }));
    expect(first).toEqual(second);
  });

  it.each([null, "synthetic-invalid-token"])("authenticates before cursor validation with token=%j", async (token) => {
    const observed = observedDb();
    const response = await getChanges(query({ since_id: "9007199254740993" }), { db: observed.db, token });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ type: `${PROBLEM_BASE}unauthorized`, status: 401 });
    expect(observed.calls).not.toHaveBeenCalled();
  });
});
