import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { loopbackOnly, runRehearsal } from "./lib/deployRehearsal.mjs";

const sha = "a".repeat(40);
const time = "2026-11-08T00:00:00.000Z";
const marker = "SYNTHETIC_SECRET_MUST_NOT_LEAVE_CHILD";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "offline-rehearsal-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "checkout");
  const scratch = path.join(base, "scratch");
  fs.mkdirSync(root);
  fs.mkdirSync(scratch);
  fs.mkdirSync(path.join(root, "migrations/d1"), { recursive: true });
  const sql = "CREATE TABLE synthetic(id INTEGER);\n";
  fs.writeFileSync(path.join(root, "migrations/d1/0001.sql"), sql);
  fs.writeFileSync(path.join(root, "migrations/d1/.sha256sum"), `${createHash("sha256").update(sql).digest("hex")}  0001.sql\n`);
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
    for (const key of ["CF_API_TOKEN", "CF_API_KEY", "CF_EMAIL", "NODE_OPTIONS", "NPM_CONFIG_USERCONFIG", "SHADOW_API_TOKEN", "GITHUB_TOKEN", "HTTPS_PROXY"]) assert.equal(options.env[key], undefined);
    assert.equal(options.env.WRANGLER_SEND_METRICS, "false");
    assert.ok(options.env.HOME.startsWith(scratch));
    if (command === "/usr/bin/git") return { status: 0, stdout: args[0] === "rev-parse" ? sha : "" };
    assert.equal(command, process.execPath);
    assert.ok(!args.includes("--remote"));
    if (args.includes("deploy")) {
      assert.ok(args.includes("--dry-run"));
      const out = args[args.indexOf("--outdir") + 1];
      fs.mkdirSync(out);
      fs.writeFileSync(path.join(out, "worker.js"), "// synthetic bundle\n");
    }
    return { status: 0, stdout: args.includes("execute") ? '[{"results":[{"name":"0001.sql"}]}]' : marker, stderr: marker };
  };
  const options = { root, scratch, candidateSha: sha, actions: "true" };
  const deps = { run, now: () => time, isolated: () => true };
  return { base, root, scratch, options, deps, calls };
}

for (const name of [".env", ".env.local", ".env.production", ".dev.vars", ".dev.vars.production", ".dev.vars.example"]) {
  for (const symlink of [false, true]) {
    if (!symlink && name === ".dev.vars.example") continue;
    test(`refuses ${name} ${symlink ? "symlink" : "file"} before subprocess or network`, (t) => {
      const f = fixture(t);
      if (symlink) fs.symlinkSync(path.join(f.base, "nonexistent"), path.join(f.root, name));
      else fs.writeFileSync(path.join(f.root, name), marker);
      const oldFetch = globalThis.fetch;
      globalThis.fetch = () => { assert.fail("network forbidden"); };
      t.after(() => { globalThis.fetch = oldFetch; });
      const receipt = runRehearsal(f.options, f.deps);
      assert.equal(receipt.errorCode, "local_credentials");
      assert.deepEqual(f.calls, []);
      assert.deepEqual(fs.readdirSync(f.scratch), []);
      assert.ok(!JSON.stringify(receipt).includes(marker));
    });
  }
}

for (const kind of ["unset", "relative", "missing", "file", "root", "checkout", "nested", "ancestor", "symlink", "parent-symlink"]) {
  test(`refuses ${kind} scratch before allocation/subprocess`, (t) => {
    const f = fixture(t);
    const locations = { unset: undefined, relative: "../scratch", missing: path.join(f.base, "missing"),
      root: "/", checkout: f.root, nested: path.join(f.root, "output"), ancestor: f.base,
      file: path.join(f.base, "file"), symlink: path.join(f.base, "link"), "parent-symlink": path.join(f.base, "parent-link/scratch") };
    fs.mkdirSync(locations.nested);
    fs.writeFileSync(locations.file, "fixture");
    fs.symlinkSync(f.scratch, locations.symlink);
    fs.symlinkSync(f.base, path.join(f.base, "parent-link"));
    const receipt = runRehearsal({ ...f.options, scratch: locations[kind] }, f.deps);
    assert.equal(receipt.conclusion, "FAIL");
    assert.deepEqual(f.calls, []);
    assert.deepEqual(fs.readdirSync(f.scratch), []);
  });
}

for (const change of [{ actions: "false" }, { candidateSha: "not-a-sha" }]) {
  test(`refuses invalid identity ${JSON.stringify(change)}`, (t) => {
    const f = fixture(t);
    assert.equal(runRehearsal({ ...f.options, ...change }, f.deps).errorCode, "invalid_identity");
    assert.deepEqual(f.calls, []);
  });
}

test("network guard accepts only current-namespace loopback addresses, never host or empty interfaces", () => {
  const lo = [{ address: "127.0.0.1", internal: true }, { address: "::1", internal: true }];
  assert.equal(loopbackOnly({ lo }), true);
  assert.equal(loopbackOnly({}), false);
  assert.equal(loopbackOnly({ lo: [] }), false);
  assert.equal(loopbackOnly({ lo, eth0: [{ address: "192.0.2.1", internal: false }] }), false);
  assert.equal(loopbackOnly({ lo: [{ address: "192.0.2.1", internal: true }] }), false);
  assert.equal(loopbackOnly({ lo: [{ address: "127.0.0.1", internal: false }] }), false);
});

test("refuses a nonisolated network before allocation/subprocess", (t) => {
  const f = fixture(t);
  assert.equal(runRehearsal(f.options, { ...f.deps, isolated: () => false }).errorCode, "network_not_isolated");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readdirSync(f.scratch), []);
});

test("fixed plan emits candidate-bound local journal, digest and sanitized receipts; removes scratch", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, ".dev.vars.example"), "# documented keys only\n");
  const receipt = runRehearsal(f.options, f.deps);
  assert.equal(receipt.conclusion, "PASS");
  assert.equal(receipt.candidateSha, sha);
  assert.equal(receipt.startedAt, time);
  assert.equal(receipt.finishedAt, time);
  assert.equal(receipt.cleanup, "PASS");
  assert.deepEqual(receipt.migrations.localJournal, ["0001.sql"]);
  assert.deepEqual(receipt.checks.map((row) => row.id), ["workflow", "vars-parity", "local-migrations", "local-journal", "worker-bundle"]);
  assert.ok(receipt.checks.every((row) => row.exitCode === 0 && row.conclusion === "PASS" && row.startedAt === time && row.finishedAt === time));
  assert.match(receipt.bundle.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(receipt).includes(marker));
  assert.ok(!JSON.stringify(receipt).includes(f.base));
  assert.deepEqual(Object.values(receipt.live), ["NOT VERIFIED", "NOT VERIFIED", "NOT VERIFIED"]);
  assert.deepEqual(fs.readdirSync(f.scratch), []);
});

for (const failure of ["sha", "dirty", "manifest", "journal", "bundle", "command", "timeout"]) {
  test(`fails closed and cleans up on ${failure} failure`, (t) => {
    const f = fixture(t);
    if (failure === "manifest") fs.appendFileSync(path.join(f.root, "migrations/d1/0001.sql"), "-- drift\n");
    const run = (command, args, options) => {
      if (failure === "sha" && args[0] === "rev-parse") return { status: 0, stdout: "b".repeat(40) };
      if (failure === "dirty" && args[0] === "status") return { status: 0, stdout: " M wrangler.toml" };
      if (failure === "command" && args[0] === "scripts/check-ci-workflow.mjs") return { status: 1, stdout: marker, stderr: marker };
      if (failure === "timeout" && args[0] === "scripts/check-ci-workflow.mjs") return { status: null, error: new Error(marker) };
      if (failure === "journal" && args.includes("execute")) return { status: 0, stdout: '[{"results":[{"name":"uncommitted.sql"}]}]' };
      if (failure === "bundle" && args.includes("deploy")) return { status: 0, stdout: marker };
      return f.deps.run(command, args, options);
    };
    const receipt = runRehearsal(f.options, { ...f.deps, run });
    assert.equal(receipt.conclusion, "FAIL");
    assert.equal(receipt.cleanup, "PASS");
    assert.ok(!JSON.stringify(receipt).includes(marker));
    assert.deepEqual(fs.readdirSync(f.scratch), []);
    if (["manifest", "sha", "dirty"].includes(failure)) assert.ok(!f.calls.some((call) => call.args.includes("deploy") || call.args.includes("d1")));
  });
}

test("Actions wiring uses the exact candidate, network namespace, pinned actions and receipt-only artifact", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/offline-rehearsal.yml", import.meta.url), "utf8");
  assert.match(workflow, /ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
  for (const boundary of ["persist-credentials: false", "sudo unshare --net", "ip link set lo up", "runuser -u", "env -i", "if-no-files-found: error", "retention-days: 14"]) assert.ok(workflow.includes(boundary));
  assert.ok(!/secrets\.|vars\.|workflow_dispatch|--remote/.test(workflow));
  for (const match of workflow.matchAll(/uses: ([^\s]+)@([^\s]+)/g)) assert.match(match[2], /^[a-f0-9]{40}$/);
});
