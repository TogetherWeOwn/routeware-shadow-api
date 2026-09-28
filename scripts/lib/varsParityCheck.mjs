/**
 * Pure helpers for the wrangler.toml [vars] vs .dev.vars.example parity gate
 * (TOG-8367, gap G20).
 *
 * Gap: a new var can land in one file but not the other — a fail-closed
 * surprise at deploy (Worker reads wrangler.toml) or a confusing local setup
 * (wrangler dev reads .dev.vars, documented by .dev.vars.example).
 *
 * Rule: every key in the top-level `[vars]` section of wrangler.toml must be
 * mentioned in `.dev.vars.example`, either as an active `KEY=` entry or as a
 * commented `# KEY=` entry (defaults live in wrangler.toml, so a commented
 * entry documents the key without overriding it — the existing style for
 * AUTH_MODE / CUSTOMER_SAVE_AUTO_TOKEN / SNAPSHOTS_R2_ENABLED). The reverse
 * also holds: an active example key that is neither a wrangler `[vars]` key
 * nor a known secret (secrets live in `.dev.vars` / `wrangler secret`, never
 * in committed files) is a typo or a renamed var, and a commented example key
 * with no counterpart anywhere is stale docs. Either direction fails the gate.
 *
 * Only top-level `[vars]` counts (`[env.*.vars]` sections are env-scoped and
 * do not apply to plain `wrangler dev`) — same scope as check-devvars.
 *
 * Everything here is pure (text in, verdicts out) so it is unit-testable
 * without filesystem access — the suite runs inside the workers pool with no
 * `node:fs`. The impure wrapper lives in `scripts/check-vars-parity.mjs`.
 * Findings name keys only, never values (CONVENTIONS.md sections 4-5); in
 * fact only keys are ever handled here.
 */

export const CHECK_NAME = "vars-parity";

/**
 * Keys that belong in `.dev.vars` / `wrangler secret`, never in
 * wrangler.toml `[vars]` — so their presence in the example is expected and
 * never reported as extra.
 */
export const SECRET_KEYS = [
  "CUSTOMER_SNAPSHOT_SYNC_SECRET",
  "LOGIN_PASSWORD",
  "LOGIN_USERNAME",
  "SHADOW_API_TOKEN",
];

/**
 * Extract commented `# KEY=` / `# KEY:` / bare `# KEY` mentions from
 * `.dev.vars.example` text. The key must be UPPER_SNAKE (env convention) so
 * prose comments (`# Copy to .dev.vars`, `# HTTP login needs …`) never parse
 * as keys: after the key only `=`, `:` or end-of-line may follow.
 *
 * @param {unknown} text
 * @returns {string[]} sorted unique commented keys
 */
export function parseExampleCommentedKeys(text) {
  const found = new Set();
  for (const line of String(text).split("\n")) {
    const match = /^\s*#\s*([A-Z][A-Z0-9_.-]*)(?=\s*(?:=|:|$))/.exec(line);
    if (match) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Compare wrangler `[vars]` keys against `.dev.vars.example` keys.
 *
 * @param {Record<string, string>} [wranglerVars] parsed top-level [vars]
 * @param {Record<string, string>} [exampleActive] parsed active example entries
 * @param {string[]} [exampleCommented] parsed commented example keys
 * @returns {{ ok: boolean, missingInExample: string[], extraInExample: string[], staleCommented: string[] }}
 */
export function compareVarsParity(wranglerVars, exampleActive, exampleCommented) {
  const wranglerKeys = new Set(Object.keys(wranglerVars ?? {}));
  const activeKeys = new Set(Object.keys(exampleActive ?? {}));
  const commentedKeys = new Set(exampleCommented ?? []);
  const secrets = new Set(SECRET_KEYS);

  const mentioned = new Set([...activeKeys, ...commentedKeys]);

  const missingInExample = [...wranglerKeys].filter((k) => !mentioned.has(k)).sort();
  const extraInExample = [...activeKeys]
    .filter((k) => !wranglerKeys.has(k) && !secrets.has(k))
    .sort();
  const staleCommented = [...commentedKeys]
    .filter((k) => !wranglerKeys.has(k) && !activeKeys.has(k) && !secrets.has(k))
    .sort();

  return {
    ok: missingInExample.length === 0 && extraInExample.length === 0 && staleCommented.length === 0,
    missingInExample,
    extraInExample,
    staleCommented,
  };
}

export function formatPassLog(wranglerCount, exampleCount) {
  return (
    `${CHECK_NAME}: PASS — ${wranglerCount} wrangler [vars] key(s) all mentioned ` +
    `in .dev.vars.example (${exampleCount} documented key(s))`
  );
}

export function formatFailureLog({ missingInExample, extraInExample, staleCommented }) {
  const lines = [`${CHECK_NAME}: FAIL — wrangler.toml [vars] and .dev.vars.example diverge:`];
  for (const key of missingInExample) {
    lines.push(`  missing in .dev.vars.example: ${key} (add an active or commented entry)`);
  }
  for (const key of extraInExample) {
    lines.push(`  extra active key in .dev.vars.example: ${key} (typo, or add it to wrangler [vars])`);
  }
  for (const key of staleCommented) {
    lines.push(`  stale commented key in .dev.vars.example: ${key} (remove it or restore the var)`);
  }
  lines.push("Keep both files in sync: keys only, never values.");
  return lines.join("\n");
}
