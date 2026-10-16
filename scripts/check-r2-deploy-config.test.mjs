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
  assert.ok(
    output.includes(`env.SNAPSHOTS_R2_ENABLED ("${input.enabled}")`),
    `Preflight R2 enabled flag mismatches Wrangler output: ${output}`,
  );
  if (input.bucket) {
    assert.ok(
      output.includes(`env.SNAPSHOTS (${input.bucket})`),
      `Preflight R2 bucket mismatches Wrangler output: ${output}`,
    );
  } else {
    assert.ok(!output.includes("env.SNAPSHOTS ("), `Preflight has no R2 bucket, but Wrangler output includes one: ${output}`);
  }
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
    const input = resolvePreflightInput({ tomlText: committed });
    const output = result.stdout + result.stderr;
    assertParity(input, output);
    assert.ok(input.bucket, "committed config must include the R2 bucket binding");

    const renamedBinding = committed.replace(
      /(^\[\[r2_buckets\]\]\n[\s\S]*?^binding\s*=\s*)"SNAPSHOTS"$/m,
      '$1"RENAMED_SNAPSHOTS"',
    );
    assert.notEqual(renamedBinding, committed, "binding skew fixture must change the top-level config");
    const renamedInput = resolvePreflightInput({ tomlText: renamedBinding });
    assert.equal(renamedInput.enabled, input.enabled, "binding skew must preserve the preflight flag");
    assert.equal(renamedInput.bucket, null, "renamed binding must not resolve to the configured bucket");
    assert.throws(() => assertParity(renamedInput, output), {
      name: "AssertionError",
      message: /Preflight has no R2 bucket/,
    });

    const mismatchedBucket = committed.replace(
      /(^\[\[r2_buckets\]\]\n[\s\S]*?^bucket_name\s*=\s*)"[^"]*"$/m,
      (_, assignment) => `${assignment}"${input.bucket}-skew"`,
    );
    assert.notEqual(mismatchedBucket, committed, "bucket-name skew fixture must change the top-level config");
    const mismatchedInput = resolvePreflightInput({ tomlText: mismatchedBucket });
    assert.equal(mismatchedInput.enabled, input.enabled, "bucket-name skew must preserve the preflight flag");
    assert.equal(mismatchedInput.bucket, `${input.bucket}-skew`, "bucket-name skew must reach the preflight input");
    assert.throws(() => assertParity(mismatchedInput, output), {
      name: "AssertionError",
      message: /Preflight R2 bucket mismatches Wrangler output/,
    });

    const disagreeingPreflight = committed.replace(
      /(^\[vars\]\n[\s\S]*?^SNAPSHOTS_R2_ENABLED\s*=\s*)"[^"]*"$/m,
      (_, assignment) => `${assignment}"${!input.enabled}"`,
    );
    assert.notEqual(disagreeingPreflight, committed, "preflight skew fixture must change the top-level config");
    const disagreeingInput = resolvePreflightInput({ tomlText: disagreeingPreflight });
    assert.equal(disagreeingInput.enabled, !input.enabled, "preflight skew fixture must disagree with the committed flag");
    assert.equal(disagreeingInput.bucket, input.bucket, "preflight skew must preserve the R2 bucket");
    assert.throws(() => assertParity(disagreeingInput, output), {
      name: "AssertionError",
      message: /Preflight R2 enabled flag mismatches Wrangler output/,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
