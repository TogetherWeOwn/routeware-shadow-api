import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import sql1 from "../migrations/d1/0001_customer_snapshot.sql?raw";
import sql2 from "../migrations/d1/0002_address_container.sql?raw";

import type { D1Migration } from "cloudflare:test";

/**
 * Applies the D1 schema migrations to the test `CUSTOMER_DB` binding.
 *
 * `wrangler.toml` declares `migrations_dir` but neither Wrangler dev nor the
 * Vitest pool applies those migrations automatically — without this, the test
 * database has no tables and no route test can drive a snapshot sync to a 200
 * (see docs/TEST-INVARIANTS.md § "The coverage ratchet").
 *
 * Idempotent: `applyD1Migrations` records applied names in `d1_migrations` and
 * skips them on later runs, so this is safe to call once per test file (or
 * from a `setupFiles` entry that runs before every file).
 *
 * The migration SQL files carry `--` comment lines that Miniflare's `db.exec`
 * rejects ("SQL code did not contain a statement"), so each file is split into
 * per-statement queries first — the same splitting `readD1Migrations` performs
 * on the Node side of the pool.
 */
function toMigration(name: string, sql: string): D1Migration {
  const queries = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
  return { name, queries };
}

const MIGRATIONS: D1Migration[] = [
  toMigration("0001_customer_snapshot.sql", sql1),
  toMigration("0002_address_container.sql", sql2)
];

export async function ensureD1TestTables(
  db: D1Database = (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB
): Promise<void> {
  await applyD1Migrations(db, MIGRATIONS);
}
