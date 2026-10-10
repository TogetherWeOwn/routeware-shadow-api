/**
 * Pure helpers for the prod dependency audit gate (TOG-8904).
 *
 * Gap: transitive vulnerabilities can land via any `npm install` without a
 * blocking signal — `npm audit` is advisory-only unless something fails the
 * build on its output. This gate runs `npm audit --omit=dev --json` and
 * fails on any high/critical advisory that is not explicitly allowlisted
 * below. Moderate/low advisories are reported but never block: historically
 * the tree carried ~25 of them (mostly Hono middleware adapters this Worker
 * never mounts — JSX, Lambda, toSSG), and gating on those would hold the
 * gate permanently red and teach everyone to ignore it. As of TOG-18932
 * (hono 4.13.13) the tree carries 0 below-threshold advisories — every
 * reported GHSA is high and allowlisted.
 *
 * Prod-only (`--omit=dev`) is deliberate: devDependencies (vitest, wrangler,
 * playwright) never ship to the Worker, and their advisory surface would
 * drown the signal for what actually runs in production.
 *
 * Allowlist lifecycle (documented in docs/DEPENDENCY-AUDIT.md):
 * - every entry names the GHSA id, the affected package, why it is
 *   tolerated, and the remediation path (usually "Dependabot proposes the
 *   fix; removing the entry is part of that PR");
 * - an entry whose GHSA no longer appears in the audit output is STALE and
 *   fails the gate until removed — so a Dependabot fix can never land
 *   without cleaning up its entry, and the allowlist only ever shrinks.
 *
 * Everything here is pure (audit JSON text in, verdicts out) so it is
 * unit-testable without network access — the suite never reaches the
 * registry. The impure wrapper lives in `scripts/check-deps-audit.mjs`.
 * Findings name GHSA ids and package names only, never credentials.
 */

export const CHECK_NAME = "deps-audit";

/** Advisory severities that block the build when unallowlisted. */
export const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/**
 * Reviewed high/critical advisories present in the tree as of TOG-18932
 * (2026-10-09, `npm audit --omit=dev`: 7 packages, 3 distinct high GHSA,
 * 0 critical). Each entry must carry a remediation path; entries are
 * removed — never edited into permanence — once the advisory is gone.
 *
 * Retired in TOG-18932 (hono ^4.13.7 bump + `npm audit fix`, non-breaking):
 * GHSA-28wg-ghj8-5hjv, GHSA-xwg4-73v4-xw9w (nanoid → 5.1.16),
 * GHSA-96hv-2xvq-fx4p (ws → 8.22.0), GHSA-mwp4-54f8-5fhr (ip-address →
 * 10.7.3), GHSA-rpmf-866q-6p89 (basic-ftp → 5.3.1), GHSA-88fw-hqm2-52qc
 * (hono → 4.13.13).
 */
export const AUDIT_ALLOWLIST = [
  {
    id: "GHSA-7pqw-9j4j-h8q3",
    package: "extract-zip",
    reason:
      "Transitive via @cloudflare/puppeteer → @puppeteer/browsers (browser " +
      "login fallback tooling, never in the request path). Symlink write " +
      "needs a malicious archive download; the in-tree fix is a breaking " +
      "puppeteer major, so this waits on upstream. Dependabot proposes it.",
    addedIn: "TOG-8904",
  },
  {
    id: "GHSA-jmr9-qjv8-65gv",
    package: "extract-zip",
    reason:
      "Same transitive chain as above (symlink path traversal twin of the " +
      "arbitrary-write advisory). Same upstream remediation.",
    addedIn: "TOG-8904",
  },
  {
    id: "GHSA-c475-qrg2-pj4r",
    package: "basic-ftp",
    reason:
      "Transitive via the puppeteer proxy-agent chain (FTP proxy support in " +
      "browser tooling), same chain as GHSA-rpmf-866q-6p89 above. " +
      "Quadratic-time DoS in Client.list() directory-listing parsing needs " +
      "an actual FTP LIST response; the Worker fetches HTTPS only and never " +
      "parses FTP listings. Fixed upstream in basic-ftp 6.2.1, but get-uri " +
      "pins ^5.0.2, so the fix rides the upstream proxy-agent chain — " +
      "Dependabot proposes it.",
    addedIn: "TOG-11682",
  },
];

/**
 * Extract the GHSA id from an advisory URL tail.
 *
 * @param {unknown} url
 * @returns {string|null}
 */
export function ghsaIdFromUrl(url) {
  // GHSA ids are four segments: GHSA-xxxx-xxxx-xxxx.
  const match = /\/([A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){3})$/.exec(String(url ?? ""));
  return match ? match[1] : null;
}

/** Rank a severity string for max() comparisons; unknown ranks below info. */
export function severityRank(severity) {
  return SEVERITY_RANK[String(severity ?? "").toLowerCase()] ?? -1;
}

/**
 * Flatten `npm audit --json` output into one record per distinct GHSA id.
 * The per-advisory (`via`) severity is authoritative — npm's package-level
 * rollup is the max over advisories we mostly ignore, so gating on it would
 * block on moderate findings. When one GHSA appears twice, keep the higher
 * severity.
 *
 * @param {unknown} auditJson parsed `npm audit --json` output
 * @returns {Map<string, { id: string, package: string, severity: string, title: string }>}
 */
export function extractAdvisories(auditJson) {
  const found = new Map();
  const vulnerabilities =
    auditJson && typeof auditJson === "object" ? (auditJson.vulnerabilities ?? {}) : {};
  for (const entry of Object.values(vulnerabilities)) {
    const via = entry && typeof entry === "object" && Array.isArray(entry.via) ? entry.via : [];
    for (const item of via) {
      if (!item || typeof item !== "object" || typeof item.url !== "string") continue;
      const id = ghsaIdFromUrl(item.url);
      if (!id) continue;
      const record = {
        id,
        package: typeof item.name === "string" ? item.name : "?",
        severity: typeof item.severity === "string" ? item.severity.toLowerCase() : "unknown",
        title: typeof item.title === "string" ? item.title : "",
      };
      const prev = found.get(id);
      if (!prev || severityRank(record.severity) > severityRank(prev.severity)) {
        found.set(id, record);
      }
    }
  }
  return found;
}

/**
 * A flattened advisory record (one per distinct GHSA id).
 *
 * @typedef {{ id: string, package: string, severity: string, title: string }} AdvisoryRecord
 */

/**
 * Evaluate parsed audit output against the allowlist.
 *
 * @param {unknown} auditJson parsed `npm audit --json` output
 * @param {Array<{ id: string }>} [allowlist] defaults to AUDIT_ALLOWLIST
 * @returns {{ ok: boolean, blocking: AdvisoryRecord[], stale: Array<{ id: string }>, scanned: number, allowlisted: number, belowThreshold: number }}
 */
export function evaluateAudit(auditJson, allowlist = AUDIT_ALLOWLIST) {
  const advisories = extractAdvisories(auditJson);
  const allowed = new Map((allowlist ?? []).map((e) => [e.id, e]));
  const blocking = [...advisories.values()]
    .filter((a) => BLOCKING_SEVERITIES.has(a.severity) && !allowed.has(a.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const stale = (allowlist ?? []).filter((e) => !advisories.has(e.id));
  const allowlisted = [...advisories.values()].filter((a) => allowed.has(a.id)).length;
  return {
    ok: blocking.length === 0 && stale.length === 0,
    blocking,
    stale,
    scanned: advisories.size,
    allowlisted,
    belowThreshold: advisories.size - blocking.length - allowlisted,
  };
}

export function formatPassLog({ scanned, allowlisted, belowThreshold }) {
  return (
    `${CHECK_NAME}: PASS — ${scanned} advisories scanned, ` +
    `0 unreviewed high/critical ` +
    `(${allowlisted} allowlisted with card refs, ${belowThreshold} below threshold)`
  );
}

export function formatFailureLog({ blocking, stale }) {
  const lines = [`${CHECK_NAME}: FAIL — unreviewed dependency risk:`];
  for (const advisory of blocking) {
    lines.push(
      `  ${advisory.severity.toUpperCase()} ${advisory.id} (${advisory.package}): ${advisory.title}`,
    );
  }
  if (blocking.length > 0) {
    lines.push(
      "Fix the dependency (Dependabot proposes bumps weekly) or, if the risk is " +
        "genuinely unreachable, add a GHSA entry with reason + remediation to " +
        "AUDIT_ALLOWLIST in scripts/lib/depsAuditCheck.mjs — see docs/DEPENDENCY-AUDIT.md.",
    );
  }
  for (const entry of stale) {
    lines.push(
      `  stale allowlist entry ${entry.id} (${entry.package}): advisory no longer reported — ` +
        "remove the entry (the fix already landed).",
    );
  }
  return lines.join("\n");
}
