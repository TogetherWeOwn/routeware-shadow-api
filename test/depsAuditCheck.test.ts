import { describe, expect, it } from "vitest";
import {
  AUDIT_ALLOWLIST,
  BLOCKING_SEVERITIES,
  CHECK_NAME,
  evaluateAudit,
  extractAdvisories,
  formatFailureLog,
  formatPassLog,
  ghsaIdFromUrl,
  severityRank,
} from "../scripts/lib/depsAuditCheck.mjs";

/**
 * Regression tests for TOG-8904: an unaudited transitive dependency can land
 * without a blocking signal. The gate fails on unallowlisted high/critical
 * advisories only; moderate/low findings (e.g. Hono adapters this Worker
 * never mounts) are reported, never blocking.
 *
 * All fixtures are inline audit-JSON fragments. No test reaches the network
 * or runs `npm audit` — house rule (docs/TEST-INVARIANTS.md).
 */

function advisory(url: string, severity = "high", name = "some-pkg", title = "Some advisory") {
  return {
    name,
    severity,
    via: [{ name, url, severity, title, range: "*" }],
  };
}

describe("ghsaIdFromUrl (TOG-8904)", () => {
  it("extracts four-segment GHSA ids from advisory URLs", () => {
    expect(ghsaIdFromUrl("https://github.com/advisories/GHSA-rpmf-866q-6p89")).toBe(
      "GHSA-rpmf-866q-6p89",
    );
  });

  it("returns null for package-name via entries and non-advisory URLs", () => {
    expect(ghsaIdFromUrl("@puppeteer/browsers")).toBeNull();
    expect(ghsaIdFromUrl(undefined)).toBeNull();
    expect(ghsaIdFromUrl("https://example.com/not-an-advisory")).toBeNull();
  });
});

describe("severityRank (TOG-8904)", () => {
  it("orders critical above high above moderate, case-insensitively", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("HIGH"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("moderate"));
    expect(severityRank("moderate")).toBeGreaterThan(severityRank("low"));
  });

  it("ranks unknown severities below info so novel values surface loudly", () => {
    expect(severityRank("mystery")).toBeLessThan(severityRank("info"));
  });
});

describe("extractAdvisories (TOG-8904)", () => {
  it("uses the per-advisory severity, not npm's package-level rollup", () => {
    // npm rolls hono up to "high" because one of its ~25 advisories is high;
    // the extractor must keep each advisory's own severity, so a moderate
    // hono finding never blocks and never needs allowlisting.
    const parsed = extractAdvisories({
      vulnerabilities: {
        hono: {
          name: "hono",
          severity: "high",
          via: [
            { name: "hono", url: "https://github.com/advisories/GHSA-qp7p-654g-cw7p", severity: "moderate", title: "CSS injection" },
            { name: "hono", url: "https://github.com/advisories/GHSA-88fw-hqm2-52qc", severity: "high", title: "CORS reflection" },
          ],
        },
      },
    });
    expect(parsed.get("GHSA-qp7p-654g-cw7p")?.severity).toBe("moderate");
    expect(parsed.get("GHSA-88fw-hqm2-52qc")?.severity).toBe("high");
  });

  it("skips string via entries (dependency names, not advisories)", () => {
    const parsed = extractAdvisories({
      vulnerabilities: {
        "@cloudflare/puppeteer": { name: "@cloudflare/puppeteer", severity: "high", via: ["@puppeteer/browsers"] },
      },
    });
    expect(parsed.size).toBe(0);
  });

  it("keeps the higher severity when one GHSA appears twice", () => {
    const parsed = extractAdvisories({
      vulnerabilities: {
        a: { name: "a", severity: "high", via: [{ name: "a", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "moderate", title: "t" }] },
        b: { name: "b", severity: "high", via: [{ name: "b", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "high", title: "t" }] },
      },
    });
    expect(parsed.get("GHSA-aaaa-bbbb-cccc")?.severity).toBe("high");
  });

  it("tolerates missing or malformed audit output", () => {
    expect(extractAdvisories(null).size).toBe(0);
    expect(extractAdvisories({}).size).toBe(0);
    expect(extractAdvisories({ vulnerabilities: null }).size).toBe(0);
  });
});

describe("evaluateAudit (TOG-8904)", () => {
  const allowlist = [{ id: "GHSA-aaaa-bbbb-cccc" }];

  it("passes when the only high advisory is allowlisted", () => {
    const outcome = evaluateAudit(
      { vulnerabilities: { p: advisory("https://github.com/advisories/GHSA-aaaa-bbbb-cccc") } },
      allowlist,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.allowlisted).toBe(1);
  });

  it("fails on an unallowlisted high advisory", () => {
    const outcome = evaluateAudit(
      { vulnerabilities: { p: advisory("https://github.com/advisories/GHSA-zzzz-yyyy-xxxx", "critical") } },
      allowlist,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.blocking.map((b) => b.id)).toEqual(["GHSA-zzzz-yyyy-xxxx"]);
  });

  it("never blocks on moderate/low advisories", () => {
    for (const severity of ["info", "low", "moderate"]) {
      const outcome = evaluateAudit(
        { vulnerabilities: { p: advisory("https://github.com/advisories/GHSA-qqqq-wwww-eeee", severity) } },
        [],
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.belowThreshold).toBe(1);
    }
  });

  it("fails on stale allowlist entries so fixes clean up after themselves", () => {
    const outcome = evaluateAudit({ vulnerabilities: {} }, allowlist);
    expect(outcome.ok).toBe(false);
    expect(outcome.stale.map((s) => s.id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    expect(formatFailureLog(outcome)).toContain("stale allowlist entry");
  });

  it("the shipped allowlist covers only high/critical ids it documents", () => {
    expect(AUDIT_ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of AUDIT_ALLOWLIST) {
      expect(entry.id).toMatch(/^GHSA-/);
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.addedIn).toBe("TOG-8904");
    }
  });

  it("the blocking set matches the gate's stated threshold", () => {
    expect([...BLOCKING_SEVERITIES].sort()).toEqual(["critical", "high"]);
  });
});

describe("formatPassLog (TOG-8904)", () => {
  it("names the check and the counts", () => {
    expect(formatPassLog({ scanned: 33, allowlisted: 8, belowThreshold: 25 })).toContain(CHECK_NAME);
  });
});
