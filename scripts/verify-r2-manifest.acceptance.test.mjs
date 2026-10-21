import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Test Author's public CLI contract (schema v1): --json writes one bounded JSON
 * object: {schemaVersion:1, checkId:"r2-manifest", ok, date, mode, dryRun,
 * coverage:{kind:"listed-only"|"expected-tables", expectedTables, verifiedTables},
 * checks:[{id,...}], findings:[{id,code,next_action,...}]}. Table arrays use bare
 * names, sorted. IDs/codes/actions are stable, not derived from untrusted text.
 * Required codes are named at their assertion sites below. Human wording is free.
 *
 * This is a test-only RED handoff, not a ready-to-merge repair. Run explicitly:
 *   node --test scripts/verify-r2-manifest.acceptance.test.mjs
 * The Builder owns wiring this command into the repository validation definition
 * and documenting the full-chain command/partial limitation; no source is edited
 * here. The Vitest companion is test/r2ManifestIdentity.acceptance.test.ts.
 *
 * Only external object IO is replaced. The real CLI, parser, hashing and report
 * run. Every child attempt is recorded; only fake npx can launch, with a PATH and
 * environment containing no real Wrangler, network tools or inherited secrets.
 */
const REPO = fileURLToPath(new URL("../", import.meta.url));
const DATE = "2026-09-28";
const BUCKET = "fixture-snapshots";
const MANIFEST = `${BUCKET}/snapshots/${DATE}.manifest.json`;
const CSV = {
  customer: "CustomerID,Name\n1,SYNTHETIC_CSV_CANARY\n",
  address: "PickupAddressID\n9\n",
  container: "ContainerID\n5\n",
};
const RAW_STDERR = "RAW_DRIVER_STDERR_CANARY";
const UNTRUSTED = "UNTRUSTED_MANIFEST_CANARY";
const objectKey = (table) => `${BUCKET}/snapshots/${DATE}/${table}.csv`;

function manifest(tables = ["customer"]) {
  return {
    version: 1, date: DATE,
    files: Object.fromEntries(tables.map((table) => [
      `${table}.csv`,
      {
        key: `snapshots/${DATE}/${table}.csv`,
        sha256: createHash("sha256").update(CSV[table]).digest("hex"),
        bytes: Buffer.byteLength(CSV[table]),
      },
    ])),
  };
}

// Patch before the CLI's ESM imports, including named child_process imports.
// Mutation logging detects temporary artifacts even if the CLI cleans them up.
const GUARD = `
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
const logs = Object.fromEntries(['children.log', 'mutations.log', 'network.log'].map(name => [name, fs.openSync(process.env.FIXTURE_ROOT + '/' + name, 'a')]));
const write = fs.writeSync;
const record = (name, value) => write(logs[name], JSON.stringify(value) + '\\n');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  cp[name] = function(command, ...args) {
    record('children.log', {name, command: String(command)});
    if (command !== 'npx') throw new Error('unexpected child process blocked');
    return original.call(this, command, ...args);
  };
}
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync']) {
  const original = fs[name];
  fs[name] = function(...args) {
    record('mutations.log', {operation: name});
    return original.apply(this, args);
  };
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'unlink', 'rename', 'copyFile']) {
  const original = fs.promises[name];
  fs.promises[name] = async function(...args) {
    record('mutations.log', {operation: name});
    return original.apply(this, args);
  };
}
const networkBlocked = () => {
  record('network.log', {operation: 'network'});
  throw new Error('network blocked');
};
globalThis.fetch = networkBlocked;
for (const module of [http, https]) for (const name of ['request', 'get']) module[name] = networkBlocked;
net.connect = net.createConnection = net.Socket.prototype.connect = networkBlocked;
syncBuiltinESMExports();
`;

const FAKE_NPX = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
fs.appendFileSync(root + '/objects.log', JSON.stringify(args) + '\\n');
const at = args.indexOf('wrangler');
if (at < 0 || args.slice(at + 1, at + 4).join(' ') !== 'r2 object get') process.exit(90);
const key = args.find(v => v.startsWith('${BUCKET}/'));
const fileAt = args.indexOf('--file');
const out = fileAt >= 0 ? args[fileAt + 1] : args.find(v => v.startsWith('--file='))?.slice(7);
if ((!out && !args.includes('--pipe')) || args.includes('--remote') === args.includes('--local')) process.exit(91);
const objects = JSON.parse(fs.readFileSync(root + '/fixture.json', 'utf8'));
if (!Object.hasOwn(objects, key) || objects[key] === null) {
  process.stderr.write('${RAW_STDERR}' + 'x'.repeat(20000));
  process.exit(1);
}
if (out) fs.writeFileSync(out, objects[key]);
else process.stdout.write(objects[key]);
`;

function lines(file) {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function tree(dir, relative = "") {
  return readdirSync(path.join(dir, relative)).sort().flatMap((name) => {
    const rel = path.join(relative, name);
    if (["children.log", "objects.log", "mutations.log", "network.log"].includes(rel)) return [];
    const file = path.join(dir, rel);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return [[rel, `symlink:${readlinkSync(file)}`]];
    return stat.isDirectory()
      ? [[rel, "directory"], ...tree(dir, rel)]
      : [[rel, createHash("sha256").update(readFileSync(file)).digest("hex")]];
  });
}

function run(flags = [], options = {}) {
  const root = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "r2-identity-"));
  try {
    cpSync(path.join(REPO, "scripts"), path.join(root, "scripts"), { recursive: true });
    cpSync(path.join(REPO, "wrangler.toml"), path.join(root, "wrangler.toml"));
    // The fake npx is CommonJS even though the repository is ESM.
    mkdirSync(path.join(root, "bin"));
    mkdirSync(path.join(root, "tmp"));
    symlinkSync(process.execPath, path.join(root, "bin/node"));
    writeFileSync(path.join(root, "bin/npx"), FAKE_NPX, { mode: 0o755 });
    writeFileSync(path.join(root, "guard.mjs"), GUARD);
    for (const log of ["children.log", "objects.log", "mutations.log", "network.log"]) writeFileSync(path.join(root, log), "");
    const data = options.manifest ?? manifest(options.tables);
    const objects = {
      [MANIFEST]: typeof data === "string" ? data : JSON.stringify(data),
      ...Object.fromEntries(Object.entries(CSV).map(([table, csv]) => [objectKey(table), csv])),
      ...options.objects,
    };
    writeFileSync(path.join(root, "fixture.json"), JSON.stringify(objects));
    const before = tree(root);
    const child = spawnSync(process.execPath, [
      "--import", path.join(root, "guard.mjs"), path.join(root, "scripts/verify-r2-manifest.mjs"),
      ...(flags.some((flag) => flag === "--date" || flag.startsWith("--date=")) ? [] : [`--date=${DATE}`]),
      `--bucket=${BUCKET}`, ...flags,
    ], {
      cwd: root,
      env: {
        PATH: path.join(root, "bin"), HOME: root, TMPDIR: path.join(root, "tmp"),
        FIXTURE_ROOT: root,
        ...(options.token ? { CLOUDFLARE_API_TOKEN: "synthetic-fixture-not-a-credential" } : {}),
      },
      encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, "the CLI must exit rather than be killed by the runtime bound");
    const result = {
      status: child.status, stdout: child.stdout, stderr: child.stderr,
      children: lines(path.join(root, "children.log")),
      calls: lines(path.join(root, "objects.log")),
      mutations: lines(path.join(root, "mutations.log")), before, after: tree(root),
    };
    assert.deepEqual(lines(path.join(root, "network.log")), [], "no direct network access is permitted");
    assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 32 * 1024, "output must be bounded");
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_CSV_CANARY|RAW_DRIVER_STDERR_CANARY|UNTRUSTED_MANIFEST_CANARY/);
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function reads(result) {
  return result.calls.map((args) => args.find((arg) => arg.startsWith(`${BUCKET}/`)));
}

function zeroExecution(result) {
  assert.deepEqual(result.children, [], "must not spawn any child process");
  assert.deepEqual(result.calls, [], "must not read any object");
  assert.deepEqual(result.mutations, [], "must not create/change even temporary artifacts");
  assert.deepEqual(result.after, result.before);
}

function jsonResult(result, ok) {
  assert.equal(result.stderr, "", "--json must not mix driver/human diagnostics into stderr");
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.checkId, "r2-manifest");
  assert.equal(report.ok, ok);
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  assert.ok(Array.isArray(report.findings));
  assert.ok(report.checks.length <= 32 && report.findings.length <= 32);
  const ids = report.checks.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of [...report.checks, ...report.findings]) assert.match(item.id, /^[a-z][a-z0-9._-]{0,95}$/);
  for (const finding of report.findings) {
    assert.match(finding.code, /^R2_[A-Z_]+$/);
    assert.equal(typeof finding.next_action, "string");
    assert.ok(finding.next_action.length > 0 && finding.next_action.length <= 256);
  }
  if (ok) assert.deepEqual(report.findings, []);
  return report;
}

function failure(result, code) {
  assert.equal(result.status, 1);
  const report = jsonResult(result, false);
  assert.ok(report.findings.some((finding) => finding.code === code), `expected fixed code ${code}`);
  return report;
}

test("positive control: legacy listed-only local command actually hashes the listed object", () => {
  const result = run();
  assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr, calls: result.calls, children: result.children }));
  assert.deepEqual(reads(result), [MANIFEST, objectKey("customer")]);
  assert.ok(result.calls.every((args) => args.includes("--local") && !args.includes("--remote")));
  const tampered = run([], { objects: { [objectKey("customer")]: CSV.customer + "tampered\n" } });
  assert.equal(tampered.status, 1);
  assert.match(tampered.stdout + tampered.stderr, /customer\.csv/);
});

test("local persistence selection is forwarded without changing to remote mode", () => {
  const result = run(["--persist-to", "fixture-state"]);
  assert.equal(result.status, 0);
  assert.deepEqual(reads(result), [MANIFEST, objectKey("customer")]);
  for (const args of result.calls) {
    assert.ok(args.includes("--local") && !args.includes("--remote"));
    const index = args.indexOf("--persist-to");
    assert.ok(index >= 0);
    assert.equal(args[index + 1], "fixture-state");
  }
});

test("listed-only JSON success labels its narrower coverage truthfully", () => {
  const result = run(["--json"]);
  assert.equal(result.status, 0);
  const report = jsonResult(result, true);
  assert.equal(report.date, DATE);
  assert.equal(report.mode, "local");
  assert.deepEqual(report.coverage, { kind: "listed-only", expectedTables: [], verifiedTables: ["customer"] });
  assert.deepEqual(reads(result), [MANIFEST, objectKey("customer")]);
});

test("human partial success is explicitly listed-only, not proof that all tables exist", () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /listed.only/i);
  assert.match(result.stdout, /partial|not.*all|not.*full/i);
});

test("explicit full-chain expectation verifies all three daily objects in canonical order", () => {
  const result = run(["--expect=customer,address,container", "--json"], { tables: ["customer", "container", "address"] });
  assert.equal(result.status, 0);
  const report = jsonResult(result, true);
  assert.deepEqual(report.coverage, {
    kind: "expected-tables", expectedTables: ["address", "container", "customer"], verifiedTables: ["address", "container", "customer"],
  });
  assert.deepEqual(reads(result), [MANIFEST, objectKey("address"), objectKey("container"), objectKey("customer")]);
});

test("an explicit nonempty subset can verify a normal partial manifest", () => {
  const result = run(["--expect", "customer", "--json"]);
  assert.equal(result.status, 0);
  assert.deepEqual(jsonResult(result, true).coverage, {
    kind: "expected-tables", expectedTables: ["customer"], verifiedTables: ["customer"],
  });
});

test("expected tables omitted by the manifest fail rather than silently narrowing the audit", () => {
  const result = run(["--expect=customer,address,container", "--json"]);
  const report = failure(result, "R2_EXPECTED_TABLE_MISSING");
  assert.deepEqual(report.coverage.expectedTables, ["address", "container", "customer"]);
  assert.ok(!report.coverage.verifiedTables.includes("address") && !report.coverage.verifiedTables.includes("container"));
  assert.ok(reads(result).every((key) => [MANIFEST, objectKey("customer")].includes(key)));
});

for (const remote of [false, true]) {
  for (const expected of [false, true]) {
    test(`dry-run plans ${remote ? "remote" : "local"}/${expected ? "explicit" : "listed-only"} with zero execution and no token`, () => {
      const result = run(["--dry-run", "--json", ...(remote ? ["--remote"] : []), ...(expected ? ["--expect=customer,address,container"] : [])]);
      zeroExecution(result);
      assert.equal(result.status, 0);
      const report = jsonResult(result, true);
      assert.equal(report.date, DATE);
      assert.equal(report.mode, remote ? "remote" : "local");
      assert.equal(report.dryRun, true);
      assert.deepEqual(report.coverage, {
        kind: expected ? "expected-tables" : "listed-only",
        expectedTables: expected ? ["address", "container", "customer"] : [], verifiedTables: [],
      });
    });
  }
}

for (const flags of [
  ["--expect="], ["--expect=customer,customer"], ["--expect=customer,"],
  ["--expect=customer,,address"], ["--expect=invoice"], ["--expect=Customer"],
  ["--expect=customer.csv"], ["--expect", "--remote"], ["--unexpected-flag"],
  ["--date=2026-02-30"], ["--date=2026-9-28"],
]) {
  test(`invalid selection/flag ${flags.join(" ")} fails before any execution`, () => {
    const result = run([...flags, "--json"]);
    zeroExecution(result);
    assert.equal(result.status, 2);
    assert.ok(jsonResult(result, false).findings.some((finding) => finding.code === "R2_ARGUMENT_INVALID"));
  });
}

test("dry-run does not forgive an invalid expected selection", () => {
  const result = run(["--expect=invoice", "--dry-run", "--remote", "--json"]);
  zeroExecution(result);
  assert.equal(result.status, 2);
  assert.ok(jsonResult(result, false).findings.some((finding) => finding.code === "R2_ARGUMENT_INVALID"));
});

const invalidManifests = [
  ["impossible date", { ...manifest(), date: "2026-02-30" }],
  ["different requested date", { ...manifest(), date: "2026-09-27" }],
  ["empty files", { ...manifest(), files: {} }],
  ["array files", { ...manifest(), files: [] }],
  ["swapped file key", { ...manifest(), files: { "customer.csv": { ...manifest().files["customer.csv"], key: `snapshots/${DATE}/address.csv` } } }],
  ["stale date key", { ...manifest(), files: { "customer.csv": { ...manifest().files["customer.csv"], key: "snapshots/2026-09-27/customer.csv" } } }],
  ["reused table key", { ...manifest(), files: {
    "customer.csv": manifest().files["customer.csv"], "address.csv": manifest().files["customer.csv"],
  } }],
  ["unsafe count", { ...manifest(), files: { "customer.csv": { ...manifest().files["customer.csv"], bytes: 9007199254740992 } } }],
  ["negative count", { ...manifest(), files: { "customer.csv": { ...manifest().files["customer.csv"], bytes: -1 } } }],
  ["fractional count", { ...manifest(), files: { "customer.csv": { ...manifest().files["customer.csv"], bytes: 1.5 } } }],
  ["unknown file", { ...manifest(), files: { [`${UNTRUSTED}.csv`]: { key: UNTRUSTED, sha256: "a".repeat(64), bytes: 1 } } }],
  ["invalid JSON", `${UNTRUSTED}{not-json`],
];
for (const [label, data] of invalidManifests) {
  test(`rejects ${label} before fetching listed CSVs`, () => {
    const result = run([], { manifest: data });
    assert.deepEqual(reads(result), [MANIFEST]);
    assert.equal(result.status, 1);
  });
}

test("manifest failure code/id/action are stable across attacker-controlled values", () => {
  const first = run(["--json"], { manifest: `${UNTRUSTED}{` });
  const second = run(["--json"], { manifest: `${UNTRUSTED}other{` });
  const a = failure(first, "R2_MANIFEST_INVALID");
  const b = failure(second, "R2_MANIFEST_INVALID");
  assert.deepEqual(a.findings, b.findings);
  assert.deepEqual(reads(first), [MANIFEST]);
});

test("valid full manifests yield deterministic JSON despite insertion/selection order", () => {
  const first = run(["--json", "--expect=customer,address,container"], { tables: ["customer", "address", "container"] });
  const second = run(["--json", "--expect=container,customer,address"], { tables: ["container", "customer", "address"] });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.deepEqual(jsonResult(first, true), jsonResult(second, true));
});

test("hash/byte mismatch gives a named, safe machine finding", () => {
  const result = run(["--json"], { objects: { [objectKey("customer")]: CSV.customer + "tampered\n" } });
  const report = failure(result, "R2_HASH_MISMATCH");
  assert.match(JSON.stringify(report), /customer(?:\.csv)?/);
});

test("missing listed object has a named finding without raw driver stderr", () => {
  const result = run(["--json"], { objects: { [objectKey("customer")]: null } });
  const report = failure(result, "R2_OBJECT_MISSING");
  assert.match(JSON.stringify(report), /customer(?:\.csv)?/);
});

for (const key of [MANIFEST, objectKey("customer")]) {
  test(`human missing-object error for ${key} does not leak raw driver stderr`, () => {
    const result = run([], { objects: { [key]: null } });
    assert.equal(result.status, 1);
  });
}

test("missing sidecar fails closed without exposing the driver stderr", () => {
  const result = run(["--json"], { objects: { [MANIFEST]: null } });
  failure(result, "R2_OBJECT_MISSING");
  assert.deepEqual(reads(result), [MANIFEST]);
});

test("remote execution without its required credential remains fenced", () => {
  const result = run(["--remote"]);
  zeroExecution(result);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /CLOUDFLARE_API_TOKEN/);
});

test("JSON remote-credential failure is structured and does not execute", () => {
  const result = run(["--remote", "--json"]);
  zeroExecution(result);
  assert.notEqual(result.status, 0);
  assert.ok(jsonResult(result, false).findings.some((finding) => finding.code === "R2_REMOTE_CREDENTIAL_REQUIRED"));
});

test("synthetic remote credential reaches only the fake reader, never local persistence", () => {
  const result = run(["--remote"], { token: true });
  assert.equal(result.status, 0);
  assert.deepEqual(reads(result), [MANIFEST, objectKey("customer")]);
  assert.ok(result.calls.every((args) => args.includes("--remote") && !args.includes("--local") && !args.includes("--persist-to")));
});

test("help discovers explicit coverage and dry-run without executing", () => {
  const result = run(["--help"]);
  zeroExecution(result);
  assert.equal(result.status, 0);
  for (const flag of ["--expect", "--dry-run", "--json"]) assert.ok(result.stdout.includes(flag), `help must expose ${flag}`);
});
