import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAdmissionReader, githubTransport, MAX_ADMISSION_READS, ADMISSION_RESERVE, ADMISSION_TIMEOUT_MS, READ_TIMEOUT_MS } from "./lib/buildAdmissionReader.mjs";
import { assertBuildPublicationHistory, REPOSITORY } from "./lib/buildPublicationHistory.mjs";
import { rateHeaders } from "./fixtures/buildAdmissionRate.mjs";

const root = `/repos/${REPOSITORY}`;
const sha = "a".repeat(40);
const workflow = `${root}/contents/.github/workflows/ci.yml?ref=${sha}`;
const reviewedWorkflow = readFileSync(new URL("./fixtures/reviewed-build-ci.yml", import.meta.url), "utf8");
const success = (headers = rateHeaders(), data = {}) => ({ status: 200, headers, data });
function provider(respond = () => success()) {
  const calls = [];
  return { calls, async request(method, path, options) {
    calls.push({ method, path, options });
    assert.equal(method, "GET");
    return respond(path, calls.length, options);
  } };
}

// All data is synthetic. No global fetch is permitted in history fixtures.
function history(count, { legacy = false, distinct = false, ambiguous = false, extraPage = false } = {}) {
  const context = { repository: REPOSITORY, sha, runId: 9999, attempt: 1, enabled: true, eventName: "push", ref: "refs/heads/main" };
  const run = (id, head = sha) => ({ id, workflow_id: 42, run_attempt: 1, head_sha: head, path: ".github/workflows/ci.yml", event: "push", head_branch: "main",
    repository: { id: 17, full_name: REPOSITORY }, head_repository: { id: 17, full_name: REPOSITORY } });
  const runs = Array.from({ length: count }, (_, i) => run(i + 1, distinct ? (i + 1).toString(16).padStart(40, "0") : sha));
  runs.push(run(context.runId));
  runs.forEach((item, index) => { item.run_number = index + 1; });
  const api = provider((path) => {
    if (path.includes("/workflows/ci.yml/runs")) return success(rateHeaders(), { total_count: runs.length, workflow_runs: runs });
    const match = path.match(/\/runs\/(\d+)\/attempts\/1(\/jobs)?(?:\?per_page=100&page=(\d+))?$/);
    if (match) {
      const current = runs.find((item) => item.id === Number(match[1]));
      if (!match[2]) return success(rateHeaders(), current);
      const steps = ["Plan deployment build identity", "Deploy Worker", "Publish non-Latest deployment build"].map((name) => ({
        name, status: "completed", conclusion: ambiguous && name === "Deploy Worker" ? "failure" : "success"
      }));
      const job = { id: current.id, run_id: current.id, run_attempt: 1, head_sha: current.head_sha,
        name: "Deploy to Cloudflare Workers", steps: legacy ? [] : steps };
      const headers = rateHeaders(extraPage && current.id === 1 && match[3] === "1" ? {
        link: `<https://api.github.com${root}/actions/runs/1/attempts/1/jobs?per_page=100&page=2>; rel="next"`
      } : {});
      return success(headers, { total_count: 1, jobs: extraPage && current.id === 1 && match[3] === "1" ? [] : [job] });
    }
    if (path.startsWith(`${root}/contents/`)) return success(rateHeaders(), {
      type: "file", encoding: "base64", content: Buffer.from(legacy ? "name: Legacy CI\n" : reviewedWorkflow).toString("base64")
    });
    throw new Error(`unexpected synthetic request ${path}`);
  });
  return { api, context };
}

for (const [count, expected] of [[0, 3], [10, 24], [97, 198]]) {
  test(`complete published history: ${count} prior attempts requires exactly ${expected} requests`, async (t) => {
    t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network"); });
    const { api, context } = history(count);
    await assertBuildPublicationHistory(context, api);
    assert.equal(api.calls.length, expected);
    assert.equal(api.calls.filter((call) => call.path.includes("/contents/")).length, count === 0 ? 0 : 1);
  });
}

test("exact boundary: 98 prior attempts and cached reviewed wiring complete in 200 requests", async () => {
  const { api, context } = history(98);
  await assertBuildPublicationHistory(context, api);
  assert.equal(api.calls.length, 200);
  assert.equal(api.calls.filter((call) => call.path.includes("/contents/")).length, 1);
});

test("one over: 98 prior attempts and an extra job page need 201 reads and refuse before request 201", async () => {
  const { api, context } = history(98, { extraPage: true });
  await assert.rejects(() => assertBuildPublicationHistory(context, api), /history read budget exceeded; NOT READY/);
  assert.equal(api.calls.length, 200);
});

test("99 prior published attempts refuse before request 201 even with cached reviewed wiring", async () => {
  const { api, context } = history(99);
  await assert.rejects(() => assertBuildPublicationHistory(context, api), /history read budget exceeded; NOT READY/);
  assert.equal(api.calls.length, 200);
});

test("immutable workflow reuse supports 98 legacy attempts at 200 reads, not 297", async () => {
  const { api, context } = history(98, { legacy: true });
  await assertBuildPublicationHistory(context, api);
  assert.equal(api.calls.length, 200);
  assert.equal(api.calls.filter((call) => call.path.includes("/contents/")).length, 1);
});

test("different commit workflow proofs stay separate and cannot hide an ambiguous deploy", async () => {
  const distinct = history(10, { legacy: true, distinct: true });
  await assertBuildPublicationHistory(distinct.context, distinct.api);
  assert.equal(distinct.api.calls.length, 33);
  const unsafe = history(10, { ambiguous: true });
  await assert.rejects(() => assertBuildPublicationHistory(unsafe.context, unsafe.api), /ambiguous deployment/);
  assert.equal(unsafe.api.calls.length, 4);
});

test("disabled context performs zero reads and never requires token or rate metadata", async () => {
  const { context } = history(0);
  await assertBuildPublicationHistory({ ...context, enabled: false }, githubTransport(undefined));
});

test("all external categories consume one shared exact budget, including normalization and repair", async () => {
  const api = provider();
  const read = createAdmissionReader(api);
  const paths = [root, `${root}/actions/workflows/ci.yml/runs?page=1`, `${root}/actions/runs/1/attempts/1`,
    `${root}/actions/runs/1/attempts/1/jobs?page=1`, workflow, `${root}/tags?page=1`,
    `${root}/git/ref/tags/build%2Fv2026.303.0`, `${root}/git/tags/${sha}`, `${root}/actions/jobs/1/logs`, `${root}/releases/tags/build%2Fv2026.303.0`];
  for (const path of paths) await read(path);
  for (let i = paths.length; i < MAX_ADMISSION_READS; i++) await read(`${root}/tags?page=${i}`);
  assert.equal(api.calls.length, MAX_ADMISSION_READS);
  await assert.rejects(() => read(root), /budget exceeded/);
  assert.equal(api.calls.length, MAX_ADMISSION_READS);
});

for (const remaining of ["0", "1", "100", "298"]) {
  test(`insufficient initial remaining=${remaining} fails on bootstrap before a second request`, async () => {
    const api = provider(() => success(rateHeaders({ "x-ratelimit-remaining": remaining })));
    const read = createAdmissionReader(api);
    await assert.rejects(() => read(root), /insufficient provider read budget/);
    await assert.rejects(() => read(root));
    assert.equal(api.calls.length, 1);
  });
}

test("exact remaining boundary funds 200 reads and leaves a 100-request reserve", async () => {
  const api = provider(() => success(rateHeaders({ "x-ratelimit-remaining": "299" })));
  const read = createAdmissionReader(api);
  for (let i = 0; i < MAX_ADMISSION_READS; i++) await read(root);
  assert.equal(api.calls.length, 200);
  assert.equal(299 - (MAX_ADMISSION_READS - 1), ADMISSION_RESERVE);
});

test("a later concurrent quota drop fails immediately, and higher metadata never refills the allowance", async () => {
  const api = provider((_, n) => success(rateHeaders({ "x-ratelimit-remaining": n === 2 ? "100" : "999" })));
  const read = createAdmissionReader(api);
  await read(root);
  await assert.rejects(() => read(root), /insufficient/);
  await assert.rejects(() => read(root), /insufficient/);
  assert.equal(api.calls.length, 2);
});

for (const name of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-used", "x-ratelimit-reset", "x-ratelimit-resource"]) {
  for (const value of [undefined, "", "NaN", "-1", "1.5", "9007199254740992"]) {
    test(`malformed/missing ${name}=${String(value)} cannot grant capacity`, async () => {
      const api = provider(() => success(rateHeaders({ [name]: value })));
      await assert.rejects(() => createAdmissionReader(api)(root), /metadata|malformed|missing/);
      assert.equal(api.calls.length, 1);
    });
  }
}
for (const change of [
  { "x-ratelimit-limit": "0" }, { "x-ratelimit-remaining": "1001" }, { "x-ratelimit-used": "1001" },
  { "x-ratelimit-used": "1000", "x-ratelimit-remaining": "999" }, { "x-ratelimit-used": "0" },
  { "x-ratelimit-reset": "1" }, { "x-ratelimit-reset": "9999999999" }, { "x-ratelimit-resource": "search" },
  { "retry-after": "60" }, { "retry-after": "invalid" }
]) {
  test(`inconsistent/exhaustion provider signals refuse: ${JSON.stringify(change)}`, async () => {
    const api = provider(() => success(rateHeaders(change)));
    await assert.rejects(() => createAdmissionReader(api)(root), /metadata|retry-after/);
    assert.equal(api.calls.length, 1);
  });
}
for (const status of [302, 403, 429, 500]) {
  test(`HTTP ${status} refuses without redirects, sleeps or retries`, async () => {
    const api = provider(() => ({ status, headers: rateHeaders(), data: {} }));
    await assert.rejects(() => createAdmissionReader(api)(root), /provider/);
    assert.equal(api.calls.length, 1);
  });
}

test("transport failures are terminal and redact possibly credential-bearing errors", async () => {
  const api = provider(() => { throw new Error("synthetic-secret-or-signed-url"); });
  const read = createAdmissionReader(api);
  await assert.rejects(() => read(root), (error) => /provider read failed/.test(error.message) && !error.message.includes("synthetic-secret"));
  await assert.rejects(() => read(root));
  assert.equal(api.calls.length, 1);
});

test("per-read timeout aborts a stalled transport, with no retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const api = provider(() => new Promise(() => {}));
  const read = createAdmissionReader(api);
  const result = assert.rejects(() => read(root), /failed or timed out/);
  t.mock.timers.tick(READ_TIMEOUT_MS);
  await result;
  assert.equal(api.calls[0].options.signal.aborted, true);
  assert.equal(api.calls.length, 1);
});

test("a resolved read past its deadline cannot bypass a delayed timer callback", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const api = provider(() => {
    clock = READ_TIMEOUT_MS + 1; // Simulate blocking body decode; no real wait.
    return success();
  });
  const read = createAdmissionReader(api);
  await assert.rejects(() => read(workflow), /provider read time budget exceeded/);
  await assert.rejects(() => read(workflow), /provider read time budget exceeded/);
  assert.equal(api.calls.length, 1, "late proof is neither accepted nor cached");
});

test("aggregate time is bounded even when each individual read succeeds", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const api = provider();
  const read = createAdmissionReader(api);
  await read(root);
  clock = ADMISSION_TIMEOUT_MS;
  await assert.rejects(() => read(root), /time budget exceeded/);
  assert.equal(api.calls.length, 1);
});

test("cache keys bind repo, SHA and object kind, with no mutation or cross-admission leakage", async () => {
  const api = provider(() => success(rateHeaders(), { proof: "original" }));
  const read = createAdmissionReader(api);
  const first = await read(workflow);
  first.data.proof = "tampered";
  assert.equal((await read(workflow)).data.proof, "original");
  for (const path of [workflow.replace(sha, "b".repeat(40)), workflow.replace(REPOSITORY, "TogetherWeOwn/another-product"), `${root}/git/tags/${sha}`]) {
    await read(path); await read(path);
  }
  assert.equal(api.calls.length, 4);
  await createAdmissionReader(api)(workflow);
  assert.equal(api.calls.length, 5);
});

test("mutable lists, run/attempt/jobs, refs, Releases and logs are never cached", async () => {
  const api = provider((_, n) => success(rateHeaders(), { observation: n }));
  const read = createAdmissionReader(api);
  for (const path of [root, `${root}/tags?page=1`, `${root}/actions/runs/1/attempts/1`, `${root}/actions/runs/1/attempts/2`,
    `${root}/actions/runs/2/attempts/1`, `${root}/actions/runs/1/attempts/1/jobs`, `${root}/git/ref/tags/build%2Fv2026.303.0`,
    `${root}/releases/tags/build%2Fv2026.303.0`, `${root}/actions/jobs/1/logs`, workflow.replace(sha, "main")]) {
    assert.notEqual((await read(path)).data.observation, (await read(path)).data.observation);
  }
  assert.equal(api.calls.length, 20);
});

test("real transport forwards native headers and abort signal, never follows log-download redirects", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/logs")) return new Response(null, { status: 302, headers: { ...rateHeaders(), location: "https://signed.example.test/private-log" } });
    return new Response(JSON.stringify({ id: 17 }), { headers: { ...rateHeaders(), link: "synthetic-link" } });
  });
  const api = githubTransport("synthetic-token");
  const read = createAdmissionReader(api);
  assert.equal((await read(root)).headers.link, "synthetic-link");
  await assert.rejects(() => read(`${root}/actions/jobs/1/logs`), /status 302/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.redirect, "manual");
    assert.equal(call.options.method, "GET");
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.ok(call.url.startsWith("https://api.github.com/repos/"));
  }
});
