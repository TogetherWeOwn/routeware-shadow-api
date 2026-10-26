#!/usr/bin/env node
/** Local-only first-run runner. Pure command, parser and result schema: lib/firstRun.mjs. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

import { parseDevVarsText } from "./lib/devVarsCheck.mjs";
import {
  CHECK_NAME, FIRST_RUN_STEPS, firstRunDocument, firstRunUsage,
  formatFirstRunSummary, localBaseUrl, parseFirstRunArgs, pickSmokeToken,
  smokeEnv, summarizeFirstRun,
} from "./lib/firstRun.mjs";

const options = parseFirstRunArgs(argv.slice(2));
function emitJson(value) {
  // The envelope contains only the fixed schema, step IDs and remediation strings.
  process.stdout.write(JSON.stringify(value) + "\n");
}
if (options.help) {
  process.stdout.write(firstRunUsage() + "\n");
  process.exit(0);
}
if (!options.valid) {
  if (options.json) emitJson(firstRunDocument({ code: "FIRST_RUN_INVALID_ARGUMENT" }));
  else process.stderr.write("first-run: invalid arguments; use --help.\n");
  process.exit(2);
}
if (options.dryRun) {
  emitJson(firstRunDocument({ dryRun: true }));
  process.exit(0);
}

// Nothing above this boundary observes credentials or performs a planned effect.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEALTH_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL_CHARS = 4_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
let interrupted = false;
let teardownFailed = false;
let activeCommand = null;
let stopSmoke = null;
let signalCleanup = Promise.resolve();

class RunFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function fail(code) { throw new RunFailure(code); }
function log(message) { if (!options.json) console.log(message); }
function diagnostic(message) { if (!options.json) console.error(message); }

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function stopCommand({ child, detached }) {
  if (!child.pid) return true;
  const stopped = () => detached ? !groupAlive(child.pid) : child.exitCode !== null || child.signalCode !== null;
  const signal = (value) => detached ? signalGroup(child.pid, value) : child.kill(value);
  signal("SIGTERM");
  if (!(await waitUntil(stopped, STOP_TIMEOUT_MS))) signal("SIGKILL");
  return waitUntil(stopped, STOP_TIMEOUT_MS);
}
function onSignal() {
  if (interrupted) return;
  interrupted = true;
  // Snapshot handles before their completion callbacks clear them. Never leave an
  // async signal callback rejection unhandled or allow a successful child race.
  const command = activeCommand;
  const smoke = stopSmoke;
  signalCleanup = Promise.all([
    command ? stopCommand(command) : true,
    smoke ? smoke() : true,
  ]).then((stopped) => { if (stopped.includes(false)) teardownFailed = true; })
    .catch(() => { teardownFailed = true; });
}

function commandArgs(command, port) {
  const [executable, ...args] = command;
  return [executable === "node" ? process.execPath : executable,
    args.map((arg, index) => executable === "node" && index === 0 ? path.join(root, arg)
      : arg === "<ephemeral>" ? String(port) : arg)];
}
function runCommand(command, { env, detached = true } = {}) {
  if (interrupted) fail("FIRST_RUN_INTERRUPTED");
  const [executable, args] = commandArgs(command);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd: root, shell: false, detached, env,
        // Discard rather than capture: even unbounded/hostile child output can
        // never become a second JSON stream or consume an unbounded buffer.
        stdio: options.json ? ["ignore", "ignore", "ignore"] : "inherit",
      });
    } catch { reject(new RunFailure("FIRST_RUN_SPAWN_FAILED")); return; }
    activeCommand = { child, detached };
    child.once("error", () => reject(new RunFailure("FIRST_RUN_SPAWN_FAILED")));
    child.once("close", (code, signal) => {
      if (activeCommand?.child === child) activeCommand = null;
      resolve(code === 0 && !signal);
    });
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
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function startDevServer(command, port, output) {
  const [executable, args] = commandArgs(command, port);
  const dev = spawn(executable, args, {
    cwd: root, detached: true, shell: false,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  dev.on("error", () => { output.spawnFailed = true; });
  const readyLine = Buffer.from(`Ready on http://127.0.0.1:${port}`);
  for (const stream of [dev.stdout, dev.stderr]) {
    let matched = 0;
    stream.on("error", () => { output.spawnFailed = true; });
    stream.on("data", (chunk) => {
      // Keep only a match index across chunks, not even a raw suffix in JSON
      // mode. The fixed ASCII marker has no internal occurrence of its first R.
      for (const byte of chunk) {
        matched = byte === readyLine[matched] ? matched + 1 : byte === readyLine[0] ? 1 : 0;
        if (matched === readyLine.length) { output.ready = true; matched = 0; }
      }
      if (!options.json) output.tail = (output.tail + chunk.subarray(-OUTPUT_TAIL_CHARS).toString()).slice(-OUTPUT_TAIL_CHARS);
    });
  }
  return dev;
}
async function healthy(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(2_000), redirect: "error" });
    await res.body?.cancel();
    return res.status === 200;
  } catch { return false; }
}
async function waitForHealth(dev, baseUrl, output) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (!interrupted && Date.now() < deadline) {
    if (output.spawnFailed) fail("FIRST_RUN_SPAWN_FAILED");
    if (dev.exitCode !== null || dev.signalCode !== null) return false;
    if (output.ready && (await healthy(baseUrl))) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}
function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (answers) => { clearTimeout(timer); socket.destroy(); resolve(answers); };
    // An inconclusive timeout is not proof of a closed port.
    const timer = setTimeout(() => finish(true), 500);
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(error.code !== "ECONNREFUSED" && error.code !== undefined));
  });
}
async function stopDevServer(dev, port) {
  if (!dev?.pid) return true; // Spawn failed before a process existed.
  signalGroup(dev.pid, "SIGTERM");
  if (!(await waitUntil(() => !groupAlive(dev.pid), STOP_TIMEOUT_MS))) signalGroup(dev.pid, "SIGKILL");
  // Closing the port alone is insufficient: a surviving workerd group is a failure.
  return waitUntil(async () => !groupAlive(dev.pid) && !(await portAnswers(port)), STOP_TIMEOUT_MS);
}
async function runSmoke(step) {
  const port = await freePort();
  const baseUrl = localBaseUrl(port);
  const token = pickSmokeToken(readDevVars());
  if (interrupted) fail("FIRST_RUN_INTERRUPTED");
  const output = { tail: "", ready: false, spawnFailed: false };
  let dev = null;
  let teardown = null;
  const stop = () => (teardown ??= stopDevServer(dev, port).catch(() => false));
  let served = false;
  try {
    try { dev = startDevServer(step.commands[0], port, output); }
    catch { fail("FIRST_RUN_SPAWN_FAILED"); }
    stopSmoke = stop;
    log(`smoke: wrangler dev on ${baseUrl}`);
    if (!(await waitForHealth(dev, baseUrl, output))) {
      if (!interrupted) diagnostic(`smoke: local dev server did not become healthy\n--- wrangler dev output (tail) ---\n${output.tail}`);
      fail(interrupted ? "FIRST_RUN_INTERRUPTED" : "FIRST_RUN_HEALTH_FAILED");
    }
    served = await runCommand(step.commands[1], {
      detached: false, env: { ...process.env, ...smokeEnv({ baseUrl, token }) },
    });
    if (!served && !interrupted) diagnostic(`--- wrangler dev output (tail) ---\n${output.tail}`);
  } finally {
    const stopped = await stop();
    stopSmoke = null;
    if (!stopped) {
      teardownFailed = true;
      // Unconfirmed cleanup must return a failure envelope, not hang forever on
      // the surviving process's pipes. This does not claim the process stopped.
      dev?.stdout?.destroy?.();
      dev?.stderr?.destroy?.();
      dev?.unref();
      diagnostic("smoke: process group or loopback port did not stop; stop leftover wrangler/workerd processes for this checkout");
    }
  }
  return served && !interrupted && !teardownFailed;
}

for (const signal of SIGNALS) process.on(signal, onSignal);
const results = [];
let code = null;
try {
  for (const [index, step] of FIRST_RUN_STEPS.entries()) {
    if (interrupted) break;
    log(`\n== [${index + 1}/${FIRST_RUN_STEPS.length}] ${step.name} ==`);
    let ok = false;
    try { ok = step.name === "smoke" ? await runSmoke(step) : await runCommand(step.commands[0]); }
    catch (error) { code = error instanceof RunFailure ? error.code : "FIRST_RUN_STEP_FAILED"; }
    await signalCleanup;
    ok &&= !interrupted && !teardownFailed;
    results.push({ name: step.name, ok });
    if (!ok) { code ??= "FIRST_RUN_STEP_FAILED"; break; }
  }
  if (teardownFailed) code = "FIRST_RUN_TEARDOWN_FAILED";
  else if (interrupted) code = "FIRST_RUN_INTERRUPTED";
  const summary = summarizeFirstRun(results);
  if (!summary.ok) code ??= "FIRST_RUN_STEP_FAILED";
  if (options.json) emitJson(firstRunDocument({ results, code, interrupted }));
  else if (interrupted) diagnostic(`\n${CHECK_NAME}: interrupted; ${teardownFailed ? "teardown incomplete" : "child processes stopped"}`);
  else log(`\n${formatFirstRunSummary(summary)}`);
  process.exitCode = interrupted ? 130 : code ? 1 : 0;
} finally {
  for (const signal of SIGNALS) process.off(signal, onSignal);
}
