// Synthetic, independently owned acceptance contract: no recording, replay or network.
// Public v1 decisions: schemaVersion=1; findings carry code/line/field/next_action;
// at most 100 findings and 64 KiB per CLI response. Codes below are fixed vocabulary.
// These tests observe public results/side effects, never implementation source text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  aggregateHarvestLines,
  buildHarvestDoc,
  createHarvestAggregator,
} from './lib/aggregateMerge.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const MARKER = 'SYNTHETIC_PRIVATE_VALUE_MUST_NOT_APPEAR';
const NOW = new Date('2026-01-02T03:04:05.000Z');
const record = (overrides = {}) => ({
  ts: '2026-01-02T03:04:05.000Z',
  method: 'GET',
  pathname: '/synthetic/items',
  ...overrides,
});
const line = (value) => JSON.stringify(value);
const VALID = line(record());
const COMMANDS = ['validate-harvest.mjs', 'aggregate.mjs'];

const INVALID = [
  ['malformed JSON', `{\"${MARKER}\":`, 'HARVEST_INVALID_JSON', '$'],
  ['null record', 'null', 'HARVEST_RECORD_TYPE', '$'],
  ['array record', line([MARKER]), 'HARVEST_RECORD_TYPE', '$'],
  ['string record', line(MARKER), 'HARVEST_RECORD_TYPE', '$'],
  ['number record', '42', 'HARVEST_RECORD_TYPE', '$'],
  ['boolean record', 'false', 'HARVEST_RECORD_TYPE', '$'],
  ['missing timestamp', line(record({ ts: undefined })), 'HARVEST_TIMESTAMP_INVALID', 'ts'],
  ['numeric timestamp', line(record({ ts: 42 })), 'HARVEST_TIMESTAMP_INVALID', 'ts'],
  ['invalid timestamp', line(record({ ts: MARKER })), 'HARVEST_TIMESTAMP_INVALID', 'ts'],
  ['missing method', line(record({ method: undefined })), 'HARVEST_METHOD_INVALID', 'method'],
  ['numeric method', line(record({ method: 42 })), 'HARVEST_METHOD_INVALID', 'method'],
  ['empty method', line(record({ method: '' })), 'HARVEST_METHOD_INVALID', 'method'],
  ['invalid method token', line(record({ method: `GET ${MARKER}` })), 'HARVEST_METHOD_INVALID', 'method'],
  ['missing pathname', line(record({ pathname: undefined })), 'HARVEST_PATH_INVALID', 'pathname'],
  ['numeric pathname', line(record({ pathname: 42 })), 'HARVEST_PATH_INVALID', 'pathname'],
  ['empty pathname', line(record({ pathname: '' })), 'HARVEST_PATH_INVALID', 'pathname'],
  ['relative pathname', line(record({ pathname: MARKER })), 'HARVEST_PATH_INVALID', 'pathname'],
  ['URL instead of pathname', line(record({ pathname: 'https://synthetic.invalid/items' })), 'HARVEST_PATH_INVALID', 'pathname'],
  ['control character in pathname', line(record({ pathname: `/synthetic/\n${MARKER}` })), 'HARVEST_PATH_INVALID', 'pathname'],
  ...[
    ['requestBodyPreview', { value: MARKER }],
    ['responseBodyPreview', { value: MARKER }],
    ['requestBodyTruncated', 'true'],
    ['responseBodyTruncated', 1],
    ['query', [MARKER]],
    ['query', MARKER],
    ['query', { page: { value: MARKER } }],
    ['query', { page: [MARKER, 42] }],
    ['queryString', { value: MARKER }],
    ['requestHeaders', [MARKER]],
    ['responseHeaders', MARKER],
    ['requestHeaders', { 'x-synthetic': { value: MARKER } }],
    ['responseHeaders', { 'x-synthetic': [MARKER] }],
    ['responseStatus', '200'],
    ['responseStatus', 200.5],
    ['responseStatus', 99],
    ['responseStatus', 600],
    ['requestContentType', { value: MARKER }],
    ['responseContentType', [MARKER]],
    ['resourceType', { value: MARKER }],
    ['pathWithQuery', { value: MARKER }],
    ['frameUrl', { value: MARKER }],
  ].map(([field, value]) => [
    `invalid ${field} (${Array.isArray(value) ? 'array' : typeof value})`,
    line(record({ [field]: value })), 'HARVEST_FIELD_INVALID', field,
  ]),
];

function sandbox(t, content = undefined, priorOutput = false) {
  const dir = fs.mkdtempSync(path.join(
    process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || os.tmpdir(),
    'harvest-contract-',
  ));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Copy executable tools/dependencies only; never copy an existing harvest/out/.
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

// Fault injection is below the real CLI. Keep the actual parsing, validation,
// aggregation and publication logic. Hooks affect only this copied tree's out/.
function preload(dir, { errno, streamOnly = false, forbidWork = false, forbidMutations = false } = {}) {
  const hook = path.join(dir, 'acceptance-hook.mjs');
  fs.writeFileSync(hook, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
const root = ${JSON.stringify(path.join(dir, 'out'))};
const audit = ${JSON.stringify(path.join(dir, 'acceptance-audit.log'))};
const append = fs.appendFileSync.bind(fs);
const target = (p) => {
  if (p instanceof URL) p = fileURLToPath(p);
  return typeof p === 'string' && (p === root || p.startsWith(root + '/'));
};
const error = () => Object.assign(new Error(${JSON.stringify(MARKER)}), { code: ${JSON.stringify(errno || 'EACCES')} });
const reads = ['stat', 'lstat', 'open', 'readFile'];
const writes = ['mkdir', 'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'rename'];
for (const base of [...reads, ...writes]) {
  for (const name of [base, base + 'Sync']) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    fs[name] = function(p, ...args) {
      const mutates = writes.includes(base);
      const refused = target(p) && ((${forbidWork} || (${forbidMutations} && mutates)) ||
        (${Boolean(errno)} && !${streamOnly} && !mutates && String(p).endsWith('harvest.ndjson')));
      if (!refused) return original.call(this, p, ...args);
      append(audit, name + '\\n');
      const e = error();
      const callback = args.at(-1);
      if (!name.endsWith('Sync') && typeof callback === 'function') { queueMicrotask(() => callback(e)); return; }
      throw e;
    };
  }
  const original = fs.promises[base];
  if (typeof original === 'function') fs.promises[base] = async function(p, ...args) {
    const mutates = writes.includes(base);
    if (target(p) && ((${forbidWork} || (${forbidMutations} && mutates)) ||
        (${Boolean(errno)} && !${streamOnly} && !mutates && String(p).endsWith('harvest.ndjson')))) {
      append(audit, base + ':promise\\n'); throw error();
    }
    return original.call(this, p, ...args);
  };
}
for (const name of ['createReadStream', 'createWriteStream']) {
  const original = fs[name];
  fs[name] = function(p, ...args) {
    const mutates = name === 'createWriteStream';
    if (!target(p) || !((${forbidWork} || (${forbidMutations} && mutates)) ||
      (${Boolean(errno)} && !mutates && String(p).endsWith('harvest.ndjson')))) return original.call(this, p, ...args);
    append(audit, name + '\\n');
    if (mutates) throw error();
    return new Readable({ read() { this.destroy(error()); } });
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

function findingsOf(error) {
  assert.ok(error, 'corrupt input must be refused, not silently aggregated');
  assert.ok(Array.isArray(error.findings), 'direct refusal must expose structured findings');
  assert.doesNotMatch(String(error.message), /TypeError|SyntaxError|Cannot read properties/);
  assert.ok(!`${error.message}${JSON.stringify(error.findings)}`.includes(MARKER));
  return error.findings;
}

function assertFinding(findings, code, field, lineNumber = 3) {
  const finding = findings.find((item) => item.code === code && item.field === field && item.line === lineNumber);
  assert.ok(finding, `expected ${code} at line ${lineNumber}, field ${field}`);
  assert.equal(typeof finding.next_action, 'string');
  assert.ok(finding.next_action.trim(), 'refusal must provide a correction next action');
}

function captureFailure(action) {
  try { action(); } catch (error) { return findingsOf(error); }
  assert.fail('corrupt input must be refused, not silently aggregated');
}

const direct = {
  iterable: (lines) => aggregateHarvestLines(lines),
  document: (lines) => buildHarvestDoc(lines.join('\n'), NOW),
  accumulator: (lines) => {
    const aggregator = createHarvestAggregator();
    for (const item of lines) aggregator.addLine(item);
    return aggregator.finish();
  },
};

for (const [name, corrupt, code, field] of INVALID) {
  for (const [boundary, aggregate] of Object.entries(direct)) {
    test(`${boundary} aggregation refuses ${name} with a line/field finding`, () => {
      const lines = [VALID, '', corrupt, VALID];
      const findings = captureFailure(() => aggregate(lines));
      assertFinding(findings, code, field);
      assert.deepEqual(findings, captureFailure(() => direct.iterable(lines)));
    });
  }

  for (const command of COMMANDS) {
    test(`${command} refuses ${name} without publishing partial output`, (t) => {
      const dir = sandbox(t, `${VALID}\n\n${corrupt}\n${VALID}\n`, true);
      const before = snapshot(path.join(dir, 'out'));
      const result = run(dir, command, ['--json']);
      assert.equal(result.status, 1, `${command} must reject corrupt input`);
      assert.deepEqual(snapshot(path.join(dir, 'out')), before, 'invalid input must leave every existing output byte intact');
      const body = machine(result, false);
      assertFinding(body.findings, code, field);
      assert.deepEqual(body.findings, captureFailure(() => aggregateHarvestLines([VALID, '', corrupt, VALID])));
    });
  }
}

test('valid partial harvests preserve blank-line counting, normalized identity, sample caps and deterministic content', () => {
  const lines = ['', ' \t', ...['1', '2', '3', '4'].map((page) => line(record({
    pathname: `/synthetic/items/${page}`, query: { page }, requestHeaders: { 'x-synthetic': 'not-retained' },
    responseHeaders: { 'content-type': 'application/json' }, responseStatus: 200,
    requestBodyPreview: '{"synthetic":true}', responseBodyPreview: 'x'.repeat(12_100),
    requestBodyTruncated: false, responseBodyTruncated: true,
  }))), ''];
  const sync = aggregateHarvestLines(lines);
  assert.deepEqual(sync, direct.accumulator(lines));
  assert.equal(sync.lineCount, 4);
  assert.equal(sync.operations.length, 1, 'a partial valid capture does not require unrelated endpoints');
  const operation = sync.operations[0];
  assert.equal(operation.key, 'GET /synthetic/items/{id}');
  assert.equal(operation.count, 4);
  assert.equal(operation.samples.length, 3);
  assert.deepEqual(operation.samples.map((sample) => sample.query), [{ page: '1' }, { page: '2' }, { page: '3' }]);
  assert.deepEqual(operation.samples[0].requestHeaderNames, ['x-synthetic']);
  assert.ok(!JSON.stringify(sync).includes('not-retained'), 'validation must not expand the recorded data surface');
  assert.ok(operation.samples[0].responseBodyPreview.length < 12_100, 'aggregate preview cap is preserved');
  const first = buildHarvestDoc(lines.join('\r\n'), NOW);
  const second = buildHarvestDoc(lines.join('\n'), NOW);
  assert.deepEqual(first, second);
  assert.equal(first.generatedAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(first.operations, sync.operations);
});

test('optional query arrays and nullable unavailable response metadata remain usable', () => {
  const result = aggregateHarvestLines([line(record({
    query: { tag: ['a', 'b'], empty: '' }, responseStatus: null,
    requestContentType: null, responseContentType: null, frameUrl: null,
  }))]);
  assert.deepEqual(result.operations[0].samples[0].query, { tag: ['a', 'b'], empty: '' });
  assert.equal(result.operations[0].samples[0].responseStatus, null);
});

test('missing, zero-byte and nonempty blank-only input retain distinct aggregate documents', () => {
  const missing = buildHarvestDoc(null, NOW);
  const empty = buildHarvestDoc('', NOW);
  const blank = buildHarvestDoc(' \r\n\t\n', NOW);
  assert.match(missing.note, /No harvest file yet/);
  assert.equal(empty.note, 'harvest.ndjson is empty.');
  assert.equal(blank.note, undefined);
  for (const doc of [missing, empty, blank]) {
    assert.equal(doc.lineCount, 0);
    assert.deepEqual(doc.operations, []);
  }
});

for (const [name, content] of [['missing', undefined], ['zero-byte', ''], ['blank-only', '\n \t\n'], ['valid', `${VALID}\n`]]) {
  test(`both CLIs expose successful schema-versioned JSON for ${name} harvests`, (t) => {
    const dir = sandbox(t, content);
    for (const command of COMMANDS) {
      const result = run(dir, command, ['--json']);
      assert.equal(result.status, 0);
      assert.deepEqual(machine(result, true).findings, []);
    }
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'out/discovered-operations.json'), 'utf8'));
    assert.equal(doc.lineCount, name === 'valid' ? 1 : 0);
    if (name === 'missing') assert.match(doc.note, /No harvest file yet/);
    if (name === 'zero-byte') assert.equal(doc.note, 'harvest.ndjson is empty.');
    if (name === 'blank-only') assert.equal(doc.note, undefined);
  });
}

for (const command of COMMANDS) {
  test(`${command} --help is discoverable and performs no harvest I/O`, (t) => {
    const dir = sandbox(t, VALID);
    const hook = preload(dir, { forbidWork: true });
    const result = run(dir, command, ['--help'], hook);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--json/);
    assert.match(result.stdout, /--help/);
    if (command === 'aggregate.mjs') assert.match(result.stdout, /--dry-run/);
    assert.ok(!fs.existsSync(path.join(dir, 'acceptance-audit.log')), 'help must run before input/output work');
  });

  test(`${command} rejects unknown flags before harvest I/O`, (t) => {
    const dir = sandbox(t, VALID);
    const hook = preload(dir, { forbidWork: true });
    const result = run(dir, command, ['--json', '--not-a-harvest-option'], hook);
    assert.equal(result.status, 1);
    assert.equal(machine(result, false).code, 'HARVEST_UNKNOWN_FLAG');
    assert.ok(!fs.existsSync(path.join(dir, 'acceptance-audit.log')), 'flag validation must precede all file I/O');
  });

  test(`${command} bounds corrupt-input findings without leaking marker values`, (t) => {
    const dir = sandbox(t, Array.from({ length: 1500 }, () => line({ method: MARKER })).join('\n'));
    const result = run(dir, command, ['--json']);
    assert.equal(result.status, 1);
    const body = machine(result, false);
    assert.ok(body.findings.length > 0);
  });

  for (const errno of ['EACCES', 'EIO', 'ENOTDIR']) {
    test(`${command} classifies ${errno} as read failure rather than missing harvest`, (t) => {
      const dir = sandbox(t, VALID, true);
      const before = snapshot(path.join(dir, 'out'));
      const hook = preload(dir, { errno });
      const result = run(dir, command, ['--json'], hook);
      assert.equal(result.status, 1);
      assert.equal(machine(result, false).code, 'HARVEST_READ_FAILED');
      assert.ok(fs.existsSync(path.join(dir, 'acceptance-audit.log')), 'the injected I/O fault must actually be reached');
      assert.deepEqual(snapshot(path.join(dir, 'out')), before);
    });
  }
}

test('aggregate catches asynchronous read-stream errors and preserves prior output', (t) => {
  const dir = sandbox(t, `${VALID}\n`, true);
  const before = snapshot(path.join(dir, 'out'));
  const hook = preload(dir, { errno: 'EIO', streamOnly: true });
  const result = run(dir, 'aggregate.mjs', ['--json'], hook);
  assert.equal(result.status, 1);
  assert.equal(machine(result, false).code, 'HARVEST_READ_FAILED');
  assert.match(fs.readFileSync(path.join(dir, 'acceptance-audit.log'), 'utf8'), /createReadStream/);
  assert.deepEqual(snapshot(path.join(dir, 'out')), before);
});

for (const [name, content] of [['missing', undefined], ['valid', `${VALID}\n`]]) {
  test(`aggregate --dry-run validates ${name} input without mkdir/write/remove`, (t) => {
    const dir = sandbox(t, content);
    const before = snapshot(path.join(dir, 'out'));
    const hook = preload(dir, { forbidMutations: true });
    const result = run(dir, 'aggregate.mjs', ['--json', '--dry-run'], hook);
    assert.equal(result.status, 0);
    const body = machine(result, true);
    assert.equal(body.dryRun, true);
    assert.ok(JSON.stringify(body).includes('discovered-operations.json'), 'dry run must describe its intended output');
    assert.ok(!fs.existsSync(path.join(dir, 'acceptance-audit.log')), 'dry run must not even attempt an output mutation');
    assert.deepEqual(snapshot(path.join(dir, 'out')), before);
  });
}

test('dry-run still rejects mixed invalid input without creating output', (t) => {
  const dir = sandbox(t, `${VALID}\nnull\n`);
  const before = snapshot(path.join(dir, 'out'));
  const hook = preload(dir, { forbidMutations: true });
  const result = run(dir, 'aggregate.mjs', ['--json', '--dry-run'], hook);
  assert.equal(result.status, 1);
  assertFinding(machine(result, false).findings, 'HARVEST_RECORD_TYPE', '$', 2);
  assert.ok(!fs.existsSync(path.join(dir, 'acceptance-audit.log')));
  assert.deepEqual(snapshot(path.join(dir, 'out')), before);
});

test('validator remains read-only on a valid capture with existing aggregate files', (t) => {
  const dir = sandbox(t, `${VALID}\n`, true);
  const before = snapshot(path.join(dir, 'out'));
  const result = run(dir, 'validate-harvest.mjs', [], preload(dir, { forbidMutations: true }));
  assert.equal(result.status, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'acceptance-audit.log')));
  assert.deepEqual(snapshot(path.join(dir, 'out')), before);
});

test('plain aggregate refuses corrupt mixed input before replacing any prior file', (t) => {
  const dir = sandbox(t, `${VALID}\n{bad-json\n${VALID}\n`, true);
  const before = snapshot(path.join(dir, 'out'));
  const result = run(dir, 'aggregate.mjs');
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /HARVEST_INVALID_JSON/);
  assert.deepEqual(snapshot(path.join(dir, 'out')), before);
});

test('successful streamed CLI and direct aggregation publish identical stable operations', (t) => {
  const content = `${VALID}\n${line(record({ method: 'POST', pathname: '/synthetic/items/42' }))}\n`;
  const dir = sandbox(t, content);
  const result = run(dir, 'aggregate.mjs');
  assert.equal(result.status, 0);
  const streamed = JSON.parse(fs.readFileSync(path.join(dir, 'out/discovered-operations.json'), 'utf8'));
  const expected = buildHarvestDoc(content, NOW);
  delete streamed.generatedAt;
  delete expected.generatedAt;
  assert.deepEqual(streamed, JSON.parse(JSON.stringify(expected)));
});
