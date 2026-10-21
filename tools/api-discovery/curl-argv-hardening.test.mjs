import assert from "node:assert/strict";
import test from "node:test";
import { runCurlPlan } from "./lib/curlRuntime.mjs";

// Pins the curl hardening argv for explicitly selected loopback GETs: config,
// proxy, glob and protocol removal, or localhost --resolve removal, must turn
// this file red. Uses an injected spawn stub; no network and no real curl.
function runSelectedGet({ base, urlPath = "/v1/things?q={a,b}" } = {}) {
  const calls = [];
  const plan = {
    schemaVersion: 1,
    operations: [{ id: "GET /v1/things", method: "GET", executable: true, urlPath, body: { source: "none" } }],
  };
  const env = base === undefined ? {} : { BASE: base };
  const code = runCurlPlan(plan, ["--operation", "GET /v1/things"], env, (bin, argv) => {
    calls.push({ bin, argv });
    return { status: 0 };
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  return calls[0];
}

function assertFlagPair(argv, flag, expected) {
  const index = argv.indexOf(flag);
  assert.ok(index !== -1, `expected ${flag} in curl argv`);
  if (expected instanceof RegExp) {
    assert.match(argv[index + 1] ?? "", expected, `expected ${flag} value to match ${expected}`);
  } else {
    assert.equal(argv[index + 1], expected, `expected ${flag} value`);
  }
}

test("selected localhost GET pins config/proxy/glob/proto hardening and resolve pin", () => {
  const { bin, argv } = runSelectedGet();
  assert.equal(bin, "curl");
  assert.ok(argv.includes("-q"), "expected -q so ~/.curlrc cannot redirect the loopback GET");
  assertFlagPair(argv, "--noproxy", "*");
  assertFlagPair(argv, "--proxy", "");
  assert.ok(argv.includes("--globoff"), "expected --globoff so {a,b} stays a single literal request");
  assertFlagPair(argv, "--proto", "=http,https");
  assertFlagPair(argv, "--resolve", /localhost:\d+:127\.0\.0\.1/);
  const urlIndexes = argv.map((entry, index) => (entry === "--url" ? index : -1)).filter((index) => index !== -1);
  assert.equal(urlIndexes.length, 1, "expected exactly one --url");
  assert.equal(argv[urlIndexes[0] + 1], "http://localhost:8787/v1/things?q={a,b}");
});

test("selected 127.0.0.1 GET pins hardening without a resolve pair", () => {
  const { argv } = runSelectedGet({ base: "http://127.0.0.1:8787" });
  assert.ok(argv.includes("-q"));
  assertFlagPair(argv, "--noproxy", "*");
  assertFlagPair(argv, "--proxy", "");
  assert.ok(argv.includes("--globoff"));
  assertFlagPair(argv, "--proto", "=http,https");
  assert.ok(!argv.includes("--resolve"), "expected no --resolve for a literal loopback IP");
});
