import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cron overlap guard (TOG-9216, gap B4).
 *
 * `src/scheduled.ts` serializes syncs per isolate with a module-level
 * in-flight flag: a second firing while the first is still in-flight skips
 * with a fixed-shape `skipped-overlap` log line instead of doubling upstream
 * load and racing the first run's D1 writes. The skip deliberately does NOT
 * call `recordCronRun`, so the persisted `cron_sync_state` rows stay the last
 * run that actually moved rows.
 *
 * History: this file used to pin the OLD no-guard behavior (TOG-9210, gaps
 * QA2 + B4) — both overlapping invocations ran to completion. That pin's own
 * header required it to fail and be updated when a guard landed; the guard
 * did exactly that (the old gate timed out because the second run no longer
 * enters the sync). This file is that update.
 *
 * Scope note: the flag serializes firings on one isolate. A platform
 * double-fire routed to two isolates can still overlap — that residual case
 * is out of scope here (see `docs/CRON-SYNC-ALARM-RUNBOOK.md` §1).
 */

const state: {
  entered: string[];
  gate: Promise<void> | null;
  releaseGate: () => void;
  error: string | null;
} = {
  entered: [],
  gate: null,
  releaseGate: () => {},
  error: null,
};

vi.mock("../src/lib/d1SnapshotSync", () => ({
  runDataSnapshotSyncChainedHttp: async (publicBase: string) => {
    state.entered.push(publicBase);
    // A set gate parks the first entrant so the test can fire the second run
    // into a guaranteed in-flight window. Runs fired with no gate set proceed
    // straight through.
    if (state.gate) {
      await state.gate;
    }
    if (state.error) {
      throw new Error(state.error);
    }
    return {
      customer: { upserted: 1, rowCount: 1 },
      address: null,
      container: null
    };
  },
  runDataSnapshotSync: async () => {
    throw new Error("overlap guard tests drive the chained path only");
  }
}));

const persistCalls: unknown[][] = [];

vi.mock("../src/lib/cronSyncState", () => ({
  recordCronRun: async (...args: unknown[]) => {
    persistCalls.push(args);
    return "recorded";
  }
}));

const { scheduled } = await import("../src/scheduled");

// logEvent hands the console one structured object per record, so the spies keep
// the object itself and assertions read its fields.
const logs: Record<string, unknown>[] = [];
const errors: Record<string, unknown>[] = [];
const real = { info: console.info, error: console.error };

/** Starts one cron invocation; returns a promise for its waitUntil work. */
function startRun(scheduledTime: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {}
  } as unknown as ExecutionContext;
  const controller = {
    cron: "0 7 * * *",
    scheduledTime: Date.parse(scheduledTime)
  } as ScheduledController;
  const env = {
    SHADOW_API_PUBLIC_BASE: "https://api.example.test"
  } as unknown as Env;
  // Intentionally not awaited here: the caller overlaps two runs, so each
  // start must return while its run is still in-flight. scheduled() itself
  // never rejects — every handler error is caught inside the waitUntil
  // closure and surfaces as a log line — so there is no rejection to miss.
  return (async () => {
    await scheduled(controller, env, ctx);
    await Promise.all(pending);
  })();
}

/** Every info record is the primary envelope; assert it before reading outcomes. */
function primaryLines(): Record<string, unknown>[] {
  return logs.map((line) => {
    expect(line).toMatchObject({
      level: "info",
      msg: "data-snapshot-sync",
      route: "scheduled.data-snapshot-sync"
    });
    expect(typeof line.ms).toBe("number");
    return line;
  });
}

async function waitFor(what: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  state.entered = [];
  state.gate = null;
  state.releaseGate = () => {};
  state.error = null;
  persistCalls.length = 0;
  logs.length = 0;
  errors.length = 0;
  console.info = (...a: unknown[]) => {
    logs.push(a[0] as Record<string, unknown>);
  };
  console.error = (...a: unknown[]) => {
    errors.push(a[0] as Record<string, unknown>);
  };
});

afterEach(() => {
  console.info = real.info;
  console.error = real.error;
  // Never leave a parked first run dangling on failure paths.
  state.releaseGate();
});

describe("scheduled cron overlap guard", () => {
  it("runs exactly one sync when two firings overlap; the other logs a fixed-shape skip", async () => {
    // Arrange — park the first run inside the sync.
    state.gate = new Promise<void>((resolve) => {
      state.releaseGate = resolve;
    });
    const run1 = startRun("2026-09-27T07:00:00.000Z");
    await waitFor("the first run to enter the sync", () => state.entered.length >= 1);

    // Act — fire the second run into the in-flight window, then release both.
    // try/finally so a failed assertion cannot park run1.
    const run2 = startRun("2026-09-27T07:00:01.000Z");
    try {
      await run2;
    } finally {
      state.releaseGate();
    }
    await run1;

    // Assert — the sync body executed exactly once.
    expect(state.entered).toEqual(["https://api.example.test"]);
    expect(errors).toEqual([]);

    // Two log lines: one success (run1), one skip (run2).
    expect(logs).toHaveLength(2);
    const lines = primaryLines();
    const successLines = lines.filter((l) => l.outcome === "success");
    const skipLines = lines.filter((l) => l.outcome === "skipped-overlap");
    expect(successLines).toHaveLength(1);
    expect(skipLines).toHaveLength(1);

    const success = successLines[0];
    expect(success.scheduledTime).toBe("2026-09-27T07:00:00.000Z");

    // The skip line is fixed-shape: literal summary, all-null tables, its own
    // firing's scheduledTime — and nothing that can carry row data,
    // credentials, or error text (no `error` key at all).
    const skip = skipLines[0];
    expect(skip).toEqual({
      level: "info",
      msg: "data-snapshot-sync",
      route: "scheduled.data-snapshot-sync",
      ms: expect.any(Number),
      event: "data-snapshot-sync",
      outcome: "skipped-overlap",
      mode: "chained-http",
      configSource: "SHADOW_API_PUBLIC_BASE",
      d1LimitRisk: false,
      tables: { customer: null, address: null, container: null },
      summary: "skipped: previous sync still in-flight",
      durationMs: expect.any(Number),
      cron: "0 7 * * *",
      scheduledTime: "2026-09-27T07:00:01.000Z"
    });
    expect(JSON.stringify(logs)).not.toContain("api.example.test");

    // The skip persisted nothing: exactly one recordCronRun call, from the
    // run that actually moved rows.
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0][1]).toMatchObject({ outcome: "success" });
  });

  it("releases the flag after completion so the next firing syncs normally", async () => {
    const run1 = startRun("2026-09-27T07:00:00.000Z");
    await run1;
    const run2 = startRun("2026-09-27T07:05:00.000Z");
    await run2;

    expect(state.entered).toHaveLength(2);
    expect(errors).toEqual([]);
    const lines = primaryLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.outcome).toBe("success");
    }
    expect(persistCalls).toHaveLength(2);
  });

  it("releases the flag after a throw so the next firing is not skipped forever", async () => {
    // Arrange — the first run throws inside the sync body.
    state.error = "[customer snapshot] boom";
    const run1 = startRun("2026-09-27T07:00:00.000Z");
    await run1;

    // Act — the next firing must proceed, not skip behind a stuck flag.
    state.error = null;
    const run2 = startRun("2026-09-27T07:05:00.000Z");
    await run2;

    // Assert — run1 logged failed (via console.error), run2 logged success:
    // the flag was released by the finally, not left set by the throw.
    expect(state.entered).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      level: "error",
      msg: "data-snapshot-sync failed",
      route: "scheduled.data-snapshot-sync",
      outcome: "failed",
      table: "customer"
    });
    expect(errors[0]).not.toHaveProperty("error");
    expect(typeof errors[0].ms).toBe("number");
    const lines = primaryLines();
    expect(lines.map((l) => l.outcome)).toEqual(["success"]);
  });
});
