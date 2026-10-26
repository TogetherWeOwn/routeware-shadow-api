import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));

// Extra wrappers outside the check-*/verify-* glob. Allowlist: each must exist,
// and a future wrapper added here without --help fails loudly like the rest.
const EXTRA_WRAPPERS = [
  "smoke-readiness.mjs",
  "first-run.mjs",
  "post-deploy-probe.mjs",
  "db-seed.mjs",
];

function discoverWrappers() {
  const entries = readdirSync(scriptsDir);
  const globbed = entries.filter(
    (name) =>
      (name.startsWith("check-") || name.startsWith("verify-")) &&
      name.endsWith(".mjs") &&
      !name.endsWith(".test.mjs"),
  );
  for (const name of EXTRA_WRAPPERS) {
    assert.ok(
      entries.includes(name),
      `allowlisted wrapper missing: scripts/${name}`,
    );
  }
  const wrappers = [...globbed, ...EXTRA_WRAPPERS].sort();
  // Guard against a silently broken glob: the spec's enumeration is 20
  // (16 check-* + 2 verify-* + smoke-readiness + first-run); with the two
  // probe/seed wrappers the current total is 22. A future wrapper raises
  // this count and is automatically covered below.
  assert.ok(
    wrappers.length >= 20,
    `expected at least 20 wrappers, discovered ${wrappers.length}: ${wrappers.join(", ")}`,
  );
  return wrappers;
}

const WRAPPERS = discoverWrappers();

// Any fetch during --help/-h is a side effect: record the attempt so the
// assertion below fails loudly instead of hanging on real network.
const fetchGuard = [
  "globalThis.fetch = async () => {",
  "  console.log('HELP_TEST_FETCH_ATTEMPT');",
  "  throw new Error('network blocked in --help test');",
  "};",
].join("\n");

function runHelp(wrapperName, flag) {
  const wrapper = path.join(scriptsDir, wrapperName);
  const scratch = mkdtempSync(path.join(tmpdir(), "wrapper-help-"));
  const before = readdirSync(scratch);
  const result = spawnSync(
    process.execPath,
    [
      `--import=data:text/javascript,${encodeURIComponent(fetchGuard)}`,
      wrapper,
      flag,
    ],
    {
      cwd: scratch,
      // PATH-only: --help must work with no tokens, no .dev.vars, no hooks.
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  const after = readdirSync(scratch);
  return { result, scratch, before, after };
}

function assertHelp(wrapperName, flag) {
  const basename = path.basename(wrapperName);
  const { result, scratch, before, after } = runHelp(wrapperName, flag);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = stdout + stderr;

  assert.ifError(
    result.error,
    `${basename} ${flag}: failed to finish in 5s in ${scratch}: ${String(result.error)}`,
  );
  assert.equal(
    result.status,
    0,
    `${basename} ${flag}: expected exit 0, got ${result.status}: ${combined}`,
  );
  assert.match(
    stdout,
    /Usage:/,
    `${basename} ${flag}: expected usage on stdout, got stdout=${JSON.stringify(stdout.slice(0, 500))} stderr=${JSON.stringify(stderr.slice(0, 500))}`,
  );
  assert.doesNotMatch(
    stderr,
    /Usage:/,
    `${basename} ${flag}: usage must go to stdout, not stderr`,
  );
  assert.ok(
    stdout.includes(basename),
    `${basename} ${flag}: usage must name the script (${basename}): ${JSON.stringify(stdout.slice(0, 500))}`,
  );
  assert.match(
    stdout,
    /--\S/,
    `${basename} ${flag}: usage must list supported flags (--...): ${JSON.stringify(stdout.slice(0, 500))}`,
  );
  const nonEmpty = stdout.split("\n").filter((line) => line.trim() !== "");
  assert.ok(
    nonEmpty.length >= 2,
    `${basename} ${flag}: usage must carry a purpose line beyond the Usage header (got ${nonEmpty.length} non-empty line(s))`,
  );
  assert.doesNotMatch(
    combined,
    /HELP_TEST_FETCH_ATTEMPT/,
    `${basename} ${flag}: must perform no network requests`,
  );
  assert.deepEqual(
    after,
    before,
    `${basename} ${flag}: must write no files outside scratch (scratch ${scratch} changed: ${JSON.stringify(after)})`,
  );
}

test("wrapper discovery covers the spec enumeration", () => {
  for (const name of ["smoke-readiness.mjs", "first-run.mjs"]) {
    assert.ok(WRAPPERS.includes(name), `discovery must include ${name}`);
  }
  assert.ok(
    WRAPPERS.some((name) => name.startsWith("check-")),
    "discovery must include check-* wrappers",
  );
  assert.ok(
    WRAPPERS.some((name) => name.startsWith("verify-")),
    "discovery must include verify-* wrappers",
  );
});

for (const wrapperName of WRAPPERS) {
  describe(wrapperName, () => {
    test("--help exits 0 with usage on stdout and no side effects", () => {
      assertHelp(wrapperName, "--help");
    });
    test("-h exits 0 with usage on stdout and no side effects", () => {
      assertHelp(wrapperName, "-h");
    });
  });
}
