import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Acceptance-first CLI oracle; no implementation diff was used to author it.
 * Run: node --test scripts/post-deploy-probe-json.acceptance.test.mjs
 *
 * Wire contract pinned here (camelCase matches verify:config --json):
 * { schemaVersion: 1, command: "probe:post-deploy", mode: "run"|"dry-run",
 *   ok: boolean, target: normalizedOrigin|null, checks: [...],
 *   errorCode: null|string, nextAction: null|string }
 * Each check has exactly { id, method, path, outcome, errorCode, httpStatus,
 * httpClass, retryable, nextAction, cron }. Execution outcomes: pass/fail/skip;
 * plan outcomes: planned (public) / unresolved (credential-dependent).
 * httpClass is null or the status family, never response text. cron is null
 * except on evaluated readiness: fresh/stale/absent/malformed. Refusals have
 * empty checks, a fixed errorCode, actionable nextAction, ok:false, exit 1.
 * JSON is one compact line + newline on stdout, empty stderr, <=8192 bytes.
 * This bounds OUTPUT ONLY, not the implementation's response-body reader.
 *
 * Safety boundary: a preload replaces fetch with synthetic responses, refuses
 * every other network API, virtualizes .dev.vars, records token access and
 * refuses child processes and filesystem mutations. Audit writes use a saved
 * fixture-only writer, never the CLI's patched fs. No inherited credentials,
 * preload hooks, live requests, secret-file reads or implementation writes.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const probe = fileURLToPath(new URL("./post-deploy-probe.mjs", import.meta.url));
const ORIGIN = "https://probe-fixture.invalid";
const TOKEN = "SYNTHETIC_PROBE_TOKEN_DO_NOT_ECHO";
const POISON = "SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO";
const IDS = ["public-health", "shadow-health", "readiness"];
const PATHS = ["/api/v1/health", "/api/v1/shadow/health", "/api/v1/readiness"];
const CODES = new Set([
  "missing_token", "http_auth", "http_client", "http_server", "http_redirect",
  "http_status", "network_error", "timeout", "invalid_json", "invalid_health",
  "invalid_readiness", "cron_stale", "malformed_readiness",
]);
const ROW_KEYS = ["id", "method", "path", "outcome", "errorCode", "httpStatus", "httpClass", "retryable", "nextAction", "cron"];

const fixture = `
  import fs from 'node:fs';
  import fsp from 'node:fs/promises';
  import cp from 'node:child_process';
  import http from 'node:http';
  import https from 'node:https';
  import net from 'node:net';
  import tls from 'node:tls';
  import dns from 'node:dns';
  import dgram from 'node:dgram';
  import { syncBuiltinESMExports } from 'node:module';
  const cfg = JSON.parse(process.env.PROBE_FIXTURE_CONFIG);
  const auditFd = fs.openSync(process.env.PROBE_FIXTURE_AUDIT, 'a');
  const auditWrite = fs.writeSync.bind(fs);
  const log = (event) => auditWrite(auditFd, JSON.stringify(event) + '\\n');
  const refuse = (effect) => { log({ effect }); throw new Error('fixture refused ' + effect); };
  for (const [module, names] of [
    [cp, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
    [http, ['request', 'get']], [https, ['request', 'get']],
    [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']],
    [tls, ['connect']], [dns, ['lookup', 'resolve']],
    [dns.promises, ['lookup', 'resolve']], [dgram, ['createSocket']],
  ]) for (const name of names) module[name] = () => refuse(module === cp ? 'subprocess' : 'network');
  const secretFile = (value) => /(?:^|[/\\\\])\\.dev\\.vars(?:[./\\\\]|$)/.test(String(value));
  const writing = (flags) => typeof flags === 'number'
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wa+]/.test(String(flags || 'r'));
  for (const name of ['readFileSync', 'readFile', 'existsSync', 'statSync', 'stat', 'accessSync', 'access', 'openSync', 'open', 'createReadStream']) {
    const original = fs[name].bind(fs);
    fs[name] = (file, ...args) => {
      if ((name === 'open' || name === 'openSync') && writing(args[0])) return refuse('filesystem-write');
      if (!secretFile(file)) return original(file, ...args);
      log({ effect: 'secret-file' });
      if (name === 'existsSync') return false;
      const error = Object.assign(new Error('synthetic absent file'), { code: 'ENOENT' });
      if (typeof args.at(-1) === 'function') { args.at(-1)(error); return; }
      throw error;
    };
  }
  for (const name of ['readFile', 'stat', 'access', 'open']) {
    const original = fsp[name].bind(fsp);
    fsp[name] = async (file, ...args) => {
      if (name === 'open' && writing(args[0])) return refuse('filesystem-write');
      if (!secretFile(file)) return original(file, ...args);
      log({ effect: 'secret-file' });
      throw Object.assign(new Error('synthetic absent file'), { code: 'ENOENT' });
    };
  }
  for (const name of ['writeFile', 'appendFile', 'truncate', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'cp', 'symlink', 'link', 'chmod', 'chown', 'utimes']) {
    for (const key of [name, name + 'Sync']) if (fs[key]) fs[key] = () => refuse('filesystem-write');
    if (fsp[name]) fsp[name] = async () => refuse('filesystem-write');
  }
  fs.createWriteStream = () => refuse('filesystem-write');
  const credentials = new Set(['SHADOW_API_TOKEN', 'CUSTOMER_SNAPSHOT_SYNC_SECRET', 'PROBE_FIXTURE_TOKEN']);
  process.env = new Proxy(process.env, {
    get(target, key) {
      if (credentials.has(key)) {
        log({ effect: 'credential' });
        if (cfg.noEffects) throw new Error('fixture forbids credential resolution');
      }
      return target[key];
    },
  });
  syncBuiltinESMExports();
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => { log({ effect: 'stdout' }); return write(...args); };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    log({ effect: 'timer', delay });
    return realSetTimeout(callback, delay, ...args);
  };
  const wait = (signal, stage, pathname) => new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => { log({ effect: 'late-completion', stage, path: pathname }); resolve(); }, 600);
    const abort = () => {
      clearTimeout(timer); log({ effect: 'abort', stage, path: pathname });
      reject(new DOMException('SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO', 'AbortError'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  const seen = new Set();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const method = init.method || 'GET';
    const authed = headers.has('authorization');
    log({ effect: 'fetch', origin: url.origin, path: url.pathname, method, authed, redirect: init.redirect ?? null });
    if (cfg.noEffects) return refuse('forbidden-fetch');
    if (init.redirect !== 'manual') return refuse('unsafe-redirect');
    if (url.origin !== cfg.origin || !cfg.paths.includes(url.pathname) || method !== 'GET' ||
        seen.has(url.pathname) || url.search || url.hash || url.username || url.password ||
        init.body != null || authed !== (url.pathname !== cfg.paths[0]) ||
        (authed && headers.get('authorization') !== 'Bearer ' + cfg.token)) return refuse('unexpected-fetch');
    seen.add(url.pathname);
    const kind = cfg.failAt === url.pathname ? cfg.kind : null;
    if (kind === 'network') throw new TypeError('SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO ' + cfg.token);
    if (kind === 'fetch-timeout') await wait(init.signal, 'fetch', url.pathname);
    const body = { status: 'ok', service: 'fixture', version: 'v1' };
    if (url.pathname === cfg.paths[2]) {
      body.checks = { d1: { ok: true }, r2: { ok: true, bound: true, enabled: true }, config: { ok: true } };
      if (!cfg.absentCron) body.checks.cron = Object.hasOwn(cfg, 'cron') ? cfg.cron : { stale: false };
    }
    if (kind === 'invalid-health' || kind === 'invalid-readiness') body.status = 'degraded';
    if (cfg.poison !== false) body.privateDetail = 'SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO'.repeat(cfg.large ? 20000 : 1);
    const status = cfg.failAt === url.pathname && cfg.bodyStream ? cfg.httpStatus : typeof kind === 'number' ? kind : 200;
    if (cfg.failAt === url.pathname && cfg.bodyStream) {
      // Native stream failures must not erase an already-known HTTP status.
      // No pull/cancel count is required: non-200 bodies may be ignored entirely.
      const stream = new ReadableStream({
        start(controller) {
          if (cfg.bodyStream === 'error') controller.error(new TypeError('SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO'));
          else {
            const abort = () => {
              log({ effect: 'abort', stage: 'native-body', path: url.pathname });
              controller.error(new DOMException('SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO', 'AbortError'));
            };
            if (init.signal?.aborted) abort();
            else init.signal?.addEventListener('abort', abort, { once: true });
          }
        },
      });
      return new Response(stream, { status });
    }
    const response = new Response(kind === 'invalid-json' ? body.privateDetail : JSON.stringify(body), { status });
    const text = response.text.bind(response);
    response.text = async () => {
      if (kind === 'body-timeout') await wait(init.signal, 'body', url.pathname);
      if (kind === 'body-error') throw new Error('SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO ' + cfg.token);
      if (cfg.delayBody) await new Promise((resolve) => realSetTimeout(resolve, 15));
      const value = await text(); log({ effect: 'body-complete', path: url.pathname }); return value;
    };
    response.json = async () => JSON.parse(await response.text());
    return response;
  };
`;

function run(args = [], options = {}) {
  const dir = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(), "probe-json-test-"));
  const audit = path.join(dir, "audit.jsonl");
  writeFileSync(audit, "");
  try {
    const cfg = { origin: ORIGIN, paths: PATHS, token: TOKEN, ...options.fixture };
    const result = spawnSync(process.execPath, [
      `--import=data:text/javascript,${encodeURIComponent(fixture)}`, probe, ...args,
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH, SHADOW_API_BASE: ORIGIN, SHADOW_API_TOKEN: TOKEN,
        ...options.env, PROBE_FIXTURE_AUDIT: audit, PROBE_FIXTURE_CONFIG: JSON.stringify(cfg),
      },
      encoding: "utf8", timeout: 6_000, maxBuffer: 256 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, "CLI must settle, not be killed by the harness");
    const events = readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const output = result.stdout + result.stderr;
    for (const marker of [TOKEN, POISON, "fixture-password", "fixture-query-secret", "fixture-user"]) {
      assert.ok(!output.includes(marker), `output leaked synthetic marker ${marker}: ${output.slice(0, 2000)}`);
    }
    assert.deepEqual(events.filter((e) => ["network", "subprocess", "filesystem-write", "unexpected-fetch", "unsafe-redirect"].includes(e.effect)), []);
    return { ...result, events, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function noEffects(result) {
  assert.deepEqual(result.events.filter((e) => e.effect !== "stdout"), [], "plan/help/refusal must not fetch, resolve credentials, read secrets, write files or spawn");
}

function json(result) {
  assert.equal(result.stderr, "", "JSON mode must not leak diagnostics on stderr");
  assert.ok(Buffer.byteLength(result.stdout) <= 8192, "bounded machine output (not bounded response reading)");
  assert.ok(result.stdout.endsWith("\n"), "one JSON line ends in a newline");
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, "exactly one JSON result, no text preamble/summary");
  assert.match(lines[0], /^\{/, "stdout must be a JSON object, not a human diagnostic");
  const doc = JSON.parse(lines[0]);
  assert.equal(lines[0], JSON.stringify(doc));
  assert.deepEqual(Object.keys(doc).sort(), ["schemaVersion", "command", "mode", "ok", "target", "checks", "errorCode", "nextAction"].sort());
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.command, "probe:post-deploy");
  assert.equal(typeof doc.ok, "boolean");
  assert.ok(doc.errorCode === null || CODES.has(doc.errorCode) || ["invalid_arguments", "invalid_target"].includes(doc.errorCode), "allowlisted envelope errorCode");
  assert.ok(doc.nextAction === null || (typeof doc.nextAction === "string" && doc.nextAction.length > 10 && doc.nextAction.length <= 240), "bounded envelope remediation");
  assert.ok(["run", "dry-run"].includes(doc.mode));
  assert.ok(Array.isArray(doc.checks));
  assert.ok(doc.target === null || (typeof doc.target === "string" && doc.target === new URL(doc.target).origin));
  return doc;
}

function rows(doc, outcomes = ["pass", "pass", "pass"]) {
  assert.equal(doc.checks.length, 3);
  doc.checks.forEach((row, i) => {
    assert.deepEqual(Object.keys(row).sort(), [...ROW_KEYS].sort());
    assert.equal(row.id, IDS[i]);
    assert.equal(row.path, PATHS[i]);
    assert.equal(row.method, "GET");
    assert.equal(row.outcome, outcomes[i]);
    assert.ok(row.httpStatus === null || (Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599));
    assert.equal(row.httpClass, row.httpStatus === null ? null : `${Math.floor(row.httpStatus / 100)}xx`);
    assert.equal(typeof row.retryable, "boolean");
    assert.ok(row.errorCode === null || CODES.has(row.errorCode), `allowlisted errorCode: ${row.errorCode}`);
    assert.ok(row.cron === null || (i === 2 && ["fresh", "stale", "absent", "malformed"].includes(row.cron)));
    if (row.outcome === "pass" || row.outcome === "planned") {
      assert.equal(row.errorCode, null);
      assert.equal(row.nextAction, null);
      assert.equal(row.retryable, false);
    } else {
      assert.equal(typeof row.nextAction, "string");
      assert.ok(row.nextAction.length > 10 && row.nextAction.length <= 240, "bounded concrete remediation");
    }
  });
}

function requests(result, origin = ORIGIN, authed = true) {
  assert.deepEqual(result.events.filter((e) => e.effect === "fetch"), (authed ? PATHS : PATHS.slice(0, 1)).map((p, i) => ({
    effect: "fetch", origin, path: p, method: "GET", authed: i !== 0, redirect: "manual",
  })), "exact fixed GETs, authentication only where needed, no retries");
}

function refusal(args, env = {}, code = "invalid_arguments") {
  const result = run(args, { env, fixture: { noEffects: true } });
  noEffects(result);
  assert.equal(result.status, 1, result.output);
  const doc = json(result);
  assert.equal(doc.ok, false);
  assert.deepEqual(doc.checks, []);
  assert.equal(doc.errorCode, code);
  assert.equal(typeof doc.nextAction, "string");
  assert.ok(doc.nextAction.length > 10 && doc.nextAction.length <= 240);
}

test("JSON success collects exactly three fixed GET results after their bodies complete", () => {
  const result = run(["--json"], { fixture: { delayBody: true } });
  assert.equal(result.status, 0, result.output);
  const doc = json(result);
  assert.equal(doc.mode, "run");
  assert.equal(doc.ok, true);
  assert.equal(doc.errorCode, null);
  assert.equal(doc.nextAction, null);
  rows(doc);
  assert.deepEqual(doc.checks.map((row) => row.httpStatus), [200, 200, 200]);
  assert.equal(doc.checks[2].cron, "fresh");
  requests(result);
  assert.equal(result.events.filter((e) => e.effect === "body-complete").length, 3);
  const firstOutput = result.events.findIndex((e) => e.effect === "stdout");
  assert.equal(result.events.slice(firstOutput).filter((e) => e.effect === "body-complete").length, 0);
});

for (const [kind, errorCode, retryable] of [
  [401, "http_auth", false], [403, "http_auth", false], [404, "http_client", false],
  [429, "http_client", true], [503, "http_server", true], [302, "http_redirect", false],
  ["network", "network_error", true], ["invalid-json", "invalid_json", false],
  ["body-error", "network_error", true],
]) {
  for (const index of [0, 1, 2]) {
    test(`JSON ${IDS[index]} ${kind}: bounded classified failure, later checks run, no retry`, () => {
      const result = run(["--json"], { fixture: { failAt: PATHS[index], kind, large: true } });
      assert.equal(result.status, 1, result.output);
      const doc = json(result);
      assert.equal(doc.ok, false);
      rows(doc, IDS.map((_, i) => i === index ? "fail" : "pass"));
      const row = doc.checks[index];
      assert.equal(row.errorCode, errorCode);
      assert.equal(row.retryable, retryable);
      assert.equal(row.httpStatus, typeof kind === "number" ? kind : kind === "network" ? null : 200);
      requests(result);
    });
  }
}

for (const [index, kind, errorCode] of [[0, "invalid-health", "invalid_health"], [1, "invalid-health", "invalid_health"], [2, "invalid-readiness", "invalid_readiness"]]) {
  test(`JSON rejects a 200 response with degraded ${IDS[index]} payload`, () => {
    const result = run(["--json"], { fixture: { failAt: PATHS[index], kind } });
    assert.equal(result.status, 1, result.output);
    const doc = json(result);
    rows(doc, IDS.map((_, i) => i === index ? "fail" : "pass"));
    assert.equal(doc.checks[index].errorCode, errorCode);
    requests(result);
  });
}

for (const stage of ["fetch", "body"]) {
  for (const index of [0, 1, 2]) {
    test(`JSON ${IDS[index]} timeout covers ${stage}, aborts and still collects later checks`, () => {
      const result = run(["--json", "--timeout-ms=100"], { fixture: { failAt: PATHS[index], kind: `${stage}-timeout` } });
      assert.equal(result.status, 1, result.output);
      const doc = json(result);
      rows(doc, IDS.map((_, i) => i === index ? "fail" : "pass"));
      assert.equal(doc.checks[index].errorCode, "timeout");
      assert.equal(doc.checks[index].retryable, true);
      assert.deepEqual(result.events.filter((e) => e.effect === "abort"), [{ effect: "abort", stage, path: PATHS[index] }]);
      assert.ok(!result.events.some((e) => e.effect === "late-completion"));
      requests(result);
    });
  }
}

for (const skip of [false, true]) {
  test(`JSON missing-token policy remains ${skip ? "skip-safe" : "strict"}`, () => {
    const result = run(["--json", ...(skip ? ["--skip-if-no-token"] : []), "--token-env=PROBE_FIXTURE_TOKEN"], {
      env: { SHADOW_API_TOKEN: "", CUSTOMER_SNAPSHOT_SYNC_SECRET: "", PROBE_FIXTURE_TOKEN: "" },
    });
    assert.equal(result.status, skip ? 0 : 1, result.output);
    const doc = json(result);
    assert.equal(doc.ok, skip);
    rows(doc, ["pass", skip ? "skip" : "fail", skip ? "skip" : "fail"]);
    for (const row of doc.checks.slice(1)) {
      assert.equal(row.errorCode, "missing_token");
      assert.equal(row.httpStatus, null);
      assert.equal(row.retryable, false);
      assert.equal(row.cron, null);
      assert.match(row.nextAction, /token|SHADOW_API_TOKEN|token-env/i);
    }
    requests(result, ORIGIN, false);
  });
}

test("--token-env uses the named synthetic credential, never a default credential instead", () => {
  const result = run(["--json", "--token-env=PROBE_FIXTURE_TOKEN"], {
    env: { PROBE_FIXTURE_TOKEN: TOKEN, SHADOW_API_TOKEN: "wrong-default-synthetic-token" },
  });
  assert.equal(result.status, 0, result.output);
  rows(json(result));
  requests(result);
});

for (const [label, fixtureConfig, outcome, code, cron] of [
  ["fresh despite old timestamp", { cron: { stale: false, lastRunAt: "1900-01-01T00:00:00Z", detail: POISON } }, "pass", null, "fresh"],
  ["stale despite future timestamp", { cron: { stale: true, lastRunAt: "2999-01-01T00:00:00Z", detail: POISON } }, "fail", "cron_stale", "stale"],
  ["absent legacy cron", { absentCron: true }, "pass", null, "absent"],
  ["fresh with poisoned non-boolean metadata", { cron: { stale: false, lastRunAt: POISON, detail: POISON, tables: { customer: POISON } } }, "pass", null, "fresh"],
  ...[null, {}, [], "false", true, false, 0, { stale: "false" }, { stale: "true" }, { stale: 0 }, { stale: 1 }, { stale: null }, { detail: POISON }]
    .map((value) => [`malformed ${JSON.stringify(value)}`, { cron: value }, "fail", "malformed_readiness", "malformed"]),
]) {
  test(`JSON cron: ${label}`, () => {
    const result = run(["--json"], { fixture: fixtureConfig });
    assert.equal(result.status, outcome === "pass" ? 0 : 1, result.output);
    const doc = json(result);
    rows(doc, ["pass", "pass", outcome]);
    assert.equal(doc.checks[2].cron, cron);
    assert.equal(doc.checks[2].errorCode, code);
    assert.equal(doc.ok, outcome === "pass");
    requests(result);
  });
}

for (const args of [["--json", "--dry-run"], ["--dry-run", "--json"], ["--json", "--dry-run", "--skip-if-no-token"]]) {
  test(`plan ${args.join(" ")} never resolves even supplied credentials or claims health`, () => {
    const result = run([...args, "--token-env=PROBE_FIXTURE_TOKEN"], {
      env: { PROBE_FIXTURE_TOKEN: TOKEN }, fixture: { noEffects: true },
    });
    noEffects(result);
    assert.equal(result.status, 0, result.output);
    const doc = json(result);
    assert.equal(doc.mode, "dry-run");
    assert.equal(doc.target, ORIGIN);
    rows(doc, ["planned", "unresolved", "unresolved"]);
    for (const row of doc.checks) {
      assert.equal(row.errorCode, null);
      assert.equal(row.httpStatus, null);
      assert.equal(row.retryable, false);
      assert.equal(row.cron, null);
    }
  });
}

test("plan without credentials stays unresolved rather than applying execution skip/fail policy", () => {
  const result = run(["--dry-run", "--json", "--skip-if-no-token"], {
    env: { SHADOW_API_TOKEN: "", CUSTOMER_SNAPSHOT_SYNC_SECRET: "" }, fixture: { noEffects: true },
  });
  noEffects(result);
  assert.equal(result.status, 0, result.output);
  const doc = json(result);
  assert.equal(doc.ok, true, "ok means valid plan, not passed probes");
  rows(doc, ["planned", "unresolved", "unresolved"]);
});

test("invalid explicit manual target refuses before credentials with a parseable JSON result", () => {
  refusal(["--json", "not-a-url"], {}, "invalid_target");
});

test("plain --dry-run describes three GETs and unresolved credentials without PASS/SKIP", () => {
  const result = run(["--dry-run"], { fixture: { noEffects: true } });
  noEffects(result);
  assert.equal(result.status, 0, result.output);
  for (const p of PATHS) assert.ok(result.output.includes(p));
  assert.match(result.output, /unresolved/i);
  assert.doesNotMatch(result.output, /\b(?:PASS|SKIP)\b/);
});

test("help documents JSON, dry-run, fixed paths and output-only bounds without effects", () => {
  const result = run(["--help"], { fixture: { noEffects: true }, env: { GITHUB_EVENT_NAME: "schedule", SHADOW_API_BASE: "" } });
  noEffects(result);
  assert.equal(result.status, 0, result.output);
  for (const term of ["--json", "--dry-run", "--scheduled", "--token-env", "--skip-if-no-token", ...PATHS]) assert.ok(result.output.includes(term), `help missing ${term}`);
  assert.match(result.output, /schema|version/i);
  assert.match(result.output, /response.body|body.reader/i);
  assert.match(result.output, /bounded|bound/i);
});

for (const args of [
  ["--json", "--json"], ["--json", "--dry-run", "--dry-run"],
  ["--json=true"], ["--json", "--dry-run=true"], ["--json", "--method=POST"],
  ["--json", "--token-env="], ["--json", "--token-env=BAD-NAME"],
  ["--json", ORIGIN, "https://second-fixture.invalid"], ["--json", `--unknown=${POISON}`],
  [`--unknown=${POISON}`, "--json"], ["--dry-run", "--json", `--unknown=${POISON}`],
]) {
  test(`invalid/ambiguous arguments ${JSON.stringify(args)} refuse before side effects`, () => refusal(args));
}

for (const base of [
  "", " ", "not-a-url", "http://remote-fixture.invalid", "https://localhost",
  "https://localhost.", "https://worker.localhost", "https://127.0.0.1", "https://127.1",
  "https://2130706433", "https://0.0.0.0", "https://[::1]", "https://[::]", "https://[::ffff:127.0.0.1]",
  "https://fixture-user:fixture-password@probe-fixture.invalid",
  `${ORIGIN}/staging`, `${ORIGIN}?fixture-query-secret`, `${ORIGIN}#fixture-query-secret`, `${ORIGIN}?`, `${ORIGIN}#`,
]) {
  for (const dryRun of [false, true]) {
    test(`scheduled target refusal ${JSON.stringify(base)} is JSON and effect-free (${dryRun ? "event/plan" : "flag/run"})`, () => {
      refusal(dryRun ? ["--dry-run", "--json"] : ["--scheduled", "--json"], {
        SHADOW_API_BASE: base, ...(dryRun ? { GITHUB_EVENT_NAME: "schedule" } : {}),
      }, "invalid_target");
    });
  }
}

for (const [label, args, env, origin] of [
  ["manual localhost fallback", [], { SHADOW_API_BASE: "" }, "http://localhost:8787"],
  ["manual normalized URL", [], { SHADOW_API_BASE: `${ORIGIN}/staging?fixture-query-secret#fixture-query-secret` }, ORIGIN],
  ["explicit target precedence", ["https://explicit-fixture.invalid/path?fixture-query-secret"], {}, "https://explicit-fixture.invalid"],
  ["scheduled explicit root and port", ["--scheduled", "https://arbitrary-fixture.invalid:8443/"], {}, "https://arbitrary-fixture.invalid:8443"],
  ["schedule env enforcement", [], { GITHUB_EVENT_NAME: "schedule" }, ORIGIN],
]) {
  for (const dryRun of [false, true]) {
    test(`${dryRun ? "plan" : "JSON"} target resolution preserves ${label} without a new approval allowlist`, () => {
      const result = run(["--json", ...(dryRun ? ["--dry-run"] : []), ...args], { env, fixture: { origin, noEffects: dryRun } });
      assert.equal(result.status, 0, result.output);
      const doc = json(result);
      assert.equal(doc.target, origin);
      rows(doc, dryRun ? ["planned", "unresolved", "unresolved"] : ["pass", "pass", "pass"]);
      if (dryRun) noEffects(result);
      else requests(result, origin);
    });
  }
}

for (const [label, config, status, pattern] of [
  ["healthy", {}, 0, /post-deploy probe: all three probes passed/],
  ["stale", { cron: { stale: true } }, 1, /FAIL cron freshness/],
  ["malformed", { cron: {} }, 1, /malformed|invalid.*cron|cron.*invalid/i],
]) {
  test(`no-flag text preserves ${label} exit/diagnosis with only the malformed-cron correction`, () => {
    const result = run([], { fixture: { ...config, poison: false } });
    assert.equal(result.status, status, result.output);
    assert.match(result.output, pattern);
    requests(result);
  });
}

// Review regressions: status-before-body, redirect policy, origin cap and timers.
// Each case runs the CLI; no assertion depends on implementation source text.
for (const [httpStatus, errorCode, retryable, indices] of [
  [401, "http_auth", false, [0, 1, 2]],
  [403, "http_auth", false, [0, 1, 2]],
  [404, "http_client", false, [2]],
  [429, "http_client", true, [2]],
  [503, "http_server", true, [2]],
  [302, "http_redirect", false, [2]],
]) {
  for (const bodyStream of ["error", "stall"]) {
    for (const index of indices) {
      test(`HTTP-body precedence ${IDS[index]} ${httpStatus} native ${bodyStream} keeps ${errorCode}`, () => {
        // A readable error-body control supplies the fixed remediation. The
        // errored/stalled body must neither replace it nor be required to drain.
        const control = run(["--json"], { fixture: { failAt: PATHS[index], kind: httpStatus } });
        assert.equal(control.status, 1, control.output);
        const controlDoc = json(control);
        requests(control);
        assert.equal(controlDoc.checks[index].errorCode, errorCode);
        const result = run(["--json", "--timeout-ms=100"], {
          fixture: { failAt: PATHS[index], httpStatus, bodyStream },
        });
        const doc = json(result);
        requests(result);
        assert.equal(result.status, 1, result.output);
        assert.equal(doc.ok, false);
        rows(doc, IDS.map((_, i) => i === index ? "fail" : "pass"));
        const row = doc.checks[index];
        assert.equal(row.httpStatus, httpStatus);
        assert.equal(row.errorCode, errorCode);
        assert.equal(row.retryable, retryable);
        assert.equal(row.nextAction, controlDoc.checks[index].nextAction, "HTTP remediation cannot depend on error-body delivery");
        assert.equal(doc.nextAction, controlDoc.nextAction);
        if (errorCode === "http_auth") assert.match(row.nextAction, /token|SHADOW_API_TOKEN|token-env/i);
      });
    }
  }
}

for (const [bodyStream, errorCode] of [["error", "network_error"], ["stall", "timeout"]]) {
  for (const index of [0, 1, 2]) {
    test(`HTTP-body control ${IDS[index]} native 200 ${bodyStream} remains ${errorCode}`, () => {
      const result = run(["--json", "--timeout-ms=100"], {
        fixture: { failAt: PATHS[index], httpStatus: 200, bodyStream },
      });
      const doc = json(result);
      requests(result);
      assert.equal(result.status, 1, result.output);
      assert.equal(doc.ok, false);
      rows(doc, IDS.map((_, i) => i === index ? "fail" : "pass"));
      assert.equal(doc.checks[index].httpStatus, 200);
      assert.equal(doc.checks[index].errorCode, errorCode);
      assert.equal(doc.checks[index].retryable, true);
    });
  }
}

test("redirect invariant: all fixed GETs explicitly request manual redirects", () => {
  const result = run(["--json"], { fixture: { failAt: PATHS[1], kind: 302 } });
  assert.equal(result.status, 1, result.output);
  const doc = json(result);
  rows(doc, ["pass", "fail", "pass"]);
  assert.equal(doc.checks[1].errorCode, "http_redirect");
  requests(result); // The fetch seam rejects and records missing/follow/error.
});

for (const length of [1023, 1024, 1025, 16384]) {
  for (const scheduled of [false, true]) {
    test(`origin cap plan ${length} bytes ${scheduled ? "scheduled" : "manual"} is bounded and effect-free`, () => {
      // WHATWG URL accepts long synthetic hostnames; DNS is never consulted.
      const origin = `https://${"a".repeat(length - "https://".length - ".invalid".length)}.invalid`;
      assert.equal(origin.length, length);
      assert.equal(new URL(origin).origin, origin);
      const result = run(["--json", "--dry-run", ...(scheduled ? ["--scheduled"] : []), origin], {
        fixture: { noEffects: true },
      });
      noEffects(result);
      const doc = json(result);
      assert.equal(doc.mode, "dry-run");
      if (length <= 1024) {
        assert.equal(result.status, 0, result.output);
        assert.equal(doc.ok, true);
        assert.equal(doc.target, origin);
        assert.equal(doc.errorCode, null);
        rows(doc, ["planned", "unresolved", "unresolved"]);
      } else {
        assert.equal(result.status, 1, result.output);
        assert.equal(doc.ok, false);
        assert.equal(doc.target, null);
        assert.equal(doc.errorCode, "invalid_target");
        assert.deepEqual(doc.checks, []);
      }
    });
  }
}

for (const value of ["0.5", "0", "-1", "NaN", "Infinity", "-Infinity", "2147483648"]) {
  for (const dryRun of [false, true]) {
    test(`timeout boundary refusal ${value} ${dryRun ? "plan" : "run"} is JSON before any effects`, () => {
      refusal(["--json", ...(dryRun ? ["--dry-run"] : []), `--timeout-ms=${value}`]);
    });
  }
}

for (const value of ["1", "1.75", "1234.75", "2147483647"]) {
  test(`timeout boundary accepted ${value} in an effect-free plan without arming timers`, () => {
    const result = run(["--json", "--dry-run", `--timeout-ms=${value}`], { fixture: { noEffects: true } });
    noEffects(result);
    assert.equal(result.status, 0, result.output);
    const doc = json(result);
    assert.equal(doc.ok, true);
    assert.equal(doc.mode, "dry-run");
    assert.equal(doc.errorCode, null);
    rows(doc, ["planned", "unresolved", "unresolved"]);
  });
}

test("timeout fractional value keeps floor semantics for actual request timers", () => {
  const result = run(["--json", "--timeout-ms=1234.75"]);
  assert.equal(result.status, 0, result.output);
  rows(json(result));
  requests(result);
  assert.deepEqual(result.events.filter((e) => e.effect === "timer"), [
    { effect: "timer", delay: 1234 },
    { effect: "timer", delay: 1234 },
    { effect: "timer", delay: 1234 },
  ]);
});
