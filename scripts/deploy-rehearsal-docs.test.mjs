import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const checklist = fs.readFileSync(new URL("../docs/PRODUCTION-DEPLOY-DRY-RUN.md", import.meta.url), "utf8");
const blocks = [...checklist.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((match) => match[1]);
const localBlock = blocks.find((block) => block.includes("check:d1-drift"));
assert.ok(localBlock, "the documented local rehearsal must exist");

function runRehearsal({ credentialFile, scratch = "external", interactive = false, failAllocation = false } = {}) {
  const base = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir();
  const fixture = fs.mkdtempSync(path.join(base, "rehearsal-docs-test-"));
  const checkout = path.join(fixture, "checkout");
  const output = path.join(fixture, "output");
  const bin = path.join(fixture, "bin");
  const receipt = path.join(fixture, "calls");
  for (const dir of [checkout, output, bin]) fs.mkdirSync(dir);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // Stub all tools; the literal documentation runs, but never npm, Wrangler or a network request.
  stub("mktemp", `printf '%s\\n' mktemp >> ${quote(receipt)}\n${failAllocation ? "exit 1" : `printf '%s\\n' ${quote(fixture)}`}`);
  for (const name of ["npm", "npx"]) {
    stub(name, `printf '%s\\n' "${name} $*" >> ${quote(receipt)}`);
  }
  if (credentialFile) fs.writeFileSync(path.join(checkout, credentialFile), "SYNTHETIC_MARKER=not-a-credential\n");
  let scratchPath = output;
  if (scratch === "internal") scratchPath = checkout;
  if (scratch === "root") scratchPath = "/";
  if (scratch === "relative") scratchPath = "../output";
  if (scratch === "missing") scratchPath = path.join(fixture, "missing");
  if (scratch === "symlink") {
    scratchPath = path.join(fixture, "scratch-link");
    fs.symlinkSync(checkout, scratchPath);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: fixture };
  if (scratch !== "unset") env.PAPERCLIP_RUN_SCRATCH_DIR = scratchPath;
  const after = interactive ? '\nprintf "BLOCK_EXIT=%s\\n" "$?"\nprintf "PARENT_ALIVE\\n"\n' : "";
  try {
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", ...(interactive ? ["-i"] : [])], {
      cwd: checkout,
      env,
      input: "GLOBIGNORE='.env.*:.dev.vars.*'; export GLOBIGNORE; set -f\n" + localBlock + after,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.ifError(result.error);
    return {
      status: result.status,
      stdout: result.stdout,
      output: result.stdout + result.stderr,
      calls: fs.existsSync(receipt) ? fs.readFileSync(receipt, "utf8").trim().split("\n") : [],
    };
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

for (const credentialFile of [".env", ".env.local", ".env.production", ".dev.vars", ".dev.vars.production"]) {
  test(`rehearsal rejects ${credentialFile} despite caller glob configuration`, () => {
    const result = runRehearsal({ credentialFile });
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(result.calls, []);
  });
}

for (const scratch of ["unset", "relative", "missing", "internal", "symlink", "root"]) {
  test(`interactive rehearsal rejects ${scratch} scratch before allocation/tools without exiting its caller`, () => {
    const result = runRehearsal({ scratch, interactive: true });
    assert.match(result.stdout, /^BLOCK_EXIT=1$/m, result.output);
    assert.match(result.stdout, /^PARENT_ALIVE$/m, result.output);
    assert.deepEqual(result.calls, []);
  });
}

test("rehearsal stops after failed HOME allocation", () => {
  const result = runRehearsal({ failAllocation: true });
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.calls, ["mktemp"]);
});

test("clean rehearsal allows the committed example and only the documented local tools", () => {
  const result = runRehearsal({ credentialFile: ".dev.vars.example" });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.calls.length, 5);
  assert.deepEqual(result.calls.slice(0, 4), [
    "mktemp", "npm run check:ci-workflow", "npm run check:vars-parity", "npm run check:d1-drift",
  ]);
  assert.match(result.calls[4], /^npx --no-install wrangler deploy --dry-run --env= --outdir \/.*\/output\/worker-dry-run$/);
});
