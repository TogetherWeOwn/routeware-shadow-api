import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cron double-fire / overlap pin (TOG-9210, gaps QA2 + B4).
 *
 * `src/scheduled.ts` has NO overlap guard: two concurrent cron invocations
 * both run the sync to completion, and each emits exactly one structured
 * `data-snapshot-sync {...}` log line. That is the behavior pinned here —
 * not tribal knowledge, asserted.
 *
 * If an overlap guard ever lands (the R4-15 follow-up: second run waits,
 * skips, or fails safe), THIS TEST MUST FAIL AND BE UPDATED in the same
 * change: the blocked-until-second-entry gate below times out when the
 * second run no longer enters the sync while the first is in-flight, and the
 * log-count assertions break when the second run stops emitting its own
 * success line. A green suite after a guard lands means the pin was updated,
 * not that the guard slipped past it.
 */

const entered: string[] = [];
let gate: Promise<void> = Promise.resolve();
let releaseGate: () => void = () => {};

vi.mock("../src/lib/d1SnapshotSync", () => ({
  runDataSnapshotSyncChainedHttp: async (publicBase: string) => {
    entered.push(publicBase);
    if (entered.length === 1) {
      // First entrant parks here until the second run has entered the sync,
      // proving true overlap rather than two sequential runs.
      await gate;
    } else {
      releaseGate();
    }
    return {
      customer: { upserted: 1, rowCount: 1 },
      address: null,
      container: null
    };
  },
  runDataSnapshotSync: async () => {
    throw new Error("overlap pin drives the chained path only");
  }
}));

const { scheduled } = await import("../src/scheduled");

const logs: string[] = [];
const errors: unknown[][] = [];
const real = { log: console.log, error: console.error };

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

async function waitFor(what: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what} — the overlap path changed; ` +
          `update this pin alongside the guard (TOG-9210)`
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  entered.length = 0;
  logs.length = 0;
  errors.length = 0;
  gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errors.push(a);
  };
});

afterEach(() => {
  console.log = real.log;
  console.error = real.error;
  // Never leave a parked first run dangling on failure paths.
  releaseGate();
});

describe("scheduled cron overlap (double-fire)", () => {
  it("runs both overlapping invocations to completion with one log line each", async () => {
    // Arrange — start the first run and wait until it is inside the sync.
    const run1 = startRun("2026-09-27T07:00:00.000Z");
    await waitFor("the first run to enter the sync", () => entered.length >= 1);

    // Act — fire the second run while the first is still in-flight, then
    // release both. try/finally so a failed assertion cannot park run1.
    const run2 = startRun("2026-09-27T07:00:01.000Z");
    try {
      await waitFor(
        "the second run to enter the sync while the first is in-flight",
        () => entered.length >= 2
      );
    } finally {
      releaseGate();
    }
    await run1;
    await run2;

    // Assert — no guard skipped, serialized, or failed the second run: the
    // sync body executed twice and neither invocation rejected (a rejection
    // above would already have failed the test; this names the property).
    expect(entered).toEqual([
      "https://api.example.test",
      "https://api.example.test"
    ]);
    expect(errors).toEqual([]);
    expect(logs).toHaveLength(2);
    const lines = logs.map((l) => {
      expect(l.startsWith("data-snapshot-sync ")).toBe(true);
      return JSON.parse(l.slice("data-snapshot-sync ".length)) as Record<
        string,
        unknown
      >;
    });
    for (const line of lines) {
      expect(line.outcome).toBe("success");
      expect(line.mode).toBe("chained-http");
    }
    // Two separate invocations logged — distinct fire times, not one line
    // duplicated.
    expect(lines.map((l) => l.scheduledTime).sort()).toEqual([
      "2026-09-27T07:00:00.000Z",
      "2026-09-27T07:00:01.000Z"
    ]);
  });
});
