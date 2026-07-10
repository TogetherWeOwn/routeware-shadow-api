#!/usr/bin/env node
/**
 * Records your UI actions on Routeware into a replayable Playwright script using
 * `playwright codegen`. Complements `record.ts`: codegen captures *what you did*
 * (clicks, typing, navigation) while the NDJSON harvest captures *the requests
 * those actions fired* (URLs, args, bodies). Use both to turn a workflow into a
 * shadow API feature.
 *
 * Cross-platform: resolves Playwright's CLI and runs it via `node` so it works in
 * PowerShell / cmd / bash without relying on PATH or npx.
 *
 * Usage (from tools/api-discovery):
 *   npm run codegen                 # opens Routeware, prints the script in the inspector
 *   npm run codegen -- -o flow.ts   # also save the generated script to flow.ts
 *   CHROME_CHANNEL=chrome npm run codegen   # use installed Chrome (passed as --channel)
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const TARGET_ORIGIN = process.env.TARGET_ORIGIN ?? "https://killeen.routeware.com";
const TARGET_BASE_PATH = process.env.TARGET_BASE_PATH ?? "/WebRW";
const START_URL = process.env.START_URL ?? `${TARGET_ORIGIN}${TARGET_BASE_PATH}/`;

function resolveCli() {
  for (const id of ["playwright/cli.js", "playwright-core/cli.js"]) {
    try {
      return require.resolve(id);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const cli = resolveCli();
if (!cli) {
  console.error(
    "Playwright CLI not found. Run `npm run setup` in tools/api-discovery " +
      "(installs Playwright + Chromium) first."
  );
  process.exit(1);
}

// Pass through any extra args after `--` (e.g. `-o flow.ts`, `--target=javascript`).
const extra = process.argv.slice(2);
if (process.env.CHROME_CHANNEL && !extra.includes("--channel")) {
  extra.push(`--channel=${process.env.CHROME_CHANNEL}`);
}

console.log(`Opening Playwright codegen at ${START_URL}`);
console.log(
  "Log in and perform the actions you want captured. The generated script appears " +
    "in the Playwright Inspector; run `npm run record` in a second terminal to also " +
    "capture the underlying requests/args."
);

const res = spawnSync(process.execPath, [cli, "codegen", ...extra, START_URL], {
  stdio: "inherit"
});
process.exit(res.status ?? 0);
