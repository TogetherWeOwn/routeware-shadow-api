/**
 * Pure helpers for the per-file coverage gate.
 *
 * `vitest.config.ts` pins global thresholds plus the coverage ratchet, but a
 * global floor can be masked by well-covered files: a brand-new module with
 * zero tests still passes every aggregate number. These helpers enforce the
 * per-file direction the globals cannot express: every src file in
 * `coverage/coverage-summary.json` must have at least one covered statement,
 * unless it is named in the allowlist.
 *
 * A file counts as tested when `statements.covered > 0`. Empty files
 * (`total === 0`) pass — there is nothing to test. Low-but-nonzero files
 * (e.g. `csvCustomerSnapshot.ts` at ~39%) pass this gate; raising those is
 * the global ratchet's job, not this check's.
 *
 * The allowlist is a dated, reasoned exception for modules that cannot run
 * under CI (e.g. puppeteer browser login), not a second floor. An allowlisted
 * file that gains coverage ("graduated") or disappears from the report
 * ("stale") fails the check so the entry is removed rather than rotting.
 *
 * Every function here is pure (strings/objects in, data out) so the whole
 * rule is unit-testable without a coverage run, Cloudflare credentials, or
 * network access. See `scripts/check-per-file-coverage.mjs` for the CLI.
 */

export const CHECK_NAME = "per-file-coverage";

/**
 * Normalize a coverage-summary.json key to a repo-relative `src/...` path.
 * Istanbul keys are absolute (e.g. `/home/runner/work/<repo>/<repo>/src/lib/foo.ts`),
 * so strip everything through the last `/src/` segment. Returns null for
 * non-`src` entries (defensive: `coverage.include` should already scope them out).
 */
export function normalizePath(key) {
  const text = String(key ?? "");
  const marker = "/src/";
  const at = text.lastIndexOf(marker);
  if (at === -1) {
    return text === "src" || text.startsWith("src/") ? text : null;
  }
  return `src/${text.slice(at + marker.length)}`;
}

/**
 * Extract per-file statement coverage from a parsed coverage summary object.
 * Returns `[{ path, covered, total, pct }]`, skipping the `total` aggregate
 * and non-`src` entries. Throws when a `src` entry lacks statements data —
 * never silently pass a file the report cannot describe.
 */
export function parseFileEntries(summary) {
  if (!summary || typeof summary !== "object") {
    throw new Error(`${CHECK_NAME}: coverage summary is not an object`);
  }
  const entries = [];
  for (const [key, value] of Object.entries(summary)) {
    if (key === "total") continue;
    const path = normalizePath(key);
    if (path === null) continue;
    const statements = value?.statements;
    if (
      typeof statements?.covered !== "number" ||
      !Number.isFinite(statements.covered) ||
      typeof statements?.total !== "number" ||
      !Number.isFinite(statements.total)
    ) {
      throw new Error(`${CHECK_NAME}: ${path} has no statements covered/total counts`);
    }
    entries.push({
      path,
      covered: statements.covered,
      total: statements.total,
      pct: typeof statements.pct === "number" ? statements.pct : null,
    });
  }
  return entries;
}

/**
 * Parse the allowlist JSON text into `[{ path, reason }]`.
 * Shape: `{ "files": [{ "path": "src/...", "reason": "..." }] }`.
 * Throws on any shape violation — a malformed allowlist must fail closed,
 * never read as "nothing is excepted" or "everything is excepted".
 */
export function parseAllowlist(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new Error(`${CHECK_NAME}: allowlist is not valid JSON`);
  }
  const files = parsed?.files;
  if (!Array.isArray(files)) {
    throw new Error(`${CHECK_NAME}: allowlist needs a "files" array`);
  }
  return files.map((entry, index) => {
    if (typeof entry?.path !== "string" || !entry.path.startsWith("src/")) {
      throw new Error(`${CHECK_NAME}: allowlist entry ${index} needs a "src/..." path`);
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(`${CHECK_NAME}: allowlist entry for ${entry?.path ?? index} needs a non-empty reason`);
    }
    return { path: entry.path, reason: entry.reason };
  });
}

/**
 * Compare file entries against the allowlist.
 * Returns `{ ok, untested, graduated, stale }`:
 * - `untested`: non-empty files with zero covered statements, not allowlisted.
 * - `graduated`: allowlisted files that now have coverage (drop the entry).
 * - `stale`: allowlisted paths absent from the report (renamed/deleted file).
 */
export function comparePerFile(entries, allowlist) {
  const allowed = new Map(allowlist.map((entry) => [entry.path, entry]));
  const seen = new Set(entries.map((entry) => entry.path));
  const untested = entries.filter(
    (entry) => entry.total > 0 && entry.covered === 0 && !allowed.has(entry.path),
  );
  const graduated = entries.filter(
    (entry) => allowed.has(entry.path) && entry.covered > 0,
  );
  const stale = allowlist.filter((entry) => !seen.has(entry.path));
  return {
    ok: untested.length === 0 && graduated.length === 0 && stale.length === 0,
    untested,
    graduated,
    stale,
  };
}

/** Human-readable report lines for a comparison result. */
export function formatPerFileReport(result) {
  const lines = [];
  for (const entry of result.untested) {
    lines.push(
      `${entry.path}: 0/${entry.total} statements covered — add tests, or allowlist it with a reason in scripts/per-file-coverage-allowlist.json`,
    );
  }
  for (const entry of result.graduated) {
    lines.push(
      `${entry.path}: now has ${entry.covered} covered statements — remove it from scripts/per-file-coverage-allowlist.json`,
    );
  }
  for (const entry of result.stale) {
    lines.push(
      `${entry.path}: allowlisted but absent from the coverage report — remove or fix the entry in scripts/per-file-coverage-allowlist.json`,
    );
  }
  return lines;
}

/**
 * End-to-end rule over raw file contents: summary JSON text + allowlist JSON text.
 * Returns `{ ok, entries, allowlist, result, lines }`.
 */
export function runPerFileCheck(summaryText, allowlistText) {
  let summary;
  try {
    summary = JSON.parse(summaryText);
  } catch {
    throw new Error(`${CHECK_NAME}: coverage summary is not valid JSON`);
  }
  const entries = parseFileEntries(summary);
  if (entries.length === 0) {
    throw new Error(
      `${CHECK_NAME}: coverage summary contains no src file entries — refusing to pass a report that inspected nothing`,
    );
  }
  const allowlist = parseAllowlist(allowlistText);
  const result = comparePerFile(entries, allowlist);
  return {
    ok: result.ok,
    entries,
    allowlist,
    result,
    lines: formatPerFileReport(result),
  };
}
