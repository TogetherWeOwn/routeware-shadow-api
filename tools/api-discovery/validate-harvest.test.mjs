/**
 * Acceptance tests for tools/api-discovery/validate-harvest.mjs (roadmap R9-16).
 *
 * Hermetic by construction: each test copies the REAL validate-harvest.mjs into a
 * fresh temp dir, lays down a synthetic out/harvest.ndjson beside it, and spawns
 * it with `node`. No live Routeware, no browser, no network; the repo's own
 * tools/api-discovery/out/ is never touched (the script resolves everything
 * relative to its own __dirname).
 *
 * Run: `node --test tools/api-discovery/validate-harvest.test.mjs`
 * (kept out of the root vitest run on purpose — vitest only includes
 * `test/**.test.ts`, so root `npm test` is untouched).
 *
 * Post-review contract (Paperclip Review on PR #272): the build card
 * extends this file only to pin
 * reviewer-mandated behavior, keeping every other pin intact. Reviewer
 * check: each fixture mutation below flips exactly one test.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir(),
    "validate-harvest-"
  ));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  // Test the real implementation: copy the script under test into the sandbox
  // so its __dirname-relative read (out/harvest.ndjson) stays isolated.
  fs.copyFileSync(
    path.join(toolsDir, "validate-harvest.mjs"),
    path.join(dir, "validate-harvest.mjs")
  );
  fs.cpSync(path.join(toolsDir, "lib"), path.join(dir, "lib"), { recursive: true });
  return dir;
}

function run(dir, flags = []) {
  const result = spawnSync(process.execPath, [path.join(dir, "validate-harvest.mjs"), ...flags], {
    cwd: dir,
    // Minimal env: the script needs no tokens or .dev.vars; prove it.
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` };
}

function goodLine(pathname = "/WebRW/Customer/CustomersRead", method = "POST") {
  return JSON.stringify({ ts: "2026-10-15T00:00:00.000Z", method, pathname });
}

test("fails on a malformed ndjson line", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(
    path.join(dir, "out", "harvest.ndjson"),
    `${goodLine()}\nthis is not json{\n`,
    "utf8"
  );

  const result = run(dir, ["--json"]);
  assert.equal(result.status, 1, `expected exit 1 on malformed line, got ${result.status}: ${result.output}`);
  let body;
  assert.doesNotThrow(() => { body = JSON.parse(result.stdout); }, "--json must emit structured diagnostics");
  assert.equal(body.schemaVersion, 1);
  assert.ok(body.findings.some((finding) => finding.code === "HARVEST_INVALID_JSON" && finding.line === 2 && finding.field === "$"));
});

test("fails when a line misses a required field", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(
    path.join(dir, "out", "harvest.ndjson"),
    `${JSON.stringify({ ts: "2026-10-15T00:00:00.000Z", method: "POST" })}\n`,
    "utf8"
  );

  const result = run(dir, ["--json"]);
  assert.equal(result.status, 1, `expected exit 1 on missing field, got ${result.status}: ${result.output}`);
  let body;
  assert.doesNotThrow(() => { body = JSON.parse(result.stdout); }, "--json must emit structured diagnostics");
  assert.equal(body.schemaVersion, 1);
  assert.ok(body.findings.some((finding) => finding.code === "HARVEST_PATH_INVALID" && finding.line === 1 && finding.field === "pathname"));
});

test("passes when the harvest file is missing", (t) => {
  const dir = sandbox(t);
  // No out/harvest.ndjson on purpose.

  const result = run(dir);
  assert.equal(result.status, 0, `missing harvest file must stay exit 0: ${result.output}`);
  assert.match(result.output, /skip/);
});

test("passes on a clean harvest", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(
    path.join(dir, "out", "harvest.ndjson"),
    `${goodLine()}\n${goodLine("/WebRW/Customer/AddNewLong", "GET")}\n`,
    "utf8"
  );

  const result = run(dir);
  assert.equal(result.status, 0, `expected exit 0 on clean harvest: ${result.output}`);
  assert.match(result.output, /OK, 2 lines checked/);
  assert.doesNotMatch(result.output, /killeen\.routeware\.com/);
});
