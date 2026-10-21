/**
 * Independently owned public-boundary acceptance tests for local curl examples.
 * Run: node --test tools/api-discovery/curl-safety.acceptance.test.mjs
 *
 * Contract supplied to the paired build (no implementation inspected):
 * - bash out/curl-examples.sh [--operation 'METHOD /WebRW/Path']
 *   [--list | --help | --dry-run | --json], target supplied by BASE.
 * - IDs are the existing map's method + space + upstreamPath, never an index.
 * - --json is a non-executing plan: {schemaVersion: 1, operations: [...]}.
 *   Each operation has id, method, upstreamPath, shadowPath, executable, body.
 *   body.source is none / harvest / synthetic / unavailable; body.file is
 *   relative to out/ when present. Unavailable bodies have code + next_action.
 * - exporter --dry-run (also with --json) validates/plans without changing out/.
 * Refusal wording and argv order are deliberately not pinned. A body diagnostic
 * must not contain payload values. Only non-GET documentation carries bodies.
 *
 * All inputs are invented. Copy the real exporter + lib/, not a renderer
 * substitute. PATH contains our recording curl, Node and basic local utilities;
 * no real curl is reachable by command lookup. All subprocesses are bounded.
 * The tests must catch: eager replay, positional IDs, write/remote bypasses,
 * truncated/trimmed payloads, misleading provenance, unbounded/HTTP-blind curl,
 * ignored bad flags, and destructive or nondeterministic generation.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { curlExampleForEntry } from "./lib/curlExamples.mjs";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const GET_ID = "GET /WebRW/Fixture/Read";
const OTHER_GET_ID = "GET /WebRW/Fixture/OtherRead";
const POST_ID = "POST /WebRW/Fixture/Save";
const COMPLETE = ' \t{"fixture":"COMPLETE_BYTES_Ω"}\r\n \t';
const FALLBACK = ' \tKnown=REPOSITORY_BYTES_Ω&Enabled=true\r\n \t';
const TRUNCATED = '{"fixture":"INCOMPLETE_PREVIEW_SENTINEL';
const MAP = [
  { method: "GET", upstreamPath: "/WebRW/Fixture/Read", shadowPath: "/api/fixture/read", exampleQuery: "fallback=yes" },
  { method: "GET", upstreamPath: "/WebRW/Fixture/OtherRead", shadowPath: "/api/fixture/other", exampleQuery: "requestID=LOCAL_FIXTURE" },
  { method: "POST", upstreamPath: "/WebRW/Fixture/Save", shadowPath: "/api/fixture/save" },
];

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function fixture(t, { map = MAP, rows = [], examples = {} } = {}) {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(root, "curl-safety-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(toolsDir, "export-curl-examples.mjs"), path.join(dir, "export-curl-examples.mjs"));
  fs.cpSync(path.join(toolsDir, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out"));
  fs.mkdirSync(path.join(dir, "bin"));
  writeJson(path.join(dir, "route-map.json"), map);
  fs.writeFileSync(path.join(dir, "out/harvest.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  for (const [name, body] of Object.entries(examples)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  for (const [name, target] of Object.entries({ node: process.execPath, bash: "/bin/bash", sh: "/bin/sh", dirname: "/usr/bin/dirname", cat: "/usr/bin/cat", mkdir: "/usr/bin/mkdir" })) {
    fs.symlinkSync(target, path.join(dir, "bin", name));
  }
  // Models curl's HTTP-error exit only when fail behavior is requested. Never
  // opens a socket. The log is outside out/ so mutation assertions stay honest.
  fs.writeFileSync(path.join(dir, "bin/curl"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CURL_LOG, JSON.stringify(args) + '\\n');
if (process.env.CURL_CASE === 'transport') process.exit(7);
if (process.env.CURL_CASE === 'http404') process.exit(args.some(a => ['--fail', '--fail-with-body', '-f'].includes(a) || /^-[^-]*f/.test(a)) ? 22 : 0);
process.exit(0);
`, { mode: 0o755 });
  const env = { PATH: path.join(dir, "bin"), HOME: dir, CURL_LOG: path.join(dir, "curl.ndjson") };
  return {
    dir,
    generate(args = []) { return run(process.execPath, [path.join(dir, "export-curl-examples.mjs"), ...args], dir, env); },
    shell(args = [], extraEnv = {}) {
      return run("/bin/bash", [path.join(dir, "out/curl-examples.sh"), ...args], dir, { ...env, ...extraEnv });
    },
    calls() {
      return fs.existsSync(env.CURL_LOG) ? fs.readFileSync(env.CURL_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
  };
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `subprocess terminated: ${result.signal}`);
  return { ...result, output: result.stdout + result.stderr };
}

function generated(t, options) {
  const f = fixture(t, options);
  const result = f.generate();
  assert.equal(result.status, 0, result.output);
  f.generation = result;
  return f;
}

function plan(result) {
  assert.equal(result.status, 0, result.output);
  let value;
  assert.doesNotThrow(() => { value = JSON.parse(result.stdout); }, `--json must be one JSON plan, not shell or log text: ${result.stdout}`);
  assert.equal(value.schemaVersion, 1);
  assert.ok(Array.isArray(value.operations), "plan.operations must be an array");
  return value;
}

function operation(value, id) {
  const matches = value.operations.filter((op) => op.id === id);
  assert.equal(matches.length, 1, `expected one stable operation ${id}`);
  return matches[0];
}

function snapshot(dir) {
  const files = {};
  function walk(at, prefix = "") {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix + entry.name;
      const abs = path.join(at, entry.name);
      const stat = fs.lstatSync(abs);
      files[rel] = { mode: stat.mode, mtime: stat.mtimeMs, size: stat.size, bytes: entry.isFile() ? fs.readFileSync(abs).toString("base64") : null };
      if (entry.isDirectory()) walk(abs, rel + "/");
    }
  }
  walk(dir);
  return files;
}

function artifactBytes(dir) {
  return Object.fromEntries(Object.entries(snapshot(dir)).map(([name, value]) => [name, { mode: value.mode, bytes: value.bytes }]));
}

function assertInert(f, result) {
  assert.deepEqual(f.calls(), [], `must not invoke curl: ${result.output}`);
}

function assertRefusal(f, result) {
  assertInert(f, result);
  assert.notEqual(result.status, 0, `must refuse with nonzero exit: ${result.output}`);
  assert.ok(result.output.trim(), "refusal must be diagnosable");
}

function bodyRow(overrides = {}) {
  return { ts: "2026-01-01T00:00:00.000Z", method: "POST", pathname: "/WebRW/Fixture/Save", query: {}, requestContentType: "application/json", requestBodyPreview: COMPLETE, requestBodyTruncated: false, ...overrides };
}

function assertBodyFile(f, op, bytes) {
  assert.equal(typeof op.body.file, "string", "available body must name its artifact relative to out/");
  const file = path.resolve(f.dir, "out", op.body.file);
  assert.ok(file.startsWith(path.join(f.dir, "out") + path.sep), "body artifact must stay inside out/");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(bytes), "complete payload bytes, not trimmed previews");
}

function timeoutValue(args, long, short) {
  const equal = args.find((arg) => arg.startsWith(long + "="));
  if (equal) return Number(equal.slice(long.length + 1));
  const index = args.findIndex((arg) => arg === long || arg === short);
  return index < 0 ? NaN : Number(args[index + 1]);
}

for (const args of [[], ["--help"], ["--list"], ["--json"], ["--dry-run"], ["--operation", GET_ID, "--dry-run"], ["--operation", GET_ID, "--json"]]) {
  test(`no network or mutation in shell planning mode ${JSON.stringify(args)}`, (t) => {
    const f = generated(t, { rows: [bodyRow()] });
    const before = snapshot(path.join(f.dir, "out"));
    const result = f.shell(args, { BASE: "http://127.0.0.1:8787" });
    assertInert(f, result);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(snapshot(path.join(f.dir, "out")), before);
    if (args.includes("--json")) plan(result);
    else assert.match(result.output, /GET \/WebRW\/Fixture\/Read/, "discoverable stable selection");
  });
}

test("help explains selection, local-only GET execution and inert planning", (t) => {
  const f = generated(t);
  const result = f.shell(["--help"]);
  assertInert(f, result);
  assert.equal(result.status, 0, result.output);
  for (const expected of [/--operation/, /--dry-run/, /--json/, /GET/, /loopback|local/i, /BASE/]) assert.match(result.output, expected);
});

test("JSON plan identifies each map entry, preserving non-GET as non-executable", (t) => {
  const f = generated(t, { rows: [bodyRow()] });
  const result = f.shell(["--json"]);
  assertInert(f, result);
  const value = plan(result);
  assert.equal(value.operations.length, 3);
  assert.deepEqual(Object.fromEntries(value.operations.map((op) => [op.id, [op.method, op.upstreamPath, op.shadowPath, op.executable]])), {
    [GET_ID]: ["GET", "/WebRW/Fixture/Read", "/api/fixture/read", true],
    [OTHER_GET_ID]: ["GET", "/WebRW/Fixture/OtherRead", "/api/fixture/other", true],
    [POST_ID]: ["POST", "/WebRW/Fixture/Save", "/api/fixture/save", false],
  });
  assert.equal(operation(value, GET_ID).body.source, "none");
});

for (const base of [undefined, "http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787"]) {
  test(`explicit stable GET executes exactly once against ${base ?? "default loopback"}`, (t) => {
    const f = generated(t, { rows: [bodyRow()] });
    const result = f.shell(["--operation", OTHER_GET_ID], base ? { BASE: base } : {});
    assert.equal(result.status, 0, result.output);
    const calls = f.calls();
    assert.equal(calls.length, 1, "selection must not replay other entries");
    const args = calls[0];
    const urls = args.filter((arg) => /^https?:\/\//.test(arg));
    assert.equal(urls.length, 1);
    const url = new URL(urls[0]);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    if (base) assert.equal(url.origin, new URL(base).origin);
    assert.equal(url.pathname, "/api/fixture/other");
    assert.equal(url.search, "?requestID=LOCAL_FIXTURE");
    assert.ok(!args.some((arg) => /^(--data|--upload|--form|--retry|--location|--insecure|--user|--oauth|-d$|-F$|-T$|-L$|-k$)/.test(arg)), "no data, retries, redirects, auth, or weakened TLS");
    assert.ok(!args.some((arg) => /authorization:|cookie:|x-api-key:/i.test(arg)), "no credential headers");
    const methodIndex = args.findIndex((arg) => arg === "-X" || arg === "--request");
    if (methodIndex >= 0) assert.equal(args[methodIndex + 1], "GET");
    for (const duration of [timeoutValue(args, "--connect-timeout"), timeoutValue(args, "--max-time", "-m")]) {
      assert.ok(Number.isFinite(duration) && duration > 0 && duration <= 120, `finite bounded timeout required: ${JSON.stringify(args)}`);
    }
    assert.ok(args.some((arg) => ["--fail", "--fail-with-body", "-f"].includes(arg) || /^-[^-]*f/.test(arg)), "curl must fail on HTTP errors");
  });
}

for (const [kind, code] of [["http404", 22], ["transport", 7]]) {
  test(`selected GET propagates ${kind} failure and does not retry`, (t) => {
    const f = generated(t, { map: [MAP[0]] });
    const result = f.shell(["--operation", GET_ID], { CURL_CASE: kind });
    assert.notEqual(result.status, 0, `curl exit ${code} must reach the caller: ${result.output}`);
    assert.equal(f.calls().length, 1, "failure must not trigger retries");
  });
}

for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
  test(`${method} stays non-executable, even with a complete body`, (t) => {
    const id = `${method} /WebRW/Fixture/Save`;
    const f = generated(t, { map: [MAP[0], { ...MAP[2], method }], rows: [bodyRow({ method })] });
    assertRefusal(f, f.shell(["--operation", id]));
    const value = plan(f.shell(["--json"]));
    assert.equal(operation(value, id).executable, false);
  });
}

for (const base of [
  "https://example.invalid", "http://192.0.2.10:8787", "http://0.0.0.0:8787",
  "http://localhost.example.invalid:8787", "http://127.0.0.1@example.invalid",
  "http://example.invalid@127.0.0.1:8787", "file:///etc/passwd", "http://[::ffff:c000:201]",
  "http://127.0.0.1:8787/#@example.invalid", "not-a-url",
]) {
  test(`nonlocal or malformed BASE is refused before curl: ${base}`, (t) => {
    const f = generated(t);
    assertRefusal(f, f.shell(["--operation", GET_ID], { BASE: base }));
  });
}

for (const args of [
  ["--operation"], ["--operation", ""], ["--operation", "GET"], ["--operation", "0"],
  ["--operation", "/api/fixture/read"], ["--operation", "GET /WebRW/Fixture/Unknown"],
  ["--operation", GET_ID, "--operation", OTHER_GET_ID], ["--operation", GET_ID, "junk"],
  ["--operation", GET_ID, "--allow-remote"], ["--operation", POST_ID, "--allow-write"],
  ["--operation", GET_ID, "--dry-rnu"], ["--operation", GET_ID, "--help", "--unknown"],
]) {
  test(`malformed selection/flags fail before any curl: ${JSON.stringify(args)}`, (t) => {
    const f = generated(t);
    assertRefusal(f, f.shell(args));
  });
}

test("stable method/path selection survives route-map reordering", (t) => {
  const f = generated(t, { map: [MAP[2], MAP[1], MAP[0]] });
  const result = f.shell(["--operation", GET_ID]);
  assert.equal(result.status, 0, result.output);
  assert.equal(f.calls().length, 1);
  const url = new URL(f.calls()[0].find((arg) => /^https?:\/\//.test(arg)));
  assert.equal(url.pathname, "/api/fixture/read", "ID selects the intended route, not its old index");
  assert.equal(url.search, "?fallback=yes");
});

test("duplicate method/path identities refuse generation and preserve prior artifacts", (t) => {
  const f = generated(t);
  const before = snapshot(path.join(f.dir, "out"));
  writeJson(path.join(f.dir, "route-map.json"), [...MAP, { ...MAP[0], shadowPath: "/api/fixture/alias" }]);
  const result = f.generate();
  assert.notEqual(result.status, 0, result.output);
  assert.deepEqual(snapshot(path.join(f.dir, "out")), before);
  assertInert(f, result);
});

test("GET harvest query takes precedence, repeats keys and escapes shell-active values literally", (t) => {
  const hostile = 'a b"\\$(echo SHELL_EXPANDED >&2)`echo SHELL_EXPANDED >&2`';
  const f = generated(t, { rows: [{ ts: "2026-01-01T00:00:00Z", method: "GET", pathname: "/WebRW/Fixture/Read", query: { x: ["one", "two"], q: hostile }, requestBodyPreview: "DO_NOT_SEND", requestBodyTruncated: false }] });
  const result = f.shell(["--operation", GET_ID]);
  assert.equal(result.status, 0, result.output);
  assert.equal(f.calls().length, 1);
  const args = f.calls()[0];
  const url = new URL(args.find((arg) => arg.startsWith("http")));
  assert.deepEqual(url.searchParams.getAll("x"), ["one", "two"]);
  assert.equal(url.searchParams.get("q"), hostile);
  assert.equal(url.searchParams.has("fallback"), false);
  assert.ok(!args.some((arg) => arg.includes("DO_NOT_SEND") || arg.startsWith("--data")));
  assert.ok(!result.stderr.includes("SHELL_EXPANDED"), "no command substitution");
});

test("route-map path and raw fallback query cannot execute shell substitutions", (t) => {
  const shadowPath = '/api/fixture/$(echo PATH_EXPANDED >&2)`echo PATH_EXPANDED >&2`';
  const query = 'x=$(echo QUERY_EXPANDED >&2)&slash=\\&quote="';
  const f = generated(t, { map: [{ ...MAP[0], shadowPath, exampleQuery: query }] });
  const result = f.shell(["--operation", GET_ID]);
  assert.doesNotMatch(result.stderr, /(^|\n)(PATH_EXPANDED|QUERY_EXPANDED)(\n|$)/);
  if (result.status !== 0) {
    // Rejecting an invalid URL is safe too; never execute its metacharacters.
    assertRefusal(f, result);
    return;
  }
  assert.equal(f.calls().length, 1);
  assert.ok(f.calls()[0].some((arg) => arg.endsWith(shadowPath + "?" + query)), "literal URL must reach curl unchanged");
});

test("pure renderer preserves complete body bytes (positive control)", () => {
  const out = curlExampleForEntry(MAP[2], bodyRow(), COMPLETE);
  assert.ok(out.bodyFile);
  assert.deepEqual(Buffer.from(out.bodyFile.text), Buffer.from(COMPLETE));
});

test("pure renderer never turns a truncated preview into a payload artifact", () => {
  const out = curlExampleForEntry(MAP[2], bodyRow({ requestBodyTruncated: true, requestBodyPreview: TRUNCATED }), TRUNCATED);
  assert.equal(out.bodyFile, null);
  assert.ok(!out.lines.join("\n").includes(TRUNCATED));
});

test("complete harvested bytes are preserved and labelled harvest, without payload diagnostics", (t) => {
  const f = generated(t, { rows: [bodyRow()] });
  assert.deepEqual(fs.readFileSync(path.join(f.dir, "out/bodies/POST_WebRW_Fixture_Save.json")), Buffer.from(COMPLETE));
  assert.ok(!f.generation.output.includes("COMPLETE_BYTES_Ω"));
  const result = f.shell(["--json"]);
  assertInert(f, result);
  const op = operation(plan(result), POST_ID);
  assert.equal(op.body.source, "harvest");
  assert.equal(op.executable, false);
  assertBodyFile(f, op, COMPLETE);
  assert.ok(!result.output.includes("COMPLETE_BYTES_Ω"));
});

test("truncated preview falls back to complete repository example with synthetic provenance", (t) => {
  const f = generated(t, {
    map: [...MAP.slice(0, 2), { ...MAP[2], exampleFile: "examples/save.body", exampleContentType: "application/x-www-form-urlencoded" }],
    rows: [bodyRow({ requestBodyPreview: TRUNCATED, requestBodyTruncated: true })],
    examples: { "examples/save.body": FALLBACK },
  });
  const fallbackFile = path.join(f.dir, "out/bodies/POST_WebRW_Fixture_Save.body");
  assert.ok(fs.existsSync(fallbackFile), "fallback must use the repository Content-Type, not truncated harvest metadata");
  assert.deepEqual(fs.readFileSync(fallbackFile), Buffer.from(FALLBACK), "fallback uses complete repository bytes");
  assert.ok(!f.generation.output.includes("INCOMPLETE_PREVIEW_SENTINEL"));
  assert.ok(!f.generation.output.includes("REPOSITORY_BYTES_Ω"));
  const result = f.shell(["--json"]);
  assertInert(f, result);
  const op = operation(plan(result), POST_ID);
  assert.equal(op.body.source, "synthetic");
  assertBodyFile(f, op, FALLBACK);
  assert.equal(op.executable, false);
  assert.ok(!result.output.includes("INCOMPLETE_PREVIEW_SENTINEL"));
  assert.ok(!result.output.includes("REPOSITORY_BYTES_Ω"));
  assertRefusal(f, f.shell(["--operation", POST_ID]));
});

test("truncated preview without fallback is unavailable with a fixed code and next action", (t) => {
  const f = fixture(t, { rows: [bodyRow({ requestBodyPreview: TRUNCATED, requestBodyTruncated: true })] });
  const harvestFile = path.join(f.dir, "out/harvest.ndjson");
  const harvestBefore = fs.readFileSync(harvestFile);
  f.generation = f.generate();
  assert.deepEqual(fs.readFileSync(harvestFile), harvestBefore, "source harvest bytes must remain unchanged");
  assert.equal(f.generation.status, 0, f.generation.output);
  assert.equal(fs.existsSync(path.join(f.dir, "out/bodies/POST_WebRW_Fixture_Save.json")), false, "truncated preview must never be emitted as a payload file");
  assert.ok(!f.generation.output.includes("INCOMPLETE_PREVIEW_SENTINEL"));
  const result = f.shell(["--json"]);
  assertInert(f, result);
  const op = operation(plan(result), POST_ID);
  assert.equal(op.body.source, "unavailable");
  assert.equal(op.body.code, "BODY_TRUNCATED");
  assert.equal(typeof op.body.next_action, "string");
  assert.ok(op.body.next_action.length > 0);
  assert.ok(op.body.file == null, "unavailable preview cannot have a payload artifact");
  assert.equal(op.executable, false);
  for (const [name, record] of Object.entries(snapshot(path.join(f.dir, "out")))) {
    if (name === "harvest.ndjson") continue; // Source input, not a generated artifact.
    if (record.bytes) assert.ok(!Buffer.from(record.bytes, "base64").toString("utf8").includes(TRUNCATED), "discard incomplete payload bytes, including in documentation");
  }
  assert.ok(!result.output.includes("INCOMPLETE_PREVIEW_SENTINEL"));
});

test("a later truncated harvest row cannot silently resurrect an older payload", (t) => {
  const f = generated(t, { rows: [bodyRow(), bodyRow({ requestBodyPreview: TRUNCATED, requestBodyTruncated: true })] });
  const op = operation(plan(f.shell(["--json"])), POST_ID);
  assert.equal(op.body.source, "unavailable");
  assert.equal(op.body.code, "BODY_TRUNCATED");
  assert.ok(op.body.file == null);
});

test("repository fallback with no harvest also preserves exact bytes and synthetic provenance", (t) => {
  const f = generated(t, { map: [{ ...MAP[2], exampleFile: "examples/save.body", exampleContentType: "text/plain" }], examples: { "examples/save.body": FALLBACK } });
  const op = operation(plan(f.shell(["--json"])), POST_ID);
  assert.equal(op.body.source, "synthetic");
  assertBodyFile(f, op, FALLBACK);
});

for (const args of [["--dry-run"], ["--dry-run", "--json"], ["--json"]]) {
  test(`exporter planning does not create or alter artifacts: ${args.join(" ")}`, (t) => {
    const fresh = fixture(t, { rows: [bodyRow()] });
    const beforeFresh = snapshot(path.join(fresh.dir, "out"));
    const first = fresh.generate(args);
    assert.equal(first.status, 0, first.output);
    assertInert(fresh, first);
    assert.deepEqual(snapshot(path.join(fresh.dir, "out")), beforeFresh);
    const existing = generated(t, { rows: [bodyRow()] });
    fs.writeFileSync(path.join(existing.dir, "out/bodies/keep-existing.txt"), "OLD_BODY_SENTINEL\n");
    const beforeExisting = snapshot(path.join(existing.dir, "out"));
    const next = existing.generate(args);
    assert.equal(next.status, 0, next.output);
    assert.deepEqual(snapshot(path.join(existing.dir, "out")), beforeExisting);
    assertInert(existing, next);
    if (args.includes("--json")) {
      const value = plan(next);
      assert.equal(operation(value, POST_ID).body.source, "harvest");
      assert.ok(!next.output.includes("COMPLETE_BYTES_Ω"));
    }
  });
}

for (const failure of ["malformed-json", "invalid-entry", "unknown-flag"]) {
  test(`generation refusal preserves every old artifact: ${failure}`, (t) => {
    const f = generated(t, { rows: [bodyRow()] });
    fs.writeFileSync(path.join(f.dir, "out/bodies/keep-existing.txt"), "OLD_BODY_SENTINEL\n");
    const before = snapshot(path.join(f.dir, "out"));
    if (failure === "malformed-json") fs.writeFileSync(path.join(f.dir, "route-map.json"), "{bad");
    if (failure === "invalid-entry") writeJson(path.join(f.dir, "route-map.json"), [MAP[0], { method: "GET", upstreamPath: "/WebRW/Fixture/Broken" }]);
    const result = f.generate(failure === "unknown-flag" ? ["--dry-rnu"] : []);
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(snapshot(path.join(f.dir, "out")), before);
    assertInert(f, result);
  });
}

test("normal generation is byte-deterministic for identical synthetic inputs", (t) => {
  const f = generated(t, { rows: [bodyRow()] });
  const before = artifactBytes(path.join(f.dir, "out"));
  const result = f.generate();
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(artifactBytes(path.join(f.dir, "out")), before);
  assertInert(f, result);
});
