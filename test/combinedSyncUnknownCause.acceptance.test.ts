import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { PartialDataSnapshotSyncError } from "../src/lib/snapshot/orchestration";

const behavior: { error: Error | null } = { error: null };

// Keep the real error class and app mapping; only inject the chained failure.
// A plain async function avoids rejected vi.fn() results in the workers pool.
vi.mock("../src/lib/d1SnapshotSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/d1SnapshotSync")>()),
  runDataSnapshotSyncChainedHttp: async () => {
    throw behavior.error;
  }
}));

const { default: app } = await import("../src/app");

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

const genericFailure =
  '{"type":"https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#internal"' +
  ',"title":"Internal Server Error","status":500' +
  ',"detail":"An unexpected error occurred. See Worker logs for details. See docs/PROBLEMS.md#internal."}';

afterEach(() => {
  behavior.error = null;
  vi.restoreAllMocks();
});

it("keeps an unclassified partial-progress cause behind the exact generic 500 response", async () => {
  // Removing the cause-name allowlist must not expose this novel failure code.
  const cause = new Error("SYNTHETIC-UNCLASSIFIED-CAUSE-MESSAGE");
  cause.name = "SYNTHETIC-UNCLASSIFIED-CAUSE-NAME";
  behavior.error = new PartialDataSnapshotSyncError(
    "address",
    "address",
    "[chained address] synthetic failure",
    { customer: { upserted: 3, rowCount: 4 }, address: null, container: null },
    { cause }
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  const secret = "synthetic-sync-secret";

  const res = await app.fetch(
    new Request("http://test.local/api/v1/data-snapshot/sync?partialProgress=true", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` }
    }),
    { ...env, CUSTOMER_SNAPSHOT_SYNC_SECRET: secret } as unknown as Env,
    ctx
  );
  const raw = await res.text();

  expect(res.status).toBe(500);
  expect(raw).toBe(genericFailure);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect(raw).not.toContain(cause.name);
  expect(raw).not.toContain(cause.message);
  expect(JSON.parse(raw)).not.toHaveProperty("failure");
  expect(JSON.parse(raw)).not.toHaveProperty("customer");
});
