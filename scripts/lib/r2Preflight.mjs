/**
 * Pure helpers for the R2 bucket-existence preflight (TOG-6290).
 *
 * The deploy job runs a read-only `wrangler r2 bucket info <name> --json`
 * lookup before `wrangler deploy` so a missing SNAPSHOTS bucket fails closed
 * with the fix named, instead of shipping a Worker whose snapshot archive
 * leg silently drops CSVs. When `SNAPSHOTS_R2_ENABLED=false` the archive leg
 * is off by design, so the preflight skips cleanly.
 *
 * Everything here is pure (plain strings in, plain data out) so it is
 * unit-testable without Wrangler, credentials, or network access. The
 * impure wrapper lives in `scripts/check-r2-preflight.mjs`.
 */

export const CHECK_NAME = "r2-preflight";
export const R2_BINDING = "SNAPSHOTS";
export const R2_ENABLED_KEY = "SNAPSHOTS_R2_ENABLED";

/** True unless the raw value is exactly "false" (any case). Undefined means on. */
export function isR2Enabled(rawValue) {
  if (rawValue === undefined || rawValue === null) return true;
  return String(rawValue).toLowerCase() !== "false";
}

/**
 * Read a `[vars]` value from the top-level (production) section of
 * wrangler.toml. Returns null when absent. Ignores `[env.*.vars]` sections.
 */
export function parseVarsValue(tomlText, key) {
  const section = String(tomlText).match(/(?:^|\n)\[vars\]\n([\s\S]*?)(?=\n\[[^\n]*\]|\n\[\[[^\n]*\]\]|$)/);
  const body = section ? section[1] : String(tomlText);
  const match = body.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : null;
}

/**
 * Read the `bucket_name` for an `[[r2_buckets]]` binding from the top-level
 * of wrangler.toml. Returns null when the binding (or its name) is absent.
 * Ignores `[[env.*.r2_buckets]]` sections.
 */
export function parseBucketName(tomlText, binding = R2_BINDING) {
  const blocks = [
    ...String(tomlText).matchAll(/\[\[r2_buckets\]\]\n([\s\S]*?)(?=\n\[[^\n]*\]|\n\[\[[^\n]*\]\]|$)/g),
  ];
  for (const [, body] of blocks) {
    const bindingMatch = body.match(/^binding\s*=\s*"([^"]*)"/m);
    if (bindingMatch && bindingMatch[1] === binding) {
      const nameMatch = body.match(/^bucket_name\s*=\s*"([^"]*)"/m);
      return nameMatch ? nameMatch[1] : null;
    }
  }
  return null;
}

/**
 * Resolve the effective inputs: an explicit env override wins over
 * wrangler.toml, matching how dashboard Variables override committed `[vars]`.
 * Returns `{ enabled, bucket }`.
 */
export function resolvePreflightInput({ env = {}, tomlText = "" } = {}) {
  const enabledRaw =
    env[R2_ENABLED_KEY] !== undefined ? env[R2_ENABLED_KEY] : parseVarsValue(tomlText, R2_ENABLED_KEY);
  const bucket = env.SNAPSHOTS_BUCKET ?? parseBucketName(tomlText, R2_BINDING) ?? null;
  return { enabled: isR2Enabled(enabledRaw), bucket };
}

export function formatSkipLog() {
  return `${CHECK_NAME}: SKIPPED (${R2_ENABLED_KEY}=false — snapshot CSVs stay in D1 only)`;
}

export function formatPassLog(bucket) {
  return `${CHECK_NAME}: PASS — R2 bucket "${bucket}" exists (read-only lookup)`;
}

/** Fail-closed message: names the missing bucket and the exact fix. */
export function formatMissingBucketError(bucket) {
  return [
    `${CHECK_NAME}: FAIL — R2 bucket "${bucket}" (binding ${R2_BINDING}) not found or not readable.`,
    `Fix: npx wrangler r2 bucket create ${bucket} (then re-run deploy).`,
    `Disable only by setting ${R2_ENABLED_KEY}="false".`,
  ].join("\n");
}

export function formatNoBucketConfiguredError() {
  return [
    `${CHECK_NAME}: FAIL — no [[r2_buckets]] binding "${R2_BINDING}" with a bucket_name in wrangler.toml.`,
    `Fix: add the [[r2_buckets]] block (see CUSTOMER_SNAPSHOT.md) and create it with`,
    `npx wrangler r2 bucket create <name>, or set ${R2_ENABLED_KEY}="false" to archive D1-only.`,
  ].join("\n");
}
