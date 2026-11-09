import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

// This captures EVERY unselected package entry, not just the hoisted versions.
// Change this baseline only after a new dependency/artifact qualification.
test('all unselected dependency metadata and both discovery files remain unchanged', () => {
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

test('only the four exact-parent repair edges are overridden', () => {
  assert.deepEqual(manifest.overrides, {
    'miniflare@4.20260421.0': { ws: '8.22.0', undici: '7.30.1' },
    'wrangler@4.84.1': { esbuild: '0.28.2' },
    '@cloudflare/vitest-pool-workers@0.14.9': { esbuild: '0.28.2' },
  });
  assert.equal(lock.packages['node_modules/miniflare'].version, '4.20260421.0');
  assert.equal(lock.packages['node_modules/wrangler'].version, '4.84.1');
  assert.equal(lock.packages['node_modules/@cloudflare/vitest-pool-workers'].version, '0.14.9');
});

test('esbuild and all 26 optional platforms match the reviewed artifact closure', () => {
  assert.equal(Object.keys(baseline.artifacts).length, 27);
  for (const [path, expected] of Object.entries(baseline.artifacts)) {
    const actual = lock.packages[path];
    assert.ok(actual, path);
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(actual[field], value, `${path}: ${field}`);
    }
    assert.equal(actual.dependencies, undefined, `${path}: no new transitive dependency`);
  }
});

test('every transport copy is patched without new optional native peers', () => {
  for (const [path, entry] of Object.entries(lock.packages)) {
    const name = path.split('node_modules/').at(-1);
    if (!(name in baseline.transport)) continue;
    const expected = baseline.transport[name];
    assert.equal(entry.version, expected.version, path);
    assert.equal(entry.integrity, expected.integrity, path);
    assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${name}-${expected.version}.tgz`);
    assert.equal(entry.dependencies, undefined);
  }
});

test('installed resolution is verified FROM each retained consumer, including sync-fetch', () => {
  const require = createRequire(import.meta.url);
  const consumers = {
    miniflare: { ws: '8.22.0', undici: '7.30.1' },
    wrangler: { esbuild: '0.28.2' },
    '@cloudflare/vitest-pool-workers': { esbuild: '0.28.2' },
  };
  for (const [parent, children] of Object.entries(consumers)) {
    const parentRequire = createRequire(require.resolve(`${parent}/package.json`));
    for (const [name, version] of Object.entries(children)) {
      assert.equal(parentRequire(`${name}/package.json`).version, version, `${parent} -> ${name}`);
    }
  }
  // Miniflare's eval worker resolves Undici with createRequire(__filename),
  // not from the process cwd. Verify that entry-point base independently.
  const syncRequire = createRequire(require.resolve('miniflare'));
  assert.equal(syncRequire('undici/package.json').version, '7.30.1');
  console.log(JSON.stringify({ node: process.version, consumers, syncFetchUndici: '7.30.1' }));
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
