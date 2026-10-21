import { describe, expect, it } from "vitest";
import * as verifyConfig from "../scripts/lib/verifyConfig.mjs";

/**
 * Acceptance contract (pure-result half) for the `verify:config --json`,
 * `--dry-run` and per-leg timeout extension. The CLI/process half lives in
 * `scripts/verify-config-json.test.mjs`.
 *
 * Everything is driven through INJECTED FAKE RUNNERS: no child process, no
 * network, no env reads, no real secrets. The suite runs in the workers pool,
 * so `scripts/lib/verifyConfig.mjs` must stay free of `node:child_process`
 * (the real spawn runner lives in `scripts/lib/verifyConfigRunner.mjs`).
 *
 * ## Contract the Builder implements in `scripts/lib/verifyConfig.mjs`
 *
 *   CHECK_TIMEOUT_MS            finite integer, 1_000..600_000 (per child leg)
 *   JSON_SCHEMA_VERSION         1
 *   parseArgs(args)             -> { ok: true, help, json, dryRun }
 *                                | { ok: false, errorCode: "unsupported_flag" }
 *                                (never echoes any argument text)
 *   buildDryRunResult()         -> the dry-run plan object (no spawning)
 *   runVerifyConfig({ runner, timeoutMs? }) -> Promise<run-result object>
 *
 * Runner: `async (check, { timeoutMs, signal, stdio }) => ({ exitCode })`.
 *   - resolves `{ exitCode: 0 }`  -> passed
 *   - resolves `{ exitCode: n }`  -> nonzero_exit (n != 0)
 *   - rejects / throws (any value) -> spawn_error
 *   - does not settle within timeoutMs -> timeout; `signal` is aborted so a
 *     real runner can kill the child; a late settle never changes the outcome
 * Legs run sequentially in CHECKS order and the run continues after a failed,
 * timed-out or spawn-failed leg.
 *
 * Run-result (exact keys):
 *   { schemaVersion: 1, command: "verify:config", mode: "run", ok, timeoutMs,
 *     checks: [{ id, outcome, errorCode, nextAction, exitCode }] }
 *   outcome   passed | nonzero_exit | timeout | spawn_error
 *   errorCode null | check_nonzero_exit | check_timeout | check_spawn_error
 *   nextAction null for passed; otherwise ONE fixed string per outcome
 *   exitCode  0 for passed, the child's number for nonzero_exit, else null
 * Dry-run result (exact keys):
 *   { schemaVersion: 1, command: "verify:config", mode: "dry-run", ok: true,
 *     timeoutMs, checks: [{ id, script, args }] }
 *
 * Child stdout/stderr, env values and raw exception text never appear in
 * either object.
 */

const CANARY = "CANARY-secret-7f3a9c1e";
const CANARY_TOKEN = `token=${CANARY}`;
const IDS = ["check:devvars", "check:vars-parity", "check:d1-drift"];

type Check = { name: string; script: string; args: string[] };
type Ctx = { timeoutMs: number; signal: AbortSignal; stdio?: string };
type Runner = (check: Check, ctx: Ctx) => Promise<unknown> | unknown;

function exported<T = (...args: any[]) => any>(name: string): T {
  const value = (verifyConfig as Record<string, unknown>)[name];
  if (value === undefined) {
    throw new Error(`scripts/lib/verifyConfig.mjs must export \`${name}\` (see the contract in this file's header)`);
  }
  return value as T;
}

const neverSettles = () => new Promise<never>(() => {});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function runnerFor(behaviors: Record<string, Runner>, calls: string[] = []): Runner {
  // Deliberately NOT async: return the behavior's promise as-is so a rejection
  // is observed synchronously by the caller (workerd reports a rejected
  // promise that gains its handler a microtask later as "unhandled").
  return (check, ctx) => {
    calls.push(check.name);
    const behavior = behaviors[check.name];
    return behavior ? behavior(check, ctx) : { exitCode: 0 };
  };
}

async function run(runner: Runner, timeoutMs = 40) {
  const runVerifyConfig = exported<(opts: { runner: Runner; timeoutMs?: number }) => Promise<any>>(
    "runVerifyConfig"
  );
  return runVerifyConfig({ runner, timeoutMs });
}

async function runWithDefaultTimeout(runner: Runner) {
  const runVerifyConfig = exported<(opts: { runner: Runner }) => Promise<any>>("runVerifyConfig");
  return runVerifyConfig({ runner });
}

describe("verify:config constants", () => {
  it("documents one finite per-leg timeout", () => {
    const ms = exported<number>("CHECK_TIMEOUT_MS");
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(1_000);
    expect(ms).toBeLessThanOrEqual(600_000);
  });

  it("versions the JSON schema as 1", () => {
    expect(exported<number>("JSON_SCHEMA_VERSION")).toBe(1);
  });
});

describe("parseArgs", () => {
  it("accepts no args and the four supported flags", () => {
    const parseArgs = exported("parseArgs");
    expect(parseArgs([])).toMatchObject({ ok: true, help: false, json: false, dryRun: false });
    expect(parseArgs(["--json"])).toMatchObject({ ok: true, json: true, dryRun: false });
    expect(parseArgs(["--dry-run"])).toMatchObject({ ok: true, json: false, dryRun: true });
    expect(parseArgs(["--dry-run", "--json"])).toMatchObject({ ok: true, json: true, dryRun: true });
    expect(parseArgs(["--json", "--dry-run"])).toMatchObject({ ok: true, json: true, dryRun: true });
    expect(parseArgs(["--help"])).toMatchObject({ ok: true, help: true });
    expect(parseArgs(["-h"])).toMatchObject({ ok: true, help: true });
  });

  const REJECTED: string[][] = [
    ["--remote"],
    ["--remote=https://x.invalid/live"],
    ["--json", "--remote"],
    ["--target", "https://x.invalid"],
    ["--target=prod"],
    ["--check", "check:devvars"],
    ["--bogus"],
    ["-x"],
    ["positional"],
    ["--JSON"],
    ["--json=true"],
    ["--dry-run=false"],
    ["--"],
    ["--json", "--bogus", "--dry-run"],
  ];

  it.each(REJECTED)("rejects unsupported argv %j with unsupported_flag", (...args) => {
    const parseArgs = exported("parseArgs");
    expect(parseArgs(args)).toEqual({ ok: false, errorCode: "unsupported_flag" });
  });

  it("never echoes argument text, even secret-shaped values", () => {
    const parseArgs = exported("parseArgs");
    const result = parseArgs([`--remote=${CANARY_TOKEN}`, CANARY]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe("buildDryRunResult", () => {
  it("reports the exact local-only plan derived from CHECKS", () => {
    const build = exported<() => any>("buildDryRunResult");
    const { CHECKS, CHECK_TIMEOUT_MS } = verifyConfig as any;
    expect(build()).toEqual({
      schemaVersion: 1,
      command: "verify:config",
      mode: "dry-run",
      ok: true,
      timeoutMs: CHECK_TIMEOUT_MS,
      checks: CHECKS.map((c: Check) => ({ id: c.name, script: c.script, args: c.args })),
    });
    expect(build().checks.map((c: any) => c.id)).toEqual(IDS);
  });

  it("is local-only: no leg carries a remote/live-target argument", () => {
    const build = exported<() => any>("buildDryRunResult");
    for (const check of build().checks) {
      expect(check.args.join(" ")).not.toMatch(/remote|https?:|--target/i);
    }
  });

  it("is idempotent and does not alias CHECKS", () => {
    const build = exported<() => any>("buildDryRunResult");
    const { CHECKS } = verifyConfig as any;
    const before = JSON.stringify(CHECKS);
    const first = build();
    first.checks.reverse();
    first.checks[0].args.push("--remote");
    expect(JSON.stringify(CHECKS)).toBe(before);
    expect(build()).toEqual(build());
    expect(build().checks.map((c: any) => c.id)).toEqual(IDS);
  });
});

describe("runVerifyConfig: pass", () => {
  it("emits the exact versioned object for an all-green run", async () => {
    const { CHECKS } = verifyConfig as any;
    const calls: string[] = [];
    const result = await run(runnerFor({}, calls), 5_000);
    expect(calls).toEqual(IDS);
    expect(result).toEqual({
      schemaVersion: 1,
      command: "verify:config",
      mode: "run",
      ok: true,
      timeoutMs: 5_000,
      checks: CHECKS.map((c: Check) => ({
        id: c.name,
        outcome: "passed",
        errorCode: null,
        nextAction: null,
        exitCode: 0,
      })),
    });
  });

  it("defaults timeoutMs to CHECK_TIMEOUT_MS and passes it to the runner", async () => {
    const seen: number[] = [];
    const result = await runWithDefaultTimeout(async (_check, ctx) => {
      seen.push(ctx.timeoutMs);
      return { exitCode: 0 };
    });
    expect(result.timeoutMs).toBe((verifyConfig as any).CHECK_TIMEOUT_MS);
    expect(seen).toEqual(Array(3).fill((verifyConfig as any).CHECK_TIMEOUT_MS));
  });

  it("hands the runner the CHECKS entry, an AbortSignal, and runs legs one at a time in order", async () => {
    const { CHECKS } = verifyConfig as any;
    const events: string[] = [];
    const seen: Check[] = [];
    const result = await run(async (check, ctx) => {
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(ctx.signal.aborted).toBe(false);
      seen.push(check);
      events.push(`start:${check.name}`);
      await sleep(2);
      events.push(`end:${check.name}`);
      return { exitCode: 0 };
    }, 5_000);
    expect(result.ok).toBe(true);
    expect(seen).toEqual(CHECKS);
    expect(events).toEqual(IDS.flatMap((id) => [`start:${id}`, `end:${id}`]));
  });
});

describe("runVerifyConfig: failures keep collecting", () => {
  it("records mixed failures, keeps order, runs every leg, aggregate not ok", async () => {
    const calls: string[] = [];
    const result = await run(
      runnerFor(
        {
          "check:devvars": async () => ({ exitCode: 1 }),
          "check:vars-parity": async () => ({ exitCode: 0 }),
          "check:d1-drift": async () => ({ exitCode: 3 }),
        },
        calls
      )
    );
    expect(calls).toEqual(IDS);
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      { id: "check:devvars", outcome: "nonzero_exit", errorCode: "check_nonzero_exit", nextAction: expect.any(String), exitCode: 1 },
      { id: "check:vars-parity", outcome: "passed", errorCode: null, nextAction: null, exitCode: 0 },
      { id: "check:d1-drift", outcome: "nonzero_exit", errorCode: "check_nonzero_exit", nextAction: expect.any(String), exitCode: 3 },
    ]);
  });

  it("uses one fixed, distinct, bounded nextAction per failing outcome", async () => {
    const result = await run(
      runnerFor({
        "check:devvars": async () => ({ exitCode: 1 }),
        "check:vars-parity": async () => {
          throw new Error("boom");
        },
        "check:d1-drift": neverSettles,
      })
    );
    const [nonzero, spawn, timeout] = result.checks;
    expect([nonzero.outcome, spawn.outcome, timeout.outcome]).toEqual(["nonzero_exit", "spawn_error", "timeout"]);
    const actions = [nonzero.nextAction, spawn.nextAction, timeout.nextAction];
    for (const action of actions) {
      expect(typeof action).toBe("string");
      expect(action.length).toBeGreaterThanOrEqual(10);
      expect(action.length).toBeLessThanOrEqual(200);
    }
    expect(new Set(actions).size).toBe(3);

    // Fixed: the same outcome yields the same string whichever leg failed.
    const again = await run(
      runnerFor({
        "check:devvars": async () => ({ exitCode: 7 }),
        "check:vars-parity": async () => ({ exitCode: 7 }),
        "check:d1-drift": async () => ({ exitCode: 7 }),
      })
    );
    expect(new Set(again.checks.map((c: any) => c.nextAction))).toEqual(new Set([nonzero.nextAction]));
  });

  it("marks a spawn failure (rejection) as spawn_error and continues", async () => {
    const calls: string[] = [];
    const result = await run(
      runnerFor(
        {
          "check:devvars": async () => {
            throw Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
          },
        },
        calls
      )
    );
    expect(calls).toEqual(IDS);
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toEqual({
      id: "check:devvars",
      outcome: "spawn_error",
      errorCode: "check_spawn_error",
      nextAction: expect.any(String),
      exitCode: null,
    });
    expect(result.checks.slice(1).map((c: any) => c.outcome)).toEqual(["passed", "passed"]);
  });

  it("treats a synchronous throw and a non-Error rejection as spawn_error", async () => {
    const result = await run(((check: Check) => {
      if (check.name === "check:devvars") throw new Error("sync");
      if (check.name === "check:vars-parity") return Promise.reject("plain string");
      return { exitCode: 0 };
    }) as Runner);
    expect(result.checks.map((c: any) => c.outcome)).toEqual(["spawn_error", "spawn_error", "passed"]);
  });
});

describe("runVerifyConfig: timeout bound", () => {
  it("times out a never-finishing leg, aborts its signal, and still runs the rest", async () => {
    const calls: string[] = [];
    let middleSignal: AbortSignal | undefined;
    const started = Date.now();
    const result = await run(
      runnerFor(
        {
          "check:vars-parity": (_check, ctx) => {
            middleSignal = ctx.signal;
            return neverSettles();
          },
        },
        calls
      ),
      30
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toEqual(IDS);
    expect(middleSignal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.timeoutMs).toBe(30);
    expect(result.checks).toEqual([
      { id: "check:devvars", outcome: "passed", errorCode: null, nextAction: null, exitCode: 0 },
      { id: "check:vars-parity", outcome: "timeout", errorCode: "check_timeout", nextAction: expect.any(String), exitCode: null },
      { id: "check:d1-drift", outcome: "passed", errorCode: null, nextAction: null, exitCode: 0 },
    ]);
  });

  it("each leg gets its own budget: three hung legs take ~3x timeoutMs, not one shared clock", async () => {
    const result = await run(async () => neverSettles(), 25);
    expect(result.checks.map((c: any) => c.outcome)).toEqual(["timeout", "timeout", "timeout"]);
  });

  it("a late successful settle after the timeout does not change the outcome", async () => {
    const result = await run(
      runnerFor({
        "check:devvars": async () => {
          await sleep(120);
          return { exitCode: 0 };
        },
      }),
      20
    );
    expect(result.checks[0].outcome).toBe("timeout");
    await sleep(200);
    expect(result.checks[0].outcome).toBe("timeout");
    expect(result.ok).toBe(false);
  });

  it("a late rejection after the timeout is swallowed (no unhandled rejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on?.("unhandledRejection", onUnhandled);
    try {
      const result = await run(
        runnerFor({
          "check:devvars": async (_check, ctx) => {
            await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
            throw new Error(`killed ${CANARY_TOKEN}`);
          },
        }),
        20
      );
      expect(result.checks[0].outcome).toBe("timeout");
      await sleep(100);
      expect(unhandled).toEqual([]);
    } finally {
      process.off?.("unhandledRejection", onUnhandled);
    }
  });

  it("clears its timers: a fast green run does not wait out a long timeout", async () => {
    const started = Date.now();
    const result = await run(runnerFor({}), 600_000);
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("runVerifyConfig: no child text, env values or exception strings", () => {
  it("never copies child output, thrown text or env into the result", async () => {
    const previous = process.env.VERIFY_CONFIG_TEST_SECRET;
    process.env.VERIFY_CONFIG_TEST_SECRET = CANARY;
    try {
      const result = await run(
        runnerFor({
          "check:devvars": async () => ({
            exitCode: 1,
            stdout: `${CANARY_TOKEN}\nBearer ${CANARY}`,
            stderr: `Error: ${CANARY_TOKEN} at /home/${CANARY}/x.mjs:1:1`,
            env: { SHADOW_API_TOKEN: CANARY },
          }),
          "check:vars-parity": async () => {
            throw Object.assign(new Error(`failed with ${CANARY_TOKEN}`), {
              code: CANARY,
              stack: `Error: ${CANARY_TOKEN}\n    at secret (${CANARY}.mjs:1:1)`,
            });
          },
          "check:d1-drift": (_check, ctx) => {
            ctx.signal.addEventListener("abort", () => {});
            return neverSettles();
          },
        })
      );
      const text = JSON.stringify(result);
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("Bearer");
      expect(text).not.toContain("token=");
      expect(text).not.toContain("ENOENT");
      expect(result.checks.map((c: any) => c.outcome)).toEqual(["nonzero_exit", "spawn_error", "timeout"]);
      for (const leg of result.checks) {
        expect(Object.keys(leg).sort()).toEqual(["errorCode", "exitCode", "id", "nextAction", "outcome"]);
      }
    } finally {
      if (previous === undefined) delete process.env.VERIFY_CONFIG_TEST_SECRET;
      else process.env.VERIFY_CONFIG_TEST_SECRET = previous;
    }
  });

  it("has exactly the documented top-level keys", async () => {
    const result = await run(runnerFor({}), 5_000);
    expect(Object.keys(result).sort()).toEqual(["checks", "command", "mode", "ok", "schemaVersion", "timeoutMs"]);
    expect(Object.keys(exported<() => any>("buildDryRunResult")()).sort()).toEqual([
      "checks",
      "command",
      "mode",
      "ok",
      "schemaVersion",
      "timeoutMs",
    ]);
  });
});

describe("legacy summary helpers keep their behavior", () => {
  it("summarizeResults/formatSummary are unchanged for timeout/spawn legs mapped to ok:false", () => {
    const { summarizeResults, formatSummary, CHECKS } = verifyConfig as any;
    const summary = summarizeResults(
      CHECKS.map((c: Check, i: number) => ({ name: c.name, ok: i === 1 }))
    );
    expect(summary).toEqual({ ok: false, failed: ["check:devvars", "check:d1-drift"], passed: ["check:vars-parity"] });
    expect(formatSummary(summary)).toBe(
      "verify:config: FAIL — check:devvars, check:d1-drift (rerun the failed check directly for detail: `npm run check:devvars`)"
    );
  });
});
