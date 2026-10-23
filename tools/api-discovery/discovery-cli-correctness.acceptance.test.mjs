/**
 * Acceptance tests for the discovery CLI correctness bundle (roadmap R15-04).
 *
 * THE CONTRACT the paired build implements (it consumes this file, never
 * edits it). Five review findings survived the #319-#331 merge sweep; each
 * section below pins one of them with synthetic fixtures only. Nothing here
 * touches a live Routeware tenant, a browser, or the network, and the repo's
 * own tools/api-discovery/out/ is never written.
 *
 * 1. Whitespace map fixtures: `parseMountedOperation` accepts exactly what the
 *    CLI check accepts (`/^[A-Z]+\s+\/\S*$/`). Mounted entries with a tab or
 *    multi-space METHOD/path separator must match real mounts (no false
 *    SHADOW_OPERATION_NOT_MOUNTED); genuinely unmounted entries still fail.
 * 2. Exporter dry-run: non-JSON `--dry-run` performs the complete validation
 *    (map checks, validateMap, body resolution, body-filename collision
 *    checks) before reporting, prints the per-operation dry-run listing, and
 *    writes nothing. `--dry-run --json` still prints the full plan.
 * 3. Symlinked out/: example-file validation rejects lexical `out/` paths
 *    (the directory itself and descendants) before realpath resolution; the
 *    existing canonical-root check still applies afterward.
 * 4. Wrapper forwarding: root `discovery:validate` forwards CLI arguments to
 *    the nested script, so the documented `npm run discovery:validate --
 *    --json` reaches validate:routes as JSON mode.
 * 5. README route location: the route-building guidance directs contributors
 *    to define `createRoute` handlers under `src/routes/*.ts` (mounted from
 *    `src/app.ts`), matching `deriveFromRepoSource`'s scan location.
 * 6. Sibling suggest-routes dry-run: load gaps and render the stub before
 *    success; input/render failures refuse without writes, just like real runs.
 *
 * Run: `node --test tools/api-discovery/discovery-cli-correctness.acceptance.test.mjs`
 * (also matched by `node --test tools/api-discovery/*.test.mjs`). The Builder
 * wires this file into `npm run test:discovery` / `npm run test:probe`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateRouteMap } from "./lib/routeMapValidation.mjs";
import { renderSuggestedRoutesStub } from "./lib/stubNaming.mjs";
import { EXPECTED_STUB_TEXT, ROUTE_GAPS } from "./downstream-fixtures.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(toolsDir, "..", "..");
const VALIDATION_CLI = path.join(toolsDir, "route-map-validation.mjs");
const EXPORTER = path.join(toolsDir, "export-curl-examples.mjs");

const scratchRoot = () =>
  process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir();

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// lstat-based: symlink-safe (a symlinked out/ is recorded, never followed).
function snapshot(dir) {
  const files = {};
  const walk = (at, prefix = "") => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix + entry.name;
      const abs = path.join(at, entry.name);
      const stat = fs.lstatSync(abs);
      files[rel] = {
        mode: stat.mode,
        mtime: stat.mtimeMs,
        size: stat.size,
        bytes: entry.isFile() ? fs.readFileSync(abs).toString("base64") : null,
      };
      if (entry.isDirectory()) walk(abs, `${rel}/`);
    }
  };
  walk(dir);
  return files;
}

function runNode(script, args, cwd, { timeout = 15_000 } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
    timeout,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `subprocess terminated: ${result.signal}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

// --- section 1: whitespace map fixtures (route-map parse parity) --------------

const WS_MAP = [
  { method: "GET", upstreamPath: "/WebRW/Fixture/Read", shadowPath: "/api/fixture/read" },
  { method: "POST", upstreamPath: "/WebRW/Fixture/Save", shadowPath: "/api/fixture/save" },
];
const WS_UNMOUNTED = {
  method: "PUT",
  upstreamPath: "/WebRW/Fixture/Missing",
  shadowPath: "/api/fixture/nowhere",
};

for (const [name, mounted] of [
  ["tab separator", ["GET\t/api/fixture/read", "POST\t/api/fixture/save"]],
  ["multi-space separator", ["GET   /api/fixture/read", "POST  /api/fixture/save"]],
  ["mixed tab-and-space separator", ["GET \t /api/fixture/read", "POST\t  /api/fixture/save"]],
]) {
  test(`whitespace: lib matches mounted operations with a ${name} (no false SHADOW_OPERATION_NOT_MOUNTED)`, () => {
    const result = validateRouteMap(structuredClone(WS_MAP), { mountedOperations: mounted });
    assert.deepEqual(
      result.findings,
      [],
      `entries the CLI check accepts must match real mounts: ${JSON.stringify(result.findings)}`
    );
    assert.equal(result.ok, true);
  });
}

test("whitespace: lib still matches single-space mounted operations (control)", () => {
  const result = validateRouteMap(structuredClone(WS_MAP), {
    mountedOperations: ["GET /api/fixture/read", "POST /api/fixture/save"],
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

test("whitespace: lib still reports a genuinely unmounted entry (control)", () => {
  const result = validateRouteMap([...structuredClone(WS_MAP), structuredClone(WS_UNMOUNTED)], {
    mountedOperations: ["GET /api/fixture/read", "POST /api/fixture/save"],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((f) => f.code), ["SHADOW_OPERATION_NOT_MOUNTED"]);
  assert.deepEqual(result.findings[0].entryIndexes, [2]);
});

function validationFixture(t, { map, mounted }) {
  assert.ok(fs.existsSync(VALIDATION_CLI), "tools/api-discovery/route-map-validation.mjs must exist");
  const dir = fs.mkdtempSync(path.join(scratchRoot(), "discovery-cli-whitespace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(VALIDATION_CLI, path.join(dir, "route-map-validation.mjs"));
  fs.cpSync(path.join(toolsDir, "lib"), path.join(dir, "lib"), { recursive: true });
  writeJson(path.join(dir, "route-map.json"), map);
  writeJson(path.join(dir, "mounted.json"), mounted);
  return dir;
}

test("whitespace: CLI validates a map whose mounted file uses tab and multi-space separators", (t) => {
  const dir = validationFixture(t, {
    map: WS_MAP,
    mounted: ["GET\t/api/fixture/read", "POST   /api/fixture/save"],
  });
  const before = snapshot(dir);
  const res = runNode(path.join(dir, "route-map-validation.mjs"), ["--json", "--mounted-operations=mounted.json"], dir);
  assert.equal(res.status, 0, res.output);
  assert.equal(res.stderr, "", "--json must leave stderr empty");
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, true, `whitespace mounts must resolve: ${res.stdout}`);
  assert.deepEqual(out.findings, []);
  assert.ok(
    out.checks.every((c) => c.status === "pass"),
    `every check passes (mounted file accepted AND resolved): ${res.stdout}`
  );
  assert.deepEqual(snapshot(dir), before, "validation must be read-only");
});

test("whitespace: CLI still fails a genuinely unmounted entry (control)", (t) => {
  const dir = validationFixture(t, {
    map: [...WS_MAP, WS_UNMOUNTED],
    mounted: ["GET /api/fixture/read", "POST /api/fixture/save"],
  });
  const before = snapshot(dir);
  const res = runNode(path.join(dir, "route-map-validation.mjs"), ["--json", "--mounted-operations=mounted.json"], dir);
  assert.equal(res.status, 1, res.output);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, false);
  assert.deepEqual(out.findings.map((f) => f.code), ["SHADOW_OPERATION_NOT_MOUNTED"]);
  assert.deepEqual(out.findings[0].entryIndexes, [2]);
  assert.deepEqual(snapshot(dir), before, "validation must be read-only");
});

// --- section 2: exporter dry-run (complete validation, reachable listing) -----

const LIST_MAP = [
  {
    method: "GET",
    upstreamPath: "/WebRW/Fixture/Read",
    shadowPath: "/api/fixture/read",
    exampleQuery: "fallback=yes",
  },
  { method: "GET", upstreamPath: "/WebRW/Fixture/OtherRead", shadowPath: "/api/fixture/other" },
  {
    method: "POST",
    upstreamPath: "/WebRW/Fixture/Save",
    shadowPath: "/api/fixture/save",
    exampleFile: "examples/save.json",
    exampleContentType: "application/json",
  },
];
const LIST_EXAMPLES = { "examples/save.json": '{"fixture":"COMPLETE_BYTES"}' };

function exporterFixture(t, { map, harvestRows = [], examples = {}, symlinkOut = null }) {
  assert.ok(fs.existsSync(EXPORTER), "tools/api-discovery/export-curl-examples.mjs must exist");
  const dir = fs.mkdtempSync(path.join(scratchRoot(), "discovery-cli-dryrun-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(EXPORTER, path.join(dir, "export-curl-examples.mjs"));
  fs.cpSync(path.join(toolsDir, "lib"), path.join(dir, "lib"), { recursive: true });
  writeJson(path.join(dir, "route-map.json"), map);
  for (const [name, body] of Object.entries(examples)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  if (symlinkOut) {
    const target = path.join(dir, symlinkOut.target);
    fs.mkdirSync(target, { recursive: true });
    for (const [name, body] of Object.entries(symlinkOut.files ?? {})) {
      const file = path.join(target, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    fs.symlinkSync(target, path.join(dir, "out"));
  } else {
    fs.mkdirSync(path.join(dir, "out"), { recursive: true });
    if (harvestRows.length > 0) {
      fs.writeFileSync(
        path.join(dir, "out", "harvest.ndjson"),
        `${harvestRows.map((row) => JSON.stringify(row)).join("\n")}\n`
      );
    }
  }
  return dir;
}

function runExport(dir, args) {
  return runNode(path.join(dir, "export-curl-examples.mjs"), args, dir);
}

test("dry-run: a valid map prints the per-operation listing and writes nothing", (t) => {
  const dir = exporterFixture(t, { map: LIST_MAP, examples: LIST_EXAMPLES });
  const before = snapshot(dir);
  const res = runExport(dir, ["--dry-run"]);
  assert.equal(res.status, 0, res.output);
  assert.match(res.output, /dry-run/i, "the dry-run verdict line is kept");
  for (const id of ["GET /WebRW/Fixture/Read", "GET /WebRW/Fixture/OtherRead", "POST /WebRW/Fixture/Save"]) {
    assert.ok(
      res.output.includes(id),
      `the per-operation dry-run listing must be reachable (missing ${id}): ${res.output}`
    );
  }
  assert.deepEqual(snapshot(dir), before, "--dry-run must not touch the filesystem");
});

// Every refusal below asserts dry-run/real parity: --dry-run fails exactly
// when the real run would fail, before any write, and never claims validity.
function expectDryRunParity(t, fixtureOptions, label) {
  const dir = exporterFixture(t, fixtureOptions);
  const before = snapshot(dir);
  const dry = runExport(dir, ["--dry-run"]);
  assert.notEqual(dry.status, 0, `${label}: --dry-run must fail, not claim validity: ${dry.output}`);
  assert.doesNotMatch(dry.output, /route map valid/, `${label}: --dry-run must not claim validity: ${dry.output}`);
  assert.deepEqual(snapshot(dir), before, `${label}: a refused --dry-run writes nothing`);
  const real = runExport(dir, []);
  assert.notEqual(real.status, 0, `${label}: the real run refuses too (parity): ${real.output}`);
  assert.deepEqual(snapshot(dir), before, `${label}: a refused real run writes nothing`);
}

test("dry-run: runs validateMap (lowercase method fails without writing)", (t) => {
  expectDryRunParity(
    t,
    {
      map: [{ method: "post", upstreamPath: "/WebRW/Fixture/Read", shadowPath: "/api/fixture/read" }],
    },
    "validateMap"
  );
});

test("dry-run: resolves bodies (missing exampleFile fails without writing)", (t) => {
  expectDryRunParity(
    t,
    {
      map: [
        {
          method: "POST",
          upstreamPath: "/WebRW/Fixture/Save",
          shadowPath: "/api/fixture/save",
          exampleFile: "examples/missing.json",
          exampleContentType: "application/json",
        },
      ],
    },
    "body resolution"
  );
});

test("dry-run: checks body-filename collisions (colliding slugs fail without writing)", (t) => {
  // Distinct upstream identities whose body slugs collide: /WebRW/A/B and
  // /WebRW_A/B both slug to POST_WebRW_A_B.json.
  expectDryRunParity(
    t,
    {
      map: [
        {
          method: "POST",
          upstreamPath: "/WebRW/A/B",
          shadowPath: "/api/fixture/a-b",
          exampleFile: "examples/a.json",
          exampleContentType: "application/json",
        },
        {
          method: "POST",
          upstreamPath: "/WebRW_A/B",
          shadowPath: "/api/fixture/a-b-2",
          exampleFile: "examples/b.json",
          exampleContentType: "application/json",
        },
      ],
      examples: { "examples/a.json": '{"a":1}', "examples/b.json": '{"b":2}' },
    },
    "body-filename collision"
  );
});

test("dry-run: mapping defects still fail first, naming the code (control)", (t) => {
  const dup = {
    method: "GET",
    upstreamPath: "/WebRW/Fixture/Read",
    shadowPath: "/api/fixture/read-v2",
  };
  const dir = exporterFixture(t, {
    map: [LIST_MAP[0], { ...LIST_MAP[0], exampleQuery: undefined }, dup].map((e) => {
      const { exampleQuery: _ignored, ...rest } = e;
      return rest;
    }),
  });
  const before = snapshot(dir);
  const res = runExport(dir, ["--dry-run"]);
  assert.equal(res.status, 1, res.output);
  assert.match(res.output, /DUPLICATE_UPSTREAM_IDENTITY/);
  assert.deepEqual(snapshot(dir), before);
});

test("dry-run: --dry-run --json still prints the full plan (control)", (t) => {
  const dir = exporterFixture(t, { map: LIST_MAP, examples: LIST_EXAMPLES });
  const before = snapshot(dir);
  const res = runExport(dir, ["--dry-run", "--json"]);
  assert.equal(res.status, 0, res.output);
  let plan;
  assert.doesNotThrow(() => {
    plan = JSON.parse(res.stdout);
  }, `--dry-run --json must print the plan as JSON: ${res.stdout}`);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.operations.length, 3);
  assert.deepEqual(
    plan.operations.map((op) => op.id).sort(),
    ["GET /WebRW/Fixture/OtherRead", "GET /WebRW/Fixture/Read", "POST /WebRW/Fixture/Save"]
  );
  assert.deepEqual(snapshot(dir), before);
});

// --- section 3: symlinked out/ (lexical rejection before realpath) ------------

const SYMLINK_FILES = {
  "evil.json": '{" planted": "OUT_TREE" }',
  "nested/deep.json": '{"planted":"OUT_NESTED"}',
};

for (const exampleFile of ["out/evil.json", "out/nested/deep.json"]) {
  test(`symlink-out: lexical ${exampleFile} is rejected even when it resolves inside the repo`, (t) => {
    const dir = exporterFixture(t, {
      map: [
        {
          method: "POST",
          upstreamPath: "/WebRW/Fixture/Save",
          shadowPath: "/api/fixture/save",
          exampleFile,
          exampleContentType: "application/json",
        },
      ],
      symlinkOut: { target: "real-examples", files: SYMLINK_FILES },
    });
    const before = snapshot(dir);
    const real = runExport(dir, []);
    assert.notEqual(real.status, 0, `lexical out/ fallback must be refused: ${real.output}`);
    assert.deepEqual(snapshot(dir), before, "a refused run writes nothing anywhere");
    const dry = runExport(dir, ["--dry-run"]);
    assert.notEqual(dry.status, 0, `--dry-run refuses the lexical out/ fallback too: ${dry.output}`);
    assert.deepEqual(snapshot(dir), before);
  });
}

test("symlink-out: a repository example outside out/ is still admitted (control)", (t) => {
  const dir = exporterFixture(t, {
    map: [
      {
        method: "POST",
        upstreamPath: "/WebRW/Fixture/Save",
        shadowPath: "/api/fixture/save",
        exampleFile: "examples/save.json",
        exampleContentType: "application/json",
      },
    ],
    examples: { "examples/save.json": '{"fixture":"REPOSITORY_BYTES"}' },
  });
  const res = runExport(dir, []);
  assert.equal(res.status, 0, res.output);
  const sh = fs.readFileSync(path.join(dir, "out", "curl-examples.sh"), "utf8");
  assert.match(sh, /Fixture\/Save/);
  const bodies = fs.readdirSync(path.join(dir, "out", "bodies"));
  assert.deepEqual(bodies, ["POST_WebRW_Fixture_Save.json"]);
});

test("symlink-out: a path escaping the tool root is still rejected (canonical-root control)", (t) => {
  const outside = path.join(
    scratchRoot(),
    `discovery-cli-outside-${process.pid}-${Date.now()}.json`
  );
  fs.writeFileSync(outside, '{"outside":true}');
  t.after(() => fs.rmSync(outside, { force: true }));
  const dir = exporterFixture(t, {
    map: [
      {
        method: "POST",
        upstreamPath: "/WebRW/Fixture/Save",
        shadowPath: "/api/fixture/save",
        exampleFile: outside,
        exampleContentType: "application/json",
      },
    ],
  });
  const before = snapshot(dir);
  const res = runExport(dir, []);
  assert.notEqual(res.status, 0, `an out-of-root example must be refused: ${res.output}`);
  assert.deepEqual(snapshot(dir), before);
});

test("symlink-out: the out/ directory itself as exampleFile is rejected (control)", (t) => {
  const dir = exporterFixture(t, {
    map: [
      {
        method: "POST",
        upstreamPath: "/WebRW/Fixture/Save",
        shadowPath: "/api/fixture/save",
        exampleFile: "out",
        exampleContentType: "application/json",
      },
    ],
  });
  const before = snapshot(dir);
  const res = runExport(dir, []);
  assert.notEqual(res.status, 0, `the out/ directory itself must be refused: ${res.output}`);
  assert.deepEqual(snapshot(dir), before);
});

// --- section 4: wrapper argument forwarding ------------------------------------

test("wrapper: root discovery:validate forwards CLI arguments to the nested script", () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const script = rootPkg.scripts["discovery:validate"];
  assert.equal(typeof script, "string", "root package.json must keep a discovery:validate script");
  assert.ok(script.includes("validate:routes"), `discovery:validate must run validate:routes, got: ${script}`);
  assert.ok(
    script.split(/\s+/).includes("--"),
    `discovery:validate must forward CLI arguments (a " --" separator), ` +
      `so "npm run discovery:validate -- --json" reaches validate:routes instead of npm itself, got: ${script}`
  );
});

for (const relative of ["README.md", "docs/CONVENTIONS.md"]) {
  test(`wrapper: ${relative} advertises npm run discovery:validate -- --json (control)`, () => {
    const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    const row = text.split("\n").find((line) => line.includes("discovery:validate"));
    assert.ok(row, `${relative} must list npm run discovery:validate`);
    assert.ok(row.includes("--json"), `${relative} must advertise --json for discovery:validate: ${row}`);
    assert.ok(
      row.includes("npm run discovery:validate -- --json"),
      `${relative} must include the npm argument separator so --json reaches the CLI: ${row}`
    );
  });
}

function wrapperFixture(t) {
  const dir = fs.mkdtempSync(path.join(scratchRoot(), "discovery-cli-wrapper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(dir, "package.json"));
  const toolsTarget = path.join(dir, "tools", "api-discovery");
  fs.mkdirSync(path.join(toolsTarget, "lib"), { recursive: true });
  fs.copyFileSync(path.join(toolsDir, "package.json"), path.join(toolsTarget, "package.json"));
  fs.copyFileSync(VALIDATION_CLI, path.join(toolsTarget, "route-map-validation.mjs"));
  fs.cpSync(path.join(toolsDir, "lib"), path.join(toolsTarget, "lib"), { recursive: true });
  writeJson(path.join(toolsTarget, "route-map.json"), [
    { method: "GET", upstreamPath: "/WebRW/Fixture/Read", shadowPath: "/api/fixture/read" },
  ]);
  const routesDir = path.join(dir, "src", "routes");
  fs.mkdirSync(routesDir, { recursive: true });
  fs.writeFileSync(
    path.join(routesDir, "fixture.ts"),
    'import { createRoute } from "../lib";\ncreateRoute({ method: "GET", path: "/api/fixture/read" });\n'
  );
  return dir;
}

test("wrapper: documented `npm run discovery:validate -- --json` reaches validate:routes as JSON mode", (t) => {
  const dir = wrapperFixture(t);
  const result = spawnSync("npm", ["run", "discovery:validate", "--", "--json"], {
    cwd: dir,
    env: { ...process.env },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `wrapper probe must exit 0: stdout=${result.stdout} stderr=${result.stderr}`);
  // npm prints its own `>` banners to stdout; the behavioral proof is the one
  // JSON result line the CLI emits in --json mode (and no text verdict).
  const jsonLines = result.stdout.split("\n").filter((line) => line.trim().startsWith("{"));
  assert.equal(
    jsonLines.length,
    1,
    "`npm run discovery:validate -- --json` must reach validate:routes as JSON mode " +
      `(exactly one JSON result line on stdout), got stdout=${JSON.stringify(result.stdout.slice(0, 800))} ` +
      `stderr=${JSON.stringify((result.stderr ?? "").slice(0, 500))}`
  );
  assert.doesNotMatch(result.stdout, /route-map validation: OK/, "text verdict means --json was swallowed by npm");
  const parsed = JSON.parse(jsonLines[0]);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.ok, true, JSON.stringify(parsed).slice(0, 500));
  assert.deepEqual(parsed.findings, []);
});

// --- section 5: README route-location wording ----------------------------------

function buildingRoutesSection() {
  const readme = fs.readFileSync(path.join(toolsDir, "README.md"), "utf8");
  const start = readme.indexOf("## Building new shadow routes");
  assert.ok(start >= 0, "tools/api-discovery/README.md must keep its route-building section");
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end < 0 ? undefined : end);
}

test("readme: route-building guidance implements createRoute handlers under src/routes/*.ts", () => {
  const section = buildingRoutesSection();
  assert.ok(section.includes("createRoute"), "the section must name createRoute");
  assert.ok(
    section.includes("src/routes/"),
    `the section must direct contributors to define handlers under src/routes/*.ts: ${section}`
  );
});

test("readme: route-building guidance never directs implementing in src/app.ts", () => {
  const section = buildingRoutesSection();
  assert.doesNotMatch(
    section,
    /implement[^\n]*src\/app\.ts/,
    `no src/app.ts implementation path (mount from src/app.ts, implement under src/routes/): ${section}`
  );
});

test("readme: route-building guidance keeps src/app.ts as the mount point (control)", () => {
  const section = buildingRoutesSection();
  assert.ok(section.includes("src/app.ts"), `the section must still name src/app.ts as the mount point: ${section}`);
});

test("readme: the CLI scan location the wording must match is src/routes/*.ts (control)", () => {
  const cli = fs.readFileSync(VALIDATION_CLI, "utf8");
  assert.match(
    cli,
    /resolve\(__dirname,\s*"\.\.",\s*"\.\.",\s*"src",\s*"routes"\)/,
    "deriveFromRepoSource must scan <repo>/src/routes/*.ts"
  );
  assert.match(cli, /createRoute/, "the scan must target createRoute definitions");
});

// --- section 6: suggest-routes dry-run (load and render before success) --------

function suggestFixture(t, { map = WS_MAP, gaps = ROUTE_GAPS, existingStub = false } = {}) {
  const dir = fs.mkdtempSync(path.join(scratchRoot(), "discovery-cli-suggest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(toolsDir, "suggest-routes.mjs"), path.join(dir, "suggest-routes.mjs"));
  fs.cpSync(path.join(toolsDir, "lib"), path.join(dir, "lib"), { recursive: true });
  if (map !== null) writeJson(path.join(dir, "route-map.json"), map);
  if (gaps !== null || existingStub) fs.mkdirSync(path.join(dir, "out"));
  if (gaps !== null) {
    fs.writeFileSync(
      path.join(dir, "out", "route-gaps.json"),
      typeof gaps === "string" ? gaps : JSON.stringify(gaps)
    );
  }
  if (existingStub) {
    fs.writeFileSync(path.join(dir, "out", "suggested-routes.stub.ts"), "PREVIOUS STUB\n");
    fs.writeFileSync(path.join(dir, "out", "keep.txt"), "UNRELATED ARTIFACT\n");
  }
  return dir;
}

const SUGGEST_RENDER_FAILURE = { missingInShadowApi: [null], staleInRouteMap: [] };
const SUGGEST_SUCCESS = /route map valid|\b(?:would[\s-]+write|wrote|success(?:ful(?:ly)?)?)\b/i;

for (const [label, gaps] of [
  ["missing route-gaps.json", null],
  ["malformed route-gaps.json", "{oops"],
  ["a gap that throws during rendering", SUGGEST_RENDER_FAILURE],
]) {
  for (const existingStub of [false, true]) {
    test(`suggest dry-run: ${label} refuses with ${existingStub ? "an existing" : "no"} stub (real-run parity)`, (t) => {
      if (gaps === SUGGEST_RENDER_FAILURE) {
        // Valid JSON, but not renderable: this reaches beyond JSON loading.
        assert.throws(() => renderSuggestedRoutesStub(gaps.missingInShadowApi), TypeError);
      }
      const dir = suggestFixture(t, { gaps, existingStub });
      const before = snapshot(dir);
      const script = path.join(dir, "suggest-routes.mjs");
      const real = runNode(script, [], dir);
      assert.deepEqual(snapshot(dir), before, "a refused real run must leave the whole tree untouched");
      assert.notEqual(real.status, 0, `real-run refusal control: ${real.output}`);
      assert.doesNotMatch(real.output, SUGGEST_SUCCESS, "a refused real run must not announce success");

      const dry = runNode(script, ["--dry-run"], dir);
      assert.deepEqual(snapshot(dir), before, "a refused dry-run must neither create nor replace any artifact");
      assert.notEqual(dry.status, 0, `--dry-run must refuse the same input as the real run: ${dry.output}`);
      assert.equal(dry.status, real.status, "dry-run and real-run refusal exit codes must agree");
      assert.doesNotMatch(dry.output, SUGGEST_SUCCESS, "no success/would-write verdict before loading and rendering");
    });
  }
}

for (const [label, map] of [["a valid map", WS_MAP], ["the optional map missing", null]]) {
  for (const existingStub of [false, true]) {
    test(`suggest dry-run: valid gaps with ${label} and ${existingStub ? "an existing" : "no"} stub (control)`, (t) => {
      const dir = suggestFixture(t, { map, existingStub });
      const before = snapshot(dir);
      const script = path.join(dir, "suggest-routes.mjs");
      const dry = runNode(script, ["--dry-run"], dir);
      assert.equal(dry.status, 0, dry.output);
      assert.match(dry.output, /dry-run/i, "successful dry-run must identify itself");
      assert.deepEqual(snapshot(dir), before, "successful dry-run must leave every byte and mtime untouched");

      const real = runNode(script, [], dir);
      assert.equal(real.status, 0, real.output);
      assert.equal(
        fs.readFileSync(path.join(dir, "out", "suggested-routes.stub.ts"), "utf8"),
        EXPECTED_STUB_TEXT,
        "the real-run artifact must retain the byte-exact synthetic checklist"
      );
      const withoutStub = (files) => Object.fromEntries(
        Object.entries(files).filter(([name]) => name !== "out" && name !== "out/suggested-routes.stub.ts")
      );
      assert.deepEqual(withoutStub(snapshot(dir)), withoutStub(before), "real-run changes only the stub artifact");
    });
  }
}
