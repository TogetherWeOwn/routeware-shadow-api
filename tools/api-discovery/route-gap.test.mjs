/**
 * Acceptance tests for tools/api-discovery/route-gap.mjs (TOG-25329, roadmap R9-16).
 *
 * Hermetic by construction: each test copies the REAL route-gap.mjs into a fresh
 * temp dir, lays down a synthetic route-map.json + out/discovered-operations.json
 * pair beside it, and spawns it with `node`. No live Routeware, no browser, no
 * network; the repo's own tools/api-discovery/out/ and route-map.json are never
 * touched (the script resolves everything relative to its own __dirname).
 *
 * Run: `node --test tools/api-discovery/route-gap.test.mjs`
 * (kept out of the root vitest run on purpose — vitest only includes
 * `test/**.test.ts`, so root `npm test` is untouched).
 *
 * Paired build card [TOG-25335](/TOG/issues/TOG-25335) implements on this branch
 * and must never edit this file. Reviewer check: each fixture mutation below
 * flips exactly one test.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-gap-"));
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  // Test the real implementation: copy the script under test into the sandbox
  // so its __dirname-relative reads (route-map.json, out/...) stay isolated.
  fs.copyFileSync(path.join(toolsDir, "route-gap.mjs"), path.join(dir, "route-gap.mjs"));
  return dir;
}

function run(dir) {
  const result = spawnSync(process.execPath, [path.join(dir, "route-gap.mjs")], {
    cwd: dir,
    // Minimal env: the script needs no tokens or .dev.vars; prove it.
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function report(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "out", "route-gaps.json"), "utf8"));
}

const MAPPED = {
  method: "POST",
  upstreamPath: "/WebRW/Customer/CustomersRead",
  shadowPath: "/api/v1/routeware/customer/customers-read",
};

function discovered(...ops) {
  return {
    generatedAt: "2026-10-15T00:00:00.000Z",
    sourceFile: "out/harvest.ndjson",
    lineCount: ops.reduce((n, o) => n + o.count, 0),
    operations: ops.map((o) => ({
      key: `${o.method} ${o.pathname}`,
      method: o.method,
      pathname: o.pathname,
      normalizedPath: o.pathname,
      count: o.count,
      resourceTypes: ["xhr"],
      samples: [],
    })),
  };
}

test("fails when a harvested operation has no shadow route", () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, "route-map.json"), JSON.stringify([MAPPED]), "utf8");
  fs.writeFileSync(
    path.join(dir, "out", "discovered-operations.json"),
    JSON.stringify(
      discovered(
        { method: "POST", pathname: "/WebRW/Customer/CustomersRead", count: 3 },
        { method: "POST", pathname: "/WebRW/Customer/PhantomRead", count: 5 }
      )
    ),
    "utf8"
  );

  const result = run(dir);
  assert.equal(result.status, 1, `expected exit 1 on missing shadow route, got ${result.status}: ${result.output}`);
  assert.match(result.output, /PhantomRead/);
  const missing = report(dir).missingInShadowApi.map((m) => `${m.method} ${m.upstreamPath}`);
  assert.ok(
    missing.includes("POST /WebRW/Customer/PhantomRead"),
    `report must list the unmapped op, got: ${JSON.stringify(missing)}`
  );
});

test("fails when a route-map entry was not seen in the harvest", () => {
  const dir = sandbox();
  fs.writeFileSync(
    path.join(dir, "route-map.json"),
    JSON.stringify([
      MAPPED,
      {
        method: "GET",
        upstreamPath: "/WebRW/Customer/StaleModal",
        shadowPath: "/api/v1/routeware/customer/stale-modal",
      },
    ]),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "out", "discovered-operations.json"),
    JSON.stringify(discovered({ method: "POST", pathname: "/WebRW/Customer/CustomersRead", count: 3 })),
    "utf8"
  );

  const result = run(dir);
  assert.equal(result.status, 1, `expected exit 1 on stale map entry, got ${result.status}: ${result.output}`);
  const stale = report(dir).mappedButNotInLastHarvest.map((m) => `${m.method} ${m.upstreamPath}`);
  assert.ok(
    stale.includes("GET /WebRW/Customer/StaleModal"),
    `report must list the stale entry, got: ${JSON.stringify(stale)}`
  );
});

test("passes when every harvested op is mapped and every map entry was harvested", () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, "route-map.json"), JSON.stringify([MAPPED]), "utf8");
  fs.writeFileSync(
    path.join(dir, "out", "discovered-operations.json"),
    JSON.stringify(discovered({ method: "POST", pathname: "/WebRW/Customer/CustomersRead", count: 3 })),
    "utf8"
  );

  const result = run(dir);
  assert.equal(result.status, 0, `expected exit 0 on clean gap report: ${result.output}`);
  assert.deepEqual(report(dir).missingInShadowApi, []);
  assert.deepEqual(report(dir).mappedButNotInLastHarvest, []);
  assert.doesNotMatch(result.output, /killeen\.routeware\.com/);
});

test("exits 0 when no aggregate exists yet", () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, "route-map.json"), JSON.stringify([MAPPED]), "utf8");
  // No out/discovered-operations.json on purpose.

  const result = run(dir);
  assert.equal(result.status, 0, `missing aggregate must stay exit 0: ${result.output}`);
  assert.match(result.output, /no aggregate yet/);
});
