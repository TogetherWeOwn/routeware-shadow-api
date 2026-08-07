import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/scheduled.ts` is the cron entry point and was at 0%.
 *
 * Two properties matter and neither is visible from the outside once it is
 * deployed. First, the handler must never reject: it runs inside
 * `ctx.waitUntil`, so an escaping error is an unattributed platform-level cron
 * failure rather than a log line anyone will read. Second, the choice between
 * the chained-HTTP and single-invocation paths is what keeps a full sync under
 * D1's per-invocation operation cap — picking the wrong one turns a working
 * nightly job into one that dies partway through, with the tables it already
 * reconciled left in whatever state it reached.
 */

type Result = { upserted: number; rowCount: number } | null;

const calls: { chained: string[]; single: number } = { chained: [], single: 0 };

const behavior: {
  result: { customer: Result; address: Result; container: Result };
  error: string | null;
} = {
  result: { customer: null, address: null, container: null },
  error: null
};

vi.mock("../src/lib/d1SnapshotSync", () => ({
  runDataSnapshotSyncChainedHttp: async (publicBase: string) => {
    calls.chained.push(publicBase);
    if (behavior.error) {
      throw new Error(behavior.error);
    }
    return behavior.result;
  },
  runDataSnapshotSync: async () => {
    calls.single += 1;
    if (behavior.error) {
      throw new Error(behavior.error);
    }
    return behavior.result;
  }
}));

const { scheduled } = await import("../src/scheduled");

const logs: string[] = [];
const warns: string[] = [];
const errors: unknown[][] = [];
const real = { log: console.log, warn: console.warn, error: console.error };

/** Captures the promise handed to waitUntil so the test can await it. */
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

function envWith(publicBase?: string): Env {
  return (publicBase === undefined
    ? {}
    : { SHADOW_API_PUBLIC_BASE: publicBase }) as unknown as Env;
}

const controller = {} as ScheduledController;

async function runScheduled(env: Env): Promise<void> {
  const { ctx, settled } = fakeCtx();
  await scheduled(controller, env, ctx);
  await settled();
}

beforeEach(() => {
  calls.chained = [];
  calls.single = 0;
  behavior.result = { customer: null, address: null, container: null };
  behavior.error = null;
  logs.length = 0;
  warns.length = 0;
  errors.length = 0;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errors.push(a);
  };
});

afterEach(() => {
  console.log = real.log;
  console.warn = real.warn;
  console.error = real.error;
});

describe("scheduled sync path selection", () => {
  it("uses the chained-HTTP path when a public base url is configured", async () => {
    // Arrange / Act — separate subrequests keep D1's per-invocation op limit
    // applying per table rather than to the whole job.
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    expect(calls.chained).toEqual(["https://api.example.test"]);
    expect(calls.single).toBe(0);
  });

  it("falls back to a single invocation when no public base url is set", async () => {
    // Arrange / Act
    await runScheduled(envWith());

    // Assert
    expect(calls.single).toBe(1);
    expect(calls.chained).toEqual([]);
  });

  it("treats a whitespace-only public base url as unset", async () => {
    // Arrange / Act
    await runScheduled(envWith("   "));

    // Assert
    expect(calls.single).toBe(1);
    expect(calls.chained).toEqual([]);
  });

  it("warns that the single-invocation path may hit D1 limits", async () => {
    // Arrange / Act — this warning is the only signal that the nightly job is
    // one large export away from dying partway through.
    await runScheduled(envWith());

    // Assert
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("SHADOW_API_PUBLIC_BASE is unset");
  });

  it("does not warn when the chained path is used", async () => {
    // Arrange / Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    expect(warns).toEqual([]);
  });
});

describe("scheduled result reporting", () => {
  it("summarises every table that ran", async () => {
    // Arrange
    behavior.result = {
      customer: { upserted: 3, rowCount: 4 },
      address: { upserted: 5, rowCount: 6 },
      container: { upserted: 7, rowCount: 8 }
    };

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    expect(logs).toContain(
      "data snapshot sync: customer: 3 upserted, 4 rows; address: 5 upserted, 6 rows; container: 7 upserted, 8 rows"
    );
  });

  it("omits the tables that were skipped", async () => {
    // Arrange
    behavior.result = { customer: { upserted: 3, rowCount: 4 }, address: null, container: null };

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    expect(logs).toContain("data snapshot sync: customer: 3 upserted, 4 rows; ");
  });

  it("reports explicitly when nothing was configured", async () => {
    // Arrange — an all-null result must not look like a silent success.
    behavior.result = { customer: null, address: null, container: null };

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    expect(logs).toContain("data snapshot sync: no report paths configured");
  });
});

describe("scheduled failure handling", () => {
  it("does not reject when the sync throws", async () => {
    // Arrange — the handler runs inside waitUntil, so an escaping error is an
    // unattributed platform failure instead of a readable log line.
    behavior.error = "[customer snapshot] D1_ERROR: database is locked";

    // Act / Assert
    await expect(runScheduled(envWith("https://api.example.test"))).resolves.toBeUndefined();
  });

  it("logs the failure with its step tag intact", async () => {
    // Arrange
    behavior.error = "[customer snapshot] D1_ERROR: database is locked";

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe("scheduled data snapshot sync failed");
    expect((errors[0][1] as Error).message).toBe(
      "[customer snapshot] D1_ERROR: database is locked"
    );
  });

  it("does not log a success summary when the sync failed", async () => {
    // Arrange
    behavior.error = "boom";

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    expect(logs).toEqual([]);
  });

  it("catches a failure on the single-invocation path too", async () => {
    // Arrange
    behavior.error = "boom";

    // Act
    await runScheduled(envWith());

    // Assert
    expect(errors).toHaveLength(1);
    expect(calls.single).toBe(1);
  });
});
