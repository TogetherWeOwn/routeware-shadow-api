/**
 * Pure helpers for the one-command config preflight (gap O3).
 *
 * `npm run verify:config` chains the three operator config checks an
 * operator would otherwise have to remember separately:
 *   1. check:devvars      (.dev.vars exists beside wrangler.toml, required
 *                          keys non-empty in the effective vars)
 *   2. check:vars-parity  (wrangler.toml [vars] vs .dev.vars.example key
 *                          parity, credential-free)
 *   3. check:d1-drift     (local-only: manifest sha256 compare + fresh local
 *                          apply journal compare, credential-free)
 *
 * The d1-drift leg intentionally runs WITHOUT --remote: the remote journal
 * compare needs CLOUDFLARE_API_TOKEN and is a deploy-time concern, while this
 * preflight must stay credential-free so it runs verbatim on a fresh clone
 * (same invariant the hygiene job pins in check-ci-workflow.mjs). Keys only,
 * never values — findings name check names, never secret material.
 *
 * Everything here is pure (results in, summary out) so it is unit-testable
 * without spawning processes — the suite runs inside the workers pool with
 * no `node:child_process`. The impure runner lives in
 * `scripts/verify-config.mjs`.
 *
 * Machine-readable extension: `--json` emits exactly one versioned object
 * (see JSON_SCHEMA_VERSION), `--dry-run` reports the plan without spawning,
 * and every leg is bounded by CHECK_TIMEOUT_MS. Legs run sequentially in
 * CHECKS order through an injected runner
 * `(check, { timeoutMs, signal, stdio }) => ({ exitCode })` so tests drive
 * fakes; the real spawn runner lives in `scripts/lib/verifyConfigRunner.mjs`
 * and kills the child when the leg's AbortSignal aborts. Child stdout/stderr,
 * env values and raw exception strings never appear in any result object —
 * legs carry only id, outcome, errorCode, a fixed nextAction, and exitCode.
 */

export const CHECK_NAME = "verify:config";

/**
 * The chained checks, in run order. `script` is repo-relative; `args` are
 * the fixed argv for the preflight (d1-drift stays local-only — see above).
 */
export const CHECKS = [
  { name: "check:devvars", script: "scripts/check-devvars.mjs", args: [] },
  { name: "check:vars-parity", script: "scripts/check-vars-parity.mjs", args: [] },
  { name: "check:d1-drift", script: "scripts/check-d1-drift.mjs", args: [] },
];

/**
 * Summarize per-check outcomes.
 *
 * @param {{ name: string, ok: boolean }[]} [results] one entry per CHECKS item
 * @returns {{ ok: boolean, passed: string[], failed: string[] }}
 */
export function summarizeResults(results) {
  const list = results ?? [];
  const passed = list.filter((r) => r.ok).map((r) => r.name);
  const failed = list.filter((r) => !r.ok).map((r) => r.name);
  return { ok: failed.length === 0 && list.length === CHECKS.length, failed, passed };
}

/**
 * Render the single pass/fail summary line(s). Green path names every check;
 * red path names only the failed checks so the operator knows where to look
 * (each leg already printed its own detail above the summary).
 *
 * @param {{ ok: boolean, passed: string[], failed: string[] }} summary
 * @returns {string}
 */
export function formatSummary(summary) {
  const { ok, passed, failed } = summary;
  if (ok) {
    return `${CHECK_NAME}: PASS — ${passed.length}/${CHECKS.length} checks green (${passed.join(", ")})`;
  }
  return (
    `${CHECK_NAME}: FAIL — ${failed.join(", ")} ` +
    `(rerun the failed check directly for detail: \`npm run ${failed[0]}\`)`
  );
}

/**
 * Per-leg child timeout in milliseconds. Each leg gets its own full budget
 * (three hung legs take ~3x this, not one shared clock); on expiry the leg's
 * AbortSignal aborts so a real runner kills the child, the leg is recorded
 * as `timeout`, and the run continues with the remaining legs.
 */
export const CHECK_TIMEOUT_MS = 120_000;

/** Version of the `--json` / `--dry-run --json` object schema. */
export const JSON_SCHEMA_VERSION = 1;

/** One fixed hint per failing outcome (never interpolated, never echoed args). */
const NEXT_ACTIONS = {
  nonzero_exit: "Rerun the failed check directly to see its detail output.",
  timeout: "Rerun the timed-out check directly; it exceeded the per-leg timeout.",
  spawn_error: "Verify node and the check script exist, then rerun the check directly.",
};

const UNSUPPORTED_NEXT_ACTION =
  "Rerun with a supported flag; see `node scripts/verify-config.mjs --help`.";

const SUPPORTED_FLAGS = new Set(["--json", "--dry-run", "--help", "-h"]);

/** Private race sentinel: the timeout branch won. */
const TIMED_OUT = Symbol("verify-config-leg-timeout");

/**
 * Parse CLI args. Only --json, --dry-run, --help/-h are supported; anything
 * else (including any --remote/live-target passthrough) is rejected before
 * any execution. Argument text is never echoed back.
 *
 * @param {string[]} [args]
 * @returns {{ ok: true, help: boolean, json: boolean, dryRun: boolean } | { ok: false, errorCode: "unsupported_flag" }}
 */
export function parseArgs(args) {
  const list = args ?? [];
  for (const arg of list) {
    if (!SUPPORTED_FLAGS.has(arg)) {
      return { ok: false, errorCode: "unsupported_flag" };
    }
  }
  return {
    ok: true,
    help: list.includes("--help") || list.includes("-h"),
    json: list.includes("--json"),
    dryRun: list.includes("--dry-run"),
  };
}

/**
 * Build the dry-run plan: the exact local-only check list derived from
 * CHECKS (a fresh copy — mutating the result never touches CHECKS).
 *
 * @returns {{ schemaVersion: number, command: string, mode: string, ok: boolean, timeoutMs: number, checks: { id: string, script: string, args: string[] }[] }}
 */
export function buildDryRunResult() {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    command: CHECK_NAME,
    mode: "dry-run",
    ok: true,
    timeoutMs: CHECK_TIMEOUT_MS,
    checks: CHECKS.map((c) => ({ id: c.name, script: c.script, args: [...c.args] })),
  };
}

/**
 * Run one leg with its own timeout budget. Resolves (never rejects); maps
 * runner outcomes to passed | nonzero_exit | timeout | spawn_error.
 */
async function runOneLeg(check, { runner, timeoutMs, stdio }) {
  const controller = new AbortController();
  let timer = null;
  const onTimeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      // Abort first so a real runner kills the child. The race below already
      // observes the runner promise, so a late settle or rejection is
      // swallowed and never changes this outcome or escapes unhandled.
      controller.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") {
      timer.unref();
    }
  });
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  let settled;
  try {
    // Call the runner inline in the race so a rejection gains its handler
    // synchronously — the workers pool reports a microtask-late handler as
    // an unhandled rejection.
    settled = await Promise.race([runner(check, { timeoutMs, signal: controller.signal, stdio }), onTimeout]);
  } catch {
    // Synchronous throw or rejection: spawn failure. The thrown value is
    // deliberately dropped — it may carry paths or secret-shaped text.
    clearTimer();
    return {
      id: check.name,
      outcome: "spawn_error",
      errorCode: "check_spawn_error",
      nextAction: NEXT_ACTIONS.spawn_error,
      exitCode: null,
    };
  }
  clearTimer();
  if (settled === TIMED_OUT) {
    return {
      id: check.name,
      outcome: "timeout",
      errorCode: "check_timeout",
      nextAction: NEXT_ACTIONS.timeout,
      exitCode: null,
    };
  }
  const exitCode = settled !== null && typeof settled === "object" ? settled.exitCode : undefined;
  if (exitCode === 0) {
    return { id: check.name, outcome: "passed", errorCode: null, nextAction: null, exitCode: 0 };
  }
  return {
    id: check.name,
    outcome: "nonzero_exit",
    errorCode: "check_nonzero_exit",
    nextAction: NEXT_ACTIONS.nonzero_exit,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
  };
}

/**
 * Run every leg sequentially in CHECKS order, continuing after failed,
 * timed-out or spawn-failed legs. Aggregate `ok` is true only when every
 * leg passed.
 *
 * @param {{ runner: Function, timeoutMs?: number, stdio?: string }} opts
 * @returns {Promise<{ schemaVersion: number, command: string, mode: string, ok: boolean, timeoutMs: number, checks: { id: string, outcome: string, errorCode: string|null, nextAction: string|null, exitCode: number|null }[] }>}
 */
export async function runVerifyConfig({ runner, timeoutMs = CHECK_TIMEOUT_MS, stdio = "ignore" } = {}) {
  const checks = [];
  for (const check of CHECKS) {
    checks.push(await runOneLeg(check, { runner, timeoutMs, stdio }));
  }
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    command: CHECK_NAME,
    mode: "run",
    ok: checks.every((leg) => leg.outcome === "passed"),
    timeoutMs,
    checks,
  };
}

/**
 * Full `--help` text. Shared by the wrapper (via handleHelpFlag) and the
 * runCli help path so the documented contract cannot drift.
 *
 * @returns {string}
 */
export function buildUsage() {
  return [
    "Usage: node scripts/verify-config.mjs [--json] [--dry-run]",
    "",
    "One-command config preflight: chains check:devvars + check:vars-parity + check:d1-drift (local-only) with one summary.",
    "",
    "  -h, --help  Print this usage and exit 0 (no checks run).",
    "  --json      Print exactly one single-line versioned JSON object (schemaVersion 1) on stdout instead of human output.",
    "  --dry-run   Print the check plan without spawning any child. Composable with --json.",
    "",
    'JSON run object: { schemaVersion, command, mode ("run" | "dry-run"), ok, timeoutMs, checks }.',
    "Each check leg: { id, outcome, errorCode, nextAction, exitCode }.",
    "  outcome    passed | nonzero_exit | timeout | spawn_error",
    "  errorCode  null | check_nonzero_exit | check_timeout | check_spawn_error",
    "  nextAction null when passed, otherwise one fixed hint per outcome.",
    'Rejected arguments exit 2 with errorCode "unsupported_flag" (as JSON with --json; argument text is never echoed).',
    "Dry-run plan legs: { id, script, args }.",
    "",
    `Each leg is bounded by a per-leg timeout of ${CHECK_TIMEOUT_MS} ms (${CHECK_TIMEOUT_MS / 1000}s); a timed-out leg aborts its child and the run continues with the remaining legs.`,
    "",
    "Exit codes:",
    "  0  Every leg passes (or --dry-run / --help).",
    "  1  Any leg did not pass.",
    "  2  Unsupported arguments.",
    "",
    "Examples:",
    "  node scripts/verify-config.mjs",
    "  node scripts/verify-config.mjs --json",
    "  node scripts/verify-config.mjs --dry-run",
    "  node scripts/verify-config.mjs --dry-run --json",
  ].join("\n");
}

/**
 * CLI orchestration over an injected runner. `stdout`/`stderr` are
 * `(text) => void` writers. Resolves to the process exit code: 0 all green /
 * dry-run / help, 1 any leg not passed, 2 rejected arguments.
 *
 * @param {string[]} args
 * @param {{ runner: Function, stdout: Function, stderr: Function, timeoutMs?: number }} opts
 * @returns {Promise<number>}
 */
export async function runCli(args, { runner, stdout, stderr, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const list = args ?? [];
  const parsed = parseArgs(list);
  if (!parsed.ok) {
    if (list.includes("--json")) {
      stdout(
        `${JSON.stringify({
          schemaVersion: JSON_SCHEMA_VERSION,
          command: CHECK_NAME,
          ok: false,
          errorCode: "unsupported_flag",
          nextAction: UNSUPPORTED_NEXT_ACTION,
        })}\n`
      );
    } else {
      stderr(`${CHECK_NAME}: unsupported flag (rerun with a supported flag; see \`node scripts/verify-config.mjs --help\`).\n`);
    }
    return 2;
  }
  if (parsed.help) {
    stdout(`${buildUsage()}\n`);
    return 0;
  }
  if (parsed.dryRun) {
    if (parsed.json) {
      stdout(`${JSON.stringify(buildDryRunResult())}\n`);
      return 0;
    }
    const lines = [
      `${CHECK_NAME} dry run — check plan (nothing executed):`,
      ...CHECKS.map(
        (c, i) => `${i + 1}. ${c.name} — node ${c.script}${c.args.length > 0 ? ` ${c.args.join(" ")}` : ""}`
      ),
    ];
    stdout(`${lines.join("\n")}\n`);
    return 0;
  }
  const stdio = parsed.json ? "ignore" : "inherit";
  if (parsed.json) {
    const result = await runVerifyConfig({ runner, timeoutMs, stdio });
    stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  const wrappedRunner = async (check, ctx) => {
    stdout(`--- ${check.name} ---\n`);
    return runner(check, ctx);
  };
  const result = await runVerifyConfig({ runner: wrappedRunner, timeoutMs, stdio });
  const summary = summarizeResults(result.checks.map((leg) => ({ name: leg.id, ok: leg.outcome === "passed" })));
  stdout(`\n${formatSummary(summary)}\n`);
  return result.ok ? 0 : 1;
}
