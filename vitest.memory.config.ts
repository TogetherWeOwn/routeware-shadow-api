import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/snapshotExportMemory.test.ts"],
    environment: "node",
    pool: "threads",
    testTimeout: 60_000
  }
});
