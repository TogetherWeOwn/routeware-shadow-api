import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Acceptance contract (CLI/process half) for `verify:config --json`,
 * `--dry-run` and the per-leg timeout. The pure-result half is
 * `test/verifyConfigJson.test.ts`; see its header for the shared contract.
 *
 * Hermetic: the CLI orchestration is driven through INJECTED FAKE RUNNERS;
 * the real script is only ever spawned for argv that must spawn NO child
 * (--help, --dry-run, rejected flags), with a preload that records any
 * child_process call. No .dev.vars, no network, no remote D1 compare, no
 * real secrets.
 *
 * Additional contract pinned here:
 *   scripts/lib/verifyConfig.mjs
 *     runCli(args, { runner, stdout, stderr, timeoutMs? }) -> Promise<exitCode>
 *       stdout/stderr are (text) => void writers; exit codes: 0 all green /
 *       dry-run / valid, 1 any leg not passed, 2 rejected arguments.
 *       Runner ctx.stdio is "inherit" in human mode, "ignore" with --json.
 *       Human mode prints `--- <id> ---` BEFORE each leg and the existing
 *       summary line after (unchanged behavior). --json prints exactly one
 *       single-line JSON object + "\n" on stdout and nothing else.
 *       Rejected args with --json: one JSON object
 *       { schemaVersion: 1, command: "verify:config", ok: false,
 *         errorCode: "unsupported_flag", nextAction: <string> } and exit 2;
 *       without --json: nothing on stdout, a message naming `verify:config`
 *       and `--help` on stderr. Argument text is never echoed.
 *   scripts/lib/verifyConfigRunner.mjs
 *     createSpawnRunner({ cwd }) -> runner (see the vitest header). Kills the
 *     child when ctx.signal aborts; stdio "ignore" keeps child output away
 *     from the parent's stdout/stderr.
 *   package.json scripts verify:config:json / verify:config:dry-run, a short
 *   CONTRIBUTING section, and `verify-config.mjs --help` documenting the
 *   schema, flags, exit codes and the timeout.
 */

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const root = path.join(scriptsDir, "..");
const scriptPath = path.join(scriptsDir, "verify-config.mjs");
const libUrl = new URL("./lib/verifyConfig.mjs", import.meta.url).href;
const runnerPath = path.join(scriptsDir, "lib", "verifyConfigRunner.mjs");

const CANARY = "CANARY-secret-7f3a9c1e";
const CANARY_TOKEN = `token=${CANARY}`;
const IDS = ["check:devvars", "check:vars-parity", "check:d1-drift"];

const lib = await import(libUrl);

function need(name) {
  assert.equal(
    typeof lib[name],
    "function",
    `scripts/lib/verifyConfig.mjs must export function \`${name}\` (see the contract in scripts/verify-config-json.test.mjs)`,
  );
  return lib[name];
}

const neverSettles = () => new Promise(() => {});

/** Drive runCli with fakes; `events` interleaves writer output and runner calls in order. */
async function drive(args, behaviors = {}, { timeoutMs } = {}) {
  const runCli = need("runCli");
  const events = [];
  const out = [];
  const err = [];
  const ctxs = [];
  const runner = async (check, ctx) => {
    events.push(`run:${check.name}`);
    ctxs.push({ name: check.name, stdio: ctx.stdio });
    const behavior = behaviors[check.name];
    return behavior ? behavior(check, ctx) : { exitCode: 0 };
  };
  const options = {
    runner,
    stdout: (text) => {
      out.push(text);
      events.push(`out:${text}`);
    },
    stderr: (text) => err.push(text),
  };
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  const exitCode = await runCli(args, options);
  return { exitCode, stdout: out.join(""), stderr: err.join(""), events, ctxs };
}

function singleJson(stdout) {
  assert.ok(stdout.endsWith("\n"), "JSON stdout must end with a newline");
  const lines = stdout.slice(0, -1).split("\n");
  assert.equal(lines.length, 1, `stdout must be exactly one single-line JSON object, got ${lines.length} lines`);
  const parsed = JSON.parse(lines[0]);
  assert.equal(lines[0], JSON.stringify(parsed), "stdout must be compact JSON");
  return parsed;
}

describe("runCli: human mode keeps today's behavior", () => {
  test("all green: headers before each leg, unchanged summary, exit 0, inherited stdio", async () => {
    const result = await drive([]);
    assert.equal(result.exitCode, 0);
    assert.equal(
      result.stdout,
      [
        "--- check:devvars ---",
        "--- check:vars-parity ---",
        "--- check:d1-drift ---",
        "",
        "verify:config: PASS — 3/3 checks green (check:devvars, check:vars-parity, check:d1-drift)",
        "",
      ].join("\n"),
    );
    assert.deepEqual(result.events, [
      "out:--- check:devvars ---\n",
      "run:check:devvars",
      "out:--- check:vars-parity ---\n",
      "run:check:vars-parity",
      "out:--- check:d1-drift ---\n",
      "run:check:d1-drift",
      `out:\nverify:config: PASS — 3/3 checks green (check:devvars, check:vars-parity, check:d1-drift)\n`,
    ]);
    assert.deepEqual(
      result.ctxs.map((c) => c.stdio),
      ["inherit", "inherit", "inherit"],
    );
    assert.equal(result.stderr, "");
  });

  test("a failed leg: exit 1, the later legs still run, summary names only the failed check", async () => {
    const result = await drive([], { "check:vars-parity": async () => ({ exitCode: 1 }) });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(
      result.ctxs.map((c) => c.name),
      IDS,
    );
    assert.ok(
      result.stdout.endsWith(
        "\nverify:config: FAIL — check:vars-parity (rerun the failed check directly for detail: `npm run check:vars-parity`)\n",
      ),
    );
  });

  test("a timed-out or spawn-failed leg is a failed leg in human mode too, bounded and secret-free", async () => {
    const result = await drive(
      [],
      {
        "check:devvars": neverSettles,
        "check:vars-parity": async () => {
          throw new Error(`spawn failed ${CANARY_TOKEN}`);
        },
      },
      { timeoutMs: 25 },
    );
    assert.equal(result.exitCode, 1);
    assert.deepEqual(
      result.ctxs.map((c) => c.name),
      IDS,
    );
    assert.ok(result.stdout.includes("verify:config: FAIL — check:devvars, check:vars-parity "));
    assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY));
  });
});

describe("runCli --json", () => {
  test("all green: exactly one versioned object, deterministic order, ignored child stdio, exit 0", async () => {
    const result = await drive(["--json"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(singleJson(result.stdout), {
      schemaVersion: 1,
      command: "verify:config",
      mode: "run",
      ok: true,
      timeoutMs: lib.CHECK_TIMEOUT_MS,
      checks: IDS.map((id) => ({ id, outcome: "passed", errorCode: null, nextAction: null, exitCode: 0 })),
    });
    assert.ok(!result.stdout.includes("---"), "no human headers in --json output");
    assert.deepEqual(
      result.ctxs.map((c) => c.stdio),
      ["ignore", "ignore", "ignore"],
    );
  });

  test("mixed failure: nonzero_exit + timeout + spawn_error, remaining legs collected, exit 1", async () => {
    const result = await drive(
      ["--json"],
      {
        "check:devvars": async () => ({ exitCode: 2 }),
        "check:vars-parity": neverSettles,
        "check:d1-drift": async () => {
          throw new Error("spawn node ENOENT");
        },
      },
      { timeoutMs: 25 },
    );
    assert.equal(result.exitCode, 1);
    const parsed = singleJson(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.timeoutMs, 25);
    assert.deepEqual(
      parsed.checks.map((c) => [c.id, c.outcome, c.errorCode, c.exitCode]),
      [
        ["check:devvars", "nonzero_exit", "check_nonzero_exit", 2],
        ["check:vars-parity", "timeout", "check_timeout", null],
        ["check:d1-drift", "spawn_error", "check_spawn_error", null],
      ],
    );
    for (const leg of parsed.checks) assert.equal(typeof leg.nextAction, "string");
    assert.deepEqual(
      result.ctxs.map((c) => c.name),
      IDS,
    );
  });

  test("a hung first leg cannot hold the run hostage: whole run finishes within a few budgets", async () => {
    const started = Date.now();
    const result = await drive(["--json"], { "check:devvars": neverSettles }, { timeoutMs: 40 });
    assert.ok(Date.now() - started < 5_000);
    assert.equal(singleJson(result.stdout).checks[0].outcome, "timeout");
    assert.equal(singleJson(result.stdout).checks[2].outcome, "passed");
  });

  test("secret-shaped child text, exceptions and env never reach stdout, stderr or the JSON", async () => {
    const previous = process.env.VERIFY_CONFIG_TEST_SECRET;
    process.env.VERIFY_CONFIG_TEST_SECRET = CANARY;
    try {
      for (const args of [["--json"], []]) {
        const result = await drive(
          args,
          {
            "check:devvars": async () => ({ exitCode: 1, stdout: CANARY_TOKEN, stderr: `Bearer ${CANARY}` }),
            "check:vars-parity": async () => {
              throw Object.assign(new Error(`leaked ${CANARY_TOKEN}`), { code: CANARY });
            },
          },
          { timeoutMs: 25 },
        );
        assert.equal(result.exitCode, 1);
        assert.ok(!result.stdout.includes(CANARY), `canary leaked to stdout for ${JSON.stringify(args)}`);
        assert.ok(!result.stderr.includes(CANARY), `canary leaked to stderr for ${JSON.stringify(args)}`);
        assert.ok(!/Bearer|token=/.test(result.stdout + result.stderr));
      }
    } finally {
      if (previous === undefined) delete process.env.VERIFY_CONFIG_TEST_SECRET;
      else process.env.VERIFY_CONFIG_TEST_SECRET = previous;
    }
  });
});

describe("runCli --dry-run", () => {
  test("--dry-run --json: exact plan, zero runner calls, exit 0, idempotent", async () => {
    const first = await drive(["--dry-run", "--json"]);
    const second = await drive(["--json", "--dry-run"]);
    assert.equal(first.exitCode, 0);
    assert.deepEqual(first.events, [`out:${first.stdout}`], "dry-run must write once and call no runner");
    assert.deepEqual(first.ctxs, []);
    assert.deepEqual(singleJson(first.stdout), {
      schemaVersion: 1,
      command: "verify:config",
      mode: "dry-run",
      ok: true,
      timeoutMs: lib.CHECK_TIMEOUT_MS,
      checks: lib.CHECKS.map((c) => ({ id: c.name, script: c.script, args: c.args })),
    });
    assert.equal(second.stdout, first.stdout);
  });

  test("--dry-run (human): lists every leg and its script in order, spawns nothing, exit 0", async () => {
    const result = await drive(["--dry-run"]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.ctxs, []);
    let cursor = 0;
    for (const check of lib.CHECKS) {
      const at = result.stdout.indexOf(check.name, cursor);
      assert.ok(at >= cursor, `plan must list ${check.name} in CHECKS order`);
      assert.ok(result.stdout.includes(check.script), `plan must show ${check.script}`);
      cursor = at;
    }
    assert.ok(!/PASS|FAIL/.test(result.stdout), "a plan is not a verdict");
  });
});

describe("runCli rejects unsupported arguments before execution", () => {
  const BAD = [
    ["--remote"],
    [`--remote=https://x.invalid/${CANARY}`],
    ["--json", "--remote"],
    ["--dry-run", "--target", "https://x.invalid"],
    ["--check", "check:devvars"],
    ["--bogus"],
    ["positional"],
    ["--json=true"],
  ];

  for (const args of BAD) {
    test(`human: ${JSON.stringify(args)} -> exit 2, stdout empty, no runner call`, async () => {
      const result = await drive(args.filter((a) => a !== "--json"));
      assert.equal(result.exitCode, 2);
      assert.equal(result.stdout, "");
      assert.deepEqual(result.ctxs, []);
      assert.match(result.stderr, /verify:config/);
      assert.match(result.stderr, /--help/);
      assert.ok(!result.stderr.includes(CANARY), "argument text must not be echoed");
    });

    test(`json: ${JSON.stringify(args)} -> exit 2, one JSON error object, no runner call`, async () => {
      const result = await drive(["--json", ...args.filter((a) => a !== "--json")]);
      assert.equal(result.exitCode, 2);
      assert.deepEqual(result.ctxs, []);
      const parsed = singleJson(result.stdout);
      assert.deepEqual(Object.keys(parsed).sort(), ["command", "errorCode", "nextAction", "ok", "schemaVersion"]);
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.command, "verify:config");
      assert.equal(parsed.ok, false);
      assert.equal(parsed.errorCode, "unsupported_flag");
      assert.equal(typeof parsed.nextAction, "string");
      assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY));
    });
  }
});

// --- real script: spawns NO child, proven by a child_process recording preload ---

const scratch = mkdtempSync(path.join(tmpdir(), "verify-config-json-"));
const spawnLog = path.join(scratch, "spawn.log");
const preload = path.join(scratch, "record-spawns.mjs");
writeFileSync(
  preload,
  [
    'import { createRequire, syncBuiltinESMExports } from "node:module";',
    'import { appendFileSync } from "node:fs";',
    "const require = createRequire(import.meta.url);",
    'const cp = require("node:child_process");',
    'for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {',
    "  const original = cp[name];",
    "  cp[name] = function (...args) {",
    "    appendFileSync(process.env.VERIFY_CONFIG_SPAWN_LOG, `${name}\\n`);",
    "    return original.apply(this, args);",
    "  };",
    "}",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"),
);

function guardedEnv() {
  return {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim(),
    VERIFY_CONFIG_SPAWN_LOG: spawnLog,
  };
}

function spawnedCalls() {
  return existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean) : [];
}

function runScript(args) {
  writeFileSync(spawnLog, "");
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: scratch,
    encoding: "utf8",
    env: guardedEnv(),
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, spawned: spawnedCalls() };
}

describe("real script: zero-spawn paths", () => {
  test("control: the recording preload does observe a child_process call", () => {
    writeFileSync(spawnLog, "");
    const probe = path.join(scratch, "probe.mjs");
    writeFileSync(
      probe,
      'import { execFileSync } from "node:child_process";\nexecFileSync(process.execPath, ["-e", "0"]);\n',
    );
    const result = spawnSync(process.execPath, [probe], { env: guardedEnv(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(spawnedCalls().includes("execFileSync"), "preload must record execFileSync");
  });

  test("--dry-run --json prints the exact plan and spawns nothing; repeat runs are identical", () => {
    const a = runScript(["--dry-run", "--json"]);
    const b = runScript(["--dry-run", "--json"]);
    assert.equal(a.status, 0, a.stderr);
    assert.deepEqual(a.spawned, []);
    assert.deepEqual(b.spawned, []);
    assert.equal(a.stdout, b.stdout);
    assert.deepEqual(singleJson(a.stdout), need("buildDryRunResult")());
    assert.deepEqual(
      singleJson(a.stdout).checks.map((c) => c.id),
      IDS,
    );
  });

  test("--dry-run (human) spawns nothing and exits 0", () => {
    const result = runScript(["--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.spawned, []);
    for (const id of IDS) assert.ok(result.stdout.includes(id));
  });

  for (const args of [["--remote"], [`--remote=${CANARY_TOKEN}`], ["--json", "--bogus"], ["--dry-run", "extra"]]) {
    test(`rejects ${JSON.stringify(args.map((a) => a.replace(CANARY, "<canary>")))}: exit 2, nothing spawned, no echo`, () => {
      const result = runScript(args);
      assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(result.spawned, []);
      assert.ok(!(result.stdout + result.stderr).includes(CANARY));
      if (args.includes("--json")) assert.equal(singleJson(result.stdout).errorCode, "unsupported_flag");
      else assert.equal(result.stdout, "");
    });
  }

  for (const args of [["--help"], ["-h"], ["--help", "--json"], ["--dry-run", "--help"], ["--bogus", "--help"]]) {
    test(`${JSON.stringify(args)} is side-effect free: usage on stdout, exit 0, nothing spawned`, () => {
      const result = runScript(args);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.spawned, []);
      assert.match(result.stdout, /^Usage:/);
    });
  }
});

describe("real script: --help documents the contract", () => {
  const help = () => runScript(["--help"]).stdout;

  test("names both flags, the schema, outcomes, error codes, exit codes and the timeout", () => {
    const text = help();
    for (const needle of [
      "--json",
      "--dry-run",
      "schemaVersion",
      "outcome",
      "passed",
      "nonzero_exit",
      "timeout",
      "spawn_error",
      "errorCode",
      "nextAction",
      "check_nonzero_exit",
      "check_timeout",
      "check_spawn_error",
      "unsupported_flag",
    ]) {
      assert.ok(text.includes(needle), `--help must mention ${needle}`);
    }
    for (const code of ["0", "1", "2"]) assert.match(text, new RegExp(`^\\s*${code}\\s{2,}\\S`, "m"), `exit code ${code} documented`);
    assert.ok(/example/i.test(text) && /verify-config\.mjs --json/.test(text), "an --json example");
    assert.ok(/verify-config\.mjs --dry-run/.test(text), "a --dry-run example");
  });

  test("states the per-leg timeout value", () => {
    const text = help();
    const ms = lib.CHECK_TIMEOUT_MS;
    assert.equal(typeof ms, "number", "CHECK_TIMEOUT_MS must be exported");
    const seconds = ms / 1000;
    assert.ok(
      text.includes(String(ms)) || new RegExp(`\\b${seconds}\\s?(s|sec|secs|seconds)\\b`, "i").test(text),
      `--help must state the ${ms} ms (${seconds}s) timeout`,
    );
  });
});

describe("discoverability and wiring", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

  test("package.json exposes the JSON and dry-run entries without touching verify:config", () => {
    assert.equal(pkg.scripts["verify:config"], "node scripts/verify-config.mjs");
    assert.equal(pkg.scripts["verify:config:json"], "node scripts/verify-config.mjs --json");
    assert.equal(pkg.scripts["verify:config:dry-run"], "node scripts/verify-config.mjs --dry-run --json");
  });

  test("npm run help lists both new entries", () => {
    const result = spawnSync(process.execPath, [path.join(scriptsDir, "help.mjs")], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verify:config:json\s+node scripts\/verify-config\.mjs --json/);
    assert.match(result.stdout, /verify:config:dry-run\s+node scripts\/verify-config\.mjs --dry-run/);
  });

  test("CONTRIBUTING has a short verify:config section with both flags, schemaVersion and the timeout", () => {
    const lines = readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8").split("\n");
    const start = lines.findIndex((l) => /^#{2,4}\s.*verify:config/.test(l));
    assert.ok(start >= 0, "CONTRIBUTING.md needs a heading that names verify:config");
    const level = lines[start].match(/^#+/)[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#+)\s/);
      if (m && m[1].length <= level) {
        end = i;
        break;
      }
    }
    const section = lines.slice(start, end).join("\n");
    assert.ok(end - start <= 40, `section should be short (<= 40 lines), got ${end - start}`);
    for (const needle of ["--json", "--dry-run", "schemaVersion", "timeout"]) {
      assert.ok(section.includes(needle), `CONTRIBUTING section must mention ${needle}`);
    }
  });

  test("this suite is wired into npm run test:probe", () => {
    assert.ok(
      pkg.scripts["test:probe"].includes("scripts/verify-config-json.test.mjs"),
      "test:probe must run scripts/verify-config-json.test.mjs",
    );
  });
});

// --- real spawn runner (synthetic children only; never the real CHECKS scripts) ---

describe("createSpawnRunner (real child processes, synthetic scripts)", () => {
  async function loadRunnerFactory() {
    assert.ok(existsSync(runnerPath), "scripts/lib/verifyConfigRunner.mjs must exist and export createSpawnRunner");
    const mod = await import(pathToFileURL(runnerPath).href);
    assert.equal(typeof mod.createSpawnRunner, "function", "verifyConfigRunner.mjs must export createSpawnRunner");
    return mod.createSpawnRunner;
  }

  function child(name, source) {
    const file = path.join(scratch, name);
    writeFileSync(file, source);
    return file;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  test("resolves the child's exit code (0 and nonzero)", async () => {
    const createSpawnRunner = await loadRunnerFactory();
    const runner = createSpawnRunner({ cwd: scratch });
    const ok = child("exit0.mjs", "process.exit(0);\n");
    const bad = child("exit3.mjs", "process.exit(3);\n");
    const ctx = () => ({ timeoutMs: 20_000, signal: new AbortController().signal, stdio: "ignore" });
    assert.equal((await runner({ name: "x", script: ok, args: [] }, ctx())).exitCode, 0);
    assert.equal((await runner({ name: "x", script: bad, args: [] }, ctx())).exitCode, 3);
  });

  test("kills the child when the signal aborts (no orphaned hung check)", async () => {
    const createSpawnRunner = await loadRunnerFactory();
    const runner = createSpawnRunner({ cwd: scratch });
    const pidFile = path.join(scratch, "hang.pid");
    const hang = child(
      "hang.mjs",
      'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n',
    );
    const controller = new AbortController();
    const running = runner(
      { name: "x", script: hang, args: [pidFile] },
      { timeoutMs: 600_000, signal: controller.signal, stdio: "ignore" },
    ).then(
      () => "settled",
      () => "settled",
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "") {
      assert.ok(Date.now() < deadline, "hang child never started");
      await sleep(25);
    }
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    assert.equal(
      await Promise.race([running, sleep(10_000).then(() => "stuck")]),
      "settled",
      "runner must settle after abort",
    );
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
        await sleep(30);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "aborted child must be dead");
  });

  test('stdio "ignore" keeps child output off the parent streams; "inherit" passes it through', async () => {
    await loadRunnerFactory();
    const noisy = child(
      "noisy.mjs",
      `console.log("OUT-${CANARY}");\nconsole.error("ERR-${CANARY}");\n`,
    );
    const parent = child(
      "parent.mjs",
      [
        `import { createSpawnRunner } from ${JSON.stringify(pathToFileURL(runnerPath).href)};`,
        `const runner = createSpawnRunner({ cwd: ${JSON.stringify(scratch)} });`,
        `await runner({ name: "x", script: ${JSON.stringify(noisy)}, args: [] }, { timeoutMs: 20000, signal: new AbortController().signal, stdio: process.argv[2] });`,
        "",
      ].join("\n"),
    );
    const ignored = spawnSync(process.execPath, [parent, "ignore"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(ignored.status, 0, ignored.stderr);
    assert.ok(!ignored.stdout.includes(CANARY) && !ignored.stderr.includes(CANARY), "ignored child output leaked");
    const inherited = spawnSync(process.execPath, [parent, "inherit"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(inherited.status, 0, inherited.stderr);
    assert.ok(inherited.stdout.includes(`OUT-${CANARY}`), "control: inherit must pass child stdout through");
  });
});

describe("process hygiene", () => {
  test("a green runCli run leaves no pending timer: the process exits promptly with a 10-minute budget", () => {
    need("runCli");
    const driver = path.join(scratch, "no-timers.mjs");
    writeFileSync(
      driver,
      [
        `import { runCli } from ${JSON.stringify(libUrl)};`,
        'const code = await runCli(["--json"], { runner: async () => ({ exitCode: 0 }), stdout: () => {}, stderr: () => {}, timeoutMs: 600000 });',
        "process.exitCode = code;",
        "",
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [driver], { encoding: "utf8", timeout: 8_000 });
    assert.equal(result.error, undefined, "process must exit on its own (no leaked timer)");
    assert.equal(result.status, 0, result.stderr);
  });
});
