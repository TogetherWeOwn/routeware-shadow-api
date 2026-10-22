/**
 * Acceptance tests for the route-map validation contract (roadmap R12-04).
 *
 * THE CONTRACT the paired build implements (it consumes this file, never
 * edits it). Fixtures are synthetic; nothing here touches a live Routeware
 * tenant, a browser, or the network, and the repo's tools/api-discovery/out/
 * is never written.
 *
 * 1. Library: tools/api-discovery/lib/routeMapValidation.mjs (pure, no I/O)
 *    - SCHEMA_VERSION = 1, SUPPORTED_METHODS = GET POST PUT PATCH DELETE
 *    - CHECK_IDS (fixed order), FINDING_CODES (closed set)
 *    - validateRouteMap(routeMap, { mountedOperations? }) -> result
 *    - mountedOperationsFromOpenApi(doc) -> sorted unique "METHOD /path"
 *    result = { schemaVersion: 1, ok, checks: [{ id, status }],
 *               findings: [...], summary: { entries, errors } }
 *    check status: "pass" | "fail" | "skipped" (the mounted-operation check is
 *    "skipped" when no mountedOperations list is supplied).
 *    finding = { id, checkId, code, severity: "error", entryIndexes,
 *                method?, upstreamPath?, shadowPath?, nextAction }
 *    Path/method fields are echoed ONLY when the value passed shape
 *    validation; an invalid value (it may carry a token) is never echoed.
 *    Finding ids are content-derived (start with the code, no whitespace,
 *    unique, independent of entry order): one finding per duplicate-upstream
 *    group, per conflicting-shadow group and per distinct unmounted
 *    (method, shadowPath), each listing every affected entry index.
 *    An entry that fails the shape, method or path checks is excluded from
 *    the later duplicate/conflict/mounted checks (no cascading findings).
 *
 *    Checks and codes, in this order:
 *      route-map.shape                ROUTE_MAP_NOT_ARRAY, ENTRY_FIELD_INVALID
 *      route-map.method               METHOD_UNSUPPORTED
 *      route-map.upstream-path        UPSTREAM_PATH_INVALID
 *      route-map.shadow-path          SHADOW_PATH_INVALID
 *      route-map.duplicate-upstream   DUPLICATE_UPSTREAM_IDENTITY
 *      route-map.conflicting-shadow   CONFLICTING_SHADOW_MAPPING
 *      route-map.mounted-operation    SHADOW_OPERATION_NOT_MOUNTED
 *    CLI-only codes: ROUTE_MAP_UNREADABLE (route-map.shape),
 *    MOUNTED_OPERATIONS_UNAVAILABLE (route-map.mounted-operation),
 *    UNKNOWN_FLAG (cli.arguments).
 *
 * 2. CLI: tools/api-discovery/route-map-validation.mjs
 *    [--json] [--mounted-operations=<file with a JSON array of "METHOD /path">]
 *    Read-only. Without --mounted-operations it derives the mounted operations
 *    from the repo source. --json: stdout is exactly one JSON object (the
 *    result above) and stderr is empty. Exit 0 = ok, 1 = findings, 2 = unknown
 *    flag/argument. Never prints harvest payloads, credentials, raw exception
 *    text or stack traces.
 *
 * 3. Wiring: route-gap.mjs, export-curl-examples.mjs and suggest-routes.mjs
 *    run the same library (mapping-intrinsic checks) before producing output;
 *    export-curl-examples.mjs and suggest-routes.mjs gain `--dry-run`
 *    (validate, print, write nothing). `npm run process` starts with the CLI;
 *    `npm run validate:routes` (tools) and `npm run discovery:validate` (root)
 *    run it; `npm run test:discovery` includes this file; READMEs document it.
 *
 * Run: `node --test tools/api-discovery/route-map-validation.test.mjs`
 * (root `npm run test:discovery`, a CI step). The workerd half lives in
 * test/discoveryMapContract.test.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { ROUTE_MAP as DOWNSTREAM_ROUTE_MAP, ROUTE_GAPS } from "./downstream-fixtures.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(toolsDir, "..", "..");
const LIB = path.join(toolsDir, "lib", "routeMapValidation.mjs");
const CLI = path.join(toolsDir, "route-map-validation.mjs");

const SENTINEL = "SECRET-SENTINEL-4f9a1c";

const CHECK_ORDER = [
  "route-map.shape",
  "route-map.method",
  "route-map.upstream-path",
  "route-map.shadow-path",
  "route-map.duplicate-upstream",
  "route-map.conflicting-shadow",
  "route-map.mounted-operation",
];
const ALL_CODES = [
  "ROUTE_MAP_NOT_ARRAY",
  "ENTRY_FIELD_INVALID",
  "METHOD_UNSUPPORTED",
  "UPSTREAM_PATH_INVALID",
  "SHADOW_PATH_INVALID",
  "DUPLICATE_UPSTREAM_IDENTITY",
  "CONFLICTING_SHADOW_MAPPING",
  "SHADOW_OPERATION_NOT_MOUNTED",
  "ROUTE_MAP_UNREADABLE",
  "MOUNTED_OPERATIONS_UNAVAILABLE",
  "UNKNOWN_FLAG",
];

async function lib() {
  assert.ok(
    fs.existsSync(LIB),
    "tools/api-discovery/lib/routeMapValidation.mjs must exist (reusable route-map validation library)"
  );
  return import(pathToFileURL(LIB).href);
}

// Synthetic valid world: three entries, all mounted.
const OK_MAP = [
  {
    method: "POST",
    upstreamPath: "/WebRW/Customer/CustomersRead",
    shadowPath: "/api/v1/routeware/customer/customers-read",
    exampleFile: "examples/customers-read.post.example.json",
  },
  {
    method: "GET",
    upstreamPath: "/WebRW/Customer/LoadLongCustomerModal",
    shadowPath: "/api/v1/routeware/customer/load-long-modal",
    exampleQuery: "customerID=1",
  },
  {
    method: "PUT",
    upstreamPath: "/WebRW/Customer/UpdateThing",
    shadowPath: "/api/v1/routeware/customer/update-thing",
  },
];
const MOUNTED = [
  "POST /api/v1/routeware/customer/customers-read",
  "GET /api/v1/routeware/customer/load-long-modal",
  "PUT /api/v1/routeware/customer/update-thing",
  "GET /api/v1/customer-snapshot/{customerId}",
];

const clone = (v) => JSON.parse(JSON.stringify(v));
const entry = (over) => ({ ...clone(OK_MAP[0]), ...over });
const codesOf = (result) => result.findings.map((f) => f.code).sort();

// --- library: valid input --------------------------------------------------

test("lib: valid map with all shadow targets mounted passes every check", async () => {
  const { validateRouteMap, SCHEMA_VERSION } = await lib();
  assert.equal(SCHEMA_VERSION, 1);
  const result = validateRouteMap(OK_MAP, { mountedOperations: MOUNTED });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(
    result.checks,
    CHECK_ORDER.map((id) => ({ id, status: "pass" }))
  );
  assert.deepEqual(result.summary, { entries: 3, errors: 0 });
});

test("lib: without a mounted-operations list the mounted check is skipped, not passed", async () => {
  const { validateRouteMap } = await lib();
  const result = validateRouteMap(OK_MAP);
  assert.equal(result.ok, true);
  const mounted = result.checks.find((c) => c.id === "route-map.mounted-operation");
  assert.equal(mounted?.status, "skipped");
  assert.ok(
    result.checks.filter((c) => c.id !== "route-map.mounted-operation").every((c) => c.status === "pass")
  );
});

test("lib: the real downstream fixture map is valid (existing valid mappings are preserved)", async () => {
  const { validateRouteMap } = await lib();
  const result = validateRouteMap(clone(DOWNSTREAM_ROUTE_MAP));
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

test("lib: exports the closed contract vocabulary", async () => {
  const { CHECK_IDS, FINDING_CODES, SUPPORTED_METHODS } = await lib();
  assert.deepEqual([...SUPPORTED_METHODS].sort(), ["DELETE", "GET", "PATCH", "POST", "PUT"]);
  assert.deepEqual([...CHECK_IDS].filter((id) => CHECK_ORDER.includes(id)), CHECK_ORDER);
  assert.deepEqual([...FINDING_CODES].sort(), [...ALL_CODES].sort());
});

test("lib: does not mutate its input", async () => {
  const { validateRouteMap } = await lib();
  const input = clone([...OK_MAP, entry({ method: "post" })]);
  const frozen = JSON.stringify(input);
  Object.freeze(input);
  input.forEach((e) => Object.freeze(e));
  const mounted = Object.freeze([...MOUNTED]);
  validateRouteMap(input, { mountedOperations: mounted });
  assert.equal(JSON.stringify(input), frozen);
});

// --- library: defects, one per check ---------------------------------------

const DEFECTS = [
  {
    name: "map is not an array",
    map: { method: "GET" },
    checkId: "route-map.shape",
    code: "ROUTE_MAP_NOT_ARRAY",
    indexes: [],
  },
  {
    name: "entry is null",
    map: [OK_MAP[0], null],
    checkId: "route-map.shape",
    code: "ENTRY_FIELD_INVALID",
    indexes: [1],
  },
  {
    name: "entry is missing shadowPath",
    map: [{ method: "GET", upstreamPath: "/WebRW/A/B" }],
    checkId: "route-map.shape",
    code: "ENTRY_FIELD_INVALID",
    indexes: [0],
  },
  {
    name: "entry has a non-string upstreamPath",
    map: [entry({ upstreamPath: 7 })],
    checkId: "route-map.shape",
    code: "ENTRY_FIELD_INVALID",
    indexes: [0],
  },
  {
    name: "lowercase method",
    map: [entry({ method: "post" })],
    checkId: "route-map.method",
    code: "METHOD_UNSUPPORTED",
    indexes: [0],
  },
  {
    name: "unknown method",
    map: [entry({ method: "FETCH" })],
    checkId: "route-map.method",
    code: "METHOD_UNSUPPORTED",
    indexes: [0],
  },
  {
    name: "method with padding",
    map: [entry({ method: " POST" })],
    checkId: "route-map.method",
    code: "METHOD_UNSUPPORTED",
    indexes: [0],
  },
  {
    name: "empty method",
    map: [entry({ method: "" })],
    checkId: "route-map.shape",
    code: "ENTRY_FIELD_INVALID",
    indexes: [0],
  },
  ...[
    ["relative upstream path", "WebRW/Customer/CustomersRead"],
    ["double slash", "/WebRW//Customer/CustomersRead"],
    ["trailing slash", "/WebRW/Customer/CustomersRead/"],
    ["dot-dot segment", "/WebRW/../Customer/CustomersRead"],
    ["dot segment", "/WebRW/./CustomersRead"],
    ["encoded dot-dot segment", "/WebRW/%2e%2e/CustomersRead"],
    ["query in path", `/WebRW/Customer/CustomersRead?token=${SENTINEL}`],
    ["fragment in path", "/WebRW/Customer/CustomersRead#frag"],
    ["whitespace in path", "/WebRW/Customer/Customers Read"],
    ["backslash in path", "\\WebRW\\Customer\\CustomersRead"],
    ["absolute URL instead of path", "https://example.invalid/WebRW/Customer/CustomersRead"],
  ].map(([name, upstreamPath]) => ({
    name: `upstream: ${name}`,
    map: [entry({ upstreamPath })],
    checkId: "route-map.upstream-path",
    code: "UPSTREAM_PATH_INVALID",
    indexes: [0],
  })),
  ...[
    ["relative shadow path", "api/v1/routeware/customer/customers-read"],
    ["double slash", "/api/v1//routeware/customer/customers-read"],
    ["trailing slash", "/api/v1/routeware/customer/customers-read/"],
    ["dot-dot segment", "/api/v1/routeware/../customer/customers-read"],
    ["query in path", `/api/v1/routeware/customer/customers-read?key=${SENTINEL}`],
  ].map(([name, shadowPath]) => ({
    name: `shadow: ${name}`,
    map: [entry({ shadowPath })],
    checkId: "route-map.shadow-path",
    code: "SHADOW_PATH_INVALID",
    indexes: [0],
  })),
  {
    name: "same method+upstream twice with different shadow paths",
    map: [OK_MAP[0], entry({ shadowPath: "/api/v1/routeware/customer/customers-read-v2" })],
    checkId: "route-map.duplicate-upstream",
    code: "DUPLICATE_UPSTREAM_IDENTITY",
    indexes: [0, 1],
  },
  {
    name: "exact duplicate entry",
    map: [OK_MAP[0], clone(OK_MAP[0])],
    checkId: "route-map.duplicate-upstream",
    code: "DUPLICATE_UPSTREAM_IDENTITY",
    indexes: [0, 1],
  },
  {
    name: "duplicate upstream differing only by letter case",
    map: [
      OK_MAP[0],
      entry({
        upstreamPath: "/webrw/customer/customersread",
        shadowPath: "/api/v1/routeware/customer/customers-read-lower",
      }),
    ],
    checkId: "route-map.duplicate-upstream",
    code: "DUPLICATE_UPSTREAM_IDENTITY",
    indexes: [0, 1],
  },
  {
    name: "two upstream operations mapped onto one shadow method+path",
    map: [OK_MAP[0], entry({ upstreamPath: "/WebRW/Customer/CustomersReadOther" })],
    checkId: "route-map.conflicting-shadow",
    code: "CONFLICTING_SHADOW_MAPPING",
    indexes: [0, 1],
  },
];

for (const defect of DEFECTS) {
  test(`lib: ${defect.name} -> ${defect.code}`, async () => {
    const { validateRouteMap } = await lib();
    const result = validateRouteMap(clone(defect.map));
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.ok, false);
    assert.deepEqual(codesOf(result), [defect.code], JSON.stringify(result.findings));
    const finding = result.findings[0];
    assert.equal(finding.checkId, defect.checkId);
    assert.equal(finding.severity, "error");
    assert.deepEqual(finding.entryIndexes, defect.indexes);
    assert.equal(typeof finding.nextAction, "string");
    assert.ok(finding.nextAction.length >= 10, "nextAction must be a concrete instruction");
    assert.ok(finding.id && !/\s/.test(finding.id), "finding id must be a stable token");
    assert.ok(finding.id.startsWith(defect.code));
    assert.equal(result.checks.find((c) => c.id === defect.checkId)?.status, "fail");
    assert.equal(result.summary.errors, 1);
  });
}

test("lib: a rejected path or credential-looking value is never echoed in the result", async () => {
  const { validateRouteMap } = await lib();
  const result = validateRouteMap([
    entry({ upstreamPath: `/WebRW/Customer/CustomersRead?token=${SENTINEL}` }),
    entry({
      upstreamPath: "/WebRW/Customer/Other",
      shadowPath: `/api/v1/x?key=${SENTINEL}`,
      exampleQuery: `customerID=${SENTINEL}`,
      secretNote: SENTINEL,
    }),
  ]);
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes(SENTINEL), "result leaked a rejected value");
});

test("lib: valid and duplicate findings echo only the valid method and paths", async () => {
  const { validateRouteMap } = await lib();
  const result = validateRouteMap([OK_MAP[0], clone(OK_MAP[0])]);
  const [finding] = result.findings;
  assert.equal(finding.method, "POST");
  assert.equal(finding.upstreamPath, "/WebRW/Customer/CustomersRead");
});

test("lib: same upstream path under a different method is not a duplicate", async () => {
  const { validateRouteMap } = await lib();
  const result = validateRouteMap([
    OK_MAP[1],
    entry({
      method: "POST",
      upstreamPath: OK_MAP[1].upstreamPath,
      shadowPath: "/api/v1/routeware/customer/load-long-modal-post",
    }),
  ]);
  assert.deepEqual(result.findings, []);
});

test("lib: one shadow path under different methods is not a conflicting mapping", async () => {
  const { validateRouteMap } = await lib();
  const result = validateRouteMap([
    entry({ method: "GET", upstreamPath: "/WebRW/A/Read", shadowPath: "/api/v1/routeware/a/read" }),
    entry({ method: "POST", upstreamPath: "/WebRW/A/Write", shadowPath: "/api/v1/routeware/a/read" }),
  ]);
  assert.deepEqual(result.findings, []);
});

test("lib: a duplicate group yields one finding listing all entries, not one per pair", async () => {
  const { validateRouteMap } = await lib();
  const result = validateRouteMap([
    OK_MAP[0],
    entry({ shadowPath: "/api/v1/routeware/customer/dup-b" }),
    entry({ shadowPath: "/api/v1/routeware/customer/dup-c" }),
  ]);
  assert.deepEqual(codesOf(result), ["DUPLICATE_UPSTREAM_IDENTITY"]);
  assert.deepEqual(result.findings[0].entryIndexes, [0, 1, 2]);
});

test("lib: several defects are all reported, ordered by check then entry index", async () => {
  const { validateRouteMap } = await lib();
  const result = validateRouteMap(
    [
      entry({ method: "nope" }),
      OK_MAP[1],
      entry({
        method: "GET",
        upstreamPath: "/WebRW/Z/Missing",
        shadowPath: "/api/v1/routeware/z/missing",
      }),
      clone(OK_MAP[1]),
    ],
    { mountedOperations: MOUNTED }
  );
  assert.deepEqual(
    result.findings.map((f) => f.code),
    ["METHOD_UNSUPPORTED", "DUPLICATE_UPSTREAM_IDENTITY", "SHADOW_OPERATION_NOT_MOUNTED"]
  );
  assert.equal(result.summary.errors, 3);
  assert.deepEqual(
    result.checks.map((c) => c.id),
    CHECK_ORDER
  );
});

test("lib: finding ids are unique, deterministic and independent of entry order", async () => {
  const { validateRouteMap } = await lib();
  const map = [
    OK_MAP[0],
    entry({ shadowPath: "/api/v1/routeware/customer/dup-b" }),
    entry({ upstreamPath: "/WebRW/Customer/Other", shadowPath: "/api/v1/routeware/customer/shared" }),
    entry({ upstreamPath: "/WebRW/Customer/Other2", shadowPath: "/api/v1/routeware/customer/shared" }),
    entry({
      upstreamPath: "/WebRW/Z/Missing",
      shadowPath: "/api/v1/routeware/z/missing",
    }),
  ];
  const opts = { mountedOperations: MOUNTED };
  const first = validateRouteMap(clone(map), opts);
  const again = validateRouteMap(clone(map), opts);
  assert.deepEqual(first, again, "validation must be deterministic");
  const ids = first.findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  assert.ok(ids.length >= 4);
  const reversed = validateRouteMap(clone(map).reverse(), opts);
  assert.deepEqual([...reversed.findings.map((f) => f.id)].sort(), [...ids].sort());
});

test("lib: every finding code and check id belongs to the closed vocabulary", async () => {
  const { validateRouteMap, FINDING_CODES, CHECK_IDS } = await lib();
  for (const { map } of DEFECTS) {
    const result = validateRouteMap(clone(map), { mountedOperations: MOUNTED });
    for (const f of result.findings) {
      assert.ok(FINDING_CODES.includes(f.code), f.code);
      assert.ok(CHECK_IDS.includes(f.checkId), f.checkId);
    }
  }
});

// --- library: mounted-operation resolution ----------------------------------

test("lib: a shadow target that is not mounted is reported even when the map is otherwise valid", async () => {
  const { validateRouteMap } = await lib();
  const result = validateRouteMap(
    [entry({ shadowPath: "/api/v1/routeware/customer/not-a-real-route" })],
    { mountedOperations: MOUNTED }
  );
  assert.deepEqual(codesOf(result), ["SHADOW_OPERATION_NOT_MOUNTED"]);
  assert.equal(result.findings[0].checkId, "route-map.mounted-operation");
  assert.equal(result.findings[0].shadowPath, "/api/v1/routeware/customer/not-a-real-route");
  assert.equal(result.findings[0].method, "POST");
});

const MOUNT_LOOKALIKES = [
  ["wrong method", { method: "GET" }],
  ["suffix lookalike", { shadowPath: "/api/v1/routeware/customer/customers-read2" }],
  ["prefix lookalike", { shadowPath: "/x/api/v1/routeware/customer/customers-read" }],
  ["different letter case", { shadowPath: "/api/v1/routeware/customer/Customers-Read" }],
  ["extra trailing segment", { shadowPath: "/api/v1/routeware/customer/customers-read/extra" }],
];
for (const [name, over] of MOUNT_LOOKALIKES) {
  test(`lib: mounted resolution rejects a ${name}`, async () => {
    const { validateRouteMap } = await lib();
    const result = validateRouteMap([entry(over)], { mountedOperations: MOUNTED });
    assert.deepEqual(codesOf(result), ["SHADOW_OPERATION_NOT_MOUNTED"], JSON.stringify(result.findings));
  });
}

test("lib: a documented {param} operation resolves exactly one concrete segment", async () => {
  const { validateRouteMap } = await lib();
  const ok = validateRouteMap(
    [entry({ method: "GET", upstreamPath: "/WebRW/Snap/Get", shadowPath: "/api/v1/customer-snapshot/123" })],
    { mountedOperations: MOUNTED }
  );
  assert.deepEqual(ok.findings, []);
  const twoSegments = validateRouteMap(
    [entry({ method: "GET", upstreamPath: "/WebRW/Snap/Get", shadowPath: "/api/v1/customer-snapshot/1/2" })],
    { mountedOperations: MOUNTED }
  );
  assert.deepEqual(codesOf(twoSegments), ["SHADOW_OPERATION_NOT_MOUNTED"]);
});

test("lib: mountedOperationsFromOpenApi turns a document into sorted unique 'METHOD /path' strings", async () => {
  const { mountedOperationsFromOpenApi } = await lib();
  const doc = {
    openapi: "3.1.0",
    paths: {
      "/b": { get: {}, parameters: [], summary: "ignored" },
      "/a/{id}": { post: {}, get: {}, delete: {} },
    },
  };
  assert.deepEqual(mountedOperationsFromOpenApi(doc), ["DELETE /a/{id}", "GET /a/{id}", "GET /b", "POST /a/{id}"]);
  assert.deepEqual(mountedOperationsFromOpenApi({ openapi: "3.1.0", paths: {} }), []);
});

// --- CLI -------------------------------------------------------------------

function sandbox(t, { map = OK_MAP, mounted = MOUNTED } = {}) {
  assert.ok(fs.existsSync(CLI), "tools/api-discovery/route-map-validation.mjs must exist (validation CLI)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-map-validation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(CLI, path.join(dir, "route-map-validation.mjs"));
  fs.cpSync(path.join(toolsDir, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  if (map !== null) {
    fs.writeFileSync(path.join(dir, "route-map.json"), typeof map === "string" ? map : JSON.stringify(map), "utf8");
  }
  if (mounted !== null) fs.writeFileSync(path.join(dir, "mounted.json"), JSON.stringify(mounted), "utf8");
  // A partial harvest holding recorded customer values: validation must never
  // read it into its output, and must never modify it.
  fs.writeFileSync(
    path.join(dir, "out", "harvest.ndjson"),
    `${JSON.stringify({ method: "POST", pathname: "/WebRW/Customer/CustomersRead", requestBodyPreview: `name=${SENTINEL}` })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "out", "discovered-operations.json"),
    JSON.stringify({ operations: [{ method: "POST", pathname: "/WebRW/Customer/CustomersRead", count: 1, note: SENTINEL }] }),
    "utf8"
  );
  return dir;
}

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (name === "node_modules") continue;
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${st.size}:${st.mtimeMs}:${fs.readFileSync(p, "utf8").length}`;
    }
  };
  walk(dir);
  return out;
}

function cli(dir, ...args) {
  const result = spawnSync(process.execPath, [path.join(dir, "route-map-validation.mjs"), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function oneObject(res) {
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(res.stdout);
  }, `stdout must be exactly one JSON object: ${res.stdout}`);
  assert.equal(typeof parsed, "object");
  assert.ok(parsed && !Array.isArray(parsed));
  assert.equal(res.stdout.trim().split("\n").length, 1, "one JSON object means one line of stdout");
  assert.equal(res.stderr, "", "--json must leave stderr empty");
  return parsed;
}

test("cli --json: valid map exits 0 with exactly one schema-versioned object and writes nothing", (t) => {
  const dir = sandbox(t);
  const before = tree(dir);
  const res = cli(dir, "--json", "--mounted-operations=mounted.json");
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  const out = oneObject(res);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.ok, true);
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.checks.map((c) => c.id), CHECK_ORDER);
  assert.ok(out.checks.every((c) => c.status === "pass"));
  assert.ok(!res.stdout.includes(SENTINEL));
  assert.deepEqual(tree(dir), before, "validation must be read-only");
});

test("cli --json: stale/partial harvest is not a validation concern (map stays ok)", (t) => {
  // The seeded harvest only covers CustomersRead; the other two mapped
  // entries are "stale" for route-gap, which is not a mapping defect.
  const dir = sandbox(t);
  const res = cli(dir, "--json", "--mounted-operations=mounted.json");
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  assert.equal(oneObject(res).ok, true);
});

test("cli --json: a conflicting map exits 1, lists findings with next actions, leaks nothing", (t) => {
  const dir = sandbox(t, {
    map: [
      OK_MAP[0],
      entry({ upstreamPath: "/WebRW/Customer/CustomersReadOther" }),
      entry({ method: "put", upstreamPath: "/WebRW/Customer/Up", shadowPath: "/api/v1/routeware/customer/up" }),
      entry({ upstreamPath: "/WebRW/Customer/Nowhere", shadowPath: "/api/v1/routeware/customer/nowhere" }),
      entry({
        upstreamPath: `/WebRW/Customer/Q?token=${SENTINEL}`,
        shadowPath: "/api/v1/routeware/customer/q",
      }),
    ],
  });
  const before = tree(dir);
  const res = cli(dir, "--json", "--mounted-operations=mounted.json");
  assert.equal(res.status, 1);
  const out = oneObject(res);
  assert.equal(out.ok, false);
  assert.deepEqual(
    [...new Set(out.findings.map((f) => f.code))].sort(),
    ["CONFLICTING_SHADOW_MAPPING", "METHOD_UNSUPPORTED", "SHADOW_OPERATION_NOT_MOUNTED", "UPSTREAM_PATH_INVALID"].sort()
  );
  for (const f of out.findings) {
    assert.ok(ALL_CODES.includes(f.code));
    assert.equal(typeof f.nextAction, "string");
    assert.ok(f.nextAction.length >= 10);
    assert.ok(typeof f.id === "string" && f.id.length > 0);
  }
  assert.ok(!res.stdout.includes(SENTINEL), "CLI echoed a rejected value or harvest value");
  assert.deepEqual(tree(dir), before);
});

test("cli: rejects unknown flags with one JSON object, exit 2, and does not echo the flag value", (t) => {
  const dir = sandbox(t);
  const res = cli(dir, "--json", `--bogus=${SENTINEL}`);
  assert.equal(res.status, 2);
  const out = oneObject(res);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.ok, false);
  assert.equal(out.findings[0].code, "UNKNOWN_FLAG");
  assert.equal(out.findings[0].checkId, "cli.arguments");
  assert.ok(!res.stdout.includes(SENTINEL));
});

test("cli: a bare positional argument is rejected like an unknown flag", (t) => {
  const dir = sandbox(t);
  const res = cli(dir, "--json", "route-map.json");
  assert.equal(res.status, 2);
  assert.equal(oneObject(res).findings[0].code, "UNKNOWN_FLAG");
});

test("cli: unknown flag before --json still yields one JSON object, exit 2, and does not echo the flag value", (t) => {
  const dir = sandbox(t);
  const res = cli(dir, `--bogus=${SENTINEL}`, "--json");
  assert.equal(res.status, 2);
  const out = oneObject(res);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.ok, false);
  assert.equal(out.findings[0].code, "UNKNOWN_FLAG");
  assert.equal(out.findings[0].checkId, "cli.arguments");
  assert.ok(!res.stdout.includes(SENTINEL));
});

test("cli: positional argument before --json is rejected like an unknown flag", (t) => {
  const dir = sandbox(t);
  const res = cli(dir, "route-map.json", "--json");
  assert.equal(res.status, 2);
  assert.equal(oneObject(res).findings[0].code, "UNKNOWN_FLAG");
});

test("cli: unknown flag without --json exits 2 and reports on stderr", (t) => {
  const dir = sandbox(t);
  const res = cli(dir, `--bogus=${SENTINEL}`);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--json/, "usage message should name the supported flags");
  assert.ok(!`${res.stdout}${res.stderr}`.includes(SENTINEL));
});

test("cli --json: an unreadable route map is a fixed-code finding, never raw exception text", (t) => {
  const dir = sandbox(t, { map: `[{"method": "GET", "note": "${SENTINEL}" ` });
  const res = cli(dir, "--json", "--mounted-operations=mounted.json");
  assert.equal(res.status, 1);
  const out = oneObject(res);
  assert.equal(out.ok, false);
  assert.deepEqual(out.findings.map((f) => f.code), ["ROUTE_MAP_UNREADABLE"]);
  const text = res.stdout;
  assert.ok(!text.includes(SENTINEL));
  assert.ok(!/SyntaxError|Unexpected|JSON\.parse|node:internal|\bat file:|\bat async\b/.test(text), text);
});

test("cli --json: a missing route-map.json is the same fixed-code finding", (t) => {
  const dir = sandbox(t, { map: null });
  const res = cli(dir, "--json", "--mounted-operations=mounted.json");
  assert.equal(res.status, 1);
  assert.deepEqual(oneObject(res).findings.map((f) => f.code), ["ROUTE_MAP_UNREADABLE"]);
});

test("cli --json: missing or malformed mounted-operations input is MOUNTED_OPERATIONS_UNAVAILABLE", (t) => {
  const dir = sandbox(t);
  const missing = cli(dir, "--json", "--mounted-operations=nope.json");
  assert.equal(missing.status, 1);
  const out = oneObject(missing);
  assert.deepEqual(out.findings.map((f) => f.code), ["MOUNTED_OPERATIONS_UNAVAILABLE"]);
  assert.equal(out.findings[0].checkId, "route-map.mounted-operation");

  fs.writeFileSync(path.join(dir, "bad.json"), `{"not":"an array","x":"${SENTINEL}"`, "utf8");
  const bad = cli(dir, "--json", "--mounted-operations=bad.json");
  assert.equal(bad.status, 1);
  assert.deepEqual(oneObject(bad).findings.map((f) => f.code), ["MOUNTED_OPERATIONS_UNAVAILABLE"]);
  assert.ok(!bad.stdout.includes(SENTINEL));
});

test("cli --json: without --mounted-operations and without repo source, validation fails closed", (t) => {
  // The sandbox has no src/ beside it, so the derived mounted set is
  // unavailable: that must fail, not silently skip the mounted check.
  const dir = sandbox(t);
  const res = cli(dir, "--json");
  assert.equal(res.status, 1);
  assert.deepEqual(oneObject(res).findings.map((f) => f.code), ["MOUNTED_OPERATIONS_UNAVAILABLE"]);
});

test("cli (text mode): reports finding codes on a bad map and exits 1", (t) => {
  const dir = sandbox(t, { map: [OK_MAP[0], clone(OK_MAP[0])] });
  const res = cli(dir, "--mounted-operations=mounted.json");
  assert.equal(res.status, 1);
  assert.match(`${res.stdout}${res.stderr}`, /DUPLICATE_UPSTREAM_IDENTITY/);
});

test("cli: the real route map validates against the mounted operations derived from the repo source", () => {
  const before = tree(toolsDir);
  const res = spawnSync(process.execPath, [CLI, "--json"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(res.error);
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
  const out = oneObject({ stdout: res.stdout, stderr: res.stderr });
  assert.equal(out.ok, true);
  const mounted = out.checks.find((c) => c.id === "route-map.mounted-operation");
  assert.equal(mounted?.status, "pass", "the real run must actually resolve mounted operations");
  assert.equal(out.summary.entries, JSON.parse(fs.readFileSync(path.join(toolsDir, "route-map.json"), "utf8")).length);
  assert.deepEqual(tree(toolsDir), before, "the real run must not write into tools/api-discovery");
});

// --- integration: validation runs before artifacts are generated -----------

function artifactSandbox(t, script, map) {
  assert.ok(fs.existsSync(path.join(toolsDir, script)), `${script} must exist`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-map-validation-artifact-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(toolsDir, script), path.join(dir, script));
  fs.cpSync(path.join(toolsDir, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out", "bodies"), { recursive: true });
  fs.writeFileSync(path.join(dir, "route-map.json"), JSON.stringify(map), "utf8");
  fs.writeFileSync(path.join(dir, "out", "route-gaps.json"), JSON.stringify(ROUTE_GAPS), "utf8");
  fs.writeFileSync(path.join(dir, "out", "bodies", "keep.txt"), "previous body", "utf8");
  fs.writeFileSync(path.join(dir, "out", "curl-examples.sh"), "OLD CURLS", "utf8");
  fs.writeFileSync(path.join(dir, "out", "suggested-routes.stub.ts"), "OLD STUB", "utf8");
  return dir;
}

function runScript(dir, script, ...args) {
  const res = spawnSync(process.execPath, [path.join(dir, script), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(res.error);
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

const NO_EXAMPLE_MAP = OK_MAP.map((e) => ({ method: e.method, upstreamPath: e.upstreamPath, shadowPath: e.shadowPath }));
const DUP_MAP = [...NO_EXAMPLE_MAP, { ...NO_EXAMPLE_MAP[0], shadowPath: "/api/v1/routeware/customer/customers-read-v2" }];

for (const script of ["export-curl-examples.mjs", "suggest-routes.mjs"]) {
  test(`${script}: an invalid route map stops before any artifact is written or removed`, (t) => {
    const dir = artifactSandbox(t, script, DUP_MAP);
    const before = tree(dir);
    const res = runScript(dir, script);
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /DUPLICATE_UPSTREAM_IDENTITY/);
    assert.deepEqual(tree(dir), before, "no artifact may be written, replaced or deleted");
  });

  test(`${script}: --dry-run on a valid map validates and writes nothing`, (t) => {
    const dir = artifactSandbox(t, script, NO_EXAMPLE_MAP);
    const before = tree(dir);
    const res = runScript(dir, script, "--dry-run");
    assert.equal(res.status, 0, res.output);
    assert.match(res.output, /dry-run/i);
    assert.deepEqual(tree(dir), before, "--dry-run must not touch the filesystem");
  });

  test(`${script}: --dry-run on an invalid map exits 1, names the code, writes nothing`, (t) => {
    const dir = artifactSandbox(t, script, DUP_MAP);
    const before = tree(dir);
    const res = runScript(dir, script, "--dry-run");
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /DUPLICATE_UPSTREAM_IDENTITY/);
    assert.deepEqual(tree(dir), before);
  });
}

test("export-curl-examples.mjs: a valid map still writes the curl artifact without --dry-run", (t) => {
  const dir = artifactSandbox(t, "export-curl-examples.mjs", NO_EXAMPLE_MAP);
  const res = runScript(dir, "export-curl-examples.mjs");
  assert.equal(res.status, 0, res.output);
  const sh = fs.readFileSync(path.join(dir, "out", "curl-examples.sh"), "utf8");
  assert.notEqual(sh, "OLD CURLS");
  assert.match(sh, /customers-read/);
});

// route-gap.mjs: a duplicate/conflicting mapping must not look "covered".

function gapSandbox(t, map, operations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-map-validation-gap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.copyFileSync(path.join(toolsDir, "route-gap.mjs"), path.join(dir, "route-gap.mjs"));
  fs.cpSync(path.join(toolsDir, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "route-map.json"), JSON.stringify(map), "utf8");
  fs.writeFileSync(
    path.join(dir, "out", "discovered-operations.json"),
    JSON.stringify({ operations }),
    "utf8"
  );
  return dir;
}

const COVERED_OP = [{ method: "POST", pathname: "/WebRW/Customer/CustomersRead", count: 3 }];

for (const flag of [[], ["--report-only"], ["--strict"]]) {
  test(`route-gap.mjs ${flag.join(" ")}: a duplicate mapping is not reported as covered`, (t) => {
    const dir = gapSandbox(t, DUP_MAP, COVERED_OP);
    const res = runScript(dir, "route-gap.mjs", ...flag);
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /DUPLICATE_UPSTREAM_IDENTITY/);
  });
}

test("route-gap.mjs: a valid map with a partial harvest keeps its exit-0 semantics (stale entries only warn)", (t) => {
  const dir = gapSandbox(t, NO_EXAMPLE_MAP, COVERED_OP);
  const warn = runScript(dir, "route-gap.mjs");
  assert.equal(warn.status, 0, warn.output);
  assert.match(warn.output, /stale map entries are warnings by default/);
  const strict = runScript(dir, "route-gap.mjs", "--strict");
  assert.equal(strict.status, 1, "--strict still fails on stale entries");
});

// --- wiring ------------------------------------------------------------------

test("wiring: package scripts run validation first and expose it to agents", () => {
  const tools = JSON.parse(fs.readFileSync(path.join(toolsDir, "package.json"), "utf8"));
  const root = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(tools.scripts["validate:routes"], "node route-map-validation.mjs");
  assert.equal(String(tools.scripts.process).split("&&")[0].trim(), "node route-map-validation.mjs");
  assert.equal(root.scripts["discovery:validate"], "npm run validate:routes --prefix tools/api-discovery --");
  assert.match(root.scripts["test:discovery"], /tools\/api-discovery\/route-map-validation\.test\.mjs/);
});

test("wiring: CI keeps running test:discovery (the new file's path into CI)", () => {
  const ci = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /run: npm run test:discovery$/m);
});

test("wiring: every consumer imports the one shared validation library", () => {
  for (const script of ["route-map-validation.mjs", "route-gap.mjs", "export-curl-examples.mjs", "suggest-routes.mjs"]) {
    const file = path.join(toolsDir, script);
    assert.ok(fs.existsSync(file), `${script} must exist`);
    assert.match(
      fs.readFileSync(file, "utf8"),
      /from\s*["']\.\/lib\/routeMapValidation\.mjs["']/,
      `${script} must import ./lib/routeMapValidation.mjs`
    );
  }
});

test("docs: discovery README documents the command, flags, schema and every code", async () => {
  const { FINDING_CODES, CHECK_IDS } = await lib();
  const readme = fs.readFileSync(path.join(toolsDir, "README.md"), "utf8");
  for (const needle of [
    "route-map-validation.mjs",
    "validate:routes",
    "--json",
    "--mounted-operations",
    "--dry-run",
    "schemaVersion",
  ]) {
    assert.ok(readme.includes(needle), `tools/api-discovery/README.md must mention ${needle}`);
  }
  for (const code of FINDING_CODES) assert.ok(readme.includes(code), `README must document ${code}`);
  for (const id of CHECK_IDS) assert.ok(readme.includes(id), `README must document check ${id}`);
});

test("docs: root README and CONVENTIONS list the agent-facing discovery:validate command", () => {
  for (const file of [path.join(repoRoot, "README.md"), path.join(repoRoot, "docs", "CONVENTIONS.md")]) {
    assert.ok(
      fs.readFileSync(file, "utf8").includes("discovery:validate"),
      `${path.relative(repoRoot, file)} must list npm run discovery:validate`
    );
  }
});
