import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isR2Enabled, resolvePreflightInput } from "./lib/r2Preflight.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const gate = fileURLToPath(new URL("./check-r2-deploy-config.mjs", import.meta.url));
const preflight = fileURLToPath(new URL("./check-r2-preflight.mjs", import.meta.url));
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

    assert.throws(() => assertParity({ ...input, bucket: null }, output), {
      name: "AssertionError",
      message: /Preflight has no R2 bucket/,
    });
    assert.throws(() => assertParity({ ...input, bucket: `${input.bucket}-skew` }, output), {
      name: "AssertionError",
      message: /Preflight R2 bucket mismatches Wrangler output/,
    });
    assert.throws(() => assertParity({ ...input, enabled: !input.enabled }, output), {
      name: "AssertionError",
      message: /Preflight R2 enabled flag mismatches Wrangler output/,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// --- R2 on/off semantics: what the flag MEANS, not just its literal ---
//
// assertParity above pins that the preflight input and the Wrangler dry-run
// agree on the flag literal and bucket name. These pins cover the meaning:
// how resolvePreflightInput turns config into a verdict input, what verdict
// each input produces through the preflight wrapper, and what the Worker
// itself sees in a dry-run. Hermetic like the rest of the suite: synthetic
// TOML, wrangler dry-run only, CLOUDFLARE_* stripped.

function fixtureToml({ flag, bucketName = "r2-semantics-fixture" } = {}) {
  const lines = [
    'name = "r2-semantics-fixture"',
    'main = "worker.mjs"',
    'compatibility_date = "2025-01-01"',
    "",
  ];
  if (flag !== undefined) lines.push("[vars]", `SNAPSHOTS_R2_ENABLED = "${flag}"`, "");
  if (bucketName !== null) {
    lines.push("[[r2_buckets]]", 'binding = "SNAPSHOTS"', `bucket_name = "${bucketName}"`, "");
  }
  return lines.join("\n");
}

function scratchDir(prefix) {
  return mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), prefix));
}

function runPreflight(config, env = {}) {
  // PATH points at the fixture dir (which holds no `npx`): the offline
  // branches below must resolve their verdict before any lookup, so a
  // lookup attempt would fail resolving `npx` instead of passing. A SKIP
  // or the no-bucket FAIL therefore proves no lookup was attempted.
  const result = spawnSync(process.execPath, [preflight, `--config=${config}`], {
    cwd: root,
    env: { ...cleanEnv(), PATH: join(config, ".."), ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("isR2Enabled disables only on exactly-false and defaults on when unset", () => {
  for (const raw of ["false", "FALSE", "False"]) assert.equal(isR2Enabled(raw), false, JSON.stringify(raw));
  for (const raw of [undefined, null, "true", "TRUE", "", "0", "yes"]) {
    assert.equal(isR2Enabled(raw), true, JSON.stringify(raw));
  }
});

test("resolvePreflightInput: disabled with no binding resolves to skip inputs", () => {
  assert.deepEqual(
    resolvePreflightInput({ tomlText: fixtureToml({ flag: "false", bucketName: null }) }),
    { enabled: false, bucket: null },
  );
});

test("resolvePreflightInput: enabled with a binding resolves to lookup inputs", () => {
  assert.deepEqual(
    resolvePreflightInput({ tomlText: fixtureToml({ flag: "true", bucketName: "r2-semantics-fixture" }) }),
    { enabled: true, bucket: "r2-semantics-fixture" },
  );
});

test("resolvePreflightInput: enabled with no binding resolves to fail-closed inputs", () => {
  assert.deepEqual(
    resolvePreflightInput({ tomlText: fixtureToml({ flag: "true", bucketName: null }) }),
    { enabled: true, bucket: null },
  );
});

test("resolvePreflightInput: an absent flag defaults on", () => {
  assert.deepEqual(
    resolvePreflightInput({ tomlText: fixtureToml({ bucketName: "r2-semantics-fixture" }) }),
    { enabled: true, bucket: "r2-semantics-fixture" },
  );
});

test("resolvePreflightInput: only the top-level config counts, env sections are ignored", () => {
  const tomlText = [
    'name = "r2-semantics-fixture"',
    "[env.test.vars]",
    'SNAPSHOTS_R2_ENABLED = "false"',
    "[[env.test.r2_buckets]]",
    'binding = "SNAPSHOTS"',
    'bucket_name = "env-only-bucket"',
    "",
  ].join("\n");
  assert.deepEqual(resolvePreflightInput({ tomlText }), { enabled: true, bucket: null });
});

test("disabled with no binding passes as SKIPPED with no lookup, and shell vars cannot re-enable it", () => {
  const scratch = scratchDir("r2-semantics-skip-");
  try {
    const config = join(scratch, "disabled-no-bucket.toml");
    writeFileSync(config, fixtureToml({ flag: "false", bucketName: null }));
    const skipped = runPreflight(config);
    assert.equal(skipped.status, 0, skipped.output);
    assert.match(skipped.output, /r2-preflight: SKIPPED/);

    const shellOverride = runPreflight(config, {
      SNAPSHOTS_R2_ENABLED: "true",
      SNAPSHOTS_BUCKET: "wrong-shell-bucket",
    });
    assert.equal(shellOverride.status, 0, shellOverride.output);
    assert.match(shellOverride.output, /r2-preflight: SKIPPED/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("enabled with no binding fails closed on the missing binding before any lookup", () => {
  const scratch = scratchDir("r2-semantics-nobucket-");
  try {
    const config = join(scratch, "enabled-no-bucket.toml");
    writeFileSync(config, fixtureToml({ flag: "true", bucketName: null }));
    const failed = runPreflight(config);
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /no \[\[r2_buckets\]\] binding "SNAPSHOTS"/);
    assert.doesNotMatch(failed.output, /could not be verified/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a disabled no-bucket fixture dry-runs with the var off and no binding (the Worker-side meaning of off)", () => {
  const scratch = scratchDir("r2-semantics-dryrun-");
  try {
    writeFileSync(join(scratch, "worker.mjs"), 'export default { fetch() { return new Response("fixture"); } };');
    const config = join(scratch, "disabled-no-bucket.toml");
    writeFileSync(config, fixtureToml({ flag: "false", bucketName: null }));
    assert.deepEqual(
      resolvePreflightInput({ tomlText: readFileSync(config, "utf8") }),
      { enabled: false, bucket: null },
    );

    const result = spawnSync(process.execPath, [
      wrangler, "deploy", "--dry-run", "--config", config,
      "--outdir", join(scratch, "out"),
    ], { cwd: root, env: cleanEnv(), encoding: "utf8", timeout: 120_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout + result.stderr;
    assert.ok(output.includes('env.SNAPSHOTS_R2_ENABLED ("false")'), output);
    assert.ok(!output.includes("env.SNAPSHOTS ("), `a disabled no-bucket Worker must have no R2 binding: ${output}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
