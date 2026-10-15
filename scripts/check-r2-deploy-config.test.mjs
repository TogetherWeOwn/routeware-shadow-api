/**
 * Failing-first acceptance tests for roadmap item R9-14
 * ([TOG-25328](/TOG/issues/TOG-25328), build card [TOG-25333](/TOG/issues/TOG-25333)):
 * pin `scripts/check-r2-deploy-config.mjs` as the R2 deploy-config parity gate.
 *
 * Contract under test (the Builder implements this in
 * `scripts/check-r2-deploy-config.mjs` and never edits this file):
 *
 *   node scripts/check-r2-deploy-config.mjs [--config=FILE]
 *
 * - Default (or `--config=wrangler.toml`): check the committed config; exit 0
 *   with an OK/PASS marker (this is also what CI runs bare).
 * - `--config=<fixture>`: check that wrangler config instead; exit nonzero
 *   with a FAIL marker when the R2 enabled-flag and the SNAPSHOTS
 *   binding/bucket disagree (the skew fixtures below), exit 0 when the
 *   config is intentionally R2-disabled with no bucket bound.
 *
 * Each fixture mutation flips exactly one test: rename the binding or drop
 * the bucket block in a fixture and only its test changes outcome. Reviewer
 * path: mutate one fixture, re-run
 * `node --test scripts/check-r2-deploy-config.test.mjs`, confirm exactly one
 * test flips.
 *
 * Hermetic by construction: synthetic fixture configs only, no `src/`
 * changes, and the child environment is scrubbed of Cloudflare credentials
 * (mirroring the gate script's own `cleanEnv`), so a run can never touch
 * live Cloudflare or need the network for auth. A generous spawn timeout
 * keeps a regressed network-dependent gate from hanging the suite.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const gate = fileURLToPath(new URL("./check-r2-deploy-config.mjs", import.meta.url));
const fixture = (name) =>
  fileURLToPath(new URL(`./fixtures/r2-deploy-config/${name}`, import.meta.url));
const committedConfig = fileURLToPath(new URL("../wrangler.toml", import.meta.url));

function runGate(args = []) {
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  // Never hand the gate ambient Cloudflare credentials: the parity check is
  // credential-free, and a lookup that needs the network must fail in here,
  // not reach live Cloudflare.
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLOUDFLARE_") || key.startsWith("CF_")) delete env[key];
  }
  const result = spawnSync(process.execPath, [gate, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("r2-deploy-config gate passes on the committed config (bare, the CI invocation)", () => {
  const result = runGate();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /OK|PASS/, "gate must report success on the committed config");
});

test("r2-deploy-config gate passes on the committed config via explicit --config", () => {
  const result = runGate([`--config=${committedConfig}`]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /OK|PASS/, "gate must report success on the committed config");
});

test("r2-deploy-config gate fails on a renamed SNAPSHOTS binding", () => {
  const result = runGate([`--config=${fixture("renamed-binding.toml")}`]);
  assert.notEqual(result.status, 0, `gate must fail closed on a renamed binding:\n${result.output}`);
  assert.match(result.output, /FAIL/i, "gate must say FAIL on a renamed binding");
});

test("r2-deploy-config gate fails when R2 is enabled but no bucket is bound", () => {
  const result = runGate([`--config=${fixture("enabled-no-bucket.toml")}`]);
  assert.notEqual(
    result.status,
    0,
    `gate must fail closed when the preflight has nothing to verify:\n${result.output}`
  );
  assert.match(result.output, /FAIL/i, "gate must say FAIL when R2 is enabled with no bucket bound");
});

test("r2-deploy-config gate still passes when R2 is disabled with no bucket", () => {
  const result = runGate([`--config=${fixture("disabled-no-bucket.toml")}`]);
  assert.equal(result.status, 0, result.output);
  assert.match(
    result.output,
    /OK|PASS|SKIPPED/,
    "gate must report success/skip for an intentionally disabled config"
  );
});
