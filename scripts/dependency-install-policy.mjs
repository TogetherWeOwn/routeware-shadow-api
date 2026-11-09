import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Run before `npm ci`, without loading anything from node_modules. Reading an
// unknown config key on an older npm is not proof it enforces release age.
assert.ok(process.env.npm_execpath, 'invoke through npm run check:dependency-install-policy');
const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
  encoding: 'utf8', timeout: 30_000,
}).trim();
const version = npm('--version');
const [major, minor] = version.split('.').map(Number);
assert.ok(major > 11 || (major === 11 && minor >= 19), `npm 11.19+ required, received ${version}`);
for (const prefix of ['.', 'tools/api-discovery']) {
  assert.equal(npm('--prefix', prefix, 'config', 'get', 'min-release-age'), '3', prefix);
  assert.equal(npm('--prefix', prefix, 'config', 'get', 'ignore-scripts'), 'true', prefix);
}
console.log(JSON.stringify({ node: process.version, npm: version, minReleaseAge: 3, ignoreScripts: true }));
