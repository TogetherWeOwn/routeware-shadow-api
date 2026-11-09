import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = read('../.github/workflows/dependency-qualification.yml');
// Exercise the actual embedded resolver, not a second implementation.
const source = workflow.match(/^            function resolve\(parent, name\) \{\n[\s\S]*?^            \}/m)?.[0];
assert.ok(source, 'native audit evidence retains its lockfile resolver');
const resolver = (lock) => runInNewContext(`(${source})`, { lock, posix });

test('audit evidence resolves root-hoisted, nested, scoped and absent lock dependencies', () => {
  const lock = JSON.parse(read('../package-lock.json'));
  const resolve = resolver(lock);
  for (const [parent, name, expected, version] of [
    ['node_modules/wrangler', 'esbuild', 'node_modules/esbuild', '0.27.3'],
    ['node_modules/miniflare', 'undici', 'node_modules/undici', '7.24.8'],
    ['node_modules/@cloudflare/vitest-pool-workers', 'esbuild', 'node_modules/esbuild', '0.27.3'],
    ['node_modules/miniflare', 'ws', 'node_modules/miniflare/node_modules/ws', '8.22.0'],
    ['', 'ws', 'node_modules/ws', '8.22.0'],
  ]) {
    const resolved = resolve(parent, name);
    assert.equal(resolved, expected, `${parent} -> ${name}`);
    assert.equal(lock.packages[resolved].version, version);
    assert.ok([expected].includes(resolved), 'parent edge survives the raw audit nodes filter');
  }
  assert.equal(resolve('node_modules/miniflare', 'missing-audit-fixture'), undefined);
  assert.equal(resolve('', 'missing-audit-fixture'), undefined);

  const nested = resolver({ packages: {
    'node_modules/child': {},
    'node_modules/parent/node_modules/child': {},
    'node_modules/parent/node_modules/@scope/child': {},
    'node_modules/@scope/root': {},
  } });
  assert.equal(nested('node_modules/parent/node_modules/@scope/consumer', 'child'),
    'node_modules/parent/node_modules/child', 'nearest ancestor wins over root');
  assert.equal(nested('node_modules/parent', '@scope/child'),
    'node_modules/parent/node_modules/@scope/child');
  assert.equal(nested('node_modules/parent/node_modules/@scope/consumer', '@scope/root'),
    'node_modules/@scope/root');
  assert.equal(nested('node_modules/parent/node_modules/@scope/consumer', 'absent'), undefined);
});
