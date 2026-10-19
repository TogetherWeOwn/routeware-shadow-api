/**
 * Acceptance tests driving the REAL downstream render scripts
 * (roadmap R9-23): suggest-routes.mjs, export-curl-examples.mjs,
 * generate-harvest-docs.mjs.
 *
 * Hermetic by construction (same pattern as the R9-16 pair):
 * each test copies the three scripts and the whole lib/ directory into a
 * fresh temp dir, lays down the shared synthetic fixtures from
 * downstream-fixtures.mjs (route-map.json, out/route-gaps.json,
 * out/harvest.ndjson, out/discovered-operations.json, examples/*), and
 * spawns one script with `node`. No live Routeware, no browser, no network;
 * the repo's own tools/api-discovery/out/ is never touched (the scripts
 * resolve everything relative to their own __dirname). Copying lib/
 * recursively means the paired build's lib extraction cannot break this
 * harness.
 *
 * Run: `node --test tools/api-discovery/downstream-scripts.test.mjs`
 * This is the script-level half of the pin set; pure render-function pins
 * live in test/discoveryDownstream.test.ts (root vitest). This file pins
 * what vitest's workers pool cannot: exit codes and files on disk,
 * including missing-input behavior.
 *
 * Expected on current main: all green — the PUT entry renders `-X PUT`
 * and the remaining pins are regression armor for the extraction.
 * Render-script changes must update the pins through new script behavior,
 * not by weakening these assertions.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DISCOVERED,
  EXAMPLE_FILES,
  EXPECTED_STUB_TEXT,
  HARVEST_LINES,
  ROUTE_GAPS,
  ROUTE_MAP,
} from "./downstream-fixtures.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = [
  "suggest-routes.mjs",
  "export-curl-examples.mjs",
  "generate-harvest-docs.mjs",
];

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "downstream-"));
  for (const script of SCRIPTS) {
    fs.copyFileSync(path.join(toolsDir, script), path.join(dir, script));
  }
  fs.cpSync(path.join(toolsDir, "lib"), path.join(dir, "lib"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  return dir;
}

function layFixtures(dir) {
  fs.writeFileSync(
    path.join(dir, "route-map.json"),
    JSON.stringify(ROUTE_MAP, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "out", "route-gaps.json"),
    JSON.stringify(ROUTE_GAPS, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "out", "harvest.ndjson"),
    `${HARVEST_LINES.join("\n")}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "out", "discovered-operations.json"),
    JSON.stringify(DISCOVERED, null, 2),
    "utf8"
  );
  for (const [rel, text] of Object.entries(EXAMPLE_FILES)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
  }
}

function run(dir, script) {
  const result = spawnSync(process.execPath, [path.join(dir, script)], {
    cwd: dir,
    // Minimal env: the scripts need no tokens or .dev.vars; prove it.
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

// --- suggest-routes.mjs ---------------------------------------------------

test("suggest-routes: missing route-gaps.json exits 1 and writes nothing", () => {
  const dir = sandbox();
  const result = run(dir, "suggest-routes.mjs");
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.output}`);
  assert.match(result.output, /route-gaps\.json/);
  assert.match(result.output, /run npm run process first/);
  assert.equal(
    fs.existsSync(path.join(dir, "out", "suggested-routes.stub.ts")),
    false,
    "no stub file may be written when the input is missing"
  );
});

test("suggest-routes: malformed route-gaps.json exits 1", () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, "out", "route-gaps.json"), "{oops", "utf8");
  const result = run(dir, "suggest-routes.mjs");
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.output}`);
  assert.match(result.output, /route-gaps\.json/);
});

test("suggest-routes: gap fixture renders the exact stub checklist", () => {
  const dir = sandbox();
  layFixtures(dir);
  const result = run(dir, "suggest-routes.mjs");
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\(2 gaps, first 40 listed\)/);
  assert.equal(read(dir, "out/suggested-routes.stub.ts"), EXPECTED_STUB_TEXT);
});

test("suggest-routes: 41 gaps render 40 blocks plus the remainder line", () => {
  const dir = sandbox();
  const gaps = {
    missingInShadowApi: Array.from({ length: 41 }, (_, i) => ({
      method: "POST",
      upstreamPath: `/WebRW/Customer/Op${i}`,
      count: 1,
    })),
  };
  fs.writeFileSync(
    path.join(dir, "out", "route-gaps.json"),
    JSON.stringify(gaps),
    "utf8"
  );
  const result = run(dir, "suggest-routes.mjs");
  assert.equal(result.status, 0, result.output);
  const stub = read(dir, "out/suggested-routes.stub.ts");
  assert.equal(stub.match(/createRoute method/g).length, 40);
  assert.match(stub, /\/\/ … and 1 more \(see route-gaps\.json\)/);
});

// --- export-curl-examples.mjs ---------------------------------------------

test("export-curl: shared world renders curls per Content-Type with body files", () => {
  const dir = sandbox();
  layFixtures(dir);
  const result = run(dir, "export-curl-examples.mjs");
  assert.equal(result.status, 0, result.output);
  const sh = read(dir, "out/curl-examples.sh");

  // JSON POST: last harvest row wins (page 99), .json body, JSON Accept.
  assert.match(sh, /-H "Content-Type: application\/json; charset=utf-8" \\/);
  assert.match(sh, /-H "Accept: application\/json, text\/javascript, \*\/\*; q=0\.01" \\/);
  assert.equal(read(dir, "out/bodies/POST_WebRW_Customer_CustomersRead.json"), '{"page":99}');

  // Form POST from harvest: .body file, */* Accept.
  assert.match(sh, /-H "Content-Type: application\/x-www-form-urlencoded; charset=UTF-8" \\/);
  assert.equal(read(dir, "out/bodies/POST_WebRW_Customer_CustomerTypesRead.body"), "EnabledOnly=true");

  // Form POST from example file (no harvest row): trimmed example content.
  assert.equal(
    read(dir, "out/bodies/POST_WebRW_Customer_SaveCustomerLongForm.body"),
    "CustomerID=42&Name=Ada+Lovelace"
  );

  // GET: harvest query (999) beats exampleQuery (111); query is URL-encoded.
  assert.match(
    sh,
    /curl -sS "\$BASE\/api\/v1\/routeware\/customer\/load-long-modal\?customerID=999&tab=a\+b"/
  );
  // GET without harvest row falls back to exampleQuery.
  assert.match(sh, /query-request-is-complete\?requestID=REPLACE_WITH_UUID/);

  // POST with no body anywhere: comment, no curl, no body file.
  assert.match(sh, /# POST \/WebRW\/Data\/NoBodyOp → \/api\/v1\/routeware\/data\/no-body-op\n# \(no body:/);

  // Exactly the body files above — nothing for GETs or the no-body op.
  assert.deepEqual(fs.readdirSync(path.join(dir, "out", "bodies")).sort(), [
    "POST_WebRW_Customer_CustomerTypesRead.body",
    "POST_WebRW_Customer_CustomersRead.json",
    "POST_WebRW_Customer_SaveCustomerLongForm.body",
    "PUT_WebRW_Customer_UpdateThing.json",
  ]);
});

test("export-curl: a PUT entry renders -X PUT, not -X POST", () => {
  const dir = sandbox();
  layFixtures(dir);
  const result = run(dir, "export-curl-examples.mjs");
  assert.equal(result.status, 0, result.output);
  const sh = read(dir, "out/curl-examples.sh");
  assert.match(
    sh,
    /curl -sS -X PUT "\$BASE\/api\/v1\/routeware\/customer\/update-thing" \\/,
    "generated curl must call the route-map method"
  );
});

test("export-curl: missing harvest.ndjson warns and uses example files only", () => {
  const dir = sandbox();
  layFixtures(dir);
  fs.rmSync(path.join(dir, "out", "harvest.ndjson"));
  const result = run(dir, "export-curl-examples.mjs");
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /No harvest\.ndjson/);
  const sh = read(dir, "out/curl-examples.sh");
  // Example-file entry still renders; harvest-only entries become no-body.
  assert.equal(
    read(dir, "out/bodies/POST_WebRW_Customer_SaveCustomerLongForm.body"),
    "CustomerID=42&Name=Ada+Lovelace"
  );
  assert.match(sh, /# POST \/WebRW\/Customer\/CustomersRead → [^\n]+\n# \(no body:/);
  // GET falls back to exampleQuery without a harvest row.
  assert.match(sh, /load-long-modal\?customerID=111/);
});

test("export-curl: missing route-map.json fails non-zero naming the file", () => {
  const dir = sandbox();
  const result = run(dir, "export-curl-examples.mjs");
  assert.notEqual(result.status, 0, `expected non-zero exit: ${result.output}`);
  assert.match(result.output, /route-map\.json/);
});

// --- generate-harvest-docs.mjs ----------------------------------------------

test("harvest-docs: generated markdown reflects the discovered-operations input", () => {
  const dir = sandbox();
  layFixtures(dir);
  const result = run(dir, "generate-harvest-docs.mjs");
  assert.equal(result.status, 0, result.output);
  const md = read(dir, "out/HARVEST_API.md");
  assert.match(
    md,
    /Generated \*\*2026-10-15T00:00:00\.000Z\*\* from `out\/harvest\.ndjson` \(16 lines\)\./
  );
  assert.match(
    md,
    /\| 9 \| POST \| `\/WebRW\/Customer\/CustomersRead` \| `\/api\/v1\/routeware\/customer\/customers-read` \|/
  );
  assert.match(md, /\| 5 \| POST \| `\/WebRW\/Customer\/PhantomRead` \| `— \*add route\* —` \|/);
  assert.match(md, /### POST `\/WebRW\/Customer\/CustomersRead` \(9 calls\)/);
  assert.match(md, /- \*\*requestContentType:\*\* application\/json; charset=utf-8/);
  assert.match(md, /```json\n\{"page":99\}\n```/);
});

test("harvest-docs: missing discovered-operations writes the stub doc, exit 0", () => {
  const dir = sandbox();
  const result = run(dir, "generate-harvest-docs.mjs");
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /No discovered-operations; wrote stub/);
  assert.equal(
    read(dir, "out/HARVEST_API.md"),
    "# Harvest API documentation\n\nRun `npm run record` then `npm run process` to generate `discovered-operations.json`.\n"
  );
});

test("harvest-docs: missing route-map is tolerated, every row unmapped", () => {
  const dir = sandbox();
  layFixtures(dir);
  fs.rmSync(path.join(dir, "route-map.json"));
  const result = run(dir, "generate-harvest-docs.mjs");
  assert.equal(result.status, 0, result.output);
  const md = read(dir, "out/HARVEST_API.md");
  assert.match(
    md,
    /\| 9 \| POST \| `\/WebRW\/Customer\/CustomersRead` \| `— \*add route\* —` \|/
  );
});
