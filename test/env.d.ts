declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

/**
 * Test-only surface of the `cloudflare:test` module (provided by
 * `@cloudflare/vitest-pool-workers` at runtime). Mirrors
 * `node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts`;
 * only the D1 migration helpers this suite uses are declared.
 */
declare module "cloudflare:test" {
  export interface D1Migration {
    name: string;
    queries: string[];
  }

  export function applyD1Migrations(
    db: D1Database,
    migrations: D1Migration[],
    migrationsTableName?: string
  ): Promise<void>;
}

/** Vite `?raw` text imports (D1 migration SQL). Bundled at transform time. */
declare module "*.sql?raw" {
  const content: string;
  export default content;
}

/** Vite raw-text imports (`import text from "../CHANGELOG.md?raw"`). */
declare module "*.md?raw" {
  const text: string;
  export default text;
}
