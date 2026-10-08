import { createHash } from "node:crypto";

/**
 * Pure helpers for the R2 snapshot-manifest verifier (TOG-8881, gap R3-06).
 *
 * Each UTC date's archive (`snapshots/<date>/{customer|address|container}.csv`)
 * carries a sidecar `snapshots/<date>.manifest.json` written by
 * `src/lib/r2SnapshotArchive.ts` (`updateSnapshotManifest`). The manifest
 * holds sha256 + byte size per CSV — hashes and keys only, never row data —
 * so failures can name the file and both hashes without touching PII
 * (CONVENTIONS.md §4–5).
 *
 * Everything here is pure (bytes/text in, verdicts out) so it is
 * unit-testable without Wrangler, credentials, or network access — the R2
 * fetching lives in the thin wrapper `scripts/verify-r2-manifest.mjs`.
 * Findings name keys and hex hashes only, never CSV bytes.
 */

export const CHECK_NAME = "r2-manifest";

export const MANIFEST_VERSION = 1;

/** sha256 hex of raw bytes. */
export function sha256HexBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Parse and shape-check manifest text. Returns `{ ok: true, manifest }` or
 * `{ ok: false, error }` where `error` names the defect (missing key,
 * bad version/date, malformed entry) without echoing bodies.
 *
 * @param {unknown} text
 * @param {string} manifestKey key the text was read from (for error context)
 */
export function parseManifest(text, manifestKey) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return { ok: false, error: `${manifestKey}: manifest is not JSON` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: `${manifestKey}: manifest is not an object` };
  }
  if (parsed.version !== MANIFEST_VERSION) {
    return { ok: false, error: `${manifestKey}: unsupported manifest version ${String(parsed.version)}` };
  }
  if (typeof parsed.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
    return { ok: false, error: `${manifestKey}: manifest date is not YYYY-MM-DD` };
  }
  if (typeof parsed.files !== "object" || parsed.files === null) {
    return { ok: false, error: `${manifestKey}: manifest files is not an object` };
  }
  const files = [];
  for (const [name, entry] of Object.entries(parsed.files)) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `${manifestKey}: entry ${name} is not an object` };
    }
    if (typeof entry.key !== "string" || entry.key.length === 0) {
      return { ok: false, error: `${manifestKey}: entry ${name} has no key` };
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      return { ok: false, error: `${manifestKey}: entry ${name} has a malformed sha256` };
    }
    if (typeof entry.bytes !== "number" || !Number.isInteger(entry.bytes) || entry.bytes < 0) {
      return { ok: false, error: `${manifestKey}: entry ${name} has a malformed byte size` };
    }
    files.push({ name, key: entry.key, sha256: entry.sha256, bytes: entry.bytes });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, manifest: { version: parsed.version, date: parsed.date, files } };
}

/**
 * Compare fetched objects against a parsed manifest.
 *
 * `actual` is `[{ name, key, sha256, bytes }]` for objects that could be
 * fetched; names the manifest lists but fetching failed go in `missing`
 * (caller passes them separately). Returns per-file verdicts; `ok` is true
 * only when every manifest entry passed.
 *
 * @param {{ name: string, key: string, sha256: string, bytes: number }[]} manifestFiles
 * @param {{ name: string, key: string, sha256: string, bytes: number }[]} actual
 * @param {string[]} missing names listed in the manifest but not fetchable
 */
export function verifyManifestHashes(manifestFiles, actual, missing = []) {
  const seen = new Map(actual.map((f) => [f.name, f]));
  const passed = [];
  const mismatched = [];
  for (const expected of manifestFiles) {
    const got = seen.get(expected.name);
    if (!got) continue; // counted in `missing` below
    if (got.sha256 === expected.sha256 && got.bytes === expected.bytes) {
      passed.push(expected.name);
    } else {
      mismatched.push({
        name: expected.name,
        key: expected.key,
        expectedSha256: expected.sha256,
        actualSha256: got.sha256,
        expectedBytes: expected.bytes,
        actualBytes: got.bytes,
      });
    }
  }
  const missingNames = [
    ...manifestFiles.map((f) => f.name).filter((n) => !seen.has(n)),
    ...missing.filter((n) => seen.has(n) === false),
  ];
  const missingUnique = [...new Set(missingNames)].sort();
  return {
    ok: mismatched.length === 0 && missingUnique.length === 0,
    passed: passed.sort(),
    mismatched,
    missing: missingUnique,
  };
}

/** Human report: one line per file plus a summary. Hashes are hex, never data. */
export function formatVerifyReport(manifestKey, result) {
  const lines = [];
  for (const name of result.passed) {
    lines.push(`  PASS ${name}`);
  }
  for (const m of result.mismatched) {
    lines.push(
      `  FAIL ${m.name} (${m.key}): sha256 mismatch ` +
        `(manifest ${m.expectedSha256}, r2 ${m.actualSha256}; ` +
        `bytes manifest=${m.expectedBytes} r2=${m.actualBytes})`
    );
  }
  for (const name of result.missing) {
    lines.push(`  FAIL ${name}: listed in manifest but not fetchable from R2`);
  }
  const status = result.ok ? "PASS" : "FAIL";
  lines.push(
    `${CHECK_NAME}: ${status} — ${manifestKey}: ` +
      `${result.passed.length} passed, ${result.mismatched.length} mismatched, ` +
      `${result.missing.length} missing`
  );
  return lines.join("\n");
}
