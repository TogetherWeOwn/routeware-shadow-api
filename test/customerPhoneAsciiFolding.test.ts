/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Builder-owned regression: the stored-phone fragment folds ASCII case only.
 *
 * SQLite `lower()` folds A-Z and leaves every other code point unchanged, so
 * the two-term OR predicate matches non-ASCII case variants (é vs É) only on
 * exact case. The served contract states this ASCII-only boundary; these tests
 * pin it for both phone columns without weakening the separate
 * no-normalization guarantee (composed é still never matches decomposed e).
 *
 * Run: npx vitest run test/customerPhoneAsciiFolding.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://phone-folding.invalid";
const STAMP = "2026-01-01T00:00:00.000Z";

type Fixture = readonly [number, string, string | null, string | null];
const fixtures: readonly Fixture[] = [
  [201, "Folding Composed Phone1", "é", null],
  [202, "Folding Decomposed Phone1", "é", null],
  [203, "Folding Office Phone2", null, "BÜRO-555"],
  [204, "Folding ASCII Phone1", "Call AbC now", null],
  [205, "Folding ASCII Phone2", null, "ext XyZ"]
];

type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
const ids = (body: Body) => body.rows.map((row) => row.customer_id);

async function page(phone: string) {
  const url = new URL(PATH, ORIGIN);
  url.search = new URLSearchParams({ phone }).toString();
  const response = await app.fetch(
    new Request(url, { headers: { authorization: "Bearer test-read-token" } }),
    TEST_ENV
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  return body;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch(
    fixtures.map(([id, company, phone1, phone2]) =>
      db
        .prepare(
          "INSERT INTO customer_snapshot (customer_id, company_name, phone1, phone2, enabled, synced_at) VALUES (?, ?, ?, ?, 1, ?)"
        )
        .bind(id, company, phone1, phone2, STAMP)
    )
  );
});

describe("stored-phone ASCII-only case folding", () => {
  it("matches phone1 non-ASCII only on exact case", async () => {
    expect(ids(await page("é"))).toEqual([201]);
    expect(ids(await page("É"))).toEqual([]);
  });

  it("never normalizes composed against decomposed phone1", async () => {
    expect(ids(await page("é"))).toEqual([202]);
  });

  it("matches phone2 non-ASCII only on exact case", async () => {
    expect(ids(await page("BÜRO"))).toEqual([203]);
    expect(ids(await page("büro"))).toEqual([]);
  });

  it("still folds ASCII case on both phone columns", async () => {
    expect(ids(await page("abc"))).toEqual([204]);
    expect(ids(await page("XYZ"))).toEqual([205]);
  });
});
