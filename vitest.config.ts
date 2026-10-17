import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import os from "node:os";
import { defineConfig } from "vitest/config";
import { unstable_readConfig } from "wrangler";

/**
 * Test bindings from wrangler.toml `[env.test.vars]`, read by
 * wrangler itself so the toml stays the single source of truth: adding or
 * editing a key there flows into the test env exactly as wrangler parses it
 * (trailing header comments, booleans, arrays, escapes, bare numbers such as
 * `SESSION_TTL_SECONDS` = 1800), and a local `.dev.vars` can never override
 * a test binding. A hand-rolled TOML subset parser here silently dropped
 * every pin on valid input it did not understand (e.g. a trailing comment
 * on the section header), which let `.dev.vars` win again with no error.
 */
const testVars =
  unstable_readConfig({
    config: fileURLToPath(new URL("./wrangler.toml", import.meta.url)),
    env: "test"
  }).vars ?? {};

// Fail loudly instead of running with no pins: empty bindings would let a
// local `.dev.vars` override the test env again, invisibly on CI (which has
// no `.dev.vars`). Miniflare `bindings` win over Wrangler's local
// `.dev.vars` secrets, which otherwise override `[env.test.vars]` in the
// workers test pool.
if (Object.keys(testVars).length === 0) {
  throw new Error(
    "vitest.config: wrangler read no [env.test.vars] bindings from wrangler.toml; refusing to run with unpinned test bindings"
  );
}

/**
 * Well above the 5s default. Istanbul instrumentation adds ~65% to run time,
 * and the first test in a file absorbs module init for the whole graph
 * (the route modules total ~1,500 lines). That combination timed out the first
 * integration test on CI's slower runner while passing locally. The tests
 * themselves do millisecond-scale work; this covers warm-up, not slow logic.
 *
 * Timeouts live in `sharedTestOptions` because workspace projects do not
 * inherit root test options. The local worker default stays at the root so
 * Vitest CLI overrides take precedence for every project.
 */
const localMaxWorkers = Math.max(1, Math.floor(os.availableParallelism() / 2));
const sharedTestOptions = {
  testTimeout: 30_000,
  hookTimeout: 30_000,
  /**
   * Worker caps for CI and local runs. An unrestricted
   * `vitest run --coverage` spawns a worker per core per job; several CI jobs
   * share each self-hosted runner, and local workloads also compete for host
   * resources. Under istanbul instrumentation, oversubscribed workers stall
   * past the 30s timeout. Capping CI at 2 cleared prior CI timeouts without
   * changing tests or timeouts. Local runs cap at half the core count to leave
   * headroom; the same `authThrottle` test passes alone in ~3.6s but timed out
   * at 30s under the uncapped suite. GitHub Actions sets CI=true. Pinned by
   * `npm run check:ci-workflow`.
   */
  maxWorkers: process.env.CI ? 2 : undefined,
};

export default defineConfig({
  test: {
    maxWorkers: process.env.CI ? 2 : localMaxWorkers,
    /**
     * Two projects: the whole suite runs in workerd, except the
     * node-only tests, which run in the node forks pool instead: the R2
     * lifecycle proposal guard test reads the committed JSON file from disk
     * (`node:fs`) — stubbed out in the workers pool — and the deps-audit
     * wrapper test spawns `scripts/check-deps-audit.mjs` as a child process
     * (`node:child_process`), which workerd cannot do. Each project spreads
     * `sharedTestOptions` above; coverage below still applies to the merged
     * run.
     *
     * The workerd project pins `miniflare.bindings` from `testVars` above:
     * bindings win over Wrangler's local `.dev.vars` secrets,
     * so a local `.dev.vars` can never override a test binding. The node-pool
     * project needs no bindings (it only reads a committed JSON file).
     */
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.toml", environment: "test" },
            miniflare: {
              bindings: testVars
            }
          })
        ],
        test: {
          ...sharedTestOptions,
          include: ["test/**/*.test.ts"],
          // snapshotExportMemory runs separately under vitest.memory.config.ts
          // (32 MiB heap ceiling with --expose-gc); it must stay out
          // of the default suite, alongside the node-pool R2 proposal guard
          // and the node-pool deps-audit wrapper test.
          exclude: [
            "test/r2LifecycleProposalCheck.test.ts",
            "test/checkDepsAudit.test.ts",
            "test/snapshotExportMemory.test.ts",
          ],
        },
      },
      {
        test: {
          ...sharedTestOptions,
          include: ["test/r2LifecycleProposalCheck.test.ts", "test/checkDepsAudit.test.ts"],
        },
      },
    ],
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
       * Branches recovered above the ECC 80% standard on 2026-09-27:
       * `test/d1TestMigrations.ts` applies the D1 migrations to the test
       * `CUSTOMER_DB`, and `test/snapshotSyncE2E.test.ts` drives the
       * login → download → parse → upsert path with assertions. See
       * docs/TEST-INVARIANTS.md § "The coverage ratchet".
       *
       * Re-measured hermetically 2026-09-28 at `2d61255`:
       * statements 90.98% (2160/2374), branches 88.27% (1416/1604),
       * functions 93.67% (311/332), lines 91.51% (2103/2298).
       * Ratcheted 2026-10-08 after a hermetic full run:
       * statements 94.70%, branches 90.59%, functions 96.46%, lines 95.20%.
       * Ratcheted 2026-10-09 after a hermetic full run:
       * statements 96.27%, branches 91.51%, functions 97.58%, lines 96.60%.
       * Ratcheted 2026-10-11 after a hermetic full run:
       * statements 97.29%, branches 92.54%, functions 98.21%, lines 97.69%.
       * (`browserAuth.ts` lines 81.57% -> 100%); branches did not move, so that
       * floor stays at 91.
       * Ratcheted 2026-10-12 after a hermetic full run:
       * statements 97.00% (3431/3537), branches 92.41% (2327/2518),
       * functions 98.01% (493/503), lines 97.42% (3324/3412).
       * Merged 2026-10-13: kept both entries; branches floor takes the max
       * (92) since both hermetic runs measured branches above it.
       * Ratcheted 2026-10-12 after a hermetic full run:
       * statements 97.26%, branches 93.91%, functions 98.01%, lines 97.69%.
       * Target-file branches: `upsert.ts` 98.27% (was 63.79%),
       * `csvAddressSnapshot.ts` / `csvContainerSnapshot.ts` /
       * `csvCustomerSnapshot.ts` 100% (were 58.33% / 58.33% / 71.42%).
       * Re-measured hermetically 2026-10-15 at `7450d46`:
       * statements 97.78% (3483/3562), branches 94.37% (2365/2506),
       * functions 98.65% (513/520), lines 98.07% (3369/3435).
       * Re-measured hermetically 2026-10-16 at `efa883b` after main merges
       * added code: statements 97.85% (3518/3595), branches 93.93%
       * (2418/2574), functions 98.65% (515/522), lines 98.15% (3403/3467).
       * Branches no longer clears 94, so that floor stays at 93 (never
       * lowered); lines still supports the raise to 98.
       * Re-measured hermetically 2026-10-17 at `88bf4c9`:
       * statements 97.89% (3532/3608), branches 94% (2429/2584),
       * functions 98.66% (516/523), lines 98.18% (3416/3479).
       * Branches clears 94 again, so that floor rises to 94.
       */
      thresholds: {
        statements: 97,
        branches: 94,
        functions: 98,
        lines: 98
      }
    }
  }
});
