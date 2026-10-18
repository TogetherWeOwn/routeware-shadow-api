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
