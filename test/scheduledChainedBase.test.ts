import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChainedBase } from "../src/scheduled";
import { runDataSnapshotSyncChainedHttp } from "../src/lib/snapshot/orchestration";

const EMPTY_DELIMITER_BASES = [
  "https://api.example.test?",
  "https://api.example.test/?",
  "https://api.example.test#",
  "https://api.example.test/#",
  "https://api.example.test/?#",
  "https://api.example.test/#?",
  "  https://api.example.test/?  ",
  "  https://api.example.test/#  "
];

const SYNC_PATHS = [
  "/api/v1/customer-snapshot/sync",
  "/api/v1/address-snapshot/sync",
  "/api/v1/container-snapshot/sync"
];

const env = {
  CUSTOMER_REPORT_EXPORT_PATH: "/fixture/customer.csv",
  ADDRESS_REPORT_EXPORT_PATH: "/fixture/address.csv",
  CONTAINER_REPORT_EXPORT_PATH: "/fixture/container.csv",
  CUSTOMER_SNAPSHOT_SYNC_SECRET: "fixture-only-secret"
} as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cron chained-base URL boundary", () => {
  it.each(EMPTY_DELIMITER_BASES)("rejects empty delimiters in %s", (raw) => {
    expect(resolveChainedBase(raw)).toBeNull();
  });

  it.each([
    ...EMPTY_DELIMITER_BASES.map((raw) => [raw, []] as const),
    ["https://api.example.test", SYNC_PATHS],
    ["https://api.example.test/", SYNC_PATHS],
    ["  https://api.example.test/  ", SYNC_PATHS],
    ["http://localhost:8787/", SYNC_PATHS]
  ] as const)("cannot chain to the root path from %s", async (raw, expectedPaths) => {
    const requests: Request[] = [];
    // Every fetch terminates here; these fixtures never call an upstream or D1.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ upserted: 1, rowCount: 1 }), {
        headers: { "content-type": "application/json" }
      });
    });

    const base = resolveChainedBase(raw);
    if (base !== null) {
      await runDataSnapshotSyncChainedHttp(base, env);
    }

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(expectedPaths);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(url.pathname).not.toBe("/");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(request.method).toBe("POST");
      expect(url.origin).toBe(new URL(raw.trim()).origin);
    }
  });
});
