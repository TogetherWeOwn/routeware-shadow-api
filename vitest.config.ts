import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml", environment: "test" }
    })
  ],
  test: {
    include: ["test/**/*.test.ts"],
    /**
     * Well above the 5s default. Istanbul instrumentation adds ~65% to run time,
     * and the first test in a file absorbs module init for the whole graph
     * (the route modules total ~1,500 lines). That combination timed out the first
     * integration test on CI's slower runner while passing locally. The tests
     * themselves do millisecond-scale work; this covers warm-up, not slow logic.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      // istanbul, not the v8 default: workerd does not expose the V8 coverage
      // APIs the v8 provider relies on.
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "json-summary"],
      /**
       * Ratchet, not the target. Floors sit just under the current measurement so
       * coverage can never regress; raise them whenever a PR moves the number up.
       *
       * **Re-baselined 2026-08-22, downward, once — read this before assuming a
       * regression.** The previous floors (90/81/93/91) were pinned against a run
       * in which `test/snapshotAuth.test.ts` "lets the sync secret past the inner
       * check" left `fetch` unstubbed, so that one request ran the real login and
       * report-download path against the **live** Routeware host. It counted the
       * lines it touched as covered while asserting nothing about them, and by
       * 2026-08-22 it no longer completed at all: the request hung to the 30s
       * timeout, the suite failed, and `--coverage` produced no report. Stubbing
       * it (the fix that accompanies this change) removed that incidental,
       * unasserted execution. **No source line lost a real test** — the numbers
       * below are the first hermetic measurement of coverage that was always
       * this high in truth.
       *
       * Branches recovered above the ECC 80% standard on 2026-09-27 (TOG-5484):
       * `test/d1TestMigrations.ts` applies the D1 migrations to the test
       * `CUSTOMER_DB`, and `test/snapshotSyncE2E.test.ts` drives the
       * login → download → parse → upsert path with assertions. See
       * docs/TEST-INVARIANTS.md § "The coverage ratchet".
       */
      thresholds: {
        statements: 89,
        branches: 83,
        functions: 92,
        lines: 89
      }
    }
  }
});
