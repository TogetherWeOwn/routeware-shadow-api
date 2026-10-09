#!/usr/bin/env node
/**
 * One-command first run on a fresh clone (TOG-9233).
 *
 * Runs check:devvars, db:migrate:local, db:seed and smoke, stopping at the
 * first failure. The smoke step starts `wrangler dev` on a free loopback port,
 * waits for GET /api/v1/health, runs smoke:readiness against it, then signals
 * the dev server's process group: wrangler and its workerd child share it, and
 * killing only the wrapper leaves workerd holding the port.
 *
 * Pure logic lives in `./lib/firstRun.mjs` and is unit-tested; this file is the
 * impure runner around it.
 *
 * Usage:
 *   npm run first-run
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDevVarsText } from "./lib/devVarsCheck.mjs";
import {
  CHECK_NAME,
  FIRST_RUN_STEPS,
  formatFirstRunSummary,
  localBaseUrl,
  pickSmokeToken,
  smokeEnv,
  summarizeFirstRun,
  wranglerDevArgs,
} from "./lib/firstRun.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEALTH_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL_CHARS = 4_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
let interrupted = false;

function runNode(script) {
  return spawnSync(process.execPath, [path.join(root, script)], { cwd: root, stdio: "inherit" }).status === 0;
}

function runNpm(script) {
  return spawnSync("npm", ["run", script], { cwd: root, stdio: "inherit" }).status === 0;
}

function runAsync(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function readDevVars() {
  const text = fs.readFileSync(path.join(root, ".dev.vars"), "utf8").replace(/^﻿/, "");
  return parseDevVarsText(text);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startDevServer(port, output) {
  const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
  const dev = spawn(process.execPath, [wrangler, ...wranglerDevArgs(port)], {
    cwd: root,
    detached: true,
    // The Ready-line match below needs plain text.
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [dev.stdout, dev.stderr]) {
    stream.on("data", (chunk) => {
      const text = output.tail + chunk;
      output.ready ||= text.includes(`Ready on http://127.0.0.1:${port}`);
      output.tail = text.slice(-OUTPUT_TAIL_CHARS);
    });
  }
  return dev;
}

async function healthy(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(2_000) });
    await res.arrayBuffer();
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitForHealth(dev, baseUrl, output) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (dev.exitCode !== null || dev.signalCode !== null) return false;
    if (output.ready && (await healthy(baseUrl))) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function stopDevServer(dev, port) {
  signalGroup(dev.pid, "SIGTERM");
  if (!(await waitUntil(async () => !groupAlive(dev.pid), STOP_TIMEOUT_MS))) {
    signalGroup(dev.pid, "SIGKILL");
  }
  return waitUntil(async () => !(await portAnswers(port)), STOP_TIMEOUT_MS);
}

async function checkServer(dev, output, baseUrl, token) {
  if (!(await waitForHealth(dev, baseUrl, output))) {
    console.error(`smoke: GET ${baseUrl}/api/v1/health did not return 200`);
    console.error(`--- wrangler dev output (tail) ---\n${output.tail}`);
    return false;
  }
  const status = await runAsync(process.execPath, [path.join(root, "scripts/smoke-readiness.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...smokeEnv({ baseUrl, token }) },
  });
  if (status !== 0) console.error(`--- wrangler dev output (tail) ---\n${output.tail}`);
  return status === 0;
}

async function runSmoke() {
  const port = await freePort();
  const baseUrl = localBaseUrl(port);
  const token = pickSmokeToken(readDevVars());
  const output = { tail: "", ready: false };
  const dev = startDevServer(port, output);
  console.log(`smoke: wrangler dev on ${baseUrl}`);

  let teardown = null;
  const stop = () => (teardown ??= stopDevServer(dev, port));
  const onSignal = async () => {
    interrupted = true;
    await stop();
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);

  let served = false;
  try {
    served = await checkServer(dev, output, baseUrl, token);
  } finally {
    const stopped = await stop();
    for (const signal of SIGNALS) process.off(signal, onSignal);
    if (!stopped) {
      console.error(`smoke: port ${port} still answers after teardown; stop leftover wrangler/workerd processes for this checkout`);
      served = false;
    }
  }
  return served;
}

const RUNNERS = {
  devvars: () => runNode("scripts/check-devvars.mjs"),
  migrate: () => runNpm("db:migrate:local"),
  seed: () => runNpm("db:seed"),
  smoke: runSmoke,
};

async function runStep(name) {
  try {
    return await RUNNERS[name]();
  } catch (error) {
    console.error(error);
    return false;
  }
}

const results = [];
for (const [index, step] of FIRST_RUN_STEPS.entries()) {
  console.log(`\n== [${index + 1}/${FIRST_RUN_STEPS.length}] ${step.name} ==`);
  const ok = await runStep(step.name);
  results.push({ name: step.name, ok });
  if (!ok) break;
}

if (interrupted) {
  console.error(`\n${CHECK_NAME}: interrupted; the dev server was stopped`);
  process.exit(130);
}
const summary = summarizeFirstRun(results);
console.log(`\n${formatFirstRunSummary(summary)}`);
process.exit(summary.ok ? 0 : 1);
