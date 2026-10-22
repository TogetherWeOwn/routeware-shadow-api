// Builder-owned supplementary pins for PR review findings on the harvest record
// contract. The Test Author acceptance blobs are frozen and untouched; these tests
// observe only public CLI results/side effects using synthetic fixtures, no
// recording, replay, network or production data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { aggregateHarvestLines } from './lib/aggregateMerge.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const MARKER = 'SYNTHETIC_PRIVATE_VALUE_MUST_NOT_APPEAR';
const record = (overrides = {}) => ({
  ts: '2026-01-02T03:04:05.000Z',
  method: 'GET',
  pathname: '/synthetic/items',
  ...overrides,
});
const line = (value) => JSON.stringify(value);
const VALID = line(record());
const COMMANDS = ['validate-harvest.mjs', 'aggregate.mjs'];

function sandbox(t, content = undefined, priorOutput = false) {
  const dir = fs.mkdtempSync(path.join(
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir(),
    'harvest-review-pins-',
  ));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(toolsDir, dir, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(toolsDir, entry);
      if (!relative) return true;
      if (relative.split(path.sep).some((part) => ['out', 'node_modules', '.git'].includes(part))) return false;
      return fs.statSync(entry).isDirectory() || entry.endsWith('.mjs');
    },
  });
  if (content !== undefined || priorOutput) fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'out/harvest.ndjson'), content);
  if (priorOutput) {
    fs.writeFileSync(path.join(dir, 'out/discovered-operations.json'), '{"prior":"aggregate must survive"}\n');
    fs.writeFileSync(path.join(dir, 'out/HARVEST_API.md'), 'prior generated documentation\n');
  }
  return dir;
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
    const entry = path.join(dir, name);
    return [name, fs.statSync(entry).isDirectory() ? snapshot(entry) : fs.readFileSync(entry).toString('base64')];
  }));
}

function preload(dir, { forbidMutations = false } = {}) {
  const hook = path.join(dir, 'review-pins-hook.mjs');
  fs.writeFileSync(hook, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = ${JSON.stringify(path.join(dir, 'out'))};
const audit = ${JSON.stringify(path.join(dir, 'review-pins-audit.log'))};
const append = fs.appendFileSync.bind(fs);
const target = (p) => {
  if (p instanceof URL) p = fileURLToPath(p);
  return typeof p === 'string' && (p === root || p.startsWith(root + '/'));
};
const error = () => Object.assign(new Error(${JSON.stringify(MARKER)}), { code: 'EACCES' });
const writes = ['mkdir', 'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'rename'];
for (const base of writes) {
  for (const name of [base, base + 'Sync']) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function(p, ...args) {
      if (!(${forbidMutations} && target(p))) return original.call(this, p, ...args);
      append(audit, name + '\\n');
      const e = error();
      const callback = args.at(-1);
      if (!name.endsWith('Sync') && typeof callback === 'function') { queueMicrotask(() => callback(e)); return; }
      throw e;
    };
  }
  const original = fs.promises[base];
  if (typeof original === 'function') fs.promises[base] = async function(p, ...args) {
    if (${forbidMutations} && target(p)) { append(audit, base + ':promise\\n'); throw error(); }
    return original.call(this, p, ...args);
  };
}
syncBuiltinESMExports();
`);
  return hook;
}

function run(dir, command, flags = [], hook = undefined) {
  const result = spawnSync(process.execPath, [
    ...(hook ? ['--import', hook] : []), path.join(dir, command), ...flags,
  ], {
    cwd: dir,
    env: { PATH: process.env.PATH, NO_COLOR: '1' },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'CLI must terminate normally within its observation bound');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(MARKER), 'CLI diagnostics must not expose record/error values');
  assert.doesNotMatch(result.stderr, /\n\s+at |TypeError:|SyntaxError:|UnhandledPromiseRejection/);
  return result;
}

function machine(result, ok) {
  assert.ok(Buffer.byteLength(`${result.stdout}${result.stderr}`) <= 64 * 1024, 'machine result must stay bounded');
  let body;
  try { body = JSON.parse(result.stdout); } catch { assert.fail('--json must emit one JSON document, without human log prefixes'); }
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.ok, ok);
  assert.match(body.code, /^[A-Z][A-Z0-9_]+$/);
  assert.equal(typeof body.next_action, 'string');
  assert.ok(body.next_action.trim());
  assert.ok(Array.isArray(body.findings));
  assert.ok(body.findings.length <= 100);
  return body;
}

function assertFinding(findings, code, field, lineNumber = 3) {
  const finding = findings.find((item) => item.code === code && item.field === field && item.line === lineNumber);
  assert.ok(finding, `expected ${code} at line ${lineNumber}, field ${field}`);
  assert.equal(typeof finding.next_action, 'string');
  assert.ok(finding.next_action.trim(), 'refusal must provide a correction next action');
}

function captureFailure(action) {
  try { action(); } catch (error) {
    assert.ok(error, 'corrupt input must be refused, not silently aggregated');
    assert.ok(Array.isArray(error.findings), 'direct refusal must expose structured findings');
    assert.doesNotMatch(String(error.message), /TypeError|SyntaxError|Cannot read properties/);
    assert.ok(!`${error.message}${JSON.stringify(error.findings)}`.includes(MARKER));
    return error.findings;
  }
  assert.fail('corrupt input must be refused, not silently aggregated');
}

for (const command of COMMANDS) {
  test(`${command} reports corrupt records as HARVEST_INVALID_RECORDS with count metadata`, (t) => {
    const dir = sandbox(t, `${VALID}\n\nnull\n${VALID}\n`, true);
    const result = run(dir, command, ['--json']);
    assert.equal(result.status, 1, `${command} must reject corrupt input`);
    const body = machine(result, false);
    assert.equal(body.code, 'HARVEST_INVALID_RECORDS');
    assert.equal(body.findingCount, 1);
    assert.equal(body.findingsTruncated, false);
    assertFinding(body.findings, 'HARVEST_RECORD_TYPE', '$');
  });

  test(`${command} caps corrupt-input findings at 100 while counting every finding`, (t) => {
    const total = 1500;
    const dir = sandbox(t, Array.from({ length: total }, () => 'null').join('\n'));
    const result = run(dir, command, ['--json']);
    assert.equal(result.status, 1);
    const body = machine(result, false);
    assert.equal(body.code, 'HARVEST_INVALID_RECORDS');
    assert.equal(body.findingCount, total);
    assert.equal(body.findingsTruncated, true);
    assert.equal(body.findings.length, 100);
  });
}

test('plain aggregate classifies output-device failure as HARVEST_WRITE_FAILED', (t) => {
  const dir = sandbox(t, `${VALID}\n`, true);
  const before = snapshot(path.join(dir, 'out'));
  const hook = preload(dir, { forbidMutations: true });
  const result = run(dir, 'aggregate.mjs', ['--json'], hook);
  assert.equal(result.status, 1);
  assert.equal(machine(result, false).code, 'HARVEST_WRITE_FAILED');
  assert.match(
    fs.readFileSync(path.join(dir, 'review-pins-audit.log'), 'utf8'),
    /mkdir|writeFile/,
    'the injected output fault must actually be reached',
  );
  assert.deepEqual(snapshot(path.join(dir, 'out')), before, 'write failure must leave prior output bytes intact');
});

for (const [name, corrupt, code, field] of [
  ['impossible calendar date', line(record({ ts: '2026-02-30T00:00:00.000Z' })), 'HARVEST_TIMESTAMP_INVALID', 'ts'],
  ['normalized end-of-day time', line(record({ ts: '2026-01-02T24:00:00.000Z' })), 'HARVEST_TIMESTAMP_INVALID', 'ts'],
  ['lowercase method', line(record({ method: 'get' })), 'HARVEST_METHOD_INVALID', 'method'],
  ['mixed-case method', line(record({ method: 'Get' })), 'HARVEST_METHOD_INVALID', 'method'],
]) {
  test(`direct aggregation refuses ${name} with a line/field finding`, () => {
    const lines = [VALID, '', corrupt, VALID];
    assertFinding(captureFailure(() => aggregateHarvestLines(lines)), code, field);
  });

  for (const command of COMMANDS) {
    test(`${command} refuses ${name} without publishing partial output`, (t) => {
      const dir = sandbox(t, `${VALID}\n\n${corrupt}\n${VALID}\n`, true);
      const before = snapshot(path.join(dir, 'out'));
      const result = run(dir, command, ['--json']);
      assert.equal(result.status, 1, `${command} must reject ${name}`);
      assert.deepEqual(snapshot(path.join(dir, 'out')), before, 'invalid input must leave every existing output byte intact');
      const body = machine(result, false);
      assert.equal(body.code, 'HARVEST_INVALID_RECORDS');
      assertFinding(body.findings, code, field);
    });
  }
}
