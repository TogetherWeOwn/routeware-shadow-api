import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  buildMigrations,
  ensureD1TestTables,
  MIGRATION_NAMES,
  splitMigrationSql,
} from "./d1TestMigrations";

/**
 * Test-migration parity guard.
 *
 * Before this, `test/d1TestMigrations.ts` hard-imported exactly two migration
 * files and split them by stripping `--` lines and splitting on `;`. That is
 * a schema-drift trap in both directions: a new `migrations/d1/0003_*.sql`
 * would never reach the test database (E2E green on a stale schema while
 * prod D1 — which applies every file in the dir — breaks), and a `;` or
 * `--` inside a string literal or trigger body would corrupt the split.
 *
 * What this pins:
 *
 * 1. Auto-discovery — `buildMigrations` takes whatever files it is given, so
 *    a `0003_*` fixture is picked up and ordered after `0002_*` with no code
 *    change; `MIGRATION_NAMES` proves the real glob discovers every file
 *    (0001..N, no gaps) and 0003 actually lands in the test database.
 * 2. Prod-equivalent splitting — the splitter is a port of wrangler's
 *    `src/d1/splitter.ts` (the same splitter `wrangler d1 migrations apply`
 *    uses), so literals, comments and `BEGIN … END` trigger bodies split
 *    exactly like prod.
 *
 * Fixtures are synthetic DDL only — no customer PII (CONVENTIONS.md § 5).
 */

describe("buildMigrations (auto-discovery)", () => {
  it("picks up a 0003 fixture and orders by migration number", () => {
    // Arrange: deliberately unsorted, with a third migration the old
    // hard-coded list would have ignored.
    const files = {
      "0002_address_container.sql": "CREATE TABLE b (id INTEGER);",
      "0003_add_note.sql":
        "ALTER TABLE customer_snapshot ADD COLUMN note TEXT;",
      "0001_customer_snapshot.sql": "CREATE TABLE a (id INTEGER);",
    };

    // Act
    const migrations = buildMigrations(files);

    // Assert
    expect(migrations.map((m) => m.name)).toEqual([
      "0001_customer_snapshot.sql",
      "0002_address_container.sql",
      "0003_add_note.sql",
    ]);
    // Single-statement files keep prod's trailing `;` verbatim (wrangler's
    // splitter returns `[trimmedSql]` when there is only one statement).
    expect(migrations[2]?.queries).toEqual([
      "ALTER TABLE customer_snapshot ADD COLUMN note TEXT;",
    ]);
  });

  it("discovers every real migration file on disk, contiguously numbered", () => {
    // Assert: the build-time glob resolves every file. Numbering must run
    // 0001..N with no gap, so an empty, mis-pointed or partial glob surfaces
    // here instead of silently migrating a stale schema. Deliberately not a
    // hard-coded name list: adding 0004 must not require editing this test.
    const numbers = MIGRATION_NAMES.map((name) =>
      parseInt(name.split("_")[0] ?? "", 10),
    );
    expect(numbers.length).toBeGreaterThanOrEqual(3);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(MIGRATION_NAMES).toContain("0003_text_filter_indexes.sql");
  });

  it("applies 0003 to the test database (the file the old helper skipped)", async () => {
    // Act
    await ensureD1TestTables();
    const db = (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
    const row = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .bind("idx_address_snapshot_enabled_address_lower")
      .first<{ name: string }>();

    // Assert: before only 0001/0002 were hard-imported, so this
    // index existed in prod D1 but never in the test schema.
    expect(row?.name).toBe("idx_address_snapshot_enabled_address_lower");
  });
});

describe("splitMigrationSql (prod parity)", () => {
  it("keeps semicolons inside string literals in one statement", () => {
    // Arrange / Act
    const queries = splitMigrationSql(
      "INSERT INTO t (note) VALUES ('a;b');\nCREATE TABLE u (id INTEGER);",
    );

    // Assert: the old naive split produced three chunks here.
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe("INSERT INTO t (note) VALUES ('a;b')");
    expect(queries[1]).toBe("CREATE TABLE u (id INTEGER)");
  });

  it("keeps double-dash inside string literals, strips real comments", () => {
    // Arrange / Act
    const queries = splitMigrationSql(
      "-- leading comment\n" +
        "INSERT INTO t (note) VALUES ('a -- not a comment'); -- trailing comment\n" +
        "/* block comment; with semicolon */\n" +
        "CREATE TABLE u (id INTEGER);",
    );

    // Assert
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe(
      "INSERT INTO t (note) VALUES ('a -- not a comment')",
    );
    expect(queries[1]).toBe("CREATE TABLE u (id INTEGER)");
  });

  it("keeps a trigger body with inner semicolons in one statement", () => {
    // Arrange / Act
    const queries = splitMigrationSql(
      "CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE u SET n = 1; END;\n" +
        "CREATE TABLE v (id INTEGER);",
    );

    // Assert: the old split cut the trigger into two invalid chunks.
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe(
      "CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE u SET n = 1; END",
    );
    expect(queries[1]).toBe("CREATE TABLE v (id INTEGER)");
  });

  it("keeps semicolons inside quoted identifiers", () => {
    // Arrange / Act
    const queries = splitMigrationSql(
      'CREATE TABLE "we;ird" (id INTEGER);\nCREATE TABLE `also;odd` (id INTEGER);',
    );

    // Assert
    expect(queries).toHaveLength(2);
  });

  it("splits plain multi-statement files like before", () => {
    // Arrange / Act
    const queries = splitMigrationSql(
      "CREATE TABLE a (id INTEGER);\n\nCREATE INDEX idx_a ON a (id);\n",
    );

    // Assert
    expect(queries).toEqual([
      "CREATE TABLE a (id INTEGER)",
      "CREATE INDEX idx_a ON a (id)",
    ]);
  });
});
