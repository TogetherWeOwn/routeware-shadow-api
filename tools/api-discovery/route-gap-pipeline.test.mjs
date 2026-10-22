/**
 * Pipeline tests for the harvest chain (Paperclip Review on PR #272).
 *
 * The unit pins in route-gap.test.mjs drive route-gap.mjs standalone. These
 * tests drive the real chain order from `npm run process` — validate-harvest
 * -> aggregate -> route-gap — against a synthetic sandbox, proving a fresh
 * checkout (no harvest) and an empty session stay exit 0 end to end instead
 * of failing on every route-map entry as "stale". Two further pins cover the
 * rest of the `process` wiring: route-gap.mjs --report-only must write the
 * gap report without gating the chain, and the sandbox chain order must match
 * the package `process` script step for step.
 *
 * Hermetic: the REAL scripts + lib/ are copied into a fresh temp dir and
 * spawned with `node`. No live Routeware, no browser, no network; the repo's
 * own tools/api-discovery/out/ is never touched.
 *
 * Run: `node --test tools/api-discovery/route-gap-pipeline.test.mjs`
 * (also via root `npm run test:discovery`; kept out of the root vitest run
 * on purpose — vitest only includes `test/**.test.ts`).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-gap-pipeline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  // The real chain: route-gap resolves everything relative to its __dirname.
  for (const f of ["validate-harvest.mjs", "aggregate.mjs", "route-gap.mjs"]) {
    fs.copyFileSync(path.join(toolsDir, f), path.join(dir, f));
  }
  // Copy the whole lib/ (per the header), not a file list: a hard-coded list
  // silently breaks the chain whenever a script gains a new lib module
  // (aggregate.mjs -> lib/aggregateMerge.mjs).
  for (const f of fs.readdirSync(path.join(toolsDir, "lib"))) {
    if (f.endsWith(".mjs")) {
      fs.copyFileSync(path.join(toolsDir, "lib", f), path.join(dir, "lib", f));
    }
  }
  // Synthetic map with an entry no empty harvest could ever cover.
  fs.writeFileSync(
    path.join(dir, "route-map.json"),
    JSON.stringify([
      {
        method: "POST",
        upstreamPath: "/WebRW/Customer/CustomersRead",
        shadowPath: "/api/v1/routeware/customer/customers-read",
      },
    ]),
    "utf8"
  );
  return dir;
}

function run(dir, script, ...args) {
  const result = spawnSync(process.execPath, [path.join(dir, script), ...args], {
    cwd: dir,
    // Minimal env: the chain needs no tokens or .dev.vars; prove it.
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("fresh checkout (no harvest) stays exit 0 through the whole chain", (t) => {
  const dir = sandbox(t);

  const validated = run(dir, "validate-harvest.mjs");
  assert.equal(validated.status, 0, `validate must skip exit 0: ${validated.output}`);

  const aggregated = run(dir, "aggregate.mjs");
  assert.equal(aggregated.status, 0, `aggregate must exit 0: ${aggregated.output}`);

  const gap = run(dir, "route-gap.mjs");
  assert.equal(gap.status, 0, `route-gap must exit 0 on empty aggregate, got ${gap.status}: ${gap.output}`);
  assert.match(gap.output, /nothing to compare/);

  const check = run(dir, "route-gap.mjs", "--check");
  assert.equal(check.status, 0, `trailing --check must exit 0, got ${check.status}: ${check.output}`);
});

test("recorded session missing a shadow route fails the chain gate", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(
    path.join(dir, "out", "harvest.ndjson"),
    `${JSON.stringify({ ts: "2026-10-15T00:00:00.000Z", method: "POST", pathname: "/WebRW/Customer/PhantomRead" })}\n`,
    "utf8"
  );

  assert.equal(run(dir, "validate-harvest.mjs").status, 0);
  assert.equal(run(dir, "aggregate.mjs").status, 0);

  const gap = run(dir, "route-gap.mjs");
  assert.equal(gap.status, 1, `route-gap must exit 1 on missing shadow route, got ${gap.status}: ${gap.output}`);

  const check = run(dir, "route-gap.mjs", "--check");
  assert.equal(check.status, 1, `trailing --check must exit 1, got ${check.status}: ${check.output}`);
  assert.match(check.output, /1 missing shadow route/);
});

test("report-only writes the gap report without gating the chain", (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(
    path.join(dir, "out", "harvest.ndjson"),
    `${JSON.stringify({ ts: "2026-10-15T00:00:00.000Z", method: "POST", pathname: "/WebRW/Customer/PhantomRead" })}\n`,
    "utf8"
  );

  assert.equal(run(dir, "validate-harvest.mjs").status, 0);
  assert.equal(run(dir, "aggregate.mjs").status, 0);

  // --report-only must still write the report and name the gap, but stay
  // exit 0 so the process chain can finish generating artifacts before its
  // final --check.
  const reportOnly = run(dir, "route-gap.mjs", "--report-only");
  assert.equal(reportOnly.status, 0, `--report-only must exit 0 with gaps, got ${reportOnly.status}: ${reportOnly.output}`);
  assert.match(reportOnly.output, /route-gaps\.json/);
  assert.match(reportOnly.output, /PhantomRead/);

  const gaps = JSON.parse(fs.readFileSync(path.join(dir, "out", "route-gaps.json"), "utf8"));
  assert.equal(gaps.missingInShadowApi.length, 1, `report must record the gap: ${JSON.stringify(gaps)}`);

  const check = run(dir, "route-gap.mjs", "--check");
  assert.equal(check.status, 1, `trailing --check must still gate exit 1, got ${check.status}: ${check.output}`);
});

test("chain order matches the package process script", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(toolsDir, "package.json"), "utf8"));
  const steps = String(pkg.scripts.process).split("&&").map((s) => s.trim());
  // The sandbox drives the gating spine of this chain (validate -> aggregate
  // -> route-gap). Pin the full order so a reorder of `npm run process` fails
  // here instead of silently diverging from the pipeline tests above.
  // Route-map validation runs first, before any artifact is built.
  assert.deepEqual(steps, [
    "node route-map-validation.mjs",
    "node validate-harvest.mjs",
    "node aggregate.mjs",
    "node generate-harvest-docs.mjs",
    "node route-gap.mjs --report-only",
    "node export-curl-examples.mjs",
    "node suggest-routes.mjs",
    "node route-gap.mjs --check",
  ]);
});
