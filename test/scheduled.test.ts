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
 *
 * A third property is new with structured logging: every run emits exactly one
 * `data-snapshot-sync {...}` JSON line whose `outcome` is `success`,
 * `unconfigured`, or `failed`. A silent failure must never look like "no
 * report paths configured" — that distinction is what the missed-sync alarm in
 * `docs/CRON-SYNC-ALARM-RUNBOOK.md` keys on.
 */

type Result = { upserted: number; rowCount: number; deleted?: number } | null;

const calls: { chained: string[]; single: number } = { chained: [], single: 0 };

const behavior: {
  result: { customer: Result; address: Result; container: Result };
  error: string | null;
  rawThrow: boolean;
} = {
  result: { customer: null, address: null, container: null },
  error: null,
  rawThrow: false
};

vi.mock("../src/lib/d1SnapshotSync", () => ({
  runDataSnapshotSyncChainedHttp: async (publicBase: string) => {
    calls.chained.push(publicBase);
    if (behavior.error) {
      // `rawThrow` covers the non-Error rejection branch in the handler.
      throw behavior.rawThrow ? behavior.error : new Error(behavior.error);
    }
    return behavior.result;
  },
  runDataSnapshotSync: async () => {
    calls.single += 1;
    if (behavior.error) {
      throw behavior.rawThrow ? behavior.error : new Error(behavior.error);
    }
    return behavior.result;
  }
}));

const { scheduled, resolveChainedBase } = await import("../src/scheduled");

const logs: string[] = [];
const errors: unknown[][] = [];
const warns: string[] = [];
const real = { log: console.log, error: console.error, warn: console.warn };

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

/** A realistic cron controller; the bare-object variant covers the fallback. */
function controllerWith(meta?: { cron?: string; scheduledTime?: number }): ScheduledController {
  return { ...(meta ?? {}) } as ScheduledController;
}

async function runScheduled(
  env: Env,
  controller: ScheduledController = controllerWith({
    cron: "0 7 * * *",
    scheduledTime: Date.parse("2026-09-27T07:00:00.000Z")
  })
): Promise<void> {
  const { ctx, settled } = fakeCtx();
  await scheduled(controller, env, ctx);
  await settled();
}

/** Parses the single structured line; asserts the greppable prefix. */
function loggedLine(): Record<string, unknown> {
  expect(logs).toHaveLength(1);
  expect(logs[0].startsWith("data-snapshot-sync ")).toBe(true);
  return JSON.parse(logs[0].slice("data-snapshot-sync ".length)) as Record<string, unknown>;
}

function errorLine(): Record<string, unknown> {
  expect(errors).toHaveLength(1);
  expect(errors[0]).toHaveLength(1);
  expect(String(errors[0][0]).startsWith("data-snapshot-sync ")).toBe(true);
  return JSON.parse(String(errors[0][0]).slice("data-snapshot-sync ".length)) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  calls.chained = [];
  calls.single = 0;
  behavior.result = { customer: null, address: null, container: null };
  behavior.error = null;
  behavior.rawThrow = false;
  logs.length = 0;
  errors.length = 0;
  warns.length = 0;
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errors.push(a);
  };
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = real.log;
  console.error = real.error;
  console.warn = real.warn;
});

describe("scheduled sync path selection", () => {
  it("uses the chained-HTTP path when a public base url is configured", async () => {
    // Arrange / Act — separate subrequests keep D1's per-invocation op limit
    // applying per table rather than to the whole job.
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    expect(calls.chained).toEqual(["https://api.example.test"]);
    expect(calls.single).toBe(0);
    const line = loggedLine();
    expect(line.mode).toBe("chained-http");
    expect(line.configSource).toBe("SHADOW_API_PUBLIC_BASE");
    expect(line.d1LimitRisk).toBe(false);
    // No fallback warning on the chained path — the var resolved.
    expect(warns).toEqual([]);
  });

  it("falls back to a single invocation when no public base url is set", async () => {
    // Arrange / Act
    await runScheduled(envWith());

    // Assert
    expect(calls.single).toBe(1);
    expect(calls.chained).toEqual([]);
    const line = loggedLine();
    expect(line.mode).toBe("single-invocation");
    expect(line.configSource).toBe("fallback-single-invocation");
    expect(line.d1LimitRisk).toBe(true);
    // The fallback warning is the operator signal: without the var, D1's
    // per-invocation limit applies to all tables as one pool.
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("SHADOW_API_PUBLIC_BASE is not set");
    expect(warns[0]).toContain("single invocation");
  });

  it("treats a whitespace-only public base url as unset", async () => {
    // Arrange / Act
    await runScheduled(envWith("   "));

    // Assert
    expect(calls.single).toBe(1);
    expect(calls.chained).toEqual([]);
    expect(loggedLine().configSource).toBe("fallback-single-invocation");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("SHADOW_API_PUBLIC_BASE is not set");
  });

  it.each([
    ["malformed URL", "not a url"],
    ["missing scheme", "api.example.test"],
    ["non-http(s) scheme", "ftp://api.example.test"],
    ["path-suffixed origin", "https://api.example.test/worker"],
    ["query-suffixed origin", "https://api.example.test?x=1"],
    ["fragment-suffixed origin", "https://api.example.test#frag"],
    ["empty query delimiter", "https://api.example.test?"],
    ["root slash and empty query delimiter", "https://api.example.test/?"],
    ["empty fragment delimiter", "https://api.example.test#"],
    ["root slash and empty fragment delimiter", "https://api.example.test/#"],
    ["userinfo origin", "https://user:pass@api.example.test"],
  ])("falls back to single-invocation on %s without throwing", async (_label, value) => {
    // Arrange — a malformed SHADOW_API_PUBLIC_BASE must never throw before
    // logging (TOG-6285): the run falls back and still emits its structured
    // success/unconfigured line with d1LimitRisk=true.
    behavior.result = { customer: { upserted: 1, rowCount: 1 }, address: null, container: null };

    // Act / Assert — resolves (no rejection), runs the single path.
    await expect(runScheduled(envWith(value))).resolves.toBeUndefined();
    expect(calls.single).toBe(1);
    expect(calls.chained).toEqual([]);
    const line = loggedLine();
    expect(line.mode).toBe("single-invocation");
    expect(line.configSource).toBe("fallback-single-invocation");
    expect(line.d1LimitRisk).toBe(true);
    expect(line.outcome).toBe("success");
    expect([...logs, ...warns, ...errors.flat().map(String)].join("\n")).not.toContain(value);
  });

  it("still chains when a valid origin has surrounding whitespace", async () => {
    // Arrange / Act — trim is preserved, not treated as malformed.
    await runScheduled(envWith("  https://api.example.test  "));

    // Assert
    expect(calls.chained).toEqual(["https://api.example.test"]);
    expect(calls.single).toBe(0);
    expect(loggedLine().mode).toBe("chained-http");
  });
});

describe("resolveChainedBase", () => {
  it.each([
    ["https://api.example.test", "https://api.example.test"],
    ["https://api.example.test/", "https://api.example.test/"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["  https://api.example.test  ", "https://api.example.test"],
  ])("accepts %s", (input, expected) => {
    expect(resolveChainedBase(input)).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
    ["malformed", "not a url"],
    ["missing scheme", "api.example.test"],
    ["non-http scheme", "ftp://api.example.test"],
    ["path suffix", "https://api.example.test/worker"],
    ["query suffix", "https://api.example.test?x=1"],
    ["fragment suffix", "https://api.example.test#frag"],
    ["userinfo", "https://user:pass@api.example.test"],
  ])("rejects %s", (_label, input) => {
    expect(resolveChainedBase(input)).toBeNull();
  });

  it("rejects non-string input without throwing", () => {
    expect(resolveChainedBase(undefined)).toBeNull();
    expect(resolveChainedBase(null)).toBeNull();
    expect(resolveChainedBase(42)).toBeNull();
  });
});

describe("scheduled structured outcome", () => {
  it("logs success with per-table counts and duration", async () => {
    // Arrange
    behavior.result = {
      customer: { upserted: 3, rowCount: 4, deleted: 1 },
      address: { upserted: 5, rowCount: 6 },
      container: { upserted: 7, rowCount: 8 }
    };

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    const line = loggedLine();
    expect(line.event).toBe("data-snapshot-sync");
    expect(line.outcome).toBe("success");
    expect(line.tables).toEqual({
      customer: { upserted: 3, rowCount: 4, deleted: 1 },
      address: { upserted: 5, rowCount: 6 },
      container: { upserted: 7, rowCount: 8 }
    });
    expect(line.summary).toContain("customer: 3 upserted, 4 rows, 1 deleted");
    expect(typeof line.durationMs).toBe("number");
    expect(line.cron).toBe("0 7 * * *");
    expect(line.scheduledTime).toBe("2026-09-27T07:00:00.000Z");
    expect(line.error).toBeUndefined();
  });

  it("reports deleted for every synced table in the cron summary (TOG-7391)", async () => {
    // Arrange — the chained path now carries per-table `deleted`; the cron
    // line must show it for address/container, not just customer.
    behavior.result = {
      customer: { upserted: 3, rowCount: 4, deleted: 1 },
      address: { upserted: 5, rowCount: 6, deleted: 2 },
      container: { upserted: 7, rowCount: 8, deleted: 0 }
    };

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    const line = loggedLine();
    expect(line.tables).toEqual({
      customer: { upserted: 3, rowCount: 4, deleted: 1 },
      address: { upserted: 5, rowCount: 6, deleted: 2 },
      container: { upserted: 7, rowCount: 8, deleted: 0 }
    });
    expect(line.summary).toBe(
      "customer: 3 upserted, 4 rows, 1 deleted; " +
        "address: 5 upserted, 6 rows, 2 deleted; " +
        "container: 7 upserted, 8 rows, 0 deleted"
    );
  });

  it("marks skipped tables explicitly instead of omitting them", async () => {
    // Arrange
    behavior.result = { customer: { upserted: 3, rowCount: 4 }, address: null, container: null };

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    const line = loggedLine();
    expect(line.outcome).toBe("success");
    expect((line.tables as Record<string, unknown>).address).toBeNull();
    expect(line.summary).toContain("address: skipped (no report path configured)");
  });

  it("reports unconfigured — not success — when nothing was configured", async () => {
    // Arrange — an all-null result is a config state, and the alarm treats it
    // as distinct from a passing sync.
    behavior.result = { customer: null, address: null, container: null };

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert — outcome plus the exact summary wording: every table names its
    // skipped state so the line can never read as a pass.
    const line = loggedLine();
    expect(line.outcome).toBe("unconfigured");
    expect(line.outcome).not.toBe("success");
    expect(line.tables).toEqual({ customer: null, address: null, container: null });
    expect(line.summary).toBe(
      "customer: skipped (no report path configured); " +
        "address: skipped (no report path configured); " +
        "container: skipped (no report path configured)"
    );
    expect(line.error).toBeUndefined();
    // Unconfigured is a stdout line like success — never the stderr failure path.
    expect(errors).toEqual([]);
  });

  it("reports unconfigured on the single-invocation path when nothing was configured (TOG-7397)", async () => {
    // Arrange — blanked report vars with no public base: the runbook §5 drill
    // shape. Same config state, fallback mode.
    behavior.result = { customer: null, address: null, container: null };

    // Act
    await runScheduled(envWith());

    // Assert
    expect(calls.single).toBe(1);
    const line = loggedLine();
    expect(line.outcome).toBe("unconfigured");
    expect(line.mode).toBe("single-invocation");
    expect(line.configSource).toBe("fallback-single-invocation");
    expect(line.tables).toEqual({ customer: null, address: null, container: null });
    expect(line.summary).toBe(
      "customer: skipped (no report path configured); " +
        "address: skipped (no report path configured); " +
        "container: skipped (no report path configured)"
    );
    expect(line.error).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("falls back to unknown scheduling metadata on a bare controller", async () => {
    // Arrange / Act
    await runScheduled(envWith("https://api.example.test"), controllerWith());

    // Assert — the handler must never throw before it can log.
    const line = loggedLine();
    expect(line.cron).toBe("unknown");
    expect(line.scheduledTime).toBe("unknown");
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

  it("logs the failure with outcome failed and its step tag intact", async () => {
    // Arrange
    behavior.error = "[customer snapshot] D1_ERROR: database is locked";

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert — failures go to console.error so they stay out of the success
    // stream, but keep the same greppable prefix and JSON shape.
    expect(logs).toEqual([]);
    const line = errorLine();
    expect(line.outcome).toBe("failed");
    expect(line.error).toBe("[customer snapshot] D1_ERROR: database is locked");
    expect(line.tables).toEqual({ customer: null, address: null, container: null });
    expect(typeof line.durationMs).toBe("number");
  });

  it("stringifies a non-Error rejection instead of dropping it", async () => {
    // Arrange
    behavior.error = "raw string failure";
    behavior.rawThrow = true;

    // Act
    await runScheduled(envWith("https://api.example.test"));

    // Assert
    expect(errorLine().error).toBe("raw string failure");
  });

  it("catches a failure on the single-invocation path too", async () => {
    // Arrange
    behavior.error = "boom";

    // Act
    await runScheduled(envWith());

    // Assert
    expect(errors).toHaveLength(1);
    expect(calls.single).toBe(1);
    expect(errorLine().mode).toBe("single-invocation");
  });
});
