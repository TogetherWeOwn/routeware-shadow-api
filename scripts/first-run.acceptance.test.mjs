import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Independent, test-first CLI contract. Run:
 *   node --test scripts/first-run.acceptance.test.mjs
 *
 * Executes the REAL wrapper and libraries in a disposable sandbox, with Node
 * builtin runner/credential/socket/network spies injected before evaluation.
 * No implementation seam/export is required. No real migration, seed, server,
 * child runner, credential file or network request can execute, even on RED.
 * The sole real child is the sandboxed Node interpreter; it inherits NO env.
 *
 * Consumer schema pinned here (not an internal implementation prescription):
 *   schemaVersion: 1, command: "first-run", mode: "dry-run" | "run",
 *   outcome: "planned" | "success" | "error" | "interrupted",
 *   steps: [{ id, outcome, ... }], failed: [id], skipped: [id],
 *   error: null | { code, retryable: false, next_action: nonempty string },
 *   next_action: null | nonempty string. Failed/interrupted steps are not passed.
 * Plans add commands/effects per step (literal local-only intent below); no
 * credential observation or runtime proof is necessary to construct a plan.
 * --dry-run alone also emits the plan. --help/-h wins anywhere, as before.
 * JSON is one document <=16 KiB, empty stderr; no raw child/error text.
 * Exit 0 = success/plan/help, 2 = bad arguments, 1 = ordinary failure;
 * interruption exits nonzero. Fixed error codes below are the public API.
 *
 * Protect both this test and test/fixtures/first-run-sandbox.mjs at handoff.
 * Builder wires this suite into test:probe; test-only handoff does not change
 * package.json, CI, README, source files, or the existing regression suites.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
const suiteDir = mkdtempSync(path.join(scratch, "first-run-acceptance-"));
after(() => rmSync(suiteDir, { recursive: true, force: true }));
const IDS = ["devvars", "migrate", "seed", "smoke"];
const CANARY = "SYNTHETIC_FIRST_RUN_PRIVATE_CANARY";
const TOKEN = "SYNTHETIC_FIRST_RUN_TOKEN_NOT_A_CREDENTIAL";
const PORT = 18791;
const PID = 424242;
const MAX_JSON_BYTES = 16 * 1024;
const PLAN_STEPS = [
  { id: "devvars", outcome: "planned", commands: [["node", "scripts/check-devvars.mjs"]], effects: ["read_local_credentials", "spawn_local_check"] },
  { id: "migrate", outcome: "planned", commands: [["npm", "run", "db:migrate:local"]], effects: ["spawn_local_migration", "write_local_database"] },
  { id: "seed", outcome: "planned", commands: [["npm", "run", "db:seed"]], effects: ["spawn_local_seed", "write_local_database"] },
  { id: "smoke", outcome: "planned", commands: [
    ["node", "node_modules/wrangler/bin/wrangler.js", "dev", "--ip", "127.0.0.1", "--port", "<ephemeral>", "--show-interactive-dev-session=false"],
    ["node", "scripts/smoke-readiness.mjs"],
  ], effects: ["read_local_credentials", "start_loopback_server", "request_loopback_health", "run_local_smoke", "stop_process_group"] },
];

function tree(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const filename = path.join(dir, entry.name);
    return [entry.name, entry.isDirectory() ? tree(filename) : readFileSync(filename).toString("base64")];
  });
}

function run(args, scenario = "success", { preflight = false, entry } = {}) {
  const dir = mkdtempSync(path.join(suiteDir, "case-"));
  const workspace = path.join(dir, "workspace");
  mkdirSync(workspace);
  // A full script/library copy lets the Builder split modules without changing
  // this test; there is deliberately no node_modules, real state or .dev.vars.
  cpSync(path.join(ROOT, "scripts"), path.join(workspace, "scripts"), { recursive: true, filter: (name) => !name.endsWith(".test.mjs") });
  cpSync(path.join(ROOT, "package.json"), path.join(workspace, "package.json"));
  for (const name of ["home", "tmp", "empty-bin"]) mkdirSync(path.join(workspace, name));
  const traceFile = path.join(dir, "trace.jsonl");
  writeFileSync(traceFile, "");
  const entryFile = entry ? path.join(workspace, "sandbox-control.mjs") : path.join(workspace, "scripts/first-run.mjs");
  if (entry) writeFileSync(entryFile, entry);
  const before = tree(workspace);
  const result = spawnSync(process.execPath, [
    "--import", path.join(ROOT, "test/fixtures/first-run-sandbox.mjs"), entryFile, ...args,
  ], {
    cwd: workspace, encoding: "utf8", timeout: 8000, maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: path.join(workspace, "empty-bin"), HOME: path.join(workspace, "home"), TMPDIR: path.join(workspace, "tmp"),
      FIRST_RUN_TEST_SCENARIO: scenario, FIRST_RUN_TEST_TRACE: traceFile, FIRST_RUN_TEST_PREFLIGHT: preflight ? "1" : "0",
      SHADOW_API_TOKEN: TOKEN, CUSTOMER_SNAPSHOT_SYNC_SECRET: TOKEN, LOGIN_PASSWORD: CANARY,
      SHADOW_API_BASE: "https://upstream.invalid", // must never override the local smoke target
      CLOUDFLARE_API_TOKEN: TOKEN, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1",
    },
  });
  assert.ifError(result.error, "sandbox must finish; a timeout/import/harness error is NOT feature RED");
  assert.equal(result.signal, null, "sandbox must produce its own CLI exit, not be killed by the harness");
  assert.deepEqual(tree(workspace), before, "the CLI must not mutate the sandbox filesystem");
  const trace = readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(trace.at(-1)?.kind, "sandbox_exit", `preload must be active through CLI exit: ${result.stderr.slice(0, 2000)}`);
  const forbidden = trace.filter((event) => ["state_write", "unexpected_network", "unexpected_subprocess", "unexpected_subprocess_api", "unexpected_process_signal", "unexpected_credential_api"].includes(event.kind));
  if (!entry) assert.deepEqual(forbidden, [], "no unsupported runner, real network, filesystem write or non-sandbox process signal");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, trace, calls: trace.filter((event) => event.kind === "subprocess") };
}

function zeroEffects(result) {
  assert.deepEqual(result.trace.filter((event) => event.kind !== "sandbox_exit"), [], "parse/help/plan must precede ALL credential reads, runners, server allocation, writes and network");
}
function secretFree(result) {
  for (const marker of [CANARY, TOKEN, "Authorization: Bearer", "password=synthetic", "raw child output", "wrangler dev output (tail)", "Error:", "at runStep"]) {
    assert.ok(!(result.stdout + result.stderr).includes(marker), `public output leaked ${marker}`);
  }
}
function json(result, mode = "run") {
  assert.equal(result.stderr, "", "JSON mode must not emit a second, unstructured error stream");
  assert.ok(Buffer.byteLength(result.stdout) <= MAX_JSON_BYTES, "one bounded JSON document, not a child-output capture");
  secretFree(result);
  assert.match(result.stdout.trim(), /^\{/, "stdout must start with a JSON object, not human headers/child output");
  // Parsing ALL stdout catches extra objects, log prefixes and Wrangler tails.
  const value = JSON.parse(result.stdout);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.command, "first-run");
  assert.equal(value.mode, mode);
  assert.deepEqual(value.steps.map((step) => step.id), IDS);
  assert.ok(Array.isArray(value.failed));
  assert.ok(Array.isArray(value.skipped));
  assert.ok(Object.hasOwn(value, "error"));
  assert.ok(Object.hasOwn(value, "next_action"));
  for (const call of result.calls) {
    const stdio = Array.isArray(call.stdio) ? call.stdio.slice(1) : [call.stdio];
    assert.ok(!stdio.some((mode) => mode === "inherit" || mode === 1 || mode === 2), `${call.stage}: JSON child output must never be inherited`);
  }
  return value;
}
function remediation(value, code) {
  assert.equal(value.error?.code, code);
  assert.equal(value.error?.retryable, false);
  assert.equal(typeof value.error?.next_action, "string");
  assert.ok(value.error.next_action.trim().length > 0 && value.error.next_action.length <= 512);
  assert.equal(value.next_action, value.error.next_action);
}
function failure(result, id, code = "FIRST_RUN_STEP_FAILED") {
  assert.equal(result.status, 1);
  const value = json(result);
  assert.equal(value.outcome, "error");
  const index = IDS.indexOf(id);
  assert.deepEqual(value.steps.map((step) => step.outcome), IDS.map((_, i) => i < index ? "passed" : i === index ? "failed" : "skipped"));
  assert.deepEqual(value.failed, [id]);
  assert.deepEqual(value.skipped, IDS.slice(index + 1));
  remediation(value, code);
  return value;
}
function localOnly(result) {
  for (const call of result.calls) {
    assert.equal(call.shell, false, "no shell interpolation");
    assert.ok(!call.args.includes("--remote"));
    assert.ok(!call.args.includes("db:migrate:remote"));
    assert.ok(!call.args.some((arg) => /https?:\/\//.test(arg)), "targets belong in controlled loopback wiring, not arbitrary runner URLs");
  }
  const server = result.calls.find((call) => call.stage === "server");
  assert.ok(server, "smoke must start its local dev server");
  assert.equal(server.detached, true, "Wrangler/workerd must have a process group");
  assert.deepEqual(server.args.slice(1), ["dev", "--ip", "127.0.0.1", "--port", String(PORT), "--show-interactive-dev-session=false"]);
  const smoke = result.calls.find((call) => call.stage === "smoke");
  if (smoke) {
    assert.equal(smoke.baseUrl, `http://127.0.0.1:${PORT}`);
    assert.equal(smoke.syntheticToken, true, "smoke receives only the injected local token");
  }
  for (const event of result.trace.filter((event) => event.kind === "fetch")) assert.equal(event.url, `http://127.0.0.1:${PORT}/api/v1/health`);
  const signals = result.trace.filter((event) => event.kind === "group_signal" && event.signal !== 0);
  assert.ok(signals.some((event) => event.signal === "SIGTERM"));
  assert.ok(signals.every((event) => event.pid === -PID), "kill the process GROUP, not only Wrangler's wrapper");
}

// The sandbox controls independently prove injections are active, rather than
// letting an absent preload turn a test into a live first-run invocation.
describe("sandbox controls", () => {
  test("named/default imports cannot reach credentials, writes or network", () => {
    const result = run([], "success", { preflight: true, entry: `
      import fs, { readFileSync, writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { request } from 'node:https';
      for (const action of [() => readFileSync('.dev.vars'), () => fs.readFileSync('.env'),
        () => process.env.LOGIN_PASSWORD, () => writeFileSync('state', 'bad'),
        () => request('https://upstream.invalid'), () => fetch('https://upstream.invalid')]) {
        try { await action(); } catch {}
      }
      const child = spawnSync('npm', ['run', 'db:migrate:local'], { stdio: 'ignore' });
      if (child.status !== 17) process.exit(99);
    ` });
    assert.equal(result.status, 0);
    for (const kind of ["preflight_credential_file", "credential_env", "state_write", "unexpected_network", "subprocess"]) {
      assert.ok(result.trace.some((event) => event.kind === kind), `sandbox control must record ${kind}`);
    }
  });
});

// Unknown/duplicate/malformed argv must not silently become a normal run.
const BAD_ARGS = [
  ["--unknown"], ["--remote"], ["--command=echo-unsafe"], ["--path=./somewhere"],
  ["--url=https://upstream.invalid"], ["--database=other"], ["--persist-to=./other"],
  ["--json", "--json"], ["--dry-run", "--dry-run"], ["--json=true"],
  ["--dry-run=false"], ["--help=false"], ["--json", "value"], ["--dry-run", "value"],
  ["--"], ["positional"], ["-j"], ["--json\n--remote"], ["--unknown=" + CANARY],
];
describe("argument validation before effects", () => {
  for (const args of BAD_ARGS) {
    for (const prefix of [[], ["--json"], ["--json", "--dry-run"]]) {
      const argv = [...prefix, ...args];
      const jsonMode = argv.includes("--json");
      test(`rejects ${JSON.stringify(argv)} without effects`, () => {
        const result = run(argv, "success", { preflight: true });
        zeroEffects(result);
        assert.equal(result.status, 2);
        secretFree(result);
        if (jsonMode || args.includes("--json")) {
          const value = json(result);
          assert.equal(value.outcome, "error");
          assert.deepEqual(value.steps.map((step) => step.outcome), IDS.map(() => "skipped"));
          assert.deepEqual(value.failed, []);
          assert.deepEqual(value.skipped, IDS);
          remediation(value, "FIRST_RUN_INVALID_ARGUMENT");
        } else {
          assert.equal(result.stdout, "");
          assert.match(result.stderr, /first-run/);
          assert.match(result.stderr, /--help/);
        }
      });
    }
  }
  for (const args of [["--help"], ["-h"], ["--json", "--help", "--remote"], ["--remote", "-h", "--json", "--json"], ["--dry-run", "--help"]]) {
    test(`preserves early help precedence for ${JSON.stringify(args)}`, () => {
      const result = run(args, "success", { preflight: true });
      zeroEffects(result);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /Usage:.*first-run\.mjs/);
    });
  }
});

describe("no-execution plans", () => {
  for (const args of [["--dry-run"], ["--json", "--dry-run"], ["--dry-run", "--json"]]) {
    test(`${args.join(" ")} plans each local effect without claiming verification`, () => {
      const result = run(args, "missing-credentials", { preflight: true });
      zeroEffects(result);
      assert.equal(result.status, 0);
      const value = json(result, "dry-run");
      assert.equal(value.outcome, "planned");
      assert.deepEqual(value.steps, PLAN_STEPS);
      assert.deepEqual(value.failed, []);
      assert.deepEqual(value.skipped, []);
      assert.equal(value.error, null);
      assert.equal(value.next_action, null);
      assert.doesNotMatch(result.stdout, /"(?:passed|verified|success)"/);
    });
  }
  test("argument order, environment and fresh sandbox paths do not change plan bytes", () => {
    const first = run(["--json", "--dry-run"], "success", { preflight: true });
    const second = run(["--dry-run", "--json"], "missing-credentials", { preflight: true });
    zeroEffects(first);
    zeroEffects(second);
    json(first, "dry-run");
    json(second, "dry-run");
    assert.equal(first.stdout, second.stdout);
  });
});

describe("JSON execution", () => {
  test("success is one bounded document after every step AND process group stop", () => {
    const result = run(["--json"]);
    assert.equal(result.status, 0);
    const value = json(result);
    assert.equal(value.outcome, "success");
    assert.deepEqual(value.steps.map((step) => step.outcome), IDS.map(() => "passed"));
    assert.deepEqual(value.failed, []);
    assert.deepEqual(value.skipped, []);
    assert.equal(value.error, null);
    assert.equal(value.next_action, null);
    assert.deepEqual(result.calls.map((call) => call.stage), ["devvars", "migrate", "seed", "server", "smoke"]);
    localOnly(result);
    assert.equal(result.trace.at(-1).groupAlive, false);
  });
  for (const [index, id] of IDS.entries()) {
    test(`${id} failure stops the chain and names every skipped step`, () => {
      const result = run(["--json"], `fail-${id}`);
      failure(result, id);
      assert.deepEqual(result.calls.map((call) => call.stage), [...IDS.slice(0, index), ...(id === "smoke" ? ["server", "smoke"] : [id])]);
      assert.equal(result.trace.at(-1).groupAlive, false);
    });
    test(`${id} spawn exception is sanitized and cannot mark a step passed`, () => {
      const result = run(["--json"], `throw-${id}`);
      failure(result, id, "FIRST_RUN_SPAWN_FAILED");
      assert.equal(result.trace.at(-1).groupAlive, false);
    });
  }
  for (const stage of ["devvars", "migrate", "seed", "server", "smoke"]) {
    test(`${stage} spawn error status/event has a fixed code and no raw exception`, () => {
      const result = run(["--json"], `error-${stage}`);
      failure(result, stage === "server" ? "smoke" : stage, "FIRST_RUN_SPAWN_FAILED");
      assert.equal(result.trace.at(-1).groupAlive, false);
    });
  }
  test("a dev-server spawn exception fails smoke without starting its probe", () => {
    const result = run(["--json"], "throw-server");
    failure(result, "smoke", "FIRST_RUN_SPAWN_FAILED");
    assert.ok(!result.calls.some((call) => call.stage === "smoke"));
    assert.equal(result.trace.at(-1).groupAlive, false);
  });
  test("large secret-like child captures stay internal and do not expand the document", () => {
    const result = run(["--json"], "flood");
    assert.equal(result.status, 0);
    assert.equal(json(result).outcome, "success");
  });
  for (const scenario of ["unhealthy", "not-ready", "health-throws"]) {
    test(`${scenario} fails smoke without exposing Wrangler tails and still tears down`, () => {
      const result = run(["--json"], scenario);
      failure(result, "smoke", "FIRST_RUN_HEALTH_FAILED");
      assert.ok(!result.calls.some((call) => call.stage === "smoke"));
      localOnly(result);
      assert.equal(result.trace.at(-1).groupAlive, false);
    });
  }
  for (const id of ["devvars", "migrate", "seed", "smoke"]) {
    test(`a signal-terminated ${id} child is not successful`, () => {
      const result = run(["--json"], `signal-${id}`);
      failure(result, id);
      assert.equal(result.trace.at(-1).groupAlive, false);
    });
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    test(`${signal} interrupts, stops the entire fake group, and never reports success`, () => {
      const result = run(["--json"], `interrupt-${signal}`);
      assert.notEqual(result.status, 0);
      const value = json(result);
      assert.equal(value.outcome, "interrupted");
      assert.notEqual(value.steps[3].outcome, "passed");
      assert.deepEqual(value.failed, ["smoke"]);
      remediation(value, "FIRST_RUN_INTERRUPTED");
      localOnly(result);
      assert.equal(result.trace.at(-1).groupAlive, false);
    });
  }
  test("an interruption racing a successful smoke result still cannot report success", () => {
    const result = run(["--json"], "interrupt-during-smoke");
    assert.notEqual(result.status, 0);
    const value = json(result);
    assert.equal(value.outcome, "interrupted");
    remediation(value, "FIRST_RUN_INTERRUPTED");
    assert.equal(result.trace.at(-1).groupAlive, false);
  });
  test("a group that needs SIGKILL is killed before success is emitted", () => {
    const result = run(["--json"], "needs-kill");
    assert.equal(result.status, 0);
    assert.equal(json(result).outcome, "success");
    assert.ok(result.trace.some((event) => event.kind === "group_signal" && event.pid === -PID && event.signal === "SIGKILL"));
    assert.equal(result.trace.at(-1).groupAlive, false);
  });
  for (const scenario of ["teardown-failure", "group-survives-port-closed", "interrupt-teardown-failure"]) {
    test(`${scenario}: no success when teardown is incomplete, even if the port is free`, () => {
      const result = run(["--json"], scenario);
      assert.notEqual(result.status, 0);
      const value = json(result);
      assert.ok(["error", "interrupted"].includes(value.outcome));
      assert.notEqual(value.steps[3].outcome, "passed");
      assert.deepEqual(value.failed, ["smoke"]);
      remediation(value, "FIRST_RUN_TEARDOWN_FAILED");
      assert.equal(result.trace.at(-1).groupAlive, true, "fixture must really represent an unconfirmed group stop");
    });
  }
});

describe("unchanged human-mode runner controls", () => {
  test("no flags preserves ordered execution, local wiring and the legacy PASS summary", () => {
    const result = run([]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls.map((call) => call.stage), ["devvars", "migrate", "seed", "server", "smoke"]);
    assert.match(result.stdout, /first-run: PASS — 4\/4 steps green \(devvars, migrate, seed, smoke\)/);
    localOnly(result);
    assert.equal(result.trace.at(-1).groupAlive, false);
  });
  for (const [index, id] of IDS.entries()) {
    test(`no flags remains fail-fast at ${id}`, () => {
      const result = run([], `fail-${id}`);
      assert.equal(result.status, 1);
      assert.match(result.stdout, new RegExp(`first-run: FAIL at ${id}`));
      assert.deepEqual(result.calls.map((call) => call.stage), [...IDS.slice(0, index), ...(id === "smoke" ? ["server", "smoke"] : [id])]);
      assert.equal(result.trace.at(-1).groupAlive, false);
    });
  }
  test("no flags retains interruption cleanup and a nonzero exit", () => {
    const result = run([], "interrupt-SIGINT");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /first-run: interrupted/);
    assert.equal(result.trace.at(-1).groupAlive, false);
  });
});

describe("agent discovery examples", () => {
  test("help exposes a runnable safe plan that agrees with its declared flags and step IDs", () => {
    const help = run(["--help"], "success", { preflight: true });
    zeroEffects(help);
    assert.match(help.stdout, /--json/);
    assert.match(help.stdout, /--dry-run/);
    for (const id of IDS) assert.match(help.stdout, new RegExp(`\\b${id}\\b`));
    assert.match(help.stdout, /schemaVersion/);
    assert.match(help.stdout, /next_action/);
    const example = help.stdout.match(/(?:node scripts\/first-run\.mjs|npm run (?:--silent )?first-run --)\s+((?:--(?:json|dry-run)(?:[ \t]+|$))+)/m);
    assert.ok(example, "help needs a runnable composable no-execution example");
    const args = example[1].trim().split(/\s+/);
    assert.deepEqual([...args].sort(), ["--dry-run", "--json"]);
    const result = run(args, "success", { preflight: true });
    zeroEffects(result);
    assert.equal(json(result, "dry-run").outcome, "planned");
  });
  test("README synthetic first-run JSON example parses and matches the runnable plan", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    const examples = [...readme.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((match) => match[1]).filter((text) => text.includes('"first-run"'));
    assert.equal(examples.length, 1, "README first-run entry needs one executable-schema JSON example");
    const example = JSON.parse(examples[0]);
    const command = readme.match(/(?:node scripts\/first-run\.mjs|npm run (?:--silent )?first-run --)\s+((?:--(?:json|dry-run)(?:[ \t]+|$))+)/m);
    assert.ok(command, "README must give an executable safe-plan command, not just an output object");
    const args = command[1].trim().split(/\s+/);
    assert.deepEqual([...args].sort(), ["--dry-run", "--json"]);
    const result = run(args, "missing-credentials", { preflight: true });
    zeroEffects(result);
    const actual = json(result, "dry-run");
    assert.deepEqual(example, actual, "the agent-facing example must not drift from the safe plan");
  });
});
