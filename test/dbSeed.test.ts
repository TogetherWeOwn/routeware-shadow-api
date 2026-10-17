import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  DATABASE,
  SEED_CONTAINER_ID,
  SEED_CUSTOMER_ID,
  SEED_PICKUP_ADDRESS_ID,
  SEED_SYNCED_AT,
  VERIFY_QUERIES,
  buildSeedStatements,
  formatSeedReport,
  parseWranglerRows,
} from "../scripts/lib/dbSeed.mjs";

/**
 * Regression tests for `npm run db:seed`: the fixture must stay a
 * minimal synthetic customer → address → container chain in FK order, written
 * as idempotent UPSERTs — never bare INSERTs, never REPLACE — or the seed
 * duplicates on re-run or trips the D1 FK chain.
 */
describe("db:seed fixture shape", () => {
  it("targets the same local database as db:migrate:*", () => {
    expect(DATABASE).toBe("routeware-customer-snapshot");
  });

  it("emits exactly three statements in FK order", () => {
    const stmts = buildSeedStatements();
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("INTO customer_snapshot");
    expect(stmts[1]).toContain("INTO address_snapshot");
    expect(stmts[2]).toContain("INTO container_snapshot");
  });

  it("upserts on the primary key so re-runs converge", () => {
    for (const stmt of buildSeedStatements()) {
      expect(stmt).toMatch(/ON CONFLICT\(\w+\) DO UPDATE SET/);
      expect(stmt).not.toContain("OR REPLACE");
    }
  });

  it("links the chain customer → address → container by id", () => {
    const [customer, address, container] = buildSeedStatements();
    expect(customer).toContain(`(${SEED_CUSTOMER_ID},`);
    expect(address).toContain(`(${SEED_PICKUP_ADDRESS_ID}, ${SEED_CUSTOMER_ID},`);
    expect(container).toContain(`(${SEED_CONTAINER_ID}, ${SEED_PICKUP_ADDRESS_ID},`);
  });

  it("keeps fixture ids in the 90000-range, away from real example ids", () => {
    for (const id of [SEED_CUSTOMER_ID, SEED_PICKUP_ADDRESS_ID, SEED_CONTAINER_ID]) {
      expect(id).toBeGreaterThanOrEqual(90000);
      expect(id).toBeLessThan(100000);
    }
  });

  it("stamps a fixed synced_at so re-runs converge to identical rows", () => {
    expect(SEED_SYNCED_AT).toBe("2026-01-01T00:00:00.000Z");
    for (const stmt of buildSeedStatements()) {
      expect(stmt).toContain(SEED_SYNCED_AT);
    }
  });

  it("stays synthetic: no emails, no real-looking PII", () => {
    const joined = buildSeedStatements().join("\n");
    expect(joined).not.toMatch(/@/);
    expect(joined).not.toMatch(/@example\.com/i);
    expect(joined.toLowerCase()).not.toContain("killeen");
  });
});

describe("db:seed verify + report", () => {
  it("verifies one table each, pinned to the fixture PK", () => {
    expect(VERIFY_QUERIES.map((q) => q.table)).toEqual([
      "customer_snapshot",
      "address_snapshot",
      "container_snapshot",
    ]);
    expect(VERIFY_QUERIES[0]?.sql).toContain(String(SEED_CUSTOMER_ID));
    expect(VERIFY_QUERIES[1]?.sql).toContain(String(SEED_PICKUP_ADDRESS_ID));
    expect(VERIFY_QUERIES[2]?.sql).toContain(String(SEED_CONTAINER_ID));
  });

  it("parses the wrangler --json envelope (array and bare shapes)", () => {
    const envelope = JSON.stringify([{ results: [{ n: 1 }] }]);
    expect(parseWranglerRows(envelope)).toEqual([{ n: 1 }]);
    expect(parseWranglerRows(JSON.stringify({ results: [{ n: 0 }] }))).toEqual([{ n: 0 }]);
  });

  it("rejects non-JSON and unexpected shapes loudly", () => {
    expect(() => parseWranglerRows("not json")).toThrow(`${CHECK_NAME}: wrangler output is not JSON`);
    expect(() => parseWranglerRows(JSON.stringify({ ok: true }))).toThrow(
      `${CHECK_NAME}: unexpected wrangler JSON shape`,
    );
  });

  it("summarizes counts only, never row contents", () => {
    const report = formatSeedReport({
      customer_snapshot: 1,
      address_snapshot: 1,
      container_snapshot: 1,
    });
    expect(report).toContain("db:seed: PASS");
    expect(report).toContain("customer_snapshot=1");
    expect(report).toContain("re-running is a no-op UPSERT");
  });
});
