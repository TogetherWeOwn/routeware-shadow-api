import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Pin for the db:seed target-shape guard: flag-looking and control-char
 * persist targets must fail closed (exit 2, zero subprocesses) because
 * Wrangler's argv parser could reinterpret them. Companion to the frozen
 * `test/dbSeedCliContract.acceptance.test.ts` INVALID table, which covers
 * only empty/whitespace/bare/duplicate targets — never dash-leading or
 * embedded-control values.
 *
 * Hermetic: executes a sandbox copy of the real wrapper with a PATH
 * containing only a logging stub. Never inherits credentials, touches a
 * real database, or permits network access. Node-only (spawns child
 * processes, which workerd cannot do); routed to the root Node project.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
const suiteDir = mkdtempSync(path.join(SCRATCH, "db-seed-target-shape-"));
afterAll(() => rmSync(suiteDir, { recursive: true, force: true }));

// Record the invocation, then answer with a valid empty envelope. Any entry
// in the log proves the wrapper forwarded to a runner instead of rejecting.
const RUNNER = `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.SEED_TEST_LOG, process.argv.slice(1).join(" ") + "\\n");
process.stdout.write(JSON.stringify([{ results: [], success: true }]));
`;

type Run = { status: number | null; stdout: string; stderr: string; invocations: string[] };

function runCli(args: string[]): Run {
  const dir = mkdtempSync(path.join(suiteDir, "case-"));
  const workspace = path.join(dir, "workspace");
  const bin = path.join(dir, "bin");
  const control = path.join(dir, "control");
  for (const folder of [workspace, bin, control]) mkdirSync(folder);
  cpSync(path.join(ROOT, "scripts"), path.join(workspace, "scripts"), { recursive: true });
  const log = path.join(control, "runner.log");
  writeFileSync(log, "");
  for (const executable of ["npx", "wrangler"]) {
    writeFileSync(path.join(bin, executable), RUNNER, { mode: 0o755 });
  }
  const result = spawnSync(process.execPath, [path.join(workspace, "scripts/db-seed.mjs"), ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    // Deliberately NOT ...process.env: no actual token, HOME or npm hook.
    env: {
      PATH: bin,
      HOME: path.join(workspace, "home"),
      TMPDIR: path.join(workspace, "tmp"),
      SEED_TEST_LOG: log,
    },
  });
  expect(result.error, "CLI harness must complete without spawn/timeout errors").toBeUndefined();
  expect(result.signal, "CLI must exit normally").toBeNull();
  const invocations = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, invocations };
}

function expectInvalidTarget(run: Run) {
  expect(run.status).toBe(2);
  expect(run.invocations, "rejected target must spawn nothing").toEqual([]);
  const output = JSON.parse(run.stdout);
  expect(output).toMatchObject({
    stage: "arguments",
    outcome: "error",
    error: { code: "DB_SEED_INVALID_TARGET", retryable: false },
  });
  expect(output.error.next_action).toContain("./");
}

describe("db:seed target shape", () => {
  it.each([["--persist-to=-foo"], ["--persist-to=--remote"], ["--persist-to=a\x01b"]])(
    "rejects %s with exit 2 and zero invocations",
    (target) => {
      expectInvalidTarget(runCli([target, "--json"]));
    },
  );

  it("rejects dash-leading targets in human output too", () => {
    const run = runCli(["--persist-to=-foo"]);
    expect(run.status).toBe(2);
    expect(run.invocations, "rejected target must spawn nothing").toEqual([]);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("DB_SEED_INVALID_TARGET");
  });

  it("accepts a ./-prefixed leading-dash path", () => {
    const run = runCli(["--persist-to=./-foo", "--dry-run", "--json"]);
    expect(run.status).toBe(0);
    expect(run.invocations, "dry-run must spawn nothing").toEqual([]);
    const output = JSON.parse(run.stdout);
    expect(output).toMatchObject({ stage: "plan", outcome: "planned", target: { persistTo: "./-foo" } });
  });
});
