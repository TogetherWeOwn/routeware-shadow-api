/**
 * Pure helpers for the coverage ratchet check.
 *
 * `vitest.config.ts` pins integer coverage floors just under the current
 * measurement so coverage can never regress. Vitest enforces the downward
 * direction (measured < floor fails the run); these helpers enforce the
 * upward direction the thresholds cannot express: when a PR moves a number
 * up by a full point, the floor must move with it.
 *
 * Rule: for each metric, `implied = Math.floor(measuredPct)`. A floor is
 * stale when `implied > floor` — the raised floor still passes Vitest
 * (`implied <= measured` always holds), so the raise is safe to demand.
 * A metric with `measured < floor` is a regression Vitest should already
 * have failed; it is reported distinctly, never auto-lowered.
 *
 * Every function here is pure (strings/objects in, data out) so the whole
 * rule is unit-testable without a coverage run, Cloudflare credentials, or
 * network access. See `scripts/check-coverage-ratchet.mjs` for the CLI.
 */

export const CHECK_NAME = "coverage-ratchet";

export const METRICS = ["statements", "branches", "functions", "lines"];

/** Readonly integer floors keyed by metric, e.g. `{ statements: 87, ... }`. */
function assertFloorsShape(floors, where) {
  for (const metric of METRICS) {
    if (typeof floors?.[metric] !== "number" || !Number.isFinite(floors[metric])) {
      throw new Error(`${CHECK_NAME}: ${where} missing numeric floor for ${metric}`);
    }
  }
  return floors;
}

/**
 * Extract the four integer floors from vitest config source text.
 * Matches the `thresholds: { ... }` block; throws when absent/incomplete.
 */
export function parseThresholds(configText) {
  const block = String(configText).match(/thresholds:\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error(`${CHECK_NAME}: no thresholds block found in vitest config`);
  const floors = {};
  for (const metric of METRICS) {
    const found = block[1].match(new RegExp(`\\b${metric}\\s*:\\s*(\\d+(?:\\.\\d+)?)`));
    if (!found) throw new Error(`${CHECK_NAME}: thresholds block missing ${metric}`);
    floors[metric] = Number(found[1]);
  }
  return floors;
}

/**
 * Extract measured `{ pct, covered, total }` per metric from a parsed
 * `coverage/coverage-summary.json` object (its `total` key).
 */
export function parseSummary(summary) {
  const total = summary?.total;
  if (!total || typeof total !== "object") {
    throw new Error(`${CHECK_NAME}: coverage summary has no total block`);
  }
  const measured = {};
  for (const metric of METRICS) {
    const entry = total[metric];
    if (typeof entry?.pct !== "number" || !Number.isFinite(entry.pct)) {
      throw new Error(`${CHECK_NAME}: coverage summary total.${metric}.pct is missing`);
    }
    measured[metric] = { pct: entry.pct, covered: entry.covered ?? null, total: entry.total ?? null };
  }
  return measured;
}

/**
 * Compare measured percentages against floors.
 * Returns `{ ok, stale, regressed }` where stale entries carry
 * `{ metric, floor, measured, suggested }` and regressed entries carry
 * `{ metric, floor, measured }`.
 */
export function compareRatchet(measured, floors) {
  assertFloorsShape(floors, "floors");
  const stale = [];
  const regressed = [];
  for (const metric of METRICS) {
    const pct = measured?.[metric]?.pct;
    if (typeof pct !== "number" || !Number.isFinite(pct)) {
      throw new Error(`${CHECK_NAME}: measured pct missing for ${metric}`);
    }
    const floor = floors[metric];
    const implied = Math.floor(pct);
    if (implied > floor) stale.push({ metric, floor, measured: pct, suggested: implied });
    else if (pct < floor) regressed.push({ metric, floor, measured: pct });
  }
  return { ok: stale.length === 0 && regressed.length === 0, stale, regressed };
}

/** Merge stale suggestions over current floors. */
export function raisedFloors(floors, stale) {
  const next = { ...floors };
  for (const entry of stale) next[entry.metric] = entry.suggested;
  return next;
}

/** Paste-ready `thresholds` block for `vitest.config.ts`. */
export function renderThresholdsBlock(floors) {
  assertFloorsShape(floors, "floors");
  const lines = METRICS.map((metric) => `        ${metric}: ${floors[metric]},`);
  return ["      thresholds: {", ...lines, "      }"].join("\n");
}

/** Human-readable report lines for a comparison result. */
export function formatRatchetReport(result, floors) {
  const lines = [];
  for (const entry of result.stale) {
    lines.push(
      `${entry.metric}: measured ${entry.measured}% implies floor ${entry.suggested} (configured ${entry.floor}) — raise it`
    );
  }
  for (const entry of result.regressed) {
    lines.push(
      `${entry.metric}: measured ${entry.measured}% is below floor ${entry.floor} — regression (vitest thresholds should already have failed this run)`
    );
  }
  if (result.stale.length > 0) {
    lines.push("Raise the floors to:");
    lines.push(renderThresholdsBlock(raisedFloors(floors, result.stale)));
  }
  return lines;
}

/**
 * End-to-end rule over raw file contents: config source + summary JSON text.
 * Returns `{ ok, floors, measured, result, lines }`.
 */
export function runRatchet(configText, summaryText) {
  let summary;
  try {
    summary = JSON.parse(summaryText);
  } catch {
    throw new Error(`${CHECK_NAME}: coverage summary is not valid JSON`);
  }
  const floors = parseThresholds(configText);
  const measured = parseSummary(summary);
  const result = compareRatchet(measured, floors);
  return { ok: result.ok, floors, measured, result, lines: formatRatchetReport(result, floors) };
}
