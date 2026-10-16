import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePreflightInput } from "./lib/r2Preflight.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const gate = fileURLToPath(new URL("./check-r2-deploy-config.mjs", import.meta.url));
const require = createRequire(import.meta.url);
const wrangler = require.resolve("wrangler/bin/wrangler.js");

function cleanEnv() {
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLOUDFLARE_") || key.startsWith("CF_")) delete env[key];
  }
  return env;
}

function assertParity(input, output) {
  assert.ok(output.includes(`env.SNAPSHOTS_R2_ENABLED ("${input.enabled}")`), output);
  if (input.bucket) assert.ok(output.includes(`env.SNAPSHOTS (${input.bucket})`), output);
  else assert.ok(!output.includes("env.SNAPSHOTS ("), output);
}

test("R2 deploy-config parity gate passes on the committed config offline", () => {
  const result = spawnSync(process.execPath, [gate], {
    cwd: root,
    env: cleanEnv(),
    encoding: "utf8",
    timeout: 120_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /R2 preflight\/deployed flag and binding agree/);
});

test("committed preflight config matches Wrangler dry-run, and skew is rejected", () => {
  const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "r2-config-test-"));
  try {
    const result = spawnSync(process.execPath, [
      wrangler, "deploy", "--dry-run", "--config", join(root, "wrangler.toml"),
      "--outdir", join(scratch, "out"),
    ], { cwd: root, env: cleanEnv(), encoding: "utf8", timeout: 120_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const committed = readFileSync(join(root, "wrangler.toml"), "utf8");
    assertParity(resolvePreflightInput({ tomlText: committed }), result.stdout + result.stderr);
    const renamedBinding = committed.replace('binding = "SNAPSHOTS"', 'binding = "RENAMED_SNAPSHOTS"');
    assert.notEqual(renamedBinding, committed, "binding skew fixture must change the config");
    assert.throws(() => assertParity(resolvePreflightInput({ tomlText: renamedBinding }), result.stdout + result.stderr), {
      name: "AssertionError",
    });

    const disagreeingPreflight = committed.replace('SNAPSHOTS_R2_ENABLED = "true"', 'SNAPSHOTS_R2_ENABLED = "false"');
    assert.notEqual(disagreeingPreflight, committed, "preflight skew fixture must change the config");
    assert.throws(() => assertParity(resolvePreflightInput({ tomlText: disagreeingPreflight }), result.stdout + result.stderr), {
      name: "AssertionError",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
