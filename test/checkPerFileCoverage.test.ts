import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Wrapper tests for `scripts/check-per-file-coverage.mjs`.
 *
 * The pure rule is covered by `perFileCoverage.test.ts`; this file pins
 * what only the wrapper does — flag parsing and exit codes (0 every file
 * tested-or-allowlisted / 1 untested, graduated, or stale file / 2
 * missing-or-malformed input) and the single error prefix. Everything
 * runs offline through the `--summary` / `--allowlist` fixture flags: no
 * coverage run, no Cloudflare credentials, no network.
 *
 * Runs in the node pool (see vitest.config.ts): spawning a child process
 * and writing temp fixtures need real node APIs, unavailable in workerd.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRAPPER = path.join(REPO_ROOT, "scripts/check-per-file-coverage.mjs");

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "per-file-coverage-fixtures-"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function summaryFile(name: string, files: Array<[string, number, number]>): string {
  const summary: Record<string, unknown> = {
    total: { statements: { total: 100, covered: 50, skipped: 0, pct: 50 } },
  };
  for (const [file, covered, total] of files) {
    summary[`/repo/${file}`] = {
      statements: { total, covered, skipped: 0, pct: total === 0 ? 100 : (covered / total) * 100 },
    };
  }
  const file = path.join(fixtureDir, name);
  writeFileSync(file, JSON.stringify(summary), "utf8");
  return file;
}

function allowlistFile(name: string, files: Array<{ path: string; reason: string }> = []): string {
  const file = path.join(fixtureDir, name);
  writeFileSync(file, JSON.stringify({ files }), "utf8");
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

describe("check-per-file-coverage wrapper", () => {
  it("exits 0 when every file is tested or allowlisted", () => {
    const run = runWrapper([
      `--summary=${summaryFile("ok.json", [["src/a.ts", 5, 10], ["src/lib/vendorLogin.ts", 0, 88]])}`,
      `--allowlist=${allowlistFile("ok.allowlist.json", [
        { path: "src/lib/vendorLogin.ts", reason: "vendor SDK login, untestable in CI" },
      ])}`,
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("per-file-coverage: OK");
    expect(run.stdout).toContain("2 src files tested or allowlisted (1 allowlisted)");
  });

  it("exits 1 naming a new uncovered file", () => {
    const run = runWrapper([
      `--summary=${summaryFile("untested.json", [["src/lib/brandNew.ts", 0, 40]])}`,
      `--allowlist=${allowlistFile("untested.allowlist.json")}`,
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "per-file-coverage: src/lib/brandNew.ts: 0/40 statements covered",
    );
  });

  it("exits 2 with a single error prefix on malformed summary JSON", () => {
    const file = path.join(fixtureDir, "bad.json");
    writeFileSync(file, "not json", "utf8");
    const run = runWrapper([`--summary=${file}`, `--allowlist=${allowlistFile("bad.allowlist.json")}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("per-file-coverage: coverage summary is not valid JSON");
    expect(run.stderr).not.toContain("per-file-coverage: per-file-coverage:");
  });

  it("exits 2 on a summary with zero src entries — never pass a report that inspected nothing", () => {
    const file = path.join(fixtureDir, "empty.json");
    writeFileSync(file, "{}", "utf8");
    const run = runWrapper([`--summary=${file}`, `--allowlist=${allowlistFile("empty.allowlist.json")}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(
      "per-file-coverage: coverage summary contains no src file entries",
    );
    expect(run.stderr).not.toContain("per-file-coverage: per-file-coverage:");
  });

  it("exits 2 when the summary file is missing — never a pass", () => {
    const run = runWrapper([
      `--summary=${path.join(fixtureDir, "nope.json")}`,
      `--allowlist=${allowlistFile("missing-summary.allowlist.json")}`,
    ]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("cannot read coverage summary");
  });

  it("exits 2 when the allowlist file is missing — never a pass", () => {
    const run = runWrapper([
      `--summary=${summaryFile("missing-allowlist.json", [["src/a.ts", 1, 10]])}`,
      `--allowlist=${path.join(fixtureDir, "nope.allowlist.json")}`,
    ]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("cannot read allowlist");
  });

  it("exits 2 on an empty --summary flag instead of falling back to the real tree", () => {
    const run = runWrapper(["--summary=", `--allowlist=${allowlistFile("empty-flag.allowlist.json")}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("cannot read coverage summary");
  });
});
