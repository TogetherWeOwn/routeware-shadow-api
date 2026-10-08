#!/usr/bin/env node
/**
 * OpenAPI contract-drift check (TOG-6282).
 *
 * Compares the routes declared in each mounted route module
 * (`createRoute({ method, path })` in `src/routes/*.ts`) against the ops that
 * actually reach `/openapi.json` (`<module>.openapi(<route>, …)` inside a
 * `createRouteModule()` — an `OpenAPIHono`). Static and credential-free: reads
 * source text only, so it runs in CI hygiene and on a nightly schedule with
 * no Worker runtime, no secrets, and no network access.
 *
 * Flags (default to the repo layout; redirect both sides so the acceptance
 * proof — a dummy plain-Hono route failing the gate — can run without
 * touching `src/`):
 *   --app=<path>        app wiring (default src/app.ts)
 *   --routes-dir=<path>  mounted route modules live here
 *                         (default src/routes; also scanned for unmounted
 *                         `*Routes` exports)
 *
 * Exit 0 when every declared op is published. Exit 1 naming each dropped op
 * (or module) with its cause. Exit 2 when an input is missing/unreadable —
 * never report a missing file as a pass.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

import {
  CHECK_NAME,
  formatDriftReport,
  parseAppMounts,
  parseModuleExports,
  runDriftCheck,
} from "./lib/openapiDriftCheck.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function readOrDie(resolved, label) {
  try {
    return readFileSync(resolved, "utf8");
  } catch (error) {
    console.error(`${CHECK_NAME}: cannot read ${label} ${resolved}: ${error.message}`);
    exit(2);
  }
}

const appPath = path.resolve(root, flagValue("app") ?? "src/app.ts");
const routesDir = path.resolve(root, flagValue("routes-dir") ?? "src/routes");

const appText = readOrDie(appPath, "app wiring");

let dirEntries;
try {
  dirEntries = readdirSync(routesDir);
} catch (error) {
  console.error(`${CHECK_NAME}: cannot read routes dir ${routesDir}: ${error.message}`);
  exit(2);
}

// Every mounted module resolves through `../`-style relative imports in
// `app.ts`, so only `src/routes/*.ts` files are candidates — and only mounted
// modules are READ (an unmounted experimental module that does not compile
// must never break the gate). Mount resolution comes from the lib; here we
// just offer each `*.ts` file's text keyed by its plausible module name.
const texts = new Map();
const allExports = [];
for (const name of dirEntries.filter((n) => n.endsWith(".ts"))) {
  const file = `src/routes/${name}`;
  const resolved = path.join(routesDir, name);
  if (!statSync(resolved).isFile()) continue;
  const text = readOrDie(resolved, "route module");
  texts.set(file, text);
  for (const module of parseModuleExports(text)) {
    allExports.push({ module, file });
  }
}

// Only mounted modules are READ: an unmounted experimental module that does
// not compile must never break the gate. A mount whose file cannot be found
// is passed as `text: null` — itself a drift finding the lib reports, never a
// silent skip.
const mounts = parseAppMounts(appText).map(({ module, file }) => ({
  module,
  file,
  text: file && texts.has(file) ? texts.get(file) : null,
}));

const outcome = runDriftCheck({ appText, modules: mounts, allExports });

if (outcome.ok) {
  console.log(
    `${CHECK_NAME}: OK — ${outcome.stats.published}/${outcome.stats.declared} declared op(s) published across ${outcome.stats.mounts} mounted module(s)`
  );
  exit(0);
}

for (const line of formatDriftReport(outcome.drops)) console.error(`${CHECK_NAME}: ${line}`);
exit(1);
