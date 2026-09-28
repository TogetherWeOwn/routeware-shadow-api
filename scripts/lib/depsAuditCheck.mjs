/**
 * Pure helpers for the prod dependency audit gate (TOG-8904).
 *
 * Gap: transitive vulnerabilities can land via any `npm install` without a
 * blocking signal — `npm audit` is advisory-only unless something fails the
 * build on its output. This gate runs `npm audit --omit=dev --json` and
 * fails on any high/critical advisory that is not explicitly allowlisted
 * below. Moderate/low advisories are reported but never block: the current
 * tree carries ~25 of them (mostly Hono middleware adapters this Worker
 * never mounts — JSX, Lambda, toSSG), and gating on those would hold the
 * gate permanently red and teach everyone to ignore it.
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
 * Reviewed high/critical advisories present in the tree as of TOG-8904
 * (2026-09-28, `npm audit --omit=dev`: 8 packages, 8 distinct high GHSA,
 * 0 critical). Each entry must carry a remediation path; entries are
 * removed — never edited into permanence — once the advisory is gone.
 */
export const AUDIT_ALLOWLIST = [
  {
    id: "GHSA-28wg-ghj8-5hjv",
    package: "nanoid",
    reason:
      "Transitive via @scalar/* (API reference UI). Non-secure generator loop " +
      "needs a negative size input; not reachable from Worker code. Fix rides " +
      "the upstream @scalar release — Dependabot proposes it.",
    addedIn: "TOG-8904",
  },
  {
    id: "GHSA-xwg4-73v4-xw9w",
    package: "nanoid",
    reason:
      "Transitive via @scalar/* (API reference UI), same chain as above. " +
      "Integer wraparound needs attacker-controlled size input; not reachable " +
      "from Worker code. Same upstream remediation.",
    addedIn: "TOG-8904",
  },
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
    id: "GHSA-96hv-2xvq-fx4p",
    package: "ws",
    reason:
      "Transitive via @cloudflare/puppeteer (ws@8.20.0; fixed upstream in " +
      "8.22.0). Tiny-fragment memory-exhaustion DoS needs a malicious WS " +
      "peer on the browser-automation socket, not the Worker fetch path. " +
      "Fix rides the upstream puppeteer bump — Dependabot proposes it.",
    addedIn: "TOG-8904",
  },
  {
    id: "GHSA-mwp4-54f8-5fhr",
    package: "ip-address",
    reason:
      "Transitive via the puppeteer proxy-agent chain (socks proxy support " +
      "in browser tooling). Octal/decimal SSRF differential needs " +
      "attacker-influenced proxy resolution; the Worker makes no proxied " +
      "requests. Same upstream remediation.",
    addedIn: "TOG-8904",
  },
  {
    id: "GHSA-rpmf-866q-6p89",
    package: "basic-ftp",
    reason:
      "Transitive via the puppeteer proxy-agent chain (FTP proxy support in " +
      "browser tooling). Malicious-FTP-server DoS needs an FTP proxy fetch; " +
      "the Worker fetches HTTPS only. Same upstream remediation.",
    addedIn: "TOG-8904",
  },
  {
    id: "GHSA-88fw-hqm2-52qc",
    package: "hono",
    reason:
      "Direct dependency (hono@4.12.14; fixed upstream in >4.13.4). CORS " +
      "credentialed-wildcard reflection applies only when `origin` is left " +
      "at the wildcard default with credentials — this repo sets explicit " +
      "origins (see the CORS audit, docs/TOG-8368). Remediation is a minor " +
      "hono bump, which Dependabot proposes weekly; removing this entry is " +
      "part of that PR (the staleness rule enforces it).",
    addedIn: "TOG-8904",
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
 * Evaluate parsed audit output against the allowlist.
 *
 * @param {unknown} auditJson parsed `npm audit --json` output
 * @param {Array<{ id: string }>} [allowlist] defaults to AUDIT_ALLOWLIST
 * @returns {{ ok: boolean, blocking: Array<object>, stale: Array<object>, scanned: number, allowlisted: number, belowThreshold: number }}
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
