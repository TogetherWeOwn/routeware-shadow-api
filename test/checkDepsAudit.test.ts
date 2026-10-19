import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * report. Everything runs offline: either through the `--audit-json` /
 * `--discovery-audit-json` fixture flags, or through a fake `npm` shim on
 * PATH that records its argv/cwd and replays canned audit JSON — the live
 * `npm audit` path (exact flags per scope, nonzero-exit stdout parsing) is
 * pinned without ever reaching the registry.
 *
 * Runs in the node pool (see vitest.config.ts): spawning a child process
 * and writing temp fixtures need real node APIs, unavailable in workerd.
 * The fake-npm tests are POSIX-only (executable shim); repo CI is
 * ubuntu-latest.
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

function runWrapper(args: string[], options: { env?: Record<string, string> } = {}) {
  const result = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
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

/**
 * Fake `npm` shim: records each invocation's cwd + argv to `$FAKE_NPM_LOG`,
 * then replays canned audit JSON per scope (`$FAKE_NPM_ROOT_JSON` /
 * `$FAKE_NPM_DISCOVERY_JSON`) and exits per scope
 * (`$FAKE_NPM_ROOT_EXIT` / `$FAKE_NPM_DISCOVERY_EXIT`, default 0).
 * `$FAKE_NPM_MODE=no-stdout` exits 1 with no output (npm itself failed).
 * Written with string concatenation (no `${}`) so the outer template
 * literal needs no escapes.
 */
const FAKE_NPM_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const log = process.env.FAKE_NPM_LOG;
const discoveryTail = ["tools", "api-discovery"].join(path.sep);
const isDiscovery = process.cwd().endsWith(discoveryTail);
const tag = isDiscovery ? "DISCOVERY" : "ROOT";
fs.appendFileSync(log, tag + " cwd=" + process.cwd() + " args=" + process.argv.slice(2).join(" ") + "\\n");
if (process.env.FAKE_NPM_MODE === "no-stdout") process.exit(1);
process.stdout.write(process.env[isDiscovery ? "FAKE_NPM_DISCOVERY_JSON" : "FAKE_NPM_ROOT_JSON"]);
process.exit(Number(process.env[isDiscovery ? "FAKE_NPM_DISCOVERY_EXIT" : "FAKE_NPM_ROOT_EXIT"] || 0));
`;

/**
 * Run the wrapper with NO fixture flags against the fake npm above: the
 * wrapper takes its live `npm audit` path, but the shim shadows the real
 * npm on PATH, so no registry is ever reached.
 */
function runWithFakeNpm(extraEnv: Record<string, string>) {
  const binDir = mkdtempSync(path.join(fixtureDir, "fake-npm-"));
  writeFileSync(path.join(binDir, "npm"), FAKE_NPM_SCRIPT, { mode: 0o755 });
  const logFile = path.join(binDir, "invocations.log");
  writeFileSync(logFile, "");
  const run = runWrapper([], {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      // Simulate the ambient trap the explicit --include=dev defeats. The
      // shim ignores these, but a regression to --omit=dev (or a bare
      // `npm audit`) would still show up in the recorded argv.
      NODE_ENV: "production",
      npm_config_omit: "dev",
      // Belt-and-braces: even if the shim somehow missed, npm could only
      // dial an unroutable registry — the suite never reaches the network.
      npm_config_registry: "http://127.0.0.1:1/",
      FAKE_NPM_LOG: logFile,
      ...extraEnv,
    },
  });
  const logged = readFileSync(logFile, "utf8").trim();
  return { run, invocations: logged ? logged.split("\n") : [] };
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

  it("rejects a bare flag without =value (exit 2)", () => {
    const run = runWrapper(["--audit-json"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unknown flag: --audit-json");
  });

  it("attributes a root-only high advisory to package-lock.json alone (exit 1)", () => {
    const rootReport = cleanRootReport();
    rootReport.vulnerabilities["some-root-dep"] = advisoryEntry(
      "GHSA-r00t-0n1y-ffff",
      "high",
      "some-root-dep",
    );
    const run = runWithFixtures(rootReport, { vulnerabilities: {} });
    expect(run.status).toBe(1);
    const scopeLine = run.stderr
      .split("\n")
      .find((line) => line.trim().startsWith("scope:") && line.includes("GHSA-r00t-0n1y-ffff"));
    expect(scopeLine?.trim()).toBe("scope: GHSA-r00t-0n1y-ffff reported by package-lock.json");
  });

  it("attributes an advisory reported by both scopes to both lockfiles (exit 1)", () => {
    const rootReport = cleanRootReport();
    rootReport.vulnerabilities["shared-dep"] = advisoryEntry(
      "GHSA-b0th-sc0p-es00",
      "high",
      "shared-dep",
    );
    const run = runWithFixtures(rootReport, {
      vulnerabilities: {
        "shared-dep": advisoryEntry("GHSA-b0th-sc0p-es00", "high", "shared-dep"),
      },
    });
    expect(run.status).toBe(1);
    const scopeLine = run.stderr
      .split("\n")
      .find((line) => line.trim().startsWith("scope:") && line.includes("GHSA-b0th-sc0p-es00"));
    expect(scopeLine?.trim()).toBe(
      "scope: GHSA-b0th-sc0p-es00 reported by package-lock.json, tools/api-discovery/package-lock.json",
    );
  });

  it("fails (exit 1) on stale allowlist entries when both scopes report clean", () => {
    const run = runWithFixtures({ vulnerabilities: {} }, { vulnerabilities: {} });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("deps-audit: FAIL");
    expect(run.stderr).toContain("stale allowlist entry");
  });

  it("rejects an unreadable audit fixture (exit 2)", () => {
    const run = runWrapper([
      `--audit-json=${path.join(fixtureDir, "does-not-exist.json")}`,
      `--discovery-audit-json=${fixtureFile("discovery.json", { vulnerabilities: {} })}`,
    ]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("cannot read audit fixture");
  });

  it("rejects an unparsable audit fixture (exit 2)", () => {
    const bad = path.join(fixtureDir, "bad.json");
    writeFileSync(bad, "{not json", "utf8");
    const run = runWrapper([
      `--audit-json=${bad}`,
      `--discovery-audit-json=${fixtureFile("discovery.json", { vulnerabilities: {} })}`,
    ]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("could not parse npm audit JSON");
    expect(run.stderr).toContain("package-lock.json");
  });

  it("rejects an empty discovery fixture operand (exit 2)", () => {
    const run = runWrapper([
      `--audit-json=${fixtureFile("root.json", cleanRootReport())}`,
      "--discovery-audit-json=",
    ]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("must not be empty");
  });
});

describe("check-deps-audit npm invocation (offline fake npm)", () => {
  it("invokes npm audit with --omit=dev for root and --include=dev for discovery", () => {
    const { run, invocations } = runWithFakeNpm({
      FAKE_NPM_ROOT_JSON: JSON.stringify(cleanRootReport()),
      FAKE_NPM_DISCOVERY_JSON: JSON.stringify({
        vulnerabilities: {
          playwright: advisoryEntry("GHSA-synt-heti-cdis", "high", "some-discovery-dep"),
        },
      }),
      FAKE_NPM_ROOT_EXIT: "0",
      // npm exits 1 when vulnerabilities are found; the wrapper must still
      // parse stdout into the verdict rather than failing the run.
      FAKE_NPM_DISCOVERY_EXIT: "1",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("deps-audit: FAIL");
    expect(run.stderr).toContain(
      "scope: GHSA-synt-heti-cdis reported by tools/api-discovery/package-lock.json",
    );
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatch(/^ROOT cwd=\S+ args=audit --omit=dev --json$/);
    expect(invocations[0]).not.toContain("api-discovery");
    expect(invocations[1]).toMatch(/^DISCOVERY cwd=\S+ args=audit --include=dev --json$/);
    // The regression pin: without the explicit --include=dev, ambient
    // NODE_ENV=production / npm_config_omit=dev empties the discovery tree
    // (that package ships only devDependencies) and the gate passes vacuously.
    expect(invocations[1]).not.toContain("--omit=dev");
  });

  it("treats an npm run with no JSON on stdout as an infrastructure failure (exit 2)", () => {
    const { run, invocations } = runWithFakeNpm({ FAKE_NPM_MODE: "no-stdout" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("did not run");
    expect(run.stderr).toContain("package-lock.json");
    expect(run.stdout).not.toContain("PASS");
    // Fail-fast at the root scope: discovery npm never runs.
    expect(invocations).toHaveLength(1);
  });
});
