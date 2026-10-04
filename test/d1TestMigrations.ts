import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

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
 * Parity guard (TOG-6551): migration files are **auto-discovered** with
 * `import.meta.glob`, never enumerated by hand — adding
 * `migrations/d1/0003_*.sql` picks it up with no code change. Before this,
 * the two files were hard-imported, so 0003 (already on main) shipped
 * with E2E green on a stale schema while prod D1 broke. Files are ordered by
 * numeric prefix, exactly like prod `readD1Migrations`.
 *
 * Splitting is a port of wrangler's `src/d1/splitter.ts` (plus `trimmer.ts`),
 * the same splitter `wrangler d1 migrations apply` uses in prod: it is aware
 * of string literals, quoted identifiers, dollar-quotes, line/block comments
 * and `BEGIN … END` compound statements (triggers). The previous
 * strip-`--`-lines-and-split-on-`;` broke on `;`/`--` inside literals and on
 * trigger bodies, and Miniflare's `db.exec` rejects comment-only chunks
 * ("SQL code did not contain a statement").
 */

/** Build-time auto-discovery: every `migrations/d1/*.sql`, contents as text. */
const MIGRATION_SQL = import.meta.glob<string>("../migrations/d1/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

function migrationName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Numeric-prefix order, mirroring prod `readD1Migrations`. */
function byMigrationNumber(a: string, b: string): number {
  return (
    parseInt(a.split("_")[0] ?? "", 10) - parseInt(b.split("_")[0] ?? "", 10)
  );
}

/**
 * Sort `files` (`name → sql`) by migration number and split each file into
 * its per-statement queries. Exported so tests can prove a `0003_*.sql`
 * fixture is picked up and ordered without touching this module.
 */
export function buildMigrations(files: Record<string, string>): D1Migration[] {
  return Object.keys(files)
    .sort(byMigrationNumber)
    .map((name) => ({ name, queries: splitMigrationSql(files[name] ?? "") }));
}

/**
 * Split one migration file into executable statements.
 * Port of wrangler `src/d1/splitter.ts` + `src/d1/trimmer.ts`.
 */
export function splitMigrationSql(sql: string): string[] {
  const trimmedSql = trimSqlQuery(sql);
  if (!mayContainMultipleStatements(trimmedSql)) {
    return [trimmedSql];
  }
  const split = splitSqlIntoStatements(trimmedSql);
  return split.length === 0 ? [trimmedSql] : split;
}

function trimSqlQuery(sql: string): string {
  if (!sql.includes("BEGIN TRANSACTION")) {
    return sql;
  }
  const trimmedSql = sql
    .replace("BEGIN TRANSACTION;", "")
    .replace("COMMIT;", "");
  if (trimmedSql.includes("BEGIN TRANSACTION")) {
    throw new Error(
      "Migration contains explicit transactions; D1 runs migrations in a transaction already.",
    );
  }
  return trimmedSql;
}

function mayContainMultipleStatements(sql: string): boolean {
  const trimmed = sql.trimEnd();
  const semiColonIndex = trimmed.indexOf(";");
  return semiColonIndex !== -1 && semiColonIndex !== trimmed.length - 1;
}

function splitSqlIntoStatements(sql: string): string[] {
  const statements: string[] = [];
  let str = "";
  const compoundStatementStack: Array<(s: string) => boolean> = [];
  const iterator = sql[Symbol.iterator]();
  let next = iterator.next();
  while (!next.done) {
    const char = next.value;
    if (compoundStatementStack[0]?.(str + char)) {
      compoundStatementStack.shift();
    }
    switch (char) {
      case `'`:
      case `"`:
      case "`":
        str += char + consumeUntilMarker(iterator, char);
        break;
      case `$`: {
        const dollarQuote =
          "$" + consumeWhile(iterator, isDollarQuoteIdentifier);
        str += dollarQuote;
        if (dollarQuote.endsWith("$")) {
          str += consumeUntilMarker(iterator, dollarQuote);
        }
        break;
      }
      case `-`:
        next = iterator.next();
        if (!next.done && next.value === "-") {
          consumeUntilMarker(iterator, "\n");
          str += "\n";
          break;
        } else {
          str += char;
          continue;
        }
      case `/`:
        next = iterator.next();
        if (!next.done && next.value === "*") {
          consumeUntilMarker(iterator, "*/");
          break;
        } else {
          str += char;
          continue;
        }
      case `;`:
        if (compoundStatementStack.length === 0) {
          statements.push(str);
          str = "";
        } else {
          str += char;
        }
        break;
      default:
        str += char;
        break;
    }
    if (isCompoundStatementStart(str)) {
      compoundStatementStack.unshift(isCompoundStatementEnd);
    }
    next = iterator.next();
  }
  statements.push(str);
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function consumeWhile(
  iterator: IterableIterator<string>,
  predicate: (s: string) => boolean,
): string {
  let next = iterator.next();
  let str = "";
  while (!next.done) {
    str += next.value;
    if (!predicate(str)) {
      break;
    }
    next = iterator.next();
  }
  return str;
}

function consumeUntilMarker(
  iterator: IterableIterator<string>,
  endMarker: string,
): string {
  return consumeWhile(iterator, (str) => !str.endsWith(endMarker));
}

function isDollarQuoteIdentifier(str: string): boolean {
  const lastChar = str.slice(-1);
  return (
    // The $ marks the end of the identifier
    lastChar !== "$" &&
    // we allow numbers, underscore and letters with diacritical marks
    (/[0-9_]/i.test(lastChar) ||
      lastChar.toLowerCase() !== lastChar.toUpperCase())
  );
}

function isCompoundStatementStart(str: string): boolean {
  return /\s(BEGIN|CASE)\s$/i.test(str);
}

function isCompoundStatementEnd(str: string): boolean {
  return /\sEND[;\s]$/.test(str);
}

const MIGRATIONS: D1Migration[] = buildMigrations(
  Object.fromEntries(
    Object.entries(MIGRATION_SQL).map(([path, sql]) => [
      migrationName(path),
      sql,
    ]),
  ),
);

/** Names of the discovered migration files, in apply order. Test-visible parity probe. */
export const MIGRATION_NAMES: string[] = MIGRATIONS.map((m) => m.name);

export async function ensureD1TestTables(
  db: D1Database = (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB,
): Promise<void> {
  await applyD1Migrations(db, MIGRATIONS);
}
