/**
 * Pure helpers for `npm run first-run` (TOG-9233).
 *
 * `scripts/first-run.mjs` runs these steps in order and stops at the first
 * failure. Everything here is pure (results in, decisions out) so it is
 * unit-testable inside the workers pool, which has no child_process. Never
 * print token values from this module.
 */
import { CLIENT_TOKEN_KEYS } from "./devVarsCheck.mjs";

export const CHECK_NAME = "first-run";

/** Run order. `rerun` is the command that retries just the failed step. */
export const FIRST_RUN_STEPS = [
  { name: "devvars", rerun: "npm run check:devvars" },
  { name: "migrate", rerun: "npm run db:migrate:local" },
  { name: "seed", rerun: "npm run db:seed" },
  { name: "smoke", rerun: "npm run first-run" },
];

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
