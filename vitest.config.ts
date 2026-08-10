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
       * Ratchet, not the target. The ECC standard is 80% (user-scope
       * ~/.claude/rules/ecc/common/engineering.md §1; per-file detail in
       * docs/TEST-INVARIANTS.md), and **all four metrics are now
       * past it**: ~90.6% statements, ~82.0% branches, ~93.4% functions, ~91.1%
       * lines. These floors are pinned just under current numbers so coverage
       * can never regress, and are still meant to be raised as the remaining
       * modules (r2SnapshotArchive, routewareQueryReportCsv) gain tests. Raise
       * them whenever a PR moves the number up.
       */
      thresholds: {
        statements: 90,
        branches: 81,
        functions: 93,
        lines: 91
      }
    }
  }
});
