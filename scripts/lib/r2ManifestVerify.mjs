import { createHash } from "node:crypto";

/** Pure daily-sidecar validation. No object reads, credentials or CSV output. */
export const CHECK_NAME = "r2-manifest";
export const MANIFEST_VERSION = 1;
export const ARCHIVE_TABLES = Object.freeze(["address", "container", "customer"]);
const FILE_NAMES = ARCHIVE_TABLES.map((table) => `${table}.csv`);

/** One definition for CLI dates, requested sidecar identity and file keys. */
export function isArchiveDate(value) {
  if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value.startsWith("0000-")) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function requestedDate(manifestKey) {
  if (typeof manifestKey !== "string") return null;
  const date = manifestKey.slice("snapshots/".length, -".manifest.json".length);
  return isArchiveDate(date) && manifestKey === `snapshots/${date}.manifest.json` ? date : null;
}

function validDigestAndSize(entry) {
  return typeof entry?.sha256 === "string" && entry.sha256.length === 64 &&
    /^[0-9a-f]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0;
}

function validFileIdentity(entry) {
  if (!FILE_NAMES.includes(entry?.name) || typeof entry.key !== "string") return false;
  const date = entry.key.slice("snapshots/".length, "snapshots/".length + 10);
  return isArchiveDate(date) && entry.key === `snapshots/${date}/${entry.name}`;
}

/** sha256 hex of raw bytes. */
export function sha256HexBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Accept only the v1 daily writer layout for the requested sidecar. Nonempty
 * partial manifests remain valid. Diagnostics are fixed text: never interpolate
 * values from a rejected manifest (including names, keys or version strings).
 *
 * @param {unknown} text
 * @param {string} manifestKey
 * @returns {{ok: boolean, error?: string, manifest?: {version: number, date: string, files: {name: string, key: string, sha256: string, bytes: number}[]}}}
 */
export function parseManifest(text, manifestKey) {
  const fail = (error) => ({ ok: false, error });
  const date = requestedDate(manifestKey);
  if (!date) return fail("requested manifest date is not YYYY-MM-DD or key is not a daily sidecar");
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return fail("manifest is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("manifest is not an object");
  }
  if (parsed.version !== MANIFEST_VERSION) return fail("unsupported manifest version");
  if (!isArchiveDate(parsed.date)) return fail("manifest date is not YYYY-MM-DD (canonical calendar date required)");
  if (parsed.date !== date) return fail("manifest date does not match requested sidecar date");
  if (typeof parsed.files !== "object" || parsed.files === null || Array.isArray(parsed.files)) {
    return fail("manifest files is not an object");
  }
  const entries = Object.entries(parsed.files);
  if (!entries.length || entries.length > FILE_NAMES.length) return fail("manifest files must contain recognized daily files");
  const files = [];
  for (const [name, entry] of entries) {
    if (!FILE_NAMES.includes(name)) return fail("manifest contains an unrecognized file name");
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail("manifest entry is not an object");
    if (entry.key !== `snapshots/${date}/${name}`) return fail("manifest entry key does not match requested date and table");
    if (typeof entry.sha256 !== "string" || entry.sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      return fail("manifest entry has a malformed sha256");
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return fail("manifest entry has a malformed byte size");
    files.push({ name, key: entry.key, sha256: entry.sha256, bytes: entry.bytes });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, manifest: { version: MANIFEST_VERSION, date, files } };
}

/**
 * Compare validated manifest entries to supplied observations. Fail closed on
 * empty, malformed, extraneous or ambiguous input; never let Map's last-wins
 * behavior turn duplicate observations into proof. Only validated values enter
 * mismatch diagnostics. The success shape is kept compatible with existing users.
 *
 * @param {{ name: string, key: string, sha256: string, bytes: number }[]} manifestFiles
 * @param {{ name: string, key: string, sha256: string, bytes: number }[]} actual
 * @param {string[]} missing
 */
export function verifyManifestHashes(manifestFiles, actual, missing = []) {
  const invalid = () => ({ ok: false, passed: [], mismatched: [], missing: [], invalid: true });
  if (!Array.isArray(manifestFiles) || !manifestFiles.length || manifestFiles.length > FILE_NAMES.length ||
      !Array.isArray(actual) || !Array.isArray(missing)) return invalid();
  if (manifestFiles.some((f) => !validFileIdentity(f) || !validDigestAndSize(f)) ||
      new Set(manifestFiles.map((f) => f.name)).size !== manifestFiles.length ||
      new Set(manifestFiles.map((f) => f.key.split("/")[1])).size !== 1) return invalid();
  const expectedNames = new Set(manifestFiles.map((f) => f.name));
  if (actual.some((f) => !expectedNames.has(f?.name) || typeof f.key !== "string" || !validDigestAndSize(f)) ||
      new Set(actual.map((f) => f.name)).size !== actual.length ||
      new Set(actual.map((f) => f.key)).size !== actual.length) return invalid();
  const seen = new Map(actual.map((f) => [f.name, f]));
  if (missing.some((name) => !expectedNames.has(name) || seen.has(name))) return invalid();
  const passed = [];
  const mismatched = [];
  const missingNames = new Set(missing);
  for (const expected of [...manifestFiles].sort((a, b) => a.name.localeCompare(b.name))) {
    const got = seen.get(expected.name);
    if (!got) {
      missingNames.add(expected.name);
    } else if (got.key === expected.key && got.sha256 === expected.sha256 && got.bytes === expected.bytes) {
      passed.push(expected.name);
    } else {
      mismatched.push({
        name: expected.name,
        key: expected.key,
        expectedSha256: expected.sha256,
        actualSha256: got.sha256,
        expectedBytes: expected.bytes,
        actualBytes: got.bytes,
        ...(got.key !== expected.key ? { reason: "identity" } : {}),
      });
    }
  }
  return {
    ok: passed.length > 0 && mismatched.length === 0 && missingNames.size === 0,
    passed,
    mismatched,
    missing: [...missingNames].sort(),
  };
}

/** Human report: validated names/keys, hex hashes and counts only, never CSV. */
export function formatVerifyReport(manifestKey, result) {
  const lines = [];
  for (const name of result.passed) lines.push(`  PASS ${name}`);
  for (const m of result.mismatched) {
    lines.push(
      `  FAIL ${m.name} (${m.key}): ${m.reason === "identity" ? "object key identity" : "sha256"} mismatch ` +
        `(manifest ${m.expectedSha256}, r2 ${m.actualSha256}; ` +
        `bytes manifest=${m.expectedBytes} r2=${m.actualBytes})`
    );
  }
  for (const name of result.missing) lines.push(`  FAIL ${name}: listed in manifest but not fetchable from R2`);
  if (result.invalid) lines.push("  FAIL invalid or ambiguous verification input");
  lines.push(
    `${CHECK_NAME}: ${result.ok ? "PASS" : "FAIL"} — ${requestedDate(manifestKey) ? manifestKey : "manifest"}: ` +
      `${result.passed.length} passed, ${result.mismatched.length} mismatched, ${result.missing.length} missing`
  );
  return lines.join("\n");
}
