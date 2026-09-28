/**
 * Pure helpers for `npm run db:seed` (TOG-8882).
 *
 * The seed loads a minimal synthetic customer → address → container fixture
 * into the LOCAL D1 only (`wrangler d1 execute ... --local`). Everything here
 * is pure (data in, SQL/text out) so it is unit-testable without Wrangler,
 * Cloudflare credentials, or network access — the impure wrapper lives in
 * `scripts/db-seed.mjs`.
 *
 * Fixture rules (pinned by `test/dbSeed.test.ts`):
 * - Synthetic data only: `Seed*` names, the fictional 555-0100 phone range,
 *   zip 00000, a fixed `synced_at`. No emails, no real addresses, no PII
 *   (CONVENTIONS.md sections 4-5).
 * - 90000-range primary keys: far from the small real Routeware ids used in
 *   examples (42/10/100), so a seed never silently overwrites a real synced
 *   row even though the writes are UPSERTs.
 * - Idempotent UPSERTs (`ON CONFLICT(pk) DO UPDATE`), never
 *   `INSERT OR REPLACE`: REPLACE deletes the parent row first and the D1 FK
 *   chain (customer → address → container) refuses that while children exist.
 * - Statement order follows the FK chain: customers, then addresses, then
 *   containers — so a fresh `db:migrate:local` DB accepts the batch as-is.
 */

export const CHECK_NAME = "db:seed";

/** Same database the `db:migrate:*` npm scripts target (see wrangler.toml). */
export const DATABASE = "routeware-customer-snapshot";

/** Fixed stamp, not "now": re-runs converge to identical rows. */
export const SEED_SYNCED_AT = "2026-01-01T00:00:00.000Z";

export const SEED_CUSTOMER_ID = 90001;
export const SEED_PICKUP_ADDRESS_ID = 90010;
export const SEED_CONTAINER_ID = 90100;

/** Escape a string literal for inline SQL (fixture constants have no quotes; belt and braces). */
function lit(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const SEED_CUSTOMER_COLUMNS =
  "(customer_id, company_name, first_name, last_name, phone1, enabled, synced_at)";
const SEED_CUSTOMER_SET =
  "company_name=excluded.company_name, first_name=excluded.first_name, " +
  "last_name=excluded.last_name, phone1=excluded.phone1, " +
  "enabled=excluded.enabled, synced_at=excluded.synced_at";

const SEED_ADDRESS_COLUMNS =
  "(pickup_address_id, customer_id, address, city, state, zip, enabled, synced_at)";
const SEED_ADDRESS_SET =
  "customer_id=excluded.customer_id, address=excluded.address, city=excluded.city, " +
  "state=excluded.state, zip=excluded.zip, enabled=excluded.enabled, synced_at=excluded.synced_at";

const SEED_CONTAINER_COLUMNS =
  "(container_id, pickup_address_id, serial_number, location_address, city, state, zip, enabled, synced_at)";
const SEED_CONTAINER_SET =
  "pickup_address_id=excluded.pickup_address_id, serial_number=excluded.serial_number, " +
  "location_address=excluded.location_address, city=excluded.city, state=excluded.state, " +
  "zip=excluded.zip, enabled=excluded.enabled, synced_at=excluded.synced_at";

/**
 * The fixture writes in FK order. Each statement is a bare INSERT … ON
 * CONFLICT DO UPDATE (no trailing semicolon; the wrapper joins the batch).
 *
 * @returns {string[]} exactly three statements: customer, address, container.
 */
export function buildSeedStatements() {
  return [
    `INSERT INTO customer_snapshot ${SEED_CUSTOMER_COLUMNS} VALUES ` +
      `(${SEED_CUSTOMER_ID}, ${lit("Seed Demo Co")}, ${lit("Demo")}, ${lit("Seeder")}, ` +
      `${lit("555-0100")}, 1, ${lit(SEED_SYNCED_AT)}) ` +
      `ON CONFLICT(customer_id) DO UPDATE SET ${SEED_CUSTOMER_SET}`,
    `INSERT INTO address_snapshot ${SEED_ADDRESS_COLUMNS} VALUES ` +
      `(${SEED_PICKUP_ADDRESS_ID}, ${SEED_CUSTOMER_ID}, ${lit("1 Seed St")}, ${lit("Seedville")}, ` +
      `${lit("TX")}, ${lit("00000")}, 1, ${lit(SEED_SYNCED_AT)}) ` +
      `ON CONFLICT(pickup_address_id) DO UPDATE SET ${SEED_ADDRESS_SET}`,
    `INSERT INTO container_snapshot ${SEED_CONTAINER_COLUMNS} VALUES ` +
      `(${SEED_CONTAINER_ID}, ${SEED_PICKUP_ADDRESS_ID}, ${lit("SEED-SN-001")}, ${lit("1 Seed St")}, ` +
      `${lit("Seedville")}, ${lit("TX")}, ${lit("00000")}, 1, ${lit(SEED_SYNCED_AT)}) ` +
      `ON CONFLICT(container_id) DO UPDATE SET ${SEED_CONTAINER_SET}`,
  ];
}

/**
 * Post-seed verification: one COUNT per table pinned to the fixture PK, so a
 * half-applied batch (or a typo'd id) fails loudly instead of looking green.
 */
export const VERIFY_QUERIES = [
  {
    table: "customer_snapshot",
    sql: `SELECT COUNT(*) AS n FROM customer_snapshot WHERE customer_id = ${SEED_CUSTOMER_ID}`,
  },
  {
    table: "address_snapshot",
    sql: `SELECT COUNT(*) AS n FROM address_snapshot WHERE pickup_address_id = ${SEED_PICKUP_ADDRESS_ID}`,
  },
  {
    table: "container_snapshot",
    sql: `SELECT COUNT(*) AS n FROM container_snapshot WHERE container_id = ${SEED_CONTAINER_ID}`,
  },
];

/**
 * Flatten `wrangler d1 execute --json` stdout to its result rows. Accepts the
 * envelope wrangler prints (an array with `{ results }`, or a bare object).
 */
export function parseWranglerRows(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${CHECK_NAME}: wrangler output is not JSON`);
  }
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const batch of batches) {
    const results = batch?.results;
    if (!Array.isArray(results)) {
      throw new Error(`${CHECK_NAME}: unexpected wrangler JSON shape`);
    }
    rows.push(...results);
  }
  return rows;
}

/** One-line human summary for the run log. Counts only, never row contents. */
export function formatSeedReport(counts) {
  return (
    `${CHECK_NAME}: PASS — fixture present ` +
    `(customer_snapshot=${counts.customer_snapshot}, ` +
    `address_snapshot=${counts.address_snapshot}, ` +
    `container_snapshot=${counts.container_snapshot}); ` +
    `re-running is a no-op UPSERT`
  );
}
