import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, test } from "node:test";
import { assertBuildPublicationHistory, proveBuildPublicationHistory } from "./lib/buildPublicationHistory.mjs";
import {
  REPOSITORY, WORKFLOW_PATH, discoverBuildRuns, assertStableBuildRunInventory
} from "./lib/buildPublicationDiscovery.mjs";

const root = `/repos/${REPOSITORY}`;
const runPath = `${root}/actions/workflows/ci.yml/runs`;
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const names = ["Plan deployment build identity", "Deploy Worker", "Publish non-Latest deployment build"];

function fixture({ count = 1002, nonPush = 0, attempts = new Map(), change = () => {} } = {}) {
  const ctx = {
    enabled: true, repository: REPOSITORY, runId: count, attempt: attempts.get(count) ?? 1,
    sha: "b".repeat(40), eventName: "push", ref: "refs/heads/main"
  };
  const rows = Array.from({ length: count + nonPush }, (_, i) => ({
    id: i + 1, run_number: i + 1, run_attempt: attempts.get(i + 1) ?? 1, workflow_id: 42, path: WORKFLOW_PATH,
    head_sha: i + 1 === count ? ctx.sha : "a".repeat(40), head_branch: "main",
    repository: { id: 17, full_name: REPOSITORY }, head_repository: { id: 17, full_name: REPOSITORY },
    event: i < count ? "push" : "pull_request", status: "completed", conclusion: "success",
    // All records deliberately share one timestamp, including page boundaries.
    // Discovery must not rely on ordering, timestamps, IDs or a date partition.
    created_at: "2026-03-03T01:00:00Z"
  }));
  const calls = [];
  let pass = 0;
  const api = { async request(method, path) {
    assert.equal(method, "GET");
    assert.ok(calls.length < 25000, "hermetic tripwire: no unbounded retries");
    calls.push(path);
    const url = new URL(path, "https://api.github.com");
    assert.equal(url.origin, "https://api.github.com");
    let data;
    let headers = {};
    if (url.pathname === runPath) {
      assert.deepEqual([...url.searchParams.keys()].sort(), ["page", "per_page"], "no capped search filters");
      assert.equal(url.searchParams.get("per_page"), "100");
      const page = Number(url.searchParams.get("page"));
      if (page === 1) pass += 1;
      data = { total_count: rows.length, workflow_runs: structuredClone(rows.slice((page - 1) * 100, page * 100)) };
      if (page * 100 < rows.length) headers.link = `<https://api.github.com${runPath}?per_page=100&page=${page + 1}>; rel="next"`;
    } else if (url.pathname === root) {
      data = { id: 17, full_name: REPOSITORY };
    } else if (url.pathname === `${root}/contents/${WORKFLOW_PATH}`) {
      assert.match(url.searchParams.get("ref"), /^[a-f0-9]{40}$/);
      data = { type: "file", encoding: "base64", content: Buffer.from(workflow).toString("base64") };
    } else if (url.pathname === `${root}/tags`) {
      data = [];
    } else {
      const match = url.pathname.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)(\/jobs)?$/);
      assert.ok(match, `unexpected read ${path}`);
      const run = rows.find((r) => r.id === Number(match[1]));
      assert.ok(run);
      const attempt = Number(match[2]);
      assert.ok(attempt > 0 && attempt <= run.run_attempt);
      if (!match[3]) data = { ...run, run_attempt: attempt };
      else {
        assert.notEqual(`${run.id}/${attempt}`, `${ctx.runId}/${ctx.attempt}`, "only current transaction is excluded");
        data = { total_count: 1, jobs: [{
          id: run.id * 100 + attempt, run_id: run.id, run_attempt: attempt, head_sha: run.head_sha,
          name: "Deploy to Cloudflare Workers", status: "completed", conclusion: "skipped",
          started_at: "2026-03-03T01:00:02Z", completed_at: "2026-03-03T01:00:02Z", steps: []
        }] };
      }
    }
    const response = { status: 200, headers, data };
    change(response, url, pass);
    return response;
  } };
  const read = (path) => api.request("GET", path);
  return { ctx, api, read, calls, rows };
}

function executedJob(response, outcome) {
  const job = response.data.jobs[0];
  job.conclusion = "failure";
  job.steps = names.map((name, i) => ({ name, number: i + 1, status: "completed", conclusion: outcome[i] }));
}

async function inventoryProof(f) {
  const before = await discoverBuildRuns(f.read);
  const after = await discoverBuildRuns(f.read);
  assertStableBuildRunInventory(before, after);
  return before;
}

describe("uncapped exhaustive build history discovery", () => {
  beforeEach((t) => {
    t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network in synthetic history"); });
  });

  test("production entry retains the same proof on small affordable history", async () => {
    const f = fixture({ count: 2 });
    await assertBuildPublicationHistory(f.ctx, f.api);
    assert.equal(f.calls.length, 5);
  });

  test("1002 main pushes with terminal skipped jobs are completely proven with a bounded fixture reader", async () => {
    const f = fixture();
    await proveBuildPublicationHistory(f.ctx, f.read);
    assert.equal(f.calls.filter((p) => p.startsWith(`${runPath}?`)).length, 22);
    assert.equal(f.calls.filter((p) => p.includes("/jobs?")).length, 1001);
    assert.equal(f.calls.length, 2025, "22 discovery + current metadata + 2 reads for each prior attempt");
  });

  for (const id of [99, 100, 101, 999, 1000, 1001]) {
    for (const kind of ["ambiguous deployment", "unpublished deployment", "missing jobs"]) {
      test(`proof beyond 1000: ${kind} at boundary run ${id} refuses`, async () => {
        const f = fixture({ change(r, u) {
          if (u.pathname !== `${root}/actions/runs/${id}/attempts/1/jobs`) return;
          if (kind === "missing jobs") r.data = { total_count: 1, jobs: [] };
          else executedJob(r, ["success", kind === "ambiguous deployment" ? "failure" : "success", "failure"]);
        } });
        await assert.rejects(() => proveBuildPublicationHistory(f.ctx, f.read),
          kind === "missing jobs" ? /job enumeration.*incomplete/ : kind === "ambiguous deployment" ? /ambiguous deployment/ : /build publication repair:/);
        assert.ok(f.calls.some((p) => p.includes(`/runs/${id}/attempts/1/jobs?`)));
      });
    }
  }

  test("a successful run-list conclusion cannot substitute for a terminal skipped production job", async () => {
    const f = fixture({ change(r, u) {
      if (u.pathname.endsWith("/runs/1000/attempts/1/jobs")) r.data.jobs[0].status = "in_progress";
    } });
    await assert.rejects(() => proveBuildPublicationHistory(f.ctx, f.read), /build publication history:/);
  });

  test("all rerun attempts, including earlier current-run attempts, remain obligations", async () => {
    const f = fixture({ attempts: new Map([[1000, 3], [1002, 2]]) });
    await proveBuildPublicationHistory(f.ctx, f.read);
    for (const [id, attempts] of [[1000, [1, 2, 3]], [1002, [1]]]) {
      for (const attempt of attempts) assert.ok(f.calls.includes(`${root}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100&page=1`));
    }
    assert.equal(f.calls.length, 2031);
  });

  test("an ambiguous first attempt cannot hide behind a terminal skipped rerun", async () => {
    const f = fixture({ attempts: new Map([[1000, 2]]), change(r, u) {
      if (u.pathname.endsWith("/runs/1000/attempts/1/jobs")) executedJob(r, ["success", "cancelled", "skipped"]);
    } });
    await assert.rejects(() => proveBuildPublicationHistory(f.ctx, f.read), /ambiguous deployment/);
  });

  test("non-push runs count toward complete discovery but not deployment obligations", async () => {
    const f = fixture({ count: 2, nonPush: 1001 });
    const discovery = await inventoryProof(f);
    assert.equal(discovery.inventory.size, 1003);
    assert.equal(discovery.runs.size, 2);
    assert.equal(f.calls.length, 22);
  });

  test("existing 50-page bound supports a complete 5000-run inventory, not a 1000-result prefix", async () => {
    const f = fixture({ count: 5000 });
    assert.equal((await inventoryProof(f)).runs.size, 5000);
    assert.equal(f.calls.length, 100, "two exhaustive inventories, 50 pages each");
  });

  test("5001 rows refuse at the physical bound, never approve a supported prefix", async () => {
    const f = fixture({ count: 5001 });
    await assert.rejects(() => discoverBuildRuns(f.read), /count exceeds the page bound/);
    assert.equal(f.calls.length, 1);
  });

  for (const [label, change] of [
    ["missing record", (r) => { r.data.workflow_runs.pop(); }],
    ["duplicate record", (r) => { r.data.workflow_runs[1] = { ...r.data.workflow_runs[0] }; }],
    ["duplicate run with another attempt", (r) => { r.data.workflow_runs[1] = { ...r.data.workflow_runs[0], run_attempt: 2 }; }],
    ["foreign repository", (r) => { r.data.workflow_runs[0].repository.full_name = "Another/repo"; }],
    ["foreign workflow", (r) => { r.data.workflow_runs[0].path = ".github/workflows/other.yml"; }],
    ["mixed workflow ID", (r) => { r.data.workflow_runs[0].workflow_id = 18; }],
    ["invalid SHA", (r) => { r.data.workflow_runs[0].head_sha = "short"; }],
    ["missing workflow run number", (r) => { delete r.data.workflow_runs[0].run_number; }],
    ["duplicate workflow run number", (r) => { r.data.workflow_runs[1].run_number = r.data.workflow_runs[0].run_number; }],
    ["deleted workflow run before enumeration", (r) => { r.data.workflow_runs[0].run_number = 1003; }],
    ["missing event on an otherwise non-push record", (r) => { delete r.data.workflow_runs[0].event; }],
    ["missing branch", (r) => { delete r.data.workflow_runs[0].head_branch; }],
    ["invalid count", (r) => { r.data.total_count = -1; }],
    ["missing next page", (r) => { r.headers = {}; }],
    ["foreign next origin", (r) => { r.headers.link = '<https://foreign.example.test/page>; rel="next"'; }],
    ["search-filter next link", (r) => { r.headers.link = `<https://api.github.com${runPath}?branch=main&per_page=100&page=2>; rel="next"`; }],
    ["wrong numeric repository", (r) => { r.headers.link = '<https://api.github.com/repositories/18/actions/workflows/ci.yml/runs?per_page=100&page=2>; rel="next"'; }],
  ]) {
    test(`complete discovery refuses ${label}`, async () => {
      const f = fixture({ change(r, u) { if (u.pathname === runPath && u.searchParams.get("page") === "1") change(r); } });
      await assert.rejects(() => discoverBuildRuns(f.read), /build publication history:/);
    });
  }

  test("numeric repository pagination is validated then normalized to the same unfiltered query", async () => {
    const f = fixture({ change(r, u) {
      if (u.pathname === runPath && r.headers.link) r.headers.link = r.headers.link.replace(`${root}/`, "/repositories/17/");
    } });
    assert.equal((await inventoryProof(f)).runs.size, 1002);
    assert.equal(f.calls.filter((p) => p === root).length, 2, "identity independently read once per inventory");
  });

  test("changing totals within pagination refuse", async () => {
    const f = fixture({ change(r, u) { if (u.pathname === runPath && u.searchParams.get("page") === "2") r.data.total_count += 1; } });
    await assert.rejects(() => inventoryProof(f), /count changed/);
  });

  for (const [label, change] of [
    ["count changed", (r) => { r.data.total_count += 1; }],
    ["rerun started", (r) => { r.data.workflow_runs[0].run_attempt += 1; }],
    ["same count but run replaced", (r) => { r.data.workflow_runs[0].id = 99999; }],
    ["same count but SHA replaced", (r) => { r.data.workflow_runs[0].head_sha = "c".repeat(40); }],
    ["event changed", (r) => { r.data.workflow_runs[0].event = "schedule"; }],
  ]) {
    test(`post-proof inventory detects ${label}`, async () => {
      const f = fixture({ change(r, u, pass) {
        if (u.pathname === runPath && pass === 2 && u.searchParams.get("page") === "1") change(r);
      } });
      await assert.rejects(() => proveBuildPublicationHistory(f.ctx, f.read), /changed|incomplete/);
    });
  }

  test("untrusted current list identity and independent attempt workflow ID cannot be interchanged", async () => {
    const f = fixture({ count: 2, change(r, u) {
      if (u.pathname.endsWith("/runs/2/attempts/1")) r.data.workflow_id = 99;
    } });
    await assert.rejects(() => proveBuildPublicationHistory(f.ctx, f.read), /another workflow/);
  });

  for (const id of [1, 2]) {
    test(`independent attempt repository ID disagreement refuses for run ${id}`, async () => {
      const f = fixture({ count: 2, change(r, u) {
        if (u.pathname.endsWith(`/runs/${id}/attempts/1`)) {
          r.data.repository = { ...r.data.repository, id: 18 };
          r.data.head_repository = { ...r.data.head_repository, id: 18 };
        }
      } });
      await assert.rejects(() => proveBuildPublicationHistory(f.ctx, f.read), /another repository/);
    });
  }

  for (const removed of [1, 100, 1000]) {
    test(`a deleted run ${removed} before both inventories leaves an unprovable sequence`, async () => {
      const f = fixture();
      f.rows.splice(removed - 1, 1);
      await assert.rejects(() => inventoryProof(f), /run number|run sequence/);
    });
  }

  test("missing current run is not excused by a complete non-push inventory", async () => {
    const f = fixture({ count: 2, change(r, u) {
      if (u.pathname === runPath) r.data.workflow_runs.find((r) => r.id === 2).event = "schedule";
    } });
    await assert.rejects(() => proveBuildPublicationHistory(f.ctx, f.read), /current build run is missing/);
  });

  test("per-page overflow refuses rather than allocating unbounded memory", async () => {
    const f = fixture({ count: 101, change(r, u) {
      if (u.pathname === runPath) r.data.workflow_runs = structuredClone(f.rows);
    } });
    await assert.rejects(() => discoverBuildRuns(f.read), /page exceeds the record bound/);
  });
});
