import { defineConfig } from "vitest/config";

// Test-only harness for the RED branch handoff. The Builder must also route
// dbSeedCliContract.acceptance.test.ts to the existing root Node project (and
// exclude it from workerd) before the final combined PR's `npm test` gate.
export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 1,
    testTimeout: 30_000,
    include: ["test/dbSeedCliContract.acceptance.test.ts", "test/dbSeed.test.ts"],
  },
});
