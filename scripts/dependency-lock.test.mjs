import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const json = (path) => JSON.parse(read(path));
const baseline = json('scripts/dependency-repair-baseline.json');
const lock = json('package-lock.json');
const manifest = json('package.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const oldBytes = execFileSync('git', ['show', `${baseline.baseline}:package-lock.json`], { cwd: root });
assert.equal(sha256(oldBytes), baseline.baselineLockSha256);
const oldLock = JSON.parse(oldBytes);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

// Compare complete records with the immutable base, not a generated-head baseline.
test('all unselected dependency metadata and both discovery files remain unchanged', () => {
  assert.deepEqual(baseline.mutablePaths, ['node_modules/miniflare/node_modules/ws']);
  assert.deepEqual(Object.keys(lock.packages).sort(), Object.keys(oldLock.packages).sort());
  const { packages: ignoredCurrent, ...metadata } = lock;
  const { packages: ignoredOld, ...oldMetadata } = oldLock;
  assert.deepEqual(metadata, oldMetadata);
  for (const [path, entry] of Object.entries(oldLock.packages)) {
    if (!baseline.mutablePaths.includes(path)) assert.deepEqual(lock.packages[path], entry, path);
  }
  const held = Object.fromEntries(Object.entries(lock.packages)
    .filter(([path]) => path && !baseline.mutablePaths.includes(path)));
  assert.equal(Object.keys(held).length, baseline.heldPackageCount);
  assert.equal(sha256(JSON.stringify(canonical(held))), baseline.heldGraphSha256);
  assert.equal(sha256(read('tools/api-discovery/package.json')), baseline.discoveryManifestSha256);
  assert.equal(sha256(read('tools/api-discovery/package-lock.json')), baseline.discoveryLockSha256);
  assert.deepEqual(manifest.dependencies, baseline.expectedManifestDependencies.dependencies);
  assert.deepEqual(manifest.devDependencies, baseline.expectedManifestDependencies.devDependencies);
  assert.deepEqual(manifest.dependencies, lock.packages[''].dependencies);
  assert.deepEqual(manifest.devDependencies, lock.packages[''].devDependencies);
});

test('only the exact Miniflare ws edge is overridden; locked parents stay at baseline', () => {
  assert.deepEqual(manifest.overrides, { 'miniflare@4.20260421.0': { ws: '8.22.0' } });
  assert.equal(lock.packages['node_modules/miniflare'].version, '4.20260421.0');
  assert.equal(lock.packages['node_modules/wrangler'].version, '4.84.1');
  assert.equal(lock.packages['node_modules/@cloudflare/vitest-pool-workers'].version, '0.14.9');
});

test('excluded Undici and all esbuild platform records are baseline restoration, not remediation', () => {
  const paths = ['node_modules/undici', 'node_modules/esbuild',
    ...Object.keys(oldLock.packages).filter((path) => path.startsWith('node_modules/@esbuild/'))];
  assert.equal(paths.length, 28);
  for (const path of paths) assert.deepEqual(lock.packages[path], oldLock.packages[path], path);
  assert.equal(lock.packages['node_modules/undici'].version, '7.24.8');
  assert.equal(lock.packages['node_modules/esbuild'].version, '0.27.3');
});

function assertWs(candidate) {
  assert.equal(candidate.packages['node_modules/ws'].version, '8.22.0', 'root ws');
  assert.equal(candidate.packages['node_modules/miniflare/node_modules/ws'].version, '8.22.0', 'nested ws');
  assert.deepEqual(candidate.packages['node_modules/miniflare/node_modules/ws'], baseline.wsRecord);
  assert.deepEqual(candidate.packages['node_modules/ws'], oldLock.packages['node_modules/ws']);
  assert.equal(baseline.wsRecord.dependencies, undefined);
}

test('both ws copies match reviewed artifacts without adding optional native peers', () => {
  assertWs(lock);
});

test('the same structural assertion rejects OLD nested ws despite patched root ws', () => {
  assert.equal(oldLock.packages['node_modules/ws'].version, '8.22.0');
  assert.equal(oldLock.packages['node_modules/miniflare/node_modules/ws'].version, '8.18.0');
  assert.throws(() => assertWs(oldLock), { code: 'ERR_ASSERTION', message: /nested ws/ });
  console.log(JSON.stringify({ structuralRegression: 'nested ws 8.18.0 rejected', base: baseline.baseline }));
});

test('installed resolution is verified FROM each retained consumer, including sync-fetch', () => {
  const require = createRequire(import.meta.url);
  const installed = json('node_modules/.package-lock.json');
  const consumers = {
    miniflare: { ws: '8.22.0', undici: '7.24.8' },
    wrangler: { esbuild: '0.27.3' },
    '@cloudflare/vitest-pool-workers': { esbuild: '0.27.3' },
  };
  for (const [parent, children] of Object.entries(consumers)) {
    const parentRequire = createRequire(import.meta.resolve(parent));
    for (const [name, version] of Object.entries(children)) {
      assert.equal(parentRequire(`${name}/package.json`).version, version, `${parent} -> ${name}`);
      const path = parent === 'miniflare' && name === 'ws'
        ? 'node_modules/miniflare/node_modules/ws' : `node_modules/${name}`;
      assert.equal(realpathSync(parentRequire.resolve(`${name}/package.json`)),
        realpathSync(new URL(`${path}/package.json`, root)), `${parent} -> ${name}: installed path`);
      for (const field of ['version', 'integrity', 'resolved']) {
        assert.equal(installed.packages[path]?.[field], lock.packages[path][field], `${path}: ${field}`);
      }
    }
  }
  assert.equal(require('ws/package.json').version, '8.22.0');
  // Miniflare's eval worker resolves Undici with createRequire(__filename),
  // not from the process cwd. This is baseline compatibility, not advisory proof.
  const syncRequire = createRequire(require.resolve('miniflare'));
  assert.equal(syncRequire('undici/package.json').version, '7.24.8');
  console.log(JSON.stringify({ node: process.version, consumers, syncFetchUndici: '7.24.8' }));
});

test('the actual installer supports release age and refuses lifecycle scripts in both roots', () => {
  // npm.cmd cannot be spawned directly on Windows without a shell; run npm's
  // CLI through Node instead, using the path set by `npm run` in Actions.
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'run this qualification through npm run test:dependency-repair');
  console.log(execFileSync(process.execPath, [npmCli, 'run', 'check:dependency-install-policy'], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
  }).trim());
  for (const prefix of ['.', 'tools/api-discovery']) {
    const scripts = json(`${prefix}/package.json`).scripts ?? {};
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
      assert.equal(scripts[hook], undefined, `${prefix}: ${hook}`);
    }
  }
});
