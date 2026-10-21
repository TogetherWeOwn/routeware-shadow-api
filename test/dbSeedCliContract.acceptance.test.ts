import { spawnSync } from "node:child_process";
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildSeedStatements, VERIFY_QUERIES } from "../scripts/lib/dbSeed.mjs";

/**
 * Public CLI acceptance contract, deliberately RED until the paired build.
 * No new implementation exports: execute a sandbox copy of the real wrapper
 * and its libraries with a PATH containing only canned npx/wrangler runners.
 * Never inherit credentials, use a real database, or permit network access.
 *
 * JSON v1: schemaVersion, mode, database, target.persistTo, stage, outcome,
 * counts; errors add {code, retryable, next_action}. A plan adds fixtureIds,
 * ordered effects/checks with stable IDs, and limitations (no live validation).
 * The concrete vocabulary below is the Builder's output contract, not a
 * demand for a particular internal parser, runner export, or module layout.
 *
 * Node-only. Until the Builder registers this file in the root Node project:
 * npx vitest run --config test/dbSeedCliContract.acceptance.config.ts \
 *   test/dbSeedCliContract.acceptance.test.ts test/dbSeed.test.ts
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRATCH = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
const suiteDir = mkdtempSync(path.join(SCRATCH, "db-seed-contract-"));
afterAll(() => rmSync(suiteDir, { recursive: true, force: true }));

const DATABASE = "routeware-customer-snapshot";
const TABLES = ["customer_snapshot", "address_snapshot", "container_snapshot"];
const FIXTURE_IDS = { customer_id: 90001, pickup_address_id: 90010, container_id: 90100 };
const COUNTS = { customer_snapshot: 1, address_snapshot: 1, container_snapshot: 1 };
const CANARY = "SYNTHETIC_CHILD_ERROR_PRIVATE_CANARY";
const SECRET_CANARY = "SYNTHETIC_ENV_CREDENTIAL_CANARY";

// Real executable boundary: record argv, return complete Wrangler envelopes,
// and never interpret SQL or execute another program. Exit/status fixtures
// distinguish apply, verify transport, malformed results and count failures.
const RUNNER = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.SEED_TEST_LOG;
fs.appendFileSync(log, JSON.stringify({ executable: require("node:path").basename(process.argv[1]), args }) + "\\n");
const sql = args[args.indexOf("--command") + 1] || "";
const verify = /^SELECT COUNT\\(\\*\\)/.test(sql);
const mode = process.env.SEED_TEST_MODE;
if ((mode === "apply-failure" && !verify) || (mode === "verify-failure" && verify)) {
  process.stdout.write("${CANARY} raw stdout SQL SELECT * FROM private_table");
  process.stderr.write("${CANARY} raw stderr exception " + process.env.CLOUDFLARE_API_TOKEN);
  process.exit(17);
}
if (verify && mode === "malformed-json") { process.stdout.write("${CANARY} not JSON"); process.exit(0); }
if (verify && mode === "wrong-shape") { process.stdout.write(JSON.stringify({ error: "${CANARY}" })); process.exit(0); }
let results = verify ? [{ n: mode === "count-mismatch" ? 0 : 1 }] : [];
if (verify && mode === "missing-count") results = [{}];
if (verify && mode === "nonnumeric-count") results = [{ n: "${CANARY}" }];
if (verify && mode === "extra-row") results = [{ n: 1 }, { n: 0 }];
const envelope = { results, success: true, meta: { duration: 1 }, messages: ["${CANARY}"] };
process.stdout.write(JSON.stringify(mode === "bare-envelope" ? envelope : [envelope]));
`;

// Protect the actual wrapper, not just the executable stub. These exports are
// synchronized so named ESM imports cannot slip past the guard. Every denied
// attempt is recorded; catching the guard's exception cannot hide the attempt.
const GUARD = `
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const record = fs.appendFileSync.bind(fs);
function deny(kind) {
  record(process.env.SEED_TEST_GUARD, kind + "\\n");
  throw new Error("Acceptance sandbox denied " + kind);
}
const readOnly = process.env.SEED_TEST_READ_ONLY === "1";
if (readOnly) process.env = new Proxy(process.env, {
  get(target, key) {
    if (typeof key === "string" && /CLOUDFLARE|TOKEN|PASSWORD|SECRET/.test(key)) deny("credential-read");
    return Reflect.get(target, key);
  },
});
for (const key of ["exec", "execSync", "fork"]) cp[key] = () => deny("unexpected-process");
for (const key of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
  const original = cp[key].bind(cp);
  cp[key] = (command, args, options, ...rest) => {
    if (!["npx", "wrangler"].includes(command) || options?.shell ||
      (options?.env && options.env.PATH !== process.env.PATH)) deny("unexpected-process");
    return original(command, args, options, ...rest);
  };
}
globalThis.fetch = () => deny("network");
for (const [mod, keys] of [[http, ["request", "get"]], [https, ["request", "get"]],
  [net, ["connect", "createConnection", "createServer"]], [tls, ["connect", "createServer"]],
  [dgram, ["createSocket"]]]) {
  for (const key of keys) mod[key] = () => deny("network");
}
for (const mod of [fs, fsp]) {
  for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
    if (typeof mod[key] !== "function") continue;
    const original = mod[key].bind(mod);
    mod[key] = (file, ...args) => {
      if (/(?:^|[/\\\\])(?:\\.dev\\.vars(?:\\..*)?|\\.env(?:\\..*)?|credentials(?:\\..*)?)$/.test(String(file))) deny("credential-read");
      return original(file, ...args);
    };
  }
  if (process.env.SEED_TEST_READ_ONLY === "1") {
    for (const key of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync",
      "rm", "rmSync", "unlink", "unlinkSync", "rename", "renameSync", "createWriteStream", "truncate", "truncateSync"]) {
      if (typeof mod[key] === "function") mod[key] = () => deny("state-write");
    }
  }
}
syncBuiltinESMExports();
`;

type Invocation = { executable: string; args: string[] };
type Run = ReturnType<typeof runCli>;

function tree(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      entries[`${entry.name}/`] = "directory";
      for (const [child, bytes] of Object.entries(tree(name))) entries[`${entry.name}/${child}`] = bytes;
    } else entries[entry.name] = readFileSync(name).toString("base64");
  }
  return entries;
}

function runCli(args: string[], mode = "success") {
  const dir = mkdtempSync(path.join(suiteDir, "case-"));
  const workspace = path.join(dir, "workspace");
  const bin = path.join(dir, "bin");
  const control = path.join(dir, "control");
  for (const folder of [workspace, bin, control]) mkdirSync(folder);
  cpSync(path.join(ROOT, "scripts"), path.join(workspace, "scripts"), { recursive: true });
  mkdirSync(path.join(workspace, "home"));
  mkdirSync(path.join(workspace, "tmp"));
  const log = path.join(control, "runner.jsonl");
  const guardLog = path.join(control, "guard.log");
  writeFileSync(log, "");
  writeFileSync(guardLog, "");
  writeFileSync(path.join(control, "guard.mjs"), GUARD);
  for (const executable of ["npx", "wrangler"]) {
    writeFileSync(path.join(bin, executable), RUNNER, { mode: 0o755 });
  }
  const before = tree(workspace);
  const result = spawnSync(process.execPath, [
    "--import", path.join(control, "guard.mjs"),
    path.join(workspace, "scripts/db-seed.mjs"), ...args,
  ], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    // Deliberately NOT ...process.env: no actual token, HOME or npm hook.
    env: {
      PATH: bin, HOME: path.join(workspace, "home"), TMPDIR: path.join(workspace, "tmp"),
      SEED_TEST_LOG: log, SEED_TEST_GUARD: guardLog, SEED_TEST_MODE: mode,
      SEED_TEST_READ_ONLY: args.some((arg) => ["--dry-run", "--help", "-h"].includes(arg)) ? "1" : "0",
      CLOUDFLARE_API_TOKEN: SECRET_CANARY,
      npm_config_registry: "http://registry.invalid",
    },
  });
  expect(result.error, "CLI harness must complete without spawn/timeout errors").toBeUndefined();
  expect(result.signal, "CLI must exit normally").toBeNull();
  const invocations = readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
  expect(readFileSync(guardLog, "utf8"), "no network, credential reads or read-only state writes").toBe("");
  expect(tree(workspace), "no local dev state or sandbox files changed").toEqual(before);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, invocations };
}

function objectOutput(run: Run) {
  // JSON.parse over ALL stdout rejects prose, multiple objects and child noise.
  expect(run.stdout.trim(), "one structured stdout object, not empty output").toMatch(/^\{/);
  const output = JSON.parse(run.stdout);
  expect(output).not.toBeNull();
  expect(Array.isArray(output)).toBe(false);
  expect(output).toMatchObject({ schemaVersion: 1, mode: "local", database: DATABASE });
  expect(output.counts).toBeTypeOf("object");
  for (const canary of [CANARY, SECRET_CANARY, "private_table", "raw stderr", "raw stdout"]) {
    expect(run.stdout).not.toContain(canary);
  }
  return output;
}

function localCalls(run: Run, persistTo?: string) {
  for (const { executable, args } of run.invocations) {
    expect(["npx", "wrangler"]).toContain(executable);
    const flags = executable === "npx" ? args.slice(1) : args;
    if (executable === "npx") expect(args[0]).toBe("wrangler");
    expect(flags.slice(0, 3)).toEqual(["d1", "execute", DATABASE]);
    expect(flags.filter((arg) => arg === "--local")).toHaveLength(1);
    expect(flags).not.toContain("--remote");
    expect(flags).toContain("--json");
    if (persistTo === undefined) expect(flags).not.toContain("--persist-to");
    else expect(flags[flags.indexOf("--persist-to") + 1]).toBe(persistTo);
    const allowed = ["--local", "--json", "--command", ...(persistTo === undefined ? [] : ["--persist-to"])];
    for (let i = 3; i < flags.length; i++) {
      expect(allowed).toContain(flags[i]);
      if (["--command", "--persist-to"].includes(flags[i])) i++;
    }
  }
}

function expectError(run: Run, code: string, stage: string, status: number) {
  expect(run.status).toBe(status);
  const output = objectOutput(run);
  expect(output).toMatchObject({ stage, outcome: "error", error: { code, retryable: false } });
  expect(output.error.next_action).toBeTypeOf("string");
  expect(output.error.next_action.trim().length).toBeGreaterThan(10);
  expect(output.error.next_action).not.toMatch(/^(?:error|failed|try again)[.!]?$/i);
  return output;
}

const INVALID = [
  { args: ["--persist-to="], code: "DB_SEED_INVALID_TARGET" },
  { args: ["--persist-to=   "], code: "DB_SEED_INVALID_TARGET" },
  { args: ["--persist-to=\t\n"], code: "DB_SEED_INVALID_TARGET" },
  { args: ["--persist-to"], code: "DB_SEED_INVALID_TARGET" },
  { args: ["--persist-to=fixture", "--persist-to=fixture"], code: "DB_SEED_DUPLICATE_TARGET" },
  { args: ["--persist-to=fixture-a", "--persist-to=fixture-b"], code: "DB_SEED_DUPLICATE_TARGET" },
  { args: ["--persist-to=fixture", "--persist-to="], code: "DB_SEED_DUPLICATE_TARGET" },
  { args: ["--persist-to=", "--persist-to=fixture"], code: "DB_SEED_DUPLICATE_TARGET" },
  { args: ["--remote"], code: "DB_SEED_REMOTE_FORBIDDEN" },
  { args: ["--persist-to=fixture", "--remote"], code: "DB_SEED_REMOTE_FORBIDDEN" },
  { args: ["--local"], code: "DB_SEED_UNKNOWN_ARGUMENT" },
  { args: ["--typo"], code: "DB_SEED_UNKNOWN_ARGUMENT" },
  { args: ["--command=DELETE FROM customer_snapshot"], code: "DB_SEED_UNKNOWN_ARGUMENT" },
  { args: ["--file=unexpected.sql"], code: "DB_SEED_UNKNOWN_ARGUMENT" },
  { args: ["--database=other"], code: "DB_SEED_UNKNOWN_ARGUMENT" },
];

describe("db:seed fail-closed arguments", () => {
  it.each(INVALID)("rejects $args before executing in human mode", ({ args, code }) => {
    const run = runCli(args);
    expect(run.invocations, "invalid target/flag must never reach a runner").toEqual([]);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(code);
    expect(run.stderr).toMatch(/next.action|npm run|--persist-to|--help/i);
  });

  it.each(INVALID)("rejects $args with a fixed JSON error", ({ args, code }) => {
    const run = runCli(["--json", ...args]);
    expect(run.invocations).toEqual([]);
    const output = expectError(run, code, "arguments", 2);
    expect(output.counts).toEqual({});
  });

  it.each([
    { args: ["--persist-to=", "--json"], code: "DB_SEED_INVALID_TARGET" },
    { args: ["--remote", "--json"], code: "DB_SEED_REMOTE_FORBIDDEN" },
    { args: ["--json", "--", "--command=DELETE FROM customer_snapshot"], code: "DB_SEED_UNKNOWN_ARGUMENT" },
  ])("recognizes JSON regardless of ordering without enabling passthrough: $args", ({ args, code }) => {
    const run = runCli(args);
    expect(run.invocations).toEqual([]);
    expectError(run, code, "arguments", 2);
  });

  it("dry-run does not conceal invalid targets", () => {
    const run = runCli(["--dry-run", "--persist-to=", "--json"]);
    expect(run.invocations).toEqual([]);
    expectError(run, "DB_SEED_INVALID_TARGET", "arguments", 2);
  });
});

describe("db:seed legacy local execution and help", () => {
  it.each([{ args: [] }, { args: ["--persist-to=fixture with spaces"] }, { args: ["--"] }])("preserves human success for $args", ({ args }) => {
    const run = runCli(args);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("db:seed: PASS");
    expect(run.stdout).toContain("re-running is a no-op UPSERT");
    expect(run.stderr).toBe("");
    expect(run.invocations).toHaveLength(4);
    localCalls(run, args[0]?.startsWith("--persist-to=") ? "fixture with spaces" : undefined);
    const sql = run.invocations.map(({ args: argv }) => argv[argv.indexOf("--command") + 1]);
    expect(sql).toEqual([buildSeedStatements().join("; "), ...VERIFY_QUERIES.map(({ sql }) => sql)]);
    const statements = sql[0].split("; ");
    expect(statements).toHaveLength(3);
    for (const [i, statement] of statements.entries()) {
      expect(statement).toContain(`INTO ${TABLES[i]}`);
      expect(statement).toMatch(/ON CONFLICT\(\w+\) DO UPDATE SET/);
      expect(statement).not.toContain("OR REPLACE");
    }
  });

  it.each(["--help", "-h"])("%s stays side-effect-free exit 0", (flag) => {
    const run = runCli([flag]);
    expect(run.status).toBe(0);
    expect(run.invocations).toEqual([]);
    expect(run.stdout).toContain("Usage:");
    expect(run.stderr).toBe("");
  });

  it("help makes planning and JSON discoverable through the existing npm entry", () => {
    const run = runCli(["--help"]);
    expect(run.invocations).toEqual([]);
    expect(run.stdout).toContain("npm run db:seed");
    expect(run.stdout).toContain("--dry-run");
    expect(run.stdout).toContain("--json");
    expect(run.stdout).toContain("schemaVersion");
  });

  it.each(["apply-failure", "verify-failure", "malformed-json", "count-mismatch"])("preserves failure exit 1 for %s", (mode) => {
    const run = runCli([], mode);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("db:seed: PASS");
    expect(run.stderr).toContain("db:seed: FAIL");
    expect(run.invocations).toHaveLength(mode === "apply-failure" ? 1 : 2);
    localCalls(run);
  });
});

describe("db:seed deterministic no-execution plan", () => {
  it.each([undefined, "fixture with spaces"])("emits the versioned local plan for target %j", (persistTo) => {
    const args = ["--dry-run", "--json", ...(persistTo === undefined ? [] : [`--persist-to=${persistTo}`])];
    const first = runCli(args);
    const second = runCli([...args].reverse());
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.invocations).toEqual([]);
    expect(second.invocations).toEqual([]);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    const plan = objectOutput(first);
    expect(plan).toMatchObject({
      stage: "plan", outcome: "planned", target: { persistTo: persistTo ?? null },
      fixtureIds: FIXTURE_IDS, counts: {},
    });
    expect(plan.effects).toHaveLength(3);
    expect(plan.effects).toMatchObject(TABLES.map((table) => ({ id: `upsert:${table}`, table, operation: "upsert" })));
    expect(plan.checks).toHaveLength(3);
    expect(plan.checks).toMatchObject(TABLES.map((table) => ({ id: `count:${table}`, table, expected: 1 })));
    expect(plan.limitations).toEqual(expect.arrayContaining([
      "migrations_not_checked", "row_availability_not_checked",
    ]));
  });

  it("plain dry-run reports intent, not a completed fixture application", () => {
    const run = runCli(["--dry-run"]);
    expect(run.status).toBe(0);
    expect(run.invocations).toEqual([]);
    expect(run.stdout).toMatch(/plan|dry.run/i);
    expect(run.stdout).toContain(DATABASE);
    for (const table of TABLES) expect(run.stdout).toContain(table);
    expect(run.stdout).not.toContain("db:seed: PASS");
    expect(run.stderr).toBe("");
  });
});

describe("db:seed bounded JSON execution", () => {
  it.each(["success", "bare-envelope"])("emits one verified result for %s", (mode) => {
    const run = runCli(["--json", "--persist-to=fixture with spaces"], mode);
    expect(run.status).toBe(0);
    expect(run.invocations).toHaveLength(4);
    localCalls(run, "fixture with spaces");
    const output = objectOutput(run);
    expect(output).toMatchObject({
      stage: "complete", outcome: "success", counts: COUNTS,
      target: { persistTo: "fixture with spaces" },
    });
    expect(output.error).toBeUndefined();
    expect(run.stderr).toBe("");
  });

  it.each([
    { mode: "apply-failure", code: "DB_SEED_APPLY_FAILED", stage: "apply", calls: 1 },
    { mode: "verify-failure", code: "DB_SEED_VERIFY_FAILED", stage: "verify", calls: 2 },
    { mode: "malformed-json", code: "DB_SEED_INVALID_RESULT", stage: "verify", calls: 2 },
    { mode: "wrong-shape", code: "DB_SEED_INVALID_RESULT", stage: "verify", calls: 2 },
    { mode: "missing-count", code: "DB_SEED_INVALID_RESULT", stage: "verify", calls: 2 },
    { mode: "nonnumeric-count", code: "DB_SEED_INVALID_RESULT", stage: "verify", calls: 2 },
    { mode: "extra-row", code: "DB_SEED_INVALID_RESULT", stage: "verify", calls: 2 },
    { mode: "count-mismatch", code: "DB_SEED_COUNT_MISMATCH", stage: "verify", calls: 2 },
  ])("classifies $mode without leaking the child output", ({ mode, code, stage, calls }) => {
    const run = runCli(["--json"], mode);
    expect(run.invocations).toHaveLength(calls);
    localCalls(run);
    const output = expectError(run, code, stage, 1);
    expect(output.counts).toEqual(mode === "count-mismatch" ? { customer_snapshot: 0 } : {});
    expect(run.stderr).toBe("");
  });
});
