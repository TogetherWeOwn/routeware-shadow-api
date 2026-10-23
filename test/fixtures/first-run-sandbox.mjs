// Test-only Node preload: all runner, credential, socket and network effects
// are injected. It is never imported by production code. Even a broken parser
// cannot start npm, Wrangler, workerd, a real server, or an upstream request.
import cp from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const scenario = process.env.FIRST_RUN_TEST_SCENARIO;
const traceFile = process.env.FIRST_RUN_TEST_TRACE;
const preflight = process.env.FIRST_RUN_TEST_PREFLIGHT === "1";
const traceFd = fs.openSync(traceFile, "a");
const write = fs.writeSync.bind(fs);
const trace = (event) => write(traceFd, JSON.stringify(event) + "\n");
const CANARY = "SYNTHETIC_FIRST_RUN_PRIVATE_CANARY";
const TOKEN = "SYNTHETIC_FIRST_RUN_TOKEN_NOT_A_CREDENTIAL";
const PORT = 18791;
const PID = 424242;
const noise = `${CANARY} Authorization: Bearer ${TOKEN} password=synthetic raw child output\n`;
let alive = false;
let dev;

function deny(kind) {
  trace({ kind });
  throw new Error(`Test sandbox denied ${kind}`);
}

// No real time budget is consumed by health/teardown failure fixtures. Keep
// asynchronous scheduling (and timer handles) real; only shorten the deadlines.
const realTimeout = globalThis.setTimeout;
const realNow = Date.now;
let clock = realNow();
Date.now = () => (clock += 1000);
globalThis.setTimeout = (callback, ms, ...args) => realTimeout(callback, Math.min(ms, 1), ...args);

function isCredential(file) {
  return /(?:^|[/\\])(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|credentials(?:\..*)?)$/.test(String(file));
}
const credentials = `LOGIN_USERNAME=synthetic\nLOGIN_PASSWORD=${CANARY}\nSHADOW_API_TOKEN=${TOKEN}\nCUSTOMER_SNAPSHOT_SYNC_SECRET=${TOKEN}\n`;
for (const mod of [fs, fsp]) {
  for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream", "access", "accessSync", "stat", "statSync", "existsSync"]) {
    if (typeof mod[key] !== "function") continue;
    const original = mod[key].bind(mod);
    mod[key] = (file, ...args) => {
      if (!isCredential(file)) return original(file, ...args);
      trace({ kind: "credential_file", api: key });
      if (preflight) return deny("preflight_credential_file");
      if (scenario === "missing-credentials") throw Object.assign(new Error(CANARY), { code: "ENOENT" });
      if (key === "readFileSync") return credentials;
      if (mod === fsp && key === "readFile") return Promise.resolve(credentials);
      if (key === "readFile") return queueMicrotask(() => args.at(-1)(null, credentials));
      // A new credential API must get a deliberate fake, never reach the host.
      return deny("unexpected_credential_api");
    };
  }
  for (const key of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync", "rm", "rmSync", "unlink", "unlinkSync", "rename", "renameSync", "createWriteStream", "truncate", "truncateSync", "copyFile", "copyFileSync", "cp", "cpSync", "symlink", "symlinkSync", "link", "linkSync"]) {
    if (typeof mod[key] === "function") mod[key] = () => deny("state_write");
  }
}
// open/write can mutate without going through writeFile; module loading remains
// read-only. Stdout/stderr writes are the CLI's public output under test.
for (const mod of [fs, fsp]) {
  for (const key of ["open", "openSync"]) {
    if (typeof mod[key] !== "function") continue;
    const original = mod[key].bind(mod);
    mod[key] = (file, flags = "r", ...args) => {
      if (typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0 : /[wa+]/.test(flags)) deny("state_write");
      return original(file, flags, ...args);
    };
  }
  for (const key of ["write", "writeSync"]) {
    if (typeof mod[key] !== "function") continue;
    const original = mod[key].bind(mod);
    mod[key] = (fd, ...args) => {
      if (fd !== 1 && fd !== 2) deny("state_write");
      return original(fd, ...args);
    };
  }
}
if (preflight) {
  process.env = new Proxy(process.env, {
    get(target, key) {
      if (typeof key === "string" && /LOGIN|TOKEN|SECRET|PASSWORD|COOKIE|CLOUDFLARE|DATABASE_URL/.test(key)) deny("credential_env");
      return Reflect.get(target, key);
    },
  });
}

function classify(command, args) {
  if (args.some((arg) => String(arg).endsWith("scripts/check-devvars.mjs"))) return "devvars";
  if (command === "npm" && args.join(" ") === "run db:migrate:local") return "migrate";
  if (command === "npm" && args.join(" ") === "run db:seed") return "seed";
  if (args.some((arg) => String(arg).endsWith("wrangler/bin/wrangler.js")) && args.includes("dev")) return "server";
  if (args.some((arg) => String(arg).endsWith("scripts/smoke-readiness.mjs"))) return "smoke";
  return "unexpected";
}
function invocation(api, command, args = [], options = {}) {
  const stage = classify(command, args);
  trace({
    kind: "subprocess", api, stage, command: path.basename(command), args,
    detached: options.detached === true, stdio: options.stdio ?? "pipe",
    shell: options.shell ?? false,
    baseUrl: options.env?.SHADOW_API_BASE ?? null,
    syntheticToken: options.env?.SHADOW_API_TOKEN === TOKEN,
  });
  if (preflight) return { stage, denied: true };
  if (stage === "unexpected") return deny("unexpected_subprocess");
  if (scenario === `throw-${stage}`) throw new Error(`${noise} spawn failed`);
  return { stage, denied: false };
}
function emitOutput(options, stdout, stderr, text = noise) {
  const stdio = options.stdio ?? "pipe";
  for (const [index, stream, parent] of [[1, stdout, process.stdout], [2, stderr, process.stderr]]) {
    const mode = Array.isArray(stdio) ? stdio[index] : stdio;
    if (mode === "inherit" || mode === index) parent.write(text);
    else if (mode === "pipe" || mode === undefined) stream?.emit("data", Buffer.from(text));
  }
}
cp.spawnSync = (command, args = [], options = {}) => {
  const { stage, denied } = invocation("spawnSync", command, args, options);
  const text = scenario === "flood" ? noise.repeat(4096) : noise;
  emitOutput(options, null, null, text);
  const signal = scenario === `signal-${stage}` ? "SIGTERM" : null;
  const error = scenario === `error-${stage}` ? Object.assign(new Error(noise), { code: "ENOENT" }) : undefined;
  const status = denied || scenario === `fail-${stage}` ? 17 : signal || error ? null : 0;
  return { pid: PID + 1, status, signal, error, stdout: Buffer.from(text), stderr: Buffer.from(text), output: [null, Buffer.from(text), Buffer.from(text)] };
};
cp.spawn = (command, args = [], options = {}) => {
  const { stage, denied } = invocation("spawn", command, args, options);
  const child = new EventEmitter();
  Object.assign(child, { pid: stage === "server" ? PID : PID + 1, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
  child.kill = (signal = "SIGTERM") => {
    trace({ kind: "child_kill", stage, signal });
    child.signalCode = signal;
    child.emit("exit", null, signal);
    child.emit("close", null, signal);
    return true;
  };
  child.unref = () => {};
  if (stage === "server") { dev = child; alive = true; }
  queueMicrotask(() => {
    if (scenario === `error-${stage}`) {
      if (stage === "server") alive = false;
      child.emit("error", Object.assign(new Error(noise), { code: "ENOENT" }));
      child.emit("close", null, null);
      return;
    }
    emitOutput(options, child.stdout, child.stderr, scenario === "flood" ? noise.repeat(4096) : noise);
    if (stage === "server" && !denied) {
      if (scenario !== "not-ready") child.stdout.emit("data", Buffer.from(`Ready on http://127.0.0.1:${PORT}\n`));
      if (["interrupt-SIGINT", "interrupt-SIGTERM", "interrupt-SIGHUP", "interrupt-teardown-failure"].includes(scenario)) {
        const signal = scenario === "interrupt-teardown-failure" ? "SIGINT" : scenario.slice("interrupt-".length);
        trace({ kind: "injected_signal", signal });
        process.emit(signal);
      }
      return;
    }
    if (scenario === "interrupt-during-smoke" && stage === "smoke") {
      trace({ kind: "injected_signal", signal: "SIGINT" });
      process.emit("SIGINT");
    }
    const signal = scenario === `signal-${stage}` ? "SIGTERM" : null;
    child.exitCode = denied || scenario === `fail-${stage}` ? 17 : signal ? null : 0;
    child.signalCode = signal;
    child.emit("exit", child.exitCode, signal);
    child.emit("close", child.exitCode, signal);
  });
  return child;
};
for (const key of ["exec", "execSync", "execFile", "execFileSync", "fork"]) cp[key] = () => deny("unexpected_subprocess_api");

net.createServer = () => {
  trace({ kind: "server_allocation" });
  if (preflight) deny("preflight_server");
  const server = new EventEmitter();
  server.listen = (...args) => { queueMicrotask(args.at(-1)); return server; };
  server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: PORT });
  server.close = (callback) => { queueMicrotask(callback); return server; };
  server.unref = () => server;
  return server;
};
net.connect = net.createConnection = (options) => {
  trace({ kind: "port_probe", host: options?.host, port: options?.port });
  if (preflight) deny("preflight_socket");
  const socket = new EventEmitter();
  socket.destroy = () => {};
  queueMicrotask(() => socket.emit(alive && scenario !== "group-survives-port-closed" ? "connect" : "error", new Error(CANARY)));
  return socket;
};
process.kill = (pid, signal = "SIGTERM") => {
  trace({ kind: "group_signal", pid, signal });
  if (preflight || pid !== -PID) deny("unexpected_process_signal");
  if (!alive) throw Object.assign(new Error("synthetic group absent"), { code: "ESRCH" });
  if (signal === 0) return true;
  const survives = ["teardown-failure", "group-survives-port-closed", "interrupt-teardown-failure"].includes(scenario) || (scenario === "needs-kill" && signal !== "SIGKILL");
  if (!survives) {
    alive = false;
    dev.signalCode = signal;
    dev.emit("exit", null, signal);
    dev.emit("close", null, signal);
  }
  return true;
};
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  trace({ kind: "fetch", url });
  if (preflight || url !== `http://127.0.0.1:${PORT}/api/v1/health`) deny("unexpected_network");
  if (scenario === "health-throws") throw new Error(noise);
  return new Response("synthetic health", { status: scenario === "unhealthy" ? 503 : 200 });
};
for (const [mod, keys] of [[http, ["request", "get", "createServer"]], [https, ["request", "get", "createServer"]], [tls, ["connect", "createServer"]], [dgram, ["createSocket"]]]) {
  for (const key of keys) mod[key] = () => deny("unexpected_network");
}
syncBuiltinESMExports();
process.on("exit", () => trace({ kind: "sandbox_exit", groupAlive: alive }));
