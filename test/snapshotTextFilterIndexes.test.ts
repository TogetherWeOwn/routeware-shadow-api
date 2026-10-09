import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import m1 from "../migrations/d1/0001_customer_snapshot.sql?raw";
import m2 from "../migrations/d1/0002_address_container.sql?raw";
import m3 from "../migrations/d1/0003_text_filter_indexes.sql?raw";

/**
 * TOG-5830: the container/address free-text list filters (`q` over
 * `location_address`/`serial_number` and over `address`) had no supporting
 * index — only zip/customer/company/enabled were indexed (0001/0002).
 *
 * What this file proves, against the REAL D1 in the workerd pool (not a
 * fake): applying the committed migration files verbatim, seeding rows, and
 * running the exact WHERE shapes from `src/routes/*Snapshot.ts` through
 * `EXPLAIN QUERY PLAN` before and after 0003.
 *
 * Measured result, pinned here against pool D1:
 * - `enabled + q` SELECT and COUNT go from SCAN to SEARCH on the `enabled`
 *   prefix of the new composite indexes (whether the planner reports the
 *   COUNT as COVERING varies with row count — only SEARCH is asserted).
 * - `enabled`-alone goes from SCAN to SEARCH too.
 * - `q`-alone (`enabled=any`, no predicate) still SCANs. That is not a gap
 *   in the migration: no B-tree can serve a mid-string `instr()` substring
 *   match. The "documents the substring boundary" test pins this so a later
 *   reader does not "fix" it with an index that changes nothing.
 *
 * Two pool-D1 limitations shape the helper, not the migration:
 * - `db.exec()` accepts only single-line statements ("incomplete input" on
 *   multi-line DDL), so `applyMigration` runs each `;`-separated statement
 *   through `prepare().run()`, which handles multi-line fine. `wrangler d1
 *   migrations apply` splits statements itself, so the committed files stay
 *   multi-line like 0001/0002.
 * - `console.log` is swallowed in the pool, so every observation is an
 *   assertion, not a log line.
 *
 * TOG-7383 extension: the same file now also audits the shapes 0003 did NOT
 * touch — the customer list/filter queries (served by 0001's
 * `idx_customer_snapshot_enabled`, so 0003 is a no-op for them) and the
 * container `customerId` join composed with `enabled + q`. Verdict: no
 * missing-index gaps; no migration 0004 needed. The full 23-shape EXPLAIN
 * matrix (before/after, all three tables) was run under `node:sqlite`
 * (SQLite 3.53.4, same engine family as D1) and its per-shape plan lines are
 * quoted in `docs/TEST-INVARIANTS.md` § "migration 0003".
 */

const db = () => (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;

/** Split a committed migration file into runnable statements. */
function splitStatements(sql: string): string[] {
  // Strip full-line `--` comments BEFORE splitting: a header comment may
  // contain `;` (e.g. "`enabled=true` / `enabled=false`; ..."), which would
  // otherwise split mid-comment into a garbage "statement".
  const uncommented = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return uncommented
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyMigration(sql: string): Promise<void> {
  const stmts = splitStatements(sql);
  expect(stmts.length).toBeGreaterThan(0);
  for (const stmt of stmts) {
    await db().prepare(stmt).bind().run();
  }
}

async function explain(sql: string, ...binds: unknown[]): Promise<string[]> {
  const r = await db()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...binds)
    .all<{ detail: string }>();
  return (r.results ?? []).map((x) => x.detail);
}

/** Full-column SELECTs copied from the route handlers (not simplified). */
const ADDR_SELECT =
  "SELECT pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments, " +
  "extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at FROM address_snapshot";
const CUST_SELECT =
  "SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name, " +
  "name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at FROM customer_snapshot";
const ADDR_Q = "instr(lower(coalesce(address, '')), lower(?)) > 0";
const CUST_Q = "instr(lower(coalesce(company_name, '')), lower(?)) > 0";
const CONT_Q =
  "(instr(lower(coalesce(c.location_address, '')), lower(?)) > 0 OR instr(lower(coalesce(c.serial_number, '')), lower(?)) > 0)";
// TOG-7383: same join shape as src/routes/containerSnapshot.ts `customerId` filter.
const CONT_JOIN = "INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id";

const plans: Record<string, string[]> = {};

beforeAll(async () => {
  // 0001 + 0002 only: capture the BEFORE plans, then apply 0003.
  await applyMigration(m1);
  await applyMigration(m2);
  await db().exec(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (1, 'Acme', 1, 't'), (2, 'Other', 1, 't')"
  );
  await db().exec(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, zip, enabled, synced_at) VALUES " +
      "(1, 1, '123 Main St', '76541', 1, 't'), (2, 1, '456 Oak Ave', '76542', 1, 't'), (3, 2, '789 Main Blvd', '78701', 0, 't')"
  );
  await db().exec(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, location_address, enabled, synced_at) VALUES " +
      "(1, 1, 'SN-001', '123 Main St', 1, 't'), (2, 2, 'BIN-002', '456 Oak Ave', 1, 't'), (3, 3, 'SN-003-MAIN', '789 Main Blvd', 0, 't')"
  );

  plans.addrEnabledQBefore = await explain(
    `${ADDR_SELECT} WHERE enabled = 1 AND ${ADDR_Q} ORDER BY pickup_address_id LIMIT ? OFFSET ?`,
    "main",
    50,
    0
  );
  plans.addrCountEnabledQBefore = await explain(
    `SELECT COUNT(*) as n FROM address_snapshot WHERE enabled = 1 AND ${ADDR_Q}`,
    "main"
  );
  plans.addrQAloneBefore = await explain(
    `${ADDR_SELECT} WHERE ${ADDR_Q} ORDER BY pickup_address_id LIMIT ? OFFSET ?`,
    "main",
    50,
    0
  );
  plans.contEnabledQBefore = await explain(
    `SELECT c.container_id FROM container_snapshot c WHERE c.enabled = 1 AND ${CONT_Q} ORDER BY c.container_id LIMIT ? OFFSET ?`,
    "main",
    "main",
    50,
    0
  );
  plans.contCountEnabledQBefore = await explain(
    `SELECT COUNT(*) as n FROM container_snapshot c WHERE c.enabled = 1 AND ${CONT_Q}`,
    "main",
    "main"
  );
  // TOG-7383: customer shapes use 0001's idx_customer_snapshot_enabled, so
  // capture them BEFORE 0003 to prove 0003 is a no-op for that table.
  plans.custEnabledQBefore = await explain(
    `${CUST_SELECT} WHERE 1 = 1 AND ${CUST_Q} AND enabled = 1 ORDER BY customer_id LIMIT ? OFFSET ?`,
    "acme",
    50,
    0
  );
  plans.custCountEnabledQBefore = await explain(
    `SELECT COUNT(*) as n FROM customer_snapshot WHERE 1 = 1 AND ${CUST_Q} AND enabled = 1`,
    "acme"
  );

  await applyMigration(m3);

  plans.addrEnabledQAfter = await explain(
    `${ADDR_SELECT} WHERE enabled = 1 AND ${ADDR_Q} ORDER BY pickup_address_id LIMIT ? OFFSET ?`,
    "main",
    50,
    0
  );
  plans.addrCountEnabledQAfter = await explain(
    `SELECT COUNT(*) as n FROM address_snapshot WHERE enabled = 1 AND ${ADDR_Q}`,
    "main"
  );
  plans.addrQAloneAfter = await explain(
    `${ADDR_SELECT} WHERE ${ADDR_Q} ORDER BY pickup_address_id LIMIT ? OFFSET ?`,
    "main",
    50,
    0
  );
  plans.addrEnabledAloneAfter = await explain(
    `${ADDR_SELECT} WHERE enabled = 0 ORDER BY pickup_address_id LIMIT ? OFFSET ?`,
    50,
    0
  );
  plans.contEnabledQAfter = await explain(
    `SELECT c.container_id FROM container_snapshot c WHERE c.enabled = 1 AND ${CONT_Q} ORDER BY c.container_id LIMIT ? OFFSET ?`,
    "main",
    "main",
    50,
    0
  );
  plans.contCountEnabledQAfter = await explain(
    `SELECT COUNT(*) as n FROM container_snapshot c WHERE c.enabled = 1 AND ${CONT_Q}`,
    "main",
    "main"
  );
  plans.contQAloneAfter = await explain(
    `SELECT c.container_id FROM container_snapshot c WHERE ${CONT_Q} ORDER BY c.container_id LIMIT ? OFFSET ?`,
    "main",
    "main",
    50,
    0
  );
  // TOG-7383: prove 0003 changes nothing for the customer table (0001's
  // enabled index already serves its shapes), record the customer q-alone
  // boundary, and pin the container customerId-join + enabled + q plan.
  plans.custEnabledQAfter = await explain(
    `${CUST_SELECT} WHERE 1 = 1 AND ${CUST_Q} AND enabled = 1 ORDER BY customer_id LIMIT ? OFFSET ?`,
    "acme",
    50,
    0
  );
  plans.custCountEnabledQAfter = await explain(
    `SELECT COUNT(*) as n FROM customer_snapshot WHERE 1 = 1 AND ${CUST_Q} AND enabled = 1`,
    "acme"
  );
  plans.custQAloneAfter = await explain(
    `${CUST_SELECT} WHERE 1 = 1 AND ${CUST_Q} ORDER BY customer_id LIMIT ? OFFSET ?`,
    "acme",
    50,
    0
  );
  plans.contJoinEnabledQAfter = await explain(
    `SELECT c.container_id FROM container_snapshot c ${CONT_JOIN} ` +
      `WHERE 1 = 1 AND a.customer_id = ? AND c.enabled = 1 AND ${CONT_Q} ORDER BY c.container_id LIMIT ? OFFSET ?`,
    1,
    "main",
    "main",
    50,
    0
  );
  // R2-32: verify the newer ID filters still drive the composed q + enabled shapes.
  plans.addrCustomerQEnabledAfter = await explain(
    `${ADDR_SELECT} WHERE 1 = 1 AND customer_id = ? AND ${ADDR_Q} AND enabled = 1 ORDER BY pickup_address_id LIMIT ? OFFSET ?`,
    1,
    "main",
    50,
    0
  );
  plans.addrCountCustomerQEnabledAfter = await explain(
    `SELECT COUNT(*) as n FROM address_snapshot WHERE 1 = 1 AND customer_id = ? AND ${ADDR_Q} AND enabled = 1`,
    1,
    "main"
  );
  plans.addrPickupQEnabledAfter = await explain(
    `${ADDR_SELECT} WHERE 1 = 1 AND pickup_address_id = ? AND ${ADDR_Q} AND enabled = 1 ORDER BY pickup_address_id LIMIT ? OFFSET ?`,
    1,
    "main",
    50,
    0
  );
  plans.addrCountPickupQEnabledAfter = await explain(
    `SELECT COUNT(*) as n FROM address_snapshot WHERE 1 = 1 AND pickup_address_id = ? AND ${ADDR_Q} AND enabled = 1`,
    1,
    "main"
  );
  plans.contPickupQEnabledAfter = await explain(
    `SELECT c.container_id FROM container_snapshot c WHERE 1 = 1 AND c.pickup_address_id = ? AND ${CONT_Q} AND c.enabled = 1 ORDER BY c.container_id LIMIT ? OFFSET ?`,
    1,
    "main",
    "main",
    50,
    0
  );
  plans.contCountPickupQEnabledAfter = await explain(
    `SELECT COUNT(*) as n FROM container_snapshot c WHERE 1 = 1 AND c.pickup_address_id = ? AND ${CONT_Q} AND c.enabled = 1`,
    1,
    "main",
    "main"
  );
  plans.contIdQEnabledAfter = await explain(
    `SELECT c.container_id FROM container_snapshot c WHERE 1 = 1 AND c.container_id = ? AND ${CONT_Q} AND c.enabled = 1 ORDER BY c.container_id LIMIT ? OFFSET ?`,
    1,
    "main",
    "main",
    50,
    0
  );
  plans.contCountIdQEnabledAfter = await explain(
    `SELECT COUNT(*) as n FROM container_snapshot c WHERE 1 = 1 AND c.container_id = ? AND ${CONT_Q} AND c.enabled = 1`,
    1,
    "main",
    "main"
  );
  // R2-32: customer customerId + q + enabled uses the primary key.
  plans.custIdQEnabledAfter = await explain(
    `${CUST_SELECT} WHERE 1 = 1 AND customer_id = ? AND ${CUST_Q} AND enabled = 1 ORDER BY customer_id LIMIT ? OFFSET ?`,
    1,
    "acme",
    50,
    0
  );
  plans.custCountIdQEnabledAfter = await explain(
    `SELECT COUNT(*) as n FROM customer_snapshot WHERE 1 = 1 AND customer_id = ? AND ${CUST_Q} AND enabled = 1`,
    1,
    "acme"
  );
});

describe("migration 0003 artifact", () => {
  it("declares exactly three composite (enabled, lower(...)) indexes", () => {
    const stmts = splitStatements(m3);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("idx_address_snapshot_enabled_address_lower");
    expect(stmts[1]).toContain("idx_container_snapshot_enabled_location_lower");
    expect(stmts[2]).toContain("idx_container_snapshot_enabled_serial_lower");
    for (const s of stmts) {
      expect(s).toMatch(/^CREATE INDEX \S+ ON \S+ \(enabled, lower\(coalesce\(/);
    }
  });

  it("registers all three indexes in sqlite_master after apply", async () => {
    const r = await db()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx\\_%' ESCAPE '\\'")
      .bind()
      .all<{ name: string }>();
    const names = (r.results ?? []).map((x) => x.name);
    expect(names).toContain("idx_address_snapshot_enabled_address_lower");
    expect(names).toContain("idx_container_snapshot_enabled_location_lower");
    expect(names).toContain("idx_container_snapshot_enabled_serial_lower");
  });
});

describe("address text filter (q over address)", () => {
  it("scans before 0003 for enabled + q", () => {
    expect(plans.addrEnabledQBefore.join(" ")).toContain("SCAN");
    expect(plans.addrCountEnabledQBefore.join(" ")).toContain("SCAN");
  });

  it("seeks the new composite index after 0003 for enabled + q", () => {
    expect(plans.addrEnabledQAfter.join(" ")).toContain(
      "SEARCH address_snapshot USING INDEX idx_address_snapshot_enabled_address_lower (enabled=?)"
    );
    // SELECT pins COVERING vs not above; for the COUNT only SEARCH on the new
    // index is pinned — whether the planner reports COVERING varies with row
    // count, so asserting the flag would couple the test to seed size.
    const countPlan = plans.addrCountEnabledQAfter.join(" ");
    expect(countPlan).toContain("SEARCH address_snapshot USING");
    expect(countPlan).toContain("idx_address_snapshot_enabled_address_lower (enabled=?)");
  });

  it("seeks the new index for the enabled-alone shape too", () => {
    expect(plans.addrEnabledAloneAfter.join(" ")).toContain(
      "SEARCH address_snapshot USING INDEX idx_address_snapshot_enabled_address_lower (enabled=?)"
    );
  });

  it("still returns the right rows for enabled + q (filter proof)", async () => {
    const r = await db()
      .prepare(`${ADDR_SELECT} WHERE enabled = 1 AND ${ADDR_Q} ORDER BY pickup_address_id LIMIT ? OFFSET ?`)
      .bind("main", 50, 0)
      .all<{ pickup_address_id: number }>();
    expect((r.results ?? []).map((x) => x.pickup_address_id)).toEqual([1]);
  });

  it("still returns the right rows for q alone across enabled values", async () => {
    const r = await db()
      .prepare(`${ADDR_SELECT} WHERE ${ADDR_Q} ORDER BY pickup_address_id LIMIT ? OFFSET ?`)
      .bind("main", 50, 0)
      .all<{ pickup_address_id: number }>();
    expect((r.results ?? []).map((x) => x.pickup_address_id)).toEqual([1, 3]);
  });
});

describe("container text filter (q over location_address OR serial_number)", () => {
  it("scans before 0003 for enabled + q", () => {
    expect(plans.contEnabledQBefore.join(" ")).toContain("SCAN");
    expect(plans.contCountEnabledQBefore.join(" ")).toContain("SCAN");
  });

  it("seeks a new composite index after 0003 for enabled + q", () => {
    // The OR spans two indexed columns; the planner picks one prefix seek.
    // Pin SEARCH on enabled plus a 0003 index, not which of the two wins.
    const selectPlan = plans.contEnabledQAfter.join(" ");
    expect(selectPlan).toContain("SEARCH c USING INDEX");
    expect(selectPlan).toContain("(enabled=?)");
    expect(selectPlan).toMatch(/idx_container_snapshot_enabled_(serial|location)_lower/);
    expect(plans.contCountEnabledQAfter.join(" ")).toContain("SEARCH c USING INDEX");
  });

  it("matches on serial_number as well as location_address", async () => {
    const bySerial = await db()
      .prepare(
        `SELECT c.container_id FROM container_snapshot c WHERE c.enabled = 1 AND ${CONT_Q} ORDER BY c.container_id LIMIT ? OFFSET ?`
      )
      .bind("bin-002", "bin-002", 50, 0)
      .all<{ container_id: number }>();
    expect((bySerial.results ?? []).map((x) => x.container_id)).toEqual([2]);
    const byLocation = await db()
      .prepare(
        `SELECT c.container_id FROM container_snapshot c WHERE c.enabled = 1 AND ${CONT_Q} ORDER BY c.container_id LIMIT ? OFFSET ?`
      )
      .bind("oak", "oak", 50, 0)
      .all<{ container_id: number }>();
    expect((byLocation.results ?? []).map((x) => x.container_id)).toEqual([2]);
  });

  it("keeps the customerId join working with q (join + enabled + q)", async () => {
    const r = await db()
      .prepare(
        `SELECT c.container_id FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id ` +
          `WHERE a.customer_id = ? AND c.enabled = 1 AND ${CONT_Q} ORDER BY c.container_id LIMIT ? OFFSET ?`
      )
      .bind(1, "main", "main", 50, 0)
      .all<{ container_id: number }>();
    expect((r.results ?? []).map((x) => x.container_id)).toEqual([1]);
  });
});

describe("customer text filter (q over company_name) — TOG-7383", () => {
  it("already seeks 0001's enabled index before 0003", () => {
    expect(plans.custEnabledQBefore.join(" ")).toContain(
      "SEARCH customer_snapshot USING INDEX idx_customer_snapshot_enabled (enabled=?)"
    );
    expect(plans.custCountEnabledQBefore.join(" ")).toContain(
      "SEARCH customer_snapshot USING INDEX idx_customer_snapshot_enabled (enabled=?)"
    );
  });

  it("0003 is a no-op for the customer table (no 0003 index involved)", () => {
    expect(plans.custEnabledQAfter).toEqual(plans.custEnabledQBefore);
    expect(plans.custCountEnabledQAfter).toEqual(plans.custCountEnabledQBefore);
    expect(plans.custEnabledQAfter.join(" ")).not.toContain("0003");
  });

  it("q-alone still scans — same instr() substring boundary as address/container", () => {
    expect(plans.custQAloneAfter.join(" ")).toContain("SCAN");
    expect(plans.custQAloneAfter.join(" ")).not.toContain("SEARCH");
  });

  it("still returns the right rows for enabled + q (filter proof)", async () => {
    const r = await db()
      .prepare(`${CUST_SELECT} WHERE 1 = 1 AND ${CUST_Q} AND enabled = 1 ORDER BY customer_id LIMIT ? OFFSET ?`)
      .bind("acme", 50, 0)
      .all<{ customer_id: number }>();
    expect((r.results ?? []).map((x) => x.customer_id)).toEqual([1]);
  });
});

describe("container customerId join + enabled + q — TOG-7383", () => {
  it("seeks indexes after 0003 (enabled-prefix composite on c, customer_id on a)", () => {
    const plan = plans.contJoinEnabledQAfter.join(" ");
    expect(plan).toContain("SEARCH");
    expect(plan).toMatch(/idx_container_snapshot_enabled_(serial|location)_lower/);
    expect(plan).toContain("idx_address_snapshot_customer_id");
  });

  it("still returns the right rows for join + enabled + q (filter proof)", async () => {
    const r = await db()
      .prepare(
        `SELECT c.container_id FROM container_snapshot c ${CONT_JOIN} ` +
          `WHERE 1 = 1 AND a.customer_id = ? AND c.enabled = 1 AND ${CONT_Q} ORDER BY c.container_id LIMIT ? OFFSET ?`
      )
      .bind(1, "main", "main", 50, 0)
      .all<{ container_id: number }>();
    expect((r.results ?? []).map((x) => x.container_id)).toEqual([1]);
  });
});

describe("newly composed identifier + text filters — R2-32", () => {
  it("uses the customer primary key for customerId + q + enabled", () => {
    expect(plans.custIdQEnabledAfter.join(" ")).toContain(
      "SEARCH customer_snapshot USING INTEGER PRIMARY KEY (rowid=?)"
    );
    expect(plans.custCountIdQEnabledAfter.join(" ")).toContain(
      "SEARCH customer_snapshot USING INTEGER PRIMARY KEY (rowid=?)"
    );
  });

  it("uses the existing address customer_id index for q + enabled", () => {
    expect(plans.addrCustomerQEnabledAfter.join(" ")).toContain(
      "SEARCH address_snapshot USING INDEX idx_address_snapshot_customer_id (customer_id=?)"
    );
    expect(plans.addrCountCustomerQEnabledAfter.join(" ")).toContain(
      "SEARCH address_snapshot USING INDEX idx_address_snapshot_customer_id (customer_id=?)"
    );
  });

  it("uses the address primary key for pickupAddressId + q + enabled", () => {
    expect(plans.addrPickupQEnabledAfter.join(" ")).toContain(
      "SEARCH address_snapshot USING INTEGER PRIMARY KEY (rowid=?)"
    );
    expect(plans.addrCountPickupQEnabledAfter.join(" ")).toContain(
      "SEARCH address_snapshot USING INTEGER PRIMARY KEY (rowid=?)"
    );
  });

  it("uses the existing container pickupAddressId index for q + enabled", () => {
    expect(plans.contPickupQEnabledAfter.join(" ")).toContain(
      "SEARCH c USING INDEX idx_container_snapshot_pickup_address_id (pickup_address_id=?)"
    );
    expect(plans.contCountPickupQEnabledAfter.join(" ")).toContain(
      "SEARCH c USING INDEX idx_container_snapshot_pickup_address_id (pickup_address_id=?)"
    );
  });

  it("uses the container primary key for containerId + q + enabled", () => {
    expect(plans.contIdQEnabledAfter.join(" ")).toContain(
      "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"
    );
    expect(plans.contCountIdQEnabledAfter.join(" ")).toContain(
      "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"
    );
  });
});

describe("substring boundary (documents what indexes cannot do)", () => {
  it("q-alone still scans after 0003 — no B-tree serves instr() substring", () => {
    // enabled=any adds no predicate, so there is no equality prefix to seek.
    // A "fix" that adds a bare expression index changes this to
    // "SCAN ... USING COVERING INDEX", never SEARCH.
    expect(plans.addrQAloneBefore.join(" ")).toContain("SCAN");
    expect(plans.addrQAloneAfter.join(" ")).toContain("SCAN");
    expect(plans.addrQAloneAfter.join(" ")).not.toContain("SEARCH");
    expect(plans.contQAloneAfter.join(" ")).toContain("SCAN");
    expect(plans.contQAloneAfter.join(" ")).not.toContain("SEARCH");
  });
});
