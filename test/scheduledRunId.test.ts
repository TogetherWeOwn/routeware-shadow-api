import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-run correlation id for the scheduled data-snapshot-sync path (TOG-19134).
 *
 * HTTP routes already correlate with a request id; chained per-table cron
 * invocations could not be correlated because `src/scheduled.ts` minted no
 * per-invocation id — the `base` log object carried event/mode/configSource/
 * d1LimitRisk/cron/scheduledTime only. Every `logEvent` on this path must now
 * carry one `crypto.randomUUID()` minted at `scheduled()` entry: spread via
 * `base` onto the scheduled-owned lines (this file, runners mocked) and
 * threaded through `SnapshotSyncRunOptions` — plus the `x-run-id` subrequest
 * header on the chained path — into the orchestration skip lines, the
 * R2-archive lines, and the per-table sub-invocations (pinned unmocked in
 * `test/scheduledRunIdThreading.test.ts` and at the routes in
 * `test/snapshotRunIdHeader.test.ts`). Stable within one run (including the
 * fallback warning, the persistence-failure lines, and the `skipped-overlap`
 * line), distinct across runs, and PII-free (a bare UUID — never exception
 * text or row data).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const state: {
  entered: number;
  gate: Promise<void> | null;
  releaseGate: () => void;
  error: string | null;
} = { entered: 0, gate: null, releaseGate: () => {}, error: null };

vi.mock("../src/lib/d1SnapshotSync", () => ({
  runDataSnapshotSyncChainedHttp: async () => {
    state.entered += 1;
    if (state.gate) {
      await state.gate;
    }
    if (state.error) {
      throw new Error(state.error);
    }
    return {
      customer: { upserted: 1, rowCount: 1 },
      address: null,
      container: null,
    };
  },
  runDataSnapshotSync: async () => {
    if (state.error) {
      throw new Error(state.error);
    }
    return { customer: null, address: null, container: null };
  },
}));

let persistShouldThrow = false;

vi.mock("../src/lib/cronSyncState", () => ({
  recordCronRun: async () => {
    if (persistShouldThrow) {
      throw new Error("D1 down");
    }
    return "recorded";
  },
}));

const { scheduled } = await import("../src/scheduled");

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
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    settled: async () => {
      await Promise.all(pending);
    },
  };
}

function controllerWith(scheduledTime: string): ScheduledController {
  return {
    cron: "0 7 * * *",
    scheduledTime: Date.parse(scheduledTime),
  } as ScheduledController;
}

async function runScheduled(env: Env, scheduledTime: string): Promise<void> {
  const { ctx, settled } = fakeCtx();
  await scheduled(controllerWith(scheduledTime), env, ctx);
  await settled();
}

/** Starts a run without awaiting it, for overlapping two firings. */
function startRun(env: Env, scheduledTime: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return (async () => {
    await scheduled(controllerWith(scheduledTime), env, ctx);
    await Promise.all(pending);
  })();
}

const chainedEnv = {
  SHADOW_API_PUBLIC_BASE: "https://api.example.test",
} as unknown as Env;
const fallbackEnv = {} as unknown as Env;

beforeEach(() => {
  state.entered = 0;
  state.gate = null;
  state.releaseGate = () => {};
  state.error = null;
  persistShouldThrow = false;
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
  state.releaseGate();
});

describe("scheduled per-run correlation id", () => {
  it("pins a UUID-shaped runId on the success line", async () => {
    await runScheduled(chainedEnv, "2026-09-27T07:00:00.000Z");

    expect(logs).toHaveLength(1);
    expect(typeof logs[0].runId).toBe("string");
    expect(logs[0].runId).toMatch(UUID_RE);
  });

  it("keeps one stable runId across the fallback warning and the success line", async () => {
    // The single-invocation path emits two lines (warn + info); both must
    // carry the same id so the warning attributes to its run.
    await runScheduled(fallbackEnv, "2026-09-27T07:00:00.000Z");

    expect(warns).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(warns[0].runId).toMatch(UUID_RE);
    expect(logs[0].runId).toBe(warns[0].runId);
  });

  it("keeps one stable runId across the persistence-failure line and the success line", async () => {
    // A D1 persistence failure emits an error line before the primary line;
    // both must carry the same id so the failure attributes to its run.
    persistShouldThrow = true;
    await runScheduled(chainedEnv, "2026-09-27T07:00:00.000Z");

    expect(errors).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: "data-snapshot-sync persistence failed",
    });
    expect(errors[0].runId).toMatch(UUID_RE);
    expect(logs[0].runId).toBe(errors[0].runId);
  });

  it("keeps one stable runId on the failure line", async () => {
    state.error = "[customer snapshot] D1_ERROR: database is locked";
    await runScheduled(chainedEnv, "2026-09-27T07:00:00.000Z");

    expect(logs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      msg: "data-snapshot-sync failed",
      outcome: "failed",
    });
    expect(errors[0].runId).toMatch(UUID_RE);
  });

  it("carries a runId on the skipped-overlap line", async () => {
    state.gate = new Promise<void>((resolve) => {
      state.releaseGate = resolve;
    });
    const run1 = startRun(chainedEnv, "2026-09-27T07:00:00.000Z");
    // Wait until run1 is parked inside the sync — without entering, the second
    // firing would sync instead of skip. Bounded by the 2s deadline; the gate
    // always releases in the finally below.
    const deadline = Date.now() + 2000;
    while (state.entered < 1) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the first run to enter the sync");
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const run2 = startRun(chainedEnv, "2026-09-27T07:00:01.000Z");
    try {
      await run2;
    } finally {
      state.releaseGate();
    }
    await run1;

    const skip = logs.find((l) => l.outcome === "skipped-overlap");
    expect(skip).toBeDefined();
    expect(skip!.runId).toMatch(UUID_RE);
  });

  it("mints a distinct runId for each run", async () => {
    await runScheduled(chainedEnv, "2026-09-27T07:00:00.000Z");
    const first = logs[0].runId;
    logs.length = 0;

    await runScheduled(chainedEnv, "2026-09-27T07:05:00.000Z");
    const second = logs[0].runId;

    expect(typeof first).toBe("string");
    expect(typeof second).toBe("string");
    expect(second).not.toBe(first);
  });
});
