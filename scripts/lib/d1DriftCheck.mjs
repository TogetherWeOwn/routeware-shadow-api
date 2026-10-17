import { createHash } from "node:crypto";

/**
 * Pure helpers for the D1 migration drift check.
 *
 * Compares the migration file set under `migrations/d1/` (names + sha256)
 * against the names recorded in a D1 `d1_migrations` journal. Both inputs
 * are plain data, so every function here is unit-testable without Wrangler,
 * Cloudflare credentials, or network access.
 *
 * Drift means any of:
 * - a file on disk with no journal row (migration never applied there),
 * - a journal row with no file on disk (applied migration file removed/renamed),
 * - a file whose content hash differs from the checked-in manifest
 *   (migration edited after it was applied — the classic D1 drift).
 */

export const CHECK_NAME = "d1-drift";

/** sha256 hex of a UTF-8 string. Newline handling is the caller's job. */
export function hashContent(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Parse a `sha256sum`-style manifest (`<hex>  <filename>` per line, `#`
 * comments and blank lines ignored) into `[{ name, sha }]`.
 */
export function parseManifest(text) {
  const entries = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+(\S+)$/);
    if (!match) throw new Error(`${CHECK_NAME}: malformed manifest line: ${line}`);
    entries.push({ name: match[2], sha: match[1].toLowerCase() });
  }
  return entries;
}

/** Render entries back to `sha256sum`-compatible text (sorted, trailing newline). */
export function renderManifest(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `${sorted.map((e) => `${e.sha}  ${e.name}`).join("\n")}\n`;
}

/**
 * Compare on-disk file hashes against the manifest.
 * `actual` is `[{ name, sha }]`; returns `{ ok, missing[], extra[], mismatched[] }`.
 */
export function verifyFileHashes(actual, manifestEntries) {
  const expected = new Map(manifestEntries.map((e) => [e.name, e.sha]));
  const seen = new Map(actual.map((f) => [f.name, f.sha]));
  const missing = manifestEntries.map((e) => e.name).filter((n) => !seen.has(n));
  const extra = actual.map((f) => f.name).filter((n) => !expected.has(n));
  const mismatched = actual
    .filter((f) => expected.has(f.name) && expected.get(f.name) !== f.sha)
    .map((f) => f.name);
  return { ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0, missing, extra, mismatched };
}

/**
 * Compare the migration file list against journal rows from `d1_migrations`.
 * Returns `{ ok, unapplied[], orphaned[] }` where `unapplied` are files with
 * no journal row and `orphaned` are journal rows with no file.
 */
export function compareAppliedState(fileNames, appliedNames) {
  const files = new Set(fileNames);
  const applied = new Set(appliedNames);
  const unapplied = fileNames.filter((n) => !applied.has(n));
  const orphaned = appliedNames.filter((n) => !files.has(n));
  return { ok: unapplied.length === 0 && orphaned.length === 0, unapplied, orphaned };
}

/**
 * Extract the `name` column rows from `wrangler d1 execute --json` stdout.
 * Accepts the envelope wrangler prints (an array with `{ results }`).
 */
export function parseWranglerExecuteJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${CHECK_NAME}: wrangler output is not JSON`);
  }
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  const names = [];
  for (const batch of batches) {
    const rows = batch?.results;
    if (!Array.isArray(rows)) throw new Error(`${CHECK_NAME}: unexpected wrangler JSON shape`);
    for (const row of rows) {
      if (typeof row?.name !== "string") throw new Error(`${CHECK_NAME}: journal row without a name`);
      names.push(row.name);
    }
  }
  return names;
}

/** One-line human summary of a failed comparison for CI logs. */
export function formatDriftReport({ hashCheck, stateCheck }) {
  const lines = [];
  if (hashCheck && !hashCheck.ok) {
    if (hashCheck.mismatched.length > 0) lines.push(`edited migrations: ${hashCheck.mismatched.join(", ")}`);
    if (hashCheck.missing.length > 0) lines.push(`manifest entries without files: ${hashCheck.missing.join(", ")}`);
    if (hashCheck.extra.length > 0) lines.push(`files without manifest entries: ${hashCheck.extra.join(", ")}`);
  }
  if (stateCheck && !stateCheck.ok) {
    if (stateCheck.unapplied.length > 0) lines.push(`not applied: ${stateCheck.unapplied.join(", ")}`);
    if (stateCheck.orphaned.length > 0) lines.push(`applied but file missing: ${stateCheck.orphaned.join(", ")}`);
  }
  return lines;
}
