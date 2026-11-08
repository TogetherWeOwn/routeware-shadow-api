import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { classifyProbeEvidence } from "./lib/probeEvidence.mjs";
import { evaluateProbe, probeDocument, probePlan, probeResult, PROBES } from "./lib/postDeployProbe.mjs";

function evidence() {
  return { kind: "staging-probe", candidateSha: "a".repeat(40), observedAt: "2026-11-08T00:00:00Z",
    approvedStagingOrigin: "https://approved.invalid", exitCode: 0,
    probe: probeDocument({ target: "https://approved.invalid", checks: PROBES.map((probe) => evaluateProbe(probe, {
      httpStatus: 200, body: { status: "ok", service: "synthetic", version: "v1", checks: { cron: { stale: false } } },
    })) }) };
}

test("all three actual v1 evaluator passes, exit 0, HTTP200/ok and fresh cron are required", () => {
  const record = evidence();
  assert.equal(classifyProbeEvidence(record).classification, "PASS");
  assert.equal(classifyProbeEvidence(record).liveReadiness, "PASS");
  record.kind = "synthetic";
  assert.equal(classifyProbeEvidence(record).classification, "PASS");
  assert.equal(classifyProbeEvidence(record).liveReadiness, "NOT VERIFIED");
});

const cases = [
  ["nonzero exit", "FAIL", (e) => { e.exitCode = 1; }],
  ["unknown exit", "FAIL", (e) => { delete e.exitCode; }],
  ["overall failure", "FAIL", (e) => { e.probe.ok = false; }],
  ["dry run", "NOT VERIFIED", (e) => { e.probe.mode = "dry-run"; e.probe.checks = probePlan(); }],
  ["ordinary CI", "NOT VERIFIED", (e) => { e.kind = "ordinary-ci"; }],
  ["public only", "NOT VERIFIED", (e) => { e.probe.checks.length = 1; }],
  ["missing approval", "NOT VERIFIED", (e) => { delete e.approvedStagingOrigin; }],
  ["different target", "NOT VERIFIED", (e) => { e.probe.target = "https://other.invalid"; }],
  ["localhost", "NOT VERIFIED", (e) => { e.approvedStagingOrigin = e.probe.target = "https://localhost"; }],
  ["unknown cron", "NOT VERIFIED", (e) => { e.probe.checks[2].cron = "absent"; }],
  ["missing cron", "NOT VERIFIED", (e) => { delete e.probe.checks[2].cron; }],
  ["stale cron", "FAIL", (e) => { e.probe.checks[2].cron = "stale"; }],
  ["malformed cron", "FAIL", (e) => { e.probe.checks[2].cron = "malformed"; }],
  ["wrong GET path", "NOT VERIFIED", (e) => { e.probe.checks[1].path = "/other"; }],
  ["mutating method", "NOT VERIFIED", (e) => { e.probe.checks[1].method = "POST"; }],
  ["duplicate checks", "NOT VERIFIED", (e) => { e.probe.checks[2] = e.probe.checks[1]; }],
  ["unexecuted outcome", "NOT VERIFIED", (e) => { e.probe.checks[1].outcome = "planned"; }],
  ["missing HTTP200", "NOT VERIFIED", (e) => { e.probe.checks[2].httpStatus = null; }],
  ["503 readiness", "FAIL", (e) => { e.probe.checks[2] = evaluateProbe(PROBES[2], { httpStatus: 503 }); }],
  ["degraded 200", "FAIL", (e) => { e.probe.checks[2] = evaluateProbe(PROBES[2], { httpStatus: 200, body: { status: "degraded", service: "synthetic", checks: { cron: { stale: false } } } }); }],
  ["missing token skip", "SKIPPED", (e) => { e.probe.checks[1] = probeResult(PROBES[1], { outcome: "skip", errorCode: "missing_token" }); }],
  ["missing token strict", "SKIPPED", (e) => { e.exitCode = 1; e.probe.ok = false; e.probe.checks[2] = probeResult(PROBES[2], { outcome: "fail", errorCode: "missing_token" }); }],
  ["public failure plus missing token", "FAIL", (e) => { e.probe.checks[0] = evaluateProbe(PROBES[0], { httpStatus: 500 }); e.probe.checks[1] = probeResult(PROBES[1], { outcome: "skip", errorCode: "missing_token" }); }],
  ["missing candidate", "NOT VERIFIED", (e) => { delete e.candidateSha; }],
  ["missing UTC", "NOT VERIFIED", (e) => { e.observedAt = "yesterday"; }],
  ["array candidate", "NOT VERIFIED", (e) => { e.candidateSha = [e.candidateSha]; }],
  ["non-coercible candidate", "NOT VERIFIED", (e) => { e.candidateSha = { toString: null }; }],
  ["impossible calendar day", "NOT VERIFIED", (e) => { e.observedAt = "2026-02-30T00:00:00Z"; }],
  ["non-leap February", "NOT VERIFIED", (e) => { e.observedAt = "2026-02-29T00:00:00.000Z"; }],
  ["normalized midnight", "NOT VERIFIED", (e) => { e.observedAt = "2026-11-08T24:00:00Z"; }],
];
for (const [name, expected, mutate] of cases) {
  test(`strict evidence classification: ${name}`, () => {
    const record = evidence();
    mutate(record);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { assert.fail("classification must never fetch"); };
    try { assert.equal(classifyProbeEvidence(record).classification, expected); }
    finally { globalThis.fetch = originalFetch; }
  });
}

test("valid leap dates and millisecond UTC timestamps retain exact identity", () => {
  for (const observedAt of ["2028-02-29T23:59:59Z", "2026-11-08T00:00:00.123Z"]) {
    const record = { ...evidence(), observedAt };
    assert.equal(classifyProbeEvidence(record).classification, "PASS");
    assert.equal(classifyProbeEvidence(record).observedAt, observedAt);
  }
});

test("data recorder drops arbitrary response/token fields and refuses malformed, oversized or symlink inputs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-evidence-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "evidence.json");
  const record = evidence();
  const marker = "SYNTHETIC_DO_NOT_EMIT";
  record.probe.checks[2].nextAction = marker;
  record.probe.rawBody = marker;
  fs.writeFileSync(file, JSON.stringify(record));
  const invoke = (target) => spawnSync(process.execPath, ["scripts/classify-probe-evidence.mjs", target], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH } });
  let result = invoke(file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(marker));
  fs.symlinkSync(file, path.join(dir, "link"));
  const fifo = path.join(dir, "fifo");
  const created = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8", timeout: 5_000 });
  assert.equal(created.status, 0, created.stderr);
  for (const bad of [fifo, path.join(dir, "link"), path.join(dir, "missing"), dir]) {
    result = invoke(bad);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).classification, "NOT VERIFIED");
  }
  for (const candidateSha of [[record.candidateSha], { toString: null }]) {
    fs.writeFileSync(file, JSON.stringify({ ...record, candidateSha }));
    result = invoke(file);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).classification, "NOT VERIFIED");
  }
  for (const text of ["not json", " ".repeat(65_537)]) {
    fs.writeFileSync(file, text);
    assert.equal(invoke(file).status, 2);
  }
});
