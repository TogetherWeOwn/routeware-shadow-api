/**
 * Pure helpers for `npm run first-run`.
 *
 * `scripts/first-run.mjs` runs these steps in order and stops at the first
 * failure. Everything here is pure (results in, decisions out) so it is
 * unit-testable inside the workers pool, which has no child_process. Never
 * print token values from this module.
 */
import { CLIENT_TOKEN_KEYS } from "./devVarsCheck.mjs";

export const CHECK_NAME = "first-run";

export const FIRST_RUN_FLAGS = [
  { names: ["-h", "--help"], description: "Print usage and exit 0, overriding other arguments." },
  { names: ["--json"], description: "Execute locally; emit one bounded JSON result, without child output." },
  { names: ["--dry-run"], description: "Emit a JSON plan only: no credential reads, subprocesses, network or writes." },
];

/** Single command/effect schema for execution, planning and help. No caller overrides. */
export const FIRST_RUN_STEPS = [
  { name: "devvars", rerun: "npm run check:devvars",
    commands: [["node", "scripts/check-devvars.mjs"]],
    effects: ["read_local_credentials", "spawn_local_check"] },
  { name: "migrate", rerun: "npm run db:migrate:local",
    commands: [["npm", "run", "db:migrate:local"]],
    effects: ["spawn_local_migration", "write_local_database"] },
  { name: "seed", rerun: "npm run db:seed",
    commands: [["npm", "run", "db:seed"]],
    effects: ["spawn_local_seed", "write_local_database"] },
  { name: "smoke", rerun: "npm run first-run",
    commands: [
      ["node", "node_modules/wrangler/bin/wrangler.js", ...wranglerDevArgs("<ephemeral>")],
      ["node", "scripts/smoke-readiness.mjs"],
    ],
    effects: ["read_local_credentials", "start_loopback_server", "request_loopback_health", "run_local_smoke", "stop_process_group"] },
];

const NEXT_ACTIONS = {
  FIRST_RUN_INVALID_ARGUMENT: "Use first-run --help; only --json and --dry-run may be combined, once each.",
  FIRST_RUN_STEP_FAILED: "Correct the failed local step, then rerun first-run. No later step was run.",
  FIRST_RUN_SPAWN_FAILED: "Check the local Node/npm installation and installed dependencies, then rerun first-run.",
  FIRST_RUN_HEALTH_FAILED: "Check the local Wrangler configuration and dependencies before rerunning first-run.",
  FIRST_RUN_INTERRUPTED: "The run was interrupted. Rerun first-run when ready; do not assume skipped steps ran.",
  FIRST_RUN_TEARDOWN_FAILED: "Stop leftover first-run/Wrangler/workerd processes for this checkout and confirm its loopback port is closed before retrying.",
};

export function parseFirstRunArgs(args) {
  // Preserve the existing help-anywhere contract, including malformed neighbours.
  if (args.some((arg) => FIRST_RUN_FLAGS[0].names.includes(arg))) return { help: true, json: false, dryRun: false, valid: true };
  const seen = new Set();
  const allowed = FIRST_RUN_FLAGS.slice(1).flatMap((flag) => flag.names);
  let valid = true;
  for (const arg of args) {
    if (!allowed.includes(arg) || seen.has(arg)) valid = false;
    seen.add(arg);
  }
  return { help: false, json: seen.has("--json"), dryRun: seen.has("--dry-run"), valid };
}

/** Only fixed vocabulary and step IDs enter the public envelope, never argv/errors/output. */
export function firstRunDocument({ results = [], code = null, dryRun = false, interrupted = false } = {}) {
  const steps = FIRST_RUN_STEPS.map((step) => dryRun
    ? { id: step.name, outcome: "planned", commands: step.commands, effects: step.effects }
    : { id: step.name, outcome: results.find((result) => result.name === step.name)?.ok === true
      ? "passed" : results.some((result) => result.name === step.name) ? "failed" : "skipped" });
  const error = code ? { code, retryable: false, next_action: NEXT_ACTIONS[code] } : null;
  return {
    schemaVersion: 1, command: CHECK_NAME, mode: dryRun ? "dry-run" : "run",
    outcome: dryRun ? "planned" : interrupted ? "interrupted" : code ? "error" : "success",
    steps, failed: steps.filter((step) => step.outcome === "failed").map((step) => step.id),
    skipped: steps.filter((step) => step.outcome === "skipped").map((step) => step.id),
    error, next_action: error?.next_action ?? null,
  };
}

export function firstRunUsage() {
  return [
    "Usage: node scripts/first-run.mjs [--json] [--dry-run]",
    "", "One-command local first run, stopping at the first failure.", "",
    ...FIRST_RUN_FLAGS.map((flag) => `  ${flag.names.join(", ")}  ${flag.description}`),
    "", "Ordered steps (execution effects, not effects of planning):",
    ...FIRST_RUN_STEPS.map((step) => `  ${step.name}: ${step.commands.map((command) => command.join(" ")).join("; ")} [${step.effects.join(", ")}]`),
    "", "JSON: schemaVersion=1, command, mode, outcome, steps, failed, skipped, error, next_action.",
    "Plans are planned intent, never verification. Errors have a fixed code and next_action; no child output.",
    "Unknown, duplicate, positional and value-bearing flags are rejected before effects. No target overrides.",
    "", "Exit codes:", "  0    Every step passes, or help/plan emitted.",
    "  1    A step or teardown fails.", "  2    Invalid arguments.", "  130  Interrupted (check teardown error before retrying).",
    "", "Example (no execution; flags compose in either order):",
    "  node scripts/first-run.mjs --json --dry-run",
  ].join("\n");
}

/**
 * The bearer the smoke check sends. Mirrors the server, which accepts
 * SHADOW_API_TOKEN and falls back to CUSTOMER_SNAPSHOT_SYNC_SECRET.
 *
 * @param {Record<string, string>} devVars parsed `.dev.vars`
 * @returns {string} the token, or "" when neither key is set
 */
export function pickSmokeToken(devVars) {
  for (const key of CLIENT_TOKEN_KEYS) {
    const value = String(devVars?.[key] ?? "").trim();
    if (value !== "") return value;
  }
  return "";
}

export function localBaseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

export function wranglerDevArgs(port) {
  return ["dev", "--ip", "127.0.0.1", "--port", String(port), "--show-interactive-dev-session=false"];
}

export function smokeEnv({ baseUrl, token }) {
  return { SHADOW_API_BASE: baseUrl, SHADOW_API_TOKEN: token };
}

/**
 * @param {{ name: string, ok: boolean }[]} results outcomes in run order
 * @returns {{ ok: boolean, passed: string[], failed: string | null, skipped: string[] }}
 */
export function summarizeFirstRun(results) {
  const passed = [];
  let failed = null;
  for (const { name, ok } of results ?? []) {
    if (!ok) {
      failed = name;
      break;
    }
    passed.push(name);
  }
  const skipped = FIRST_RUN_STEPS.map((step) => step.name).filter(
    (name) => !passed.includes(name) && name !== failed,
  );
  return {
    ok: failed === null && passed.length === FIRST_RUN_STEPS.length,
    passed,
    failed,
    skipped,
  };
}

/**
 * @param {ReturnType<typeof summarizeFirstRun>} summary
 * @returns {string}
 */
export function formatFirstRunSummary(summary) {
  if (summary.ok) {
    return (
      `${CHECK_NAME}: PASS — ${summary.passed.length}/${FIRST_RUN_STEPS.length} steps green ` +
      `(${summary.passed.join(", ")})`
    );
  }
  const step = FIRST_RUN_STEPS.find((candidate) => candidate.name === summary.failed);
  const where = summary.failed ? `FAIL at ${summary.failed}` : "FAIL";
  const notRun = summary.skipped.length > 0 ? `; not run: ${summary.skipped.join(", ")}` : "";
  const retry = step ? ` — retry: ${step.rerun}` : "";
  return `${CHECK_NAME}: ${where}${notRun}${retry}`;
}
