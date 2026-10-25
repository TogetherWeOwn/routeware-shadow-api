import { defineConfig } from "vitest/config";

// The oracle executes the real routeExamples test callbacks in Node. The
// Builder must add this file to the root Node project and exclude it from
// workerd before landing the combined PR; the oracle itself stays immutable.
export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 1,
    include: ["test/routeExamplesParameters.acceptance.test.ts"],
  },
});
