import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_ALLOWLIST } from "../scripts/lib/depsAuditCheck.mjs";

/**
 * Wrapper tests for `scripts/check-deps-audit.mjs`.
 *
 * The pure helpers are covered by `depsAuditCheck.test.ts`; this file pins
 * what only the wrapper does — flag parsing, exit codes (0 pass / 1 verdict
 * fail / 2 infrastructure failure), per-scope attribution lines, and the
 * rejection of npm error JSON (ENOLOCK) that must never read as a clean
 * report. Everything runs offline through the `--audit-json` /
 * `--discovery-audit-json` fixture flags: no `npm audit`, no registry.
 *
 * Runs in the node pool (see vitest.config.ts): spawning a child process
 * and writing temp fixtures need real node APIs, unavailable in workerd.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRAPPER = path.join(REPO_ROOT, "scripts/check-deps-audit.mjs");

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "deps-audit-fixtures-"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function advisoryEntry(id: string, severity = "high", name = "some-pkg") {
  return {
    name,
    severity,
    via: [
      {
        name,
        url: `https://github.com/advisories/${id}`,
        severity,
        title: "Fixture advisory",
        range: "*",
      },
    ],
  };
}

/** Root fixture reporting exactly the shipped allowlist, so nothing is stale. */
function cleanRootReport() {
  const vulnerabilities: Record<string, { name: string; severity: string; via: unknown[] }> = {};
  for (const entry of AUDIT_ALLOWLIST) {
    // Several allowlist entries can share one package; merge their via arrays.
    const existing = vulnerabilities[entry.package];
    const fixture = advisoryEntry(entry.id, "high", entry.package);
    if (existing) {
      existing.via.push(...fixture.via);
    } else {
      vulnerabilities[entry.package] = fixture;
    }
  }
  return { vulnerabilities };
}

function fixtureFile(name: string, report: unknown): string {
  const file = path.join(fixtureDir, name);
  writeFileSync(file, JSON.stringify(report), "utf8");
  return file;
}

function runWrapper(args: string[]) {
  const result = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runWithFixtures(rootReport: unknown, discoveryReport: unknown) {
  return runWrapper([
    `--audit-json=${fixtureFile("root.json", rootReport)}`,
    `--discovery-audit-json=${fixtureFile("discovery.json", discoveryReport)}`,
  ]);
}

describe("check-deps-audit wrapper", () => {
  it("passes (exit 0) and names both lockfiles when only allowlisted advisories appear", () => {
    const run = runWithFixtures(cleanRootReport(), { vulnerabilities: {} });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("deps-audit: PASS");
    expect(run.stdout).toContain("package-lock.json:");
    expect(run.stdout).toContain("tools/api-discovery/package-lock.json: 0 advisories");
  });

  it("fails (exit 1) with scope attribution on a discovery-only high advisory", () => {
    const run = runWithFixtures(cleanRootReport(), {
      vulnerabilities: {
        playwright: advisoryEntry("GHSA-synt-heti-cdis", "high", "some-discovery-dep"),
      },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("deps-audit: FAIL");
    expect(run.stderr).toContain(
      "scope: GHSA-synt-heti-cdis reported by tools/api-discovery/package-lock.json",
    );
  });

  it("rejects npm error JSON (ENOLOCK) as an infrastructure failure (exit 2), not a pass", () => {
    const run = runWithFixtures(cleanRootReport(), {
      error: { code: "ENOLOCK", summary: "This command requires an existing lockfile." },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("tools/api-discovery/package-lock.json");
    expect(run.stderr).toContain("ENOLOCK");
    expect(run.stdout).not.toContain("PASS");
  });

  it("rejects a report with no vulnerabilities object (exit 2)", () => {
    const run = runWithFixtures(cleanRootReport(), {});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no vulnerabilities object");
  });

  it("rejects an empty-tree report covering 0 dependencies (exit 2)", () => {
    const run = runWithFixtures(cleanRootReport(), {
      vulnerabilities: {},
      metadata: { dependencies: { prod: 0, dev: 0, total: 0 } },
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("0 dependencies");
  });

  it("rejects an empty fixture operand (exit 2) instead of falling back to a live audit", () => {
    const run = runWrapper(["--audit-json="]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("must not be empty");
  });

  it("rejects unknown flags (exit 2)", () => {
    const run = runWrapper(["--nope=1"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unknown flag");
  });
});
