import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

test("discovery setup retains the reviewed Chromium-compatible Playwright release", () => {
  const manifest = readJson("./package.json");
  const lock = readJson("./package-lock.json");
  // 1.64 removes Chromium archives for macOS 13, Ubuntu 20.04 and Debian 11.
  // Revisit this pin only with artifact, host-compatibility and audit evidence.
  assert.equal(manifest.devDependencies.playwright, "1.59.1");
  assert.equal(lock.packages[""].devDependencies.playwright, "1.59.1");
  for (const name of ["playwright", "playwright-core"]) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry.version, "1.59.1");
    assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${name}-1.59.1.tgz`);
    assert.match(entry.integrity, /^sha512-/);
  }
  assert.equal(lock.packages["node_modules/playwright"].dependencies["playwright-core"], "1.59.1");
  assert.equal(manifest.scripts.setup, "playwright install chromium");
  assert.equal(
    readJson("../../package.json").scripts["discovery:setup"],
    "npm --prefix tools/api-discovery ci --include=dev && npm run setup --prefix tools/api-discovery",
  );
});

test("named development commands retain their prerequisites with install hooks disabled", () => {
  const { scripts } = readJson("../../package.json");
  assert.equal(scripts.dev, "npm run check:devvars && wrangler dev");
  assert.equal(scripts.typecheck, "npm run types && tsc --noEmit && tsc --noEmit -p tsconfig.src.json");
  assert.equal(scripts.predev, undefined);
  assert.equal(scripts.pretypecheck, undefined);
});

for (const relative of ["../../.npmrc", "./.npmrc"]) {
  test(`native install controls apply at ${relative}`, () => {
    const settings = new Map(readFileSync(new URL(relative, import.meta.url), "utf8")
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")));
    assert.deepEqual(settings, new Map([["min-release-age", "3"], ["ignore-scripts", "true"]]));
  });
}
