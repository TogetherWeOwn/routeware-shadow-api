import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Wrapper tests for `scripts/check-coverage-ratchet.mjs`.
 *
 * The pure rule is covered by `coverageRatchet.test.ts`; this file pins
 * what only the wrapper does — flag parsing and exit codes (0 match / 1
 * stale-or-regressed / 2 missing-or-malformed input), the single error
 * prefix, and the verbatim paste-ready `thresholds` block. Everything runs
 * offline through the `--summary` / `--config` fixture flags: no coverage
 * run, no Cloudflare credentials, no network.
 *
 * Runs in the node pool (see vitest.config.ts): spawning a child process
 * and writing temp fixtures need real node APIs, unavailable in workerd.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRAPPER = path.join(REPO_ROOT, "scripts/check-coverage-ratchet.mjs");

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "coverage-ratchet-fixtures-"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function configFile(name: string, floors: Record<string, number>): string {
  const block = Object.entries(floors)
    .map(([metric, floor]) => `        ${metric}: ${floor},`)
    .join("\n");
  const file = path.join(fixtureDir, name);
  writeFileSync(file, `export default { test: { coverage: { thresholds: {\n${block}\n      } } } };\n`, "utf8");
  return file;
}

function summaryFile(name: string, pcts: Record<string, number>): string {
  const total: Record<string, { total: number; covered: number; skipped: number; pct: number }> = {};
  for (const [metric, pct] of Object.entries(pcts)) {
    total[metric] = { total: 100, covered: pct, skipped: 0, pct };
  }
  const file = path.join(fixtureDir, name);
  writeFileSync(file, JSON.stringify({ total }), "utf8");
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

const FLOORS = { statements: 87, branches: 81, functions: 91, lines: 87 };
const AT_FLOOR = { statements: 87.4, branches: 81.2, functions: 91, lines: 87 };

describe("check-coverage-ratchet wrapper", () => {
  it("exits 0 when every floor matches its measurement", () => {
    const run = runWrapper([
      `--summary=${summaryFile("ok.json", AT_FLOOR)}`,
      `--config=${configFile("ok.ts", FLOORS)}`,
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("coverage-ratchet: OK");
  });

  it("exits 1 with a paste-ready thresholds block when a metric climbs a full point", () => {
    const run = runWrapper([
      `--summary=${summaryFile("stale.json", { ...AT_FLOOR, statements: 88.3 })}`,
      `--config=${configFile("stale.ts", FLOORS)}`,
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("coverage-ratchet: statements: measured 88.3% implies floor 88");
    expect(run.stderr).toContain("statements: 88,");
    // The block prints verbatim: no stray check-name prefix on its lines.
    expect(run.stderr).not.toContain("coverage-ratchet:       thresholds");
    expect(run.stderr).not.toContain("coverage-ratchet:         statements");
  });

  it("exits 1 on a below-floor regression, never auto-lowering", () => {
    const run = runWrapper([
      `--summary=${summaryFile("regressed.json", { ...AT_FLOOR, branches: 80.5 })}`,
      `--config=${configFile("regressed.ts", FLOORS)}`,
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is below floor 81 — regression");
  });

  it("exits 2 with a single error prefix on malformed summary JSON", () => {
    const file = path.join(fixtureDir, "bad.json");
    writeFileSync(file, "not json", "utf8");
    const run = runWrapper([`--summary=${file}`, `--config=${configFile("bad.ts", FLOORS)}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("coverage-ratchet: coverage summary is not valid JSON");
    expect(run.stderr).not.toContain("coverage-ratchet: coverage-ratchet:");
  });

  it("exits 2 when the summary file is missing — never a pass", () => {
    const run = runWrapper([
      `--summary=${path.join(fixtureDir, "nope.json")}`,
      `--config=${configFile("missing.ts", FLOORS)}`,
    ]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("cannot read coverage summary");
  });

  it("exits 2 on an empty --summary flag instead of falling back to the real tree", () => {
    const run = runWrapper(["--summary=", `--config=${configFile("empty.ts", FLOORS)}`]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("cannot read coverage summary");
  });
});
