#!/usr/bin/env node
/** Credential-free regression: preflight and Wrangler must deploy the same R2 config. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "r2-deploy-config-"));
const require = createRequire(import.meta.url);
const wrangler = require.resolve("wrangler/bin/wrangler.js");
const lookupLog = join(scratch, "lookup.json");
const bin = join(scratch, "bin");
const wrapper = join(root, "scripts/check-r2-preflight.mjs");
const cleanEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
// Dry-runs bundle only; don't give fixture commands ambient Cloudflare credentials.
for (const key of Object.keys(cleanEnv)) {
  if (key.startsWith("CLOUDFLARE_") || key.startsWith("CF_")) delete cleanEnv[key];
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root, env, encoding: "utf8", timeout: 120_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

function preflight(config, extraEnv = {}, extraArgs = []) {
  rmSync(lookupLog, { force: true });
  return run(process.execPath, [wrapper, `--config=${config}`, ...extraArgs], {
    ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, LOOKUP_LOG: lookupLog,
    SNAPSHOTS_R2_ENABLED: "false", SNAPSHOTS_BUCKET: "wrong-shell-bucket", ...extraEnv,
  });
}

function dryRun(config, enabled, hasBucket = true) {
  const result = run(process.execPath, [wrangler, "deploy", "--dry-run", "--config", config, "--outdir", join(scratch, `out-${enabled}-${hasBucket}`)], {
    ...cleanEnv, SNAPSHOTS_R2_ENABLED: enabled === "true" ? "false" : "true",
    SNAPSHOTS_BUCKET: "wrong-shell-bucket",
  });
  assert.equal(result.status, 0, result.output);
  assert.ok(result.output.includes(`env.SNAPSHOTS_R2_ENABLED ("${enabled}")`), result.output);
  if (hasBucket) assert.ok(result.output.includes("env.SNAPSHOTS (r2-config-regression)"), result.output);
  else assert.ok(!result.output.includes("env.SNAPSHOTS ("), result.output);
  assert.ok(!result.output.includes("wrong-shell-bucket"), result.output);
}

try {
  mkdirSync(bin);
  writeFileSync(join(bin, "npx"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.LOOKUP_LOG, JSON.stringify(process.argv.slice(2)));
process.exit(process.env.LOOKUP_FAIL === "true" ? 1 : 0);
`, { mode: 0o755 });
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(join(scratch, "worker.mjs"), 'export default { fetch() { return new Response("fixture"); } };');

  const configText = (enabled, hasBucket = true) => [
    'name = "r2-config-regression"', 'main = "worker.mjs"', 'compatibility_date = "2025-01-01"',
    "[vars]", `SNAPSHOTS_R2_ENABLED = "${enabled}"`,
    ...(hasBucket ? ['[[r2_buckets]]', 'binding = "SNAPSHOTS"', 'bucket_name = "r2-config-regression"'] : []),
    "",
  ].join("\n");
  const enabledConfig = join(scratch, "enabled.toml");
  const disabledConfig = join(scratch, "disabled.toml");
  const noBucketConfig = join(scratch, "disabled-no-bucket.toml");
  writeFileSync(enabledConfig, configText("true"));
  writeFileSync(disabledConfig, configText("false"));
  writeFileSync(noBucketConfig, configText("false", false));

  const pass = preflight(enabledConfig);
  assert.equal(pass.status, 0, pass.output);
  assert.match(pass.output, /r2-preflight: PASS/);
  assert.deepEqual(JSON.parse(readFileSync(lookupLog, "utf8")), [
    "wrangler", "r2", "bucket", "info", "r2-config-regression", "--json", "--config", enabledConfig,
  ]);
  dryRun(enabledConfig, "true");

  const missing = preflight(enabledConfig, { LOOKUP_FAIL: "true" });
  assert.equal(missing.status, 1, missing.output);
  assert.match(missing.output, /Fix: npx wrangler r2 bucket create r2-config-regression/);
  assert.ok(readFileSync(lookupLog, "utf8").includes('"info"'));

  for (const config of [disabledConfig, noBucketConfig]) {
    const skipped = preflight(config, { SNAPSHOTS_R2_ENABLED: "true" });
    assert.equal(skipped.status, 0, skipped.output);
    assert.match(skipped.output, /r2-preflight: SKIPPED/);
    assert.throws(() => readFileSync(lookupLog), { code: "ENOENT" });
    dryRun(config, "false", config === disabledConfig);
  }

  const invalidOverride = preflight(enabledConfig, {}, ["--bucket=wrong-cli-bucket"]);
  assert.equal(invalidOverride.status, 1, invalidOverride.output);
  assert.throws(() => readFileSync(lookupLog), { code: "ENOENT" });
  console.log("OK: R2 preflight/deployed flag and binding agree; shell overrides cannot bypass the lookup; disabled config skips; missing bucket fails closed (offline)");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
