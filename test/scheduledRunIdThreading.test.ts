import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-run correlation id threading (TOG-19134, round 2).
 *
 * Minting `runId` in `scheduled()` is not enough: the id must reach every
 * line the run emits — the orchestration skip lines, the R2-archive lines,
 * and (on the chained path) the per-table sub-invocations via the `x-run-id`
 * header. This file drives the real modules (no `d1SnapshotSync` mock) and
 * pins that propagation; `test/scheduledRunId.test.ts` owns the
 * scheduled-owned lines with the sync runners mocked.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUN_ID = "123e4567-e89b-12d3-a456-426614174000";

const { scheduled } = await import("../src/scheduled");
const {
  parseRunIdHeader,
  runAddressSnapshotSync,
  runCustomerSnapshotSync,
  runContainerSnapshotSync,
  runDataSnapshotSync,
  runDataSnapshotSyncChainedHttp
} = await import("../src/lib/snapshot/orchestration");
const { archiveReportCsvToR2AfterD1 } = await import(
  "../src/lib/r2SnapshotArchive"
);
const { stringToUint8Stream } = await import("../src/lib/csvStream");

const logs: Record<string, unknown>[] = [];
const warns: Record<string, unknown>[] = [];
const errors: Record<string, unknown>[] = [];
const real = { info: console.info, warn: console.warn, error: console.error };

function fakeCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  return {
    ctx,
    settled: async () => {
      await Promise.all(pending);
    }
  };
}

function controllerWith(scheduledTime: string): ScheduledController {
  return {
    cron: "0 7 * * *",
    scheduledTime: Date.parse(scheduledTime)
  } as ScheduledController;
}

const emptyEnv = {} as unknown as Env;

function configuredEnv(): Env {
  return {
    CUSTOMER_REPORT_QUERY_ID: "23",
    ADDRESS_REPORT_QUERY_ID: "24",
    CONTAINER_REPORT_QUERY_ID: "25",
    CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-secret"
  } as unknown as Env;
}

beforeEach(() => {
  logs.length = 0;
  warns.length = 0;
  errors.length = 0;
  console.info = (...a: unknown[]) => {
    logs.push(a[0] as Record<string, unknown>);
  };
  console.warn = (...a: unknown[]) => {
    warns.push(a[0] as Record<string, unknown>);
  };
  console.error = (...a: unknown[]) => {
    errors.push(a[0] as Record<string, unknown>);
  };
});

afterEach(() => {
  console.info = real.info;
  console.warn = real.warn;
  console.error = real.error;
  vi.unstubAllGlobals();
});

describe("parseRunIdHeader", () => {
  it("accepts a UUID-shaped value", () => {
    expect(parseRunIdHeader(RUN_ID)).toBe(RUN_ID);
  });

  it("accepts uppercase hex and trims whitespace", () => {
    expect(parseRunIdHeader(`  ${RUN_ID.toUpperCase()} `)).toBe(
      RUN_ID.toUpperCase()
    );
  });

  it("drops absent, blank, and malformed values", () => {
    expect(parseRunIdHeader(null)).toBeUndefined();
    expect(parseRunIdHeader(undefined)).toBeUndefined();
    expect(parseRunIdHeader("")).toBeUndefined();
    expect(parseRunIdHeader("   ")).toBeUndefined();
    expect(parseRunIdHeader("not-a-uuid")).toBeUndefined();
    // A UUID prefix with attacker text appended is not a UUID.
    expect(parseRunIdHeader(`${RUN_ID}; rm -rf /`)).toBeUndefined();
    expect(parseRunIdHeader(RUN_ID.slice(1))).toBeUndefined();
  });
});

describe("unmocked scheduled run shares one runId across all five lines", () => {
  it("warn + three orchestration skips + success carry the same UUID", async () => {
    // Arrange — no report config: the single-invocation fallback path.
    const { ctx, settled } = fakeCtx();

    // Act
    await scheduled(controllerWith("2026-09-27T07:00:00.000Z"), emptyEnv, ctx);
    await settled();

    // Assert — the exact shape the review reproduced: five lines, one id.
    expect(warns).toHaveLength(1);
    expect(logs).toHaveLength(4);
    expect(errors).toHaveLength(0);
    const all = [...warns, ...logs];
    const ids = new Set(all.map((l) => l.runId));
    expect(ids.size).toBe(1);
    const [shared] = [...ids];
    expect(typeof shared).toBe("string");
    expect(shared).toMatch(UUID_RE);
    expect(
      logs
        .filter((l) => l.route === "snapshot.orchestration")
        .map((l) => l.table)
        .sort()
    ).toEqual(["address", "container", "customer"]);
  });
});

describe("runDataSnapshotSync runId threading", () => {
  it("carries runId onto every orchestration skip line", async () => {
    // Act
    const result = await runDataSnapshotSync(emptyEnv, { runId: RUN_ID });

    // Assert
    expect(result).toEqual({ customer: null, address: null, container: null });
    expect(logs).toHaveLength(3);
    for (const line of logs) {
      expect(line.route).toBe("snapshot.orchestration");
      expect(line.runId).toBe(RUN_ID);
    }
  });

  it("emits byte-identical skip lines without a runId", async () => {
    // Act — direct callers without a run keep the pre-TOG-19134 shape.
    await runDataSnapshotSync(emptyEnv);

    // Assert
    expect(logs).toHaveLength(3);
    for (const line of logs) {
      expect("runId" in line).toBe(false);
    }
  });

  it("carries runId onto the per-table runner skip and dry-run lines", async () => {
    // Act
    await runCustomerSnapshotSync(emptyEnv, { runId: RUN_ID });
    await runAddressSnapshotSync(emptyEnv, { runId: RUN_ID });
    await runContainerSnapshotSync(emptyEnv, { runId: RUN_ID });

    // Assert
    expect(logs).toHaveLength(3);
    expect(logs.map((l) => l.table).sort()).toEqual([
      "address",
      "container",
      "customer"
    ]);
    for (const line of logs) {
      expect(line.runId).toBe(RUN_ID);
    }
  });
});

describe("runDataSnapshotSyncChainedHttp x-run-id header", () => {
  function stubFetch(
    onRequest: (url: string, headers: Record<string, string>) => void
  ): void {
    vi.stubGlobal(
      "fetch",
      async (url: string, init: RequestInit) => {
        onRequest(String(url), { ...(init.headers as Record<string, string>) });
        return new Response(JSON.stringify({ upserted: 3, rowCount: 3 }), {
          status: 200
        });
      }
    );
  }

  it("sends the runId to every per-table subrequest", async () => {
    // Arrange
    const seen: { url: string; headers: Record<string, string> }[] = [];
    stubFetch((url, headers) => {
      seen.push({ url, headers });
    });

    // Act
    const result = await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      configuredEnv(),
      { runId: RUN_ID }
    );

    // Assert
    expect(result.customer).toMatchObject({ upserted: 3, rowCount: 3 });
    expect(seen).toHaveLength(3);
    for (const { headers } of seen) {
      expect(headers["x-run-id"]).toBe(RUN_ID);
      // Auth is untouched by the correlation header.
      expect(headers.authorization).toBe("Bearer test-secret");
    }
  });

  it("sends no x-run-id header without a runId", async () => {
    // Arrange
    const seen: Record<string, string>[] = [];
    stubFetch((_url, headers) => {
      seen.push(headers);
    });

    // Act
    await runDataSnapshotSyncChainedHttp(
      "https://api.example.test",
      configuredEnv()
    );

    // Assert — absent, not empty: sub-invocations keep the old shape.
    expect(seen).toHaveLength(3);
    for (const headers of seen) {
      expect("x-run-id" in headers).toBe(false);
    }
  });
});

describe("R2 archive leg runId threading", () => {
  it("carries runId onto the archive-disabled line", async () => {
    // Arrange — archive off, so the leg logs once and runs D1 only.
    const env = { SNAPSHOTS_R2_ENABLED: "false" } as unknown as Env;
    let reported: unknown;
    const sync = async () => ({ upserted: 1, rowCount: 1 });

    // Act
    const result = await archiveReportCsvToR2AfterD1(
      env,
      "customer",
      stringToUint8Stream("CustomerID\n1\n"),
      sync,
      (d) => {
        reported = d;
      },
      RUN_ID
    );

    // Assert
    expect(result).toEqual({ upserted: 1, rowCount: 1 });
    expect(reported).toMatchObject({ status: "disabled" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      msg: "R2 snapshot archive disabled",
      runId: RUN_ID
    });
  });
});
