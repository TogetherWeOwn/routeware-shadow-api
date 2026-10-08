import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { AUTH_THROTTLE_MAX_FAILURES } from "../src/lib/authThrottle";
import { problemType } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

const API_TOKEN = "test-api-token";
const BOUNDARY_QUERY = "x".repeat(100);
const TEST_ENV = env as unknown as Env;
const SPECS = [
  { name: "customer", id: "customer_id", matches: [1], ip: "192.0.2.211" },
  { name: "address", id: "pickup_address_id", matches: [1], ip: "192.0.2.212" },
  // One match in location_address and one in serial_number pins both OR legs.
  { name: "container", id: "container_id", matches: [1, 2], ip: "192.0.2.213" }
] as const;

async function list(
  name: string,
  q: string | undefined,
  options: { token?: string | null; ip?: string; db?: D1Database } = {}
): Promise<Response> {
  const headers = new Headers();
  const token = options.token === undefined ? API_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (options.ip) headers.set("cf-connecting-ip", options.ip);
  const query = q === undefined ? "" : `?q=${encodeURIComponent(q)}`;
  return app.fetch(
    new Request(`http://test.local/api/v1/${name}-snapshot${query}`, { headers }),
    options.db ? { ...TEST_ENV, CUSTOMER_DB: options.db } : TEST_ENV
  );
}

async function expectProblem(response: Response, status: number, slug: string): Promise<string> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ type: problemType(slug), status });
  return text;
}

beforeAll(async () => {
  await ensureD1TestTables();
});

const originalFetch = globalThis.fetch;
beforeEach(async () => {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("Unexpected upstream fetch in snapshot query-limit test");
  }) as typeof fetch;

  // Synthetic labels only: no names, addresses, report exports or real PII.
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const [id, label] of [[1, "fixture-needle"], [2, "fixture-other"], [3, BOUNDARY_QUERY]] as const) {
    await db.batch([
      db.prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, 'test')"
      ).bind(id, label),
      db.prepare(
        "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, 1, 'test')"
      ).bind(id, id, label),
      db.prepare(
        "INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, 1, 'test')"
      ).bind(id, id, label, id === 2 ? "fixture-needle" : "fixture-other")
    ]);
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe.each(SPECS)("$name snapshot q limit", (spec) => {
  it.each([101, 10_000])("rejects a %i-character q before touching D1 or echoing its value", async (length) => {
    const q = "x".repeat(length);
    const prepare = vi.fn(() => {
      throw new Error("Rejected query must not reach D1");
    });
    const db = { prepare } as unknown as D1Database;
    const errorLog = vi.spyOn(console, "error");
    try {
      const response = await list(spec.name, q, { db });
      const text = await expectProblem(response, 400, "bad-request");
      expect(text).not.toContain(q);
      expect(prepare).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("accepts exactly 100 characters and filters without truncation", async () => {
    const response = await list(spec.name, BOUNDARY_QUERY);
    expect(response.status).toBe(200);
    const body = await response.json() as { rows: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(1);
    expect(body.rows.map((row) => row[spec.id])).toEqual([3]);
  });

  it("keeps trimmed, case-insensitive substring filtering", async () => {
    const response = await list(spec.name, "  nEeDlE  ");
    expect(response.status).toBe(200);
    const body = await response.json() as { rows: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(spec.matches.length);
    expect(body.rows.map((row) => row[spec.id])).toEqual(spec.matches);
  });

  it.each([undefined, "", "   "])("keeps an absent or blank q unfiltered (%j)", async (q) => {
    const response = await list(spec.name, q);
    expect(response.status).toBe(200);
    const body = await response.json() as { rows: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(3);
    expect(body.rows.map((row) => row[spec.id])).toEqual([1, 2, 3]);
  });

  it("caps the raw q before trimming rather than accepting oversized padding", async () => {
    const response = await list(spec.name, `needle${" ".repeat(95)}`);
    await expectProblem(response, 400, "bad-request");
  });

  it("preserves outer-gate 401/429 precedence over q validation", async () => {
    const q = "x".repeat(101);
    await expectProblem(await list(spec.name, q, { token: null }), 401, "unauthorized");
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      await expectProblem(
        await list(spec.name, q, { token: "invalid-test-token", ip: spec.ip }),
        401,
        "unauthorized"
      );
    }
    const throttled = await list(spec.name, q, { token: "invalid-test-token", ip: spec.ip });
    await expectProblem(throttled, 429, "rate-limited");
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);

    // Correct credentials still pass the throttle and reach query validation.
    await expectProblem(await list(spec.name, q, { ip: spec.ip }), 400, "bad-request");
  });
});
