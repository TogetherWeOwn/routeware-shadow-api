import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Caller seam, deliberately specified before implementation:
 *   planBuildRequest({ repository, sha, runId, attempt, enabled, eventName, ref })
 *     -> { phase: "plan", input: { channel, sha, operation, policy, namespace, latest } }
 *   publishBuildRequest(frozenPlan, { ...context, deployOutcome, deployedVersion })
 *     -> { phase: "publish", plan: frozenPlan }
 * Both exports in ./calver-build.mjs are synchronous/pure. Disabled contexts return
 * null; publication also returns null unless deployOutcome is exactly "success".
 * Eligible contexts with invalid identity/plan/deployedVersion throw Error.
 * enabled is a boolean already evaluated by the existing Actions production gate;
 * runId/attempt are positive safe integers; operation is routeware-build:RUN:ATTEMPT.
 * Only a same-repository push to main is eligible. No token, clock, local notes
 * filename, allocator, network transport or release writer belongs to this seam.
 *
 * The frozen specimen below is a literal output of the released shared engine at
 * 1508f2c10cb83bc0677e8e559ff796a55c66e737, using an empty offline tag history and
 * an injected 2026-03-03T23:59:59.999Z clock. Its provenance is not recomputed here.
 * Shared allocation, collision/replay and tag/Release mutations remain its tests.
 * Structural workflow/doc pins are intentional safety requirements in addition
 * to (not a substitute for) the executable caller tests.
 */
const repository = "TogetherWeOwn/routeware-shadow-api";
const sha = "31cd91285aa6a814c034b66dae6bb17151038d55";
const pin = "1508f2c10cb83bc0677e8e559ff796a55c66e737";
const action = `TogetherWeOwn/.github/actions/calver@${pin}`;
const context = Object.freeze({
  repository,
  sha,
  runId: 6200345,
  attempt: 2,
  enabled: true,
  eventName: "push",
  ref: "refs/heads/main",
});
const frozenPlan = Object.freeze({
  schema: "calver-plan-v1",
  repository,
  version: "2026.303.0",
  tag: "build/v2026.303.0",
  date: "2026-03-03",
  channel: "stable",
  namespace: "build",
  sha,
  operation: "routeware-build:6200345:2",
  policy: "direct-release",
  latest: "never",
  repairDate: null,
  sourceCanary: null,
  source: null,
  evidence: null,
  previousStableTag: null,
  id: "deffc3f9994c8309550c9ce413d48ab1847cdf4905ee1a0fff3c986ceb624b01",
});
const deployed = Object.freeze({ ...context, deployOutcome: "success", deployedVersion: "2026.303.0" });
const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const adapter = () => import("./calver-build.mjs");

test("planning requests only the stable non-Latest build exception", async () => {
  const { planBuildRequest } = await adapter();
  assert.deepEqual(planBuildRequest(context), {
    phase: "plan",
    input: {
      channel: "stable",
      sha,
      operation: "routeware-build:6200345:2",
      policy: "direct-release",
      namespace: "build",
      latest: "never",
    },
  });
});

test("operation identity binds both the run and attempt without caller-controlled release options", async () => {
  const { planBuildRequest } = await adapter();
  const first = planBuildRequest(context);
  const retry = planBuildRequest({ ...context, attempt: 3 });
  const nextRun = planBuildRequest({ ...context, runId: 6200346 });
  assert.equal(first.input.operation, "routeware-build:6200345:2");
  assert.equal(retry.input.operation, "routeware-build:6200345:3");
  assert.equal(nextRun.input.operation, "routeware-build:6200346:2");
  assert.match(first.input.operation, /^[A-Za-z0-9_.:/-]{1,200}$/);
  assert.deepEqual(planBuildRequest({
    ...context, channel: "canary", namespace: "", latest: "auto", policy: "live-digest",
    operation: "foreign-operation", repairDate: "2025-01-01", notesFile: "/tmp/synthetic-notes",
    token: "synthetic-provider-token", CLOUDFLARE_API_TOKEN: "synthetic-cloud-token",
  }), first);
});

for (const enabled of [false, undefined, null, "true", "false", 1]) {
  test(`disabled/non-boolean enabled=${typeof enabled}:${String(enabled)} cannot request a plan or publication`, async () => {
    const { planBuildRequest, publishBuildRequest } = await adapter();
    assert.equal(planBuildRequest({ ...context, enabled }), null);
    assert.equal(publishBuildRequest(frozenPlan, { ...deployed, enabled }), null);
  });
}

for (const [name, change] of [
  ["foreign repository", { repository: "TogetherWeOwn/another-product" }],
  ["case-variant repository", { repository: "togetherweown/routeware-shadow-api" }],
  ["missing repository", { repository: undefined }],
  ["short SHA", { sha: sha.slice(0, 7) }],
  ["uppercase SHA", { sha: sha.toUpperCase() }],
  ["nonhex SHA", { sha: "z".repeat(40) }],
  ["SHA with newline", { sha: `${sha}\n` }],
  ["missing SHA", { sha: undefined }],
  ["zero run", { runId: 0 }],
  ["negative run", { runId: -1 }],
  ["string run", { runId: "6200345" }],
  ["unsafe run", { runId: Number.MAX_SAFE_INTEGER + 1 }],
  ["missing run", { runId: undefined }],
  ["zero attempt", { attempt: 0 }],
  ["fractional attempt", { attempt: 1.5 }],
  ["string attempt", { attempt: "2" }],
  ["unsafe attempt", { attempt: Number.MAX_SAFE_INTEGER + 1 }],
  ["missing attempt", { attempt: undefined }],
  ["PR event", { eventName: "pull_request" }],
  ["manual event", { eventName: "workflow_dispatch" }],
  ["scheduled event", { eventName: "schedule" }],
  ["tag ref", { ref: "refs/tags/v1.0.0" }],
  ["feature ref", { ref: "refs/heads/feature" }],
]) {
  test(`eligible caller refuses ${name} rather than creating an action request`, async () => {
    const { planBuildRequest, publishBuildRequest } = await adapter();
    assert.throws(() => planBuildRequest({ ...context, ...change }), Error);
    assert.throws(() => publishBuildRequest(frozenPlan, { ...deployed, ...change }), Error);
  });
}

for (const deployOutcome of [undefined, null, "failure", "cancelled", "skipped", "", "SUCCESS", true]) {
  test(`deploy outcome ${String(deployOutcome)} cannot request publication`, async () => {
    const { publishBuildRequest } = await adapter();
    assert.equal(publishBuildRequest(frozenPlan, { ...deployed, deployOutcome }), null);
  });
}

test("successful deployment hands the exact frozen plan to the shared publisher", async () => {
  const { publishBuildRequest } = await adapter();
  const request = publishBuildRequest(frozenPlan, deployed);
  assert.deepEqual(request, { phase: "publish", plan: frozenPlan });
  assert.strictEqual(request.plan, frozenPlan, "do not reconstruct or prune shared provenance");
  assert.deepEqual(JSON.parse(JSON.stringify(request)), { phase: "publish", plan: frozenPlan });
});

test("cross-midnight publication and a retry keep the deployed version, date, operation and provenance", async (t) => {
  const { publishBuildRequest } = await adapter();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-03-03T23:59:59.999Z") });
  const before = publishBuildRequest(frozenPlan, deployed);
  t.mock.timers.setTime(Date.parse("2026-03-04T00:00:00.001Z"));
  const after = publishBuildRequest(frozenPlan, deployed);
  assert.deepEqual(before, { phase: "publish", plan: frozenPlan });
  assert.deepEqual(after, before);
  assert.equal(after.plan.version, "2026.303.0");
  assert.equal(after.plan.tag, "build/v2026.303.0");
  assert.equal(after.plan.date, "2026-03-03");
  assert.strictEqual(after.plan, frozenPlan);
});

for (const deployedVersion of [undefined, "", "2026.304.0", "2026.303.1", "build/v2026.303.0", "1.0.0"]) {
  test(`successful outcome with mismatched deployed version ${String(deployedVersion)} refuses publication`, async () => {
    const { publishBuildRequest } = await adapter();
    assert.throws(() => publishBuildRequest(frozenPlan, { ...deployed, deployedVersion }), Error);
  });
}

// Adversarial specimens have literal, internally consistent SHA-256 provenance
// fingerprints. Rejecting a stale fingerprint alone is not policy/context validation.
// These fixtures do not copy the shared allocator or its test suite.
for (const [name, change] of [
  ["schema", { schema: "unknown-plan", id: "a095722821f9fe8a3f4523817dc66d54b00f7002a3877aa66d7a0eb874093b75" }],
  ["repository", { repository: "TogetherWeOwn/another-product", id: "9b7292b977a776214296ae811b1b517332c7428852d48d763a1c8b37cd6b41ea" }],
  ["SHA", { sha: "a".repeat(40), id: "c60235d7fc150d2c9bd4b2438146dc146ee3762c2b2564d3ec5ce1f09dfc07cc" }],
  ["channel", { channel: "canary", version: "2026.303.0-canary.1", tag: "build/canary/v2026.303.0-canary.1", id: "c2e64d5423d2cf5579e7a79466ce113fe526b515c6fe5a8d58a79578c40f264d" }],
  ["namespace", { namespace: "", tag: "v2026.303.0", id: "2b646588c4c87ef5db20c5a6f0d6b02e2e4a7ebbf45d6888d04e8fc450770075" }],
  ["policy", { policy: "live-digest", id: "a3c09e835e0217734551cdaa69d5a46a5f0af223dc319877a9517c2aaf17d4f0" }],
  ["Latest", { latest: "auto", id: "2ef8fa55a3ee111fadd7911484fd37ef237e3dae4040e654e78221c097aebf1f" }],
  ["operation run", { operation: "routeware-build:6200346:2", id: "679407f3c835d2779d78bd9f4b643225811026882e16f1765fe30d3e8be8a7aa" }],
  ["operation attempt", { operation: "routeware-build:6200345:3", id: "50f39171304d05694422512c23fde431e6ccbe018c50f0e84ecc1bcd6fdbe614" }],
  ["plain API tag", { tag: "v2026.303.0", id: "a477ffd5fe9fd10be89c36d029b5058f3130e4ee7a81e6a93a2a1aa2092564c6" }],
  ["tag/version mismatch", { tag: "build/v2026.303.1", id: "2cb7bd2b51d868e7d18459008bc72aabe4a3f78d6fab8abd5e30024ea288f3ea" }],
  ["date/version mismatch", { date: "2026-03-04", id: "ee9b879ce8d2ad2c848692ba11ed753282132492915e0eb8aeedfe0955351eb3" }],
  ["noncanonical version", { version: "2026.0303.0", tag: "build/v2026.0303.0", id: "36214a2b5cd0c49f9ab7aabf34decb0db4ecf4e3fd9eb23042d02a8a03d6a56c" }],
  ["impossible calendar date", { date: "2026-02-29", version: "2026.229.0", tag: "build/v2026.229.0", id: "c120d7955e03e4204a507eb42bfb983a48dbc64b46c396175da0229ef7bf5b0f" }],
  ["missing provenance", { id: undefined }],
  ["repair", { repairDate: "2026-03-03", id: "76018da1f147fe7563c0be7746580b2488223e8c9d9674122cfaf0e86185249a" }],
]) {
  test(`foreign/malformed frozen plan ${name} is refused before the shared publisher`, async () => {
    const { publishBuildRequest } = await adapter();
    assert.throws(() => publishBuildRequest(Object.freeze({ ...frozenPlan, ...change }), deployed), Error);
  });
}

for (const plan of [undefined, null, {}, "not-json", JSON.stringify(frozenPlan), []]) {
  test(`successful publication refuses a non-plan ${typeof plan}:${String(plan).slice(0, 30)}`, async () => {
    const { publishBuildRequest } = await adapter();
    assert.throws(() => publishBuildRequest(plan, deployed), Error);
  });
}

test("request construction neither mutates inputs nor propagates provider credentials or local notes paths", async (t) => {
  const { planBuildRequest, publishBuildRequest } = await adapter();
  t.mock.method(globalThis, "fetch", () => { throw new Error("caller adapter must be offline"); });
  const input = Object.freeze({
    ...deployed,
    token: "synthetic-github-token",
    CLOUD_API_TOKEN: "synthetic-cloud-token",
    notesFile: "/tmp/synthetic-notes",
    APP_VERSION: "2026.303.0",
  });
  const snapshot = JSON.stringify(input);
  const request = publishBuildRequest(frozenPlan, input);
  assert.deepEqual(request, { phase: "publish", plan: frozenPlan });
  assert.deepEqual(planBuildRequest(input), {
    phase: "plan",
    input: { channel: "stable", sha, operation: "routeware-build:6200345:2", policy: "direct-release", namespace: "build", latest: "never" },
  });
  assert.equal(JSON.stringify(input), snapshot);
  assert.doesNotMatch(JSON.stringify(request), /synthetic-(?:github|cloud)-token|synthetic-notes|APP_VERSION|notesFile/);
});

// These helpers inspect the repository's conventional YAML indentation, not a
// second workflow engine. Behavior-level refusal and frozen-plan tests are above.
function jobs() {
  const yaml = read("../.github/workflows/ci.yml");
  const start = yaml.indexOf("\njobs:\n");
  assert.ok(start >= 0, "CI must declare its existing jobs");
  const body = yaml.slice(start + 7);
  const markers = [...body.matchAll(/^  ([\w-]+):\s*$/gm)];
  return { yaml, entries: Object.fromEntries(markers.map((m, i) => [m[1], body.slice(m.index, markers[i + 1]?.index)])) };
}
function steps(job) {
  return job.split(/(?=^      - )/m).slice(1).map((text) => ({
    text,
    // Ignore comments when asserting actual safety controls.
    executable: text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n"),
    id: text.match(/^\s+(?:- )?id:\s*([\w-]+)\s*$/m)?.[1],
  }));
}
function runBody(step) {
  const lines = step.executable.split("\n");
  const start = lines.findIndex((line) => /^        run: /.test(line));
  assert.ok(start >= 0, "caller has an executable run step");
  let end = start + 1;
  while (end < lines.length && !/^        [\w-]+:/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}
function production() {
  const parsed = jobs();
  assert.ok(parsed.entries.deploy, "retain the existing production job, not a second release job");
  return { ...parsed, job: parsed.entries.deploy, steps: steps(parsed.entries.deploy) };
}
function sharedSteps() {
  const p = production();
  const shared = p.steps.filter((s) => s.executable.includes("uses: TogetherWeOwn/.github/actions/calver@"));
  assert.equal(shared.length, 2, "plan and publish must both use the approved immutable shared step action");
  for (const step of shared) {
    const uses = step.executable.match(/^\s+(?:- )?uses:\s*(\S+)/m)?.[1];
    assert.equal(uses, action, "use exactly the approved 40-hex tooling pin, not a ref or suffix");
  }
  assert.ok(shared[0].id, "the shared planner needs an output identity");
  return { ...p, planner: shared[0], publisher: shared[1] };
}

test("CI preserves the existing jobs, free runners and nightly schedule without creating a release workflow", () => {
  const { yaml, entries } = jobs();
  assert.deepEqual(readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((name) => /\.ya?ml$/.test(name)).sort(),
    ["ci.yml", "post-deploy-probe.yml", "pr-lint.yml", "test-guard.yml"]);
  assert.deepEqual(Object.keys(entries).sort(), ["build", "changes", "ci-ok", "deploy", "hygiene", "shadow-api-v1"].sort());
  assert.equal((yaml.match(/^\s+runs-on:\s*ubuntu-latest\s*$/gm) || []).length, 6);
  assert.doesNotMatch(yaml, /runs-on:\s*(?:\[|self-hosted|ubuntu-.*-(?:core|large))/);
  assert.deepEqual([...yaml.matchAll(/^\s+- cron:\s*["']([^"']+)["']/gm)].map((m) => m[1]), ["23 4 * * *"]);
});

test("production still requires push/main/enabled, successful prerequisites and the one uncancelled transaction lock", () => {
  const { job } = production();
  assert.match(job, /^    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && vars\.PRODUCTION_DEPLOY_ENABLED == 'true'\s*$/m);
  assert.match(job, /^    needs: \[build, hygiene\]\s*$/m);
  assert.match(job, /^    environment: production\s*$/m);
  assert.match(job, /^    timeout-minutes: 20\s*$/m);
  assert.match(job, /concurrency:\s*\n\s+group: deploy-production\s*\n\s+cancel-in-progress: false/);
  const executable = job.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(executable, /always\s*\(|continue-on-error:\s*true/);
});

test("both shared phases are inside the serialized job around the existing preflight/migrate/deploy ordering", () => {
  const { yaml, job, steps: all, planner, publisher } = sharedSteps();
  assert.equal((yaml.match(/^\s+(?:- )?uses: TogetherWeOwn\/\.github\/actions\/calver@/gm) || []).length,
    2, "no out-of-lock shared writer");
  const preflight = all.findIndex((s) => /run:.*check-r2-preflight\.mjs --config=["']?\$WRANGLER_CONFIG/.test(s.executable));
  const migrate = all.findIndex((s) => /run: npm run db:migrate:remote/.test(s.executable));
  const deploy = all.findIndex((s) => /\bwrangler deploy\b/.test(s.executable));
  assert.ok(preflight >= 0 && preflight < migrate && migrate < deploy, "preserve R2 preflight and migration-before-deploy");
  assert.ok(all.indexOf(planner) < deploy && deploy < all.indexOf(publisher), "plan before deploy; publish only after successful Wrangler");
  assert.match(job, /WRANGLER_CONFIG: wrangler\.toml/);
  for (const step of [planner, publisher]) {
    assert.match(step.executable, /runs-on-json:\s*['"](?:"ubuntu-latest"|'ubuntu-latest')['"]/);
    assert.doesNotMatch(step.executable, /CLOUDFLARE|CF_TOKEN|notes-file|(?:always|failure|cancelled)\s*\(|continue-on-error:\s*true/);
  }
});

test("Wrangler receives the frozen shared version as a Worker var, never a contract-version rewrite", () => {
  const { steps: all, planner } = sharedSteps();
  const worker = all.find((s) => /\bwrangler deploy\b/.test(s.executable));
  assert.ok(worker?.id, "bind publication to the actual Wrangler step outcome");
  assert.ok(worker.executable.includes(`BUILD_VERSION: \${{ steps.${planner.id}.outputs.version }}`), "stamp the planner's frozen version through trusted environment data");
  assert.match(worker.executable, /--var\b[^\n]*BUILD_VERSION/);
  assert.doesNotMatch(runBody(worker), /\$\{\{|--define|APP_VERSION|npm version/);
});

test("caller adapters bind trusted Actions identity and pass the exact frozen plan plus deploy outcome through environment data", () => {
  const { job, steps: all, planner, publisher } = sharedSteps();
  const callers = all.filter((s) => s.executable.includes("scripts/calver-build.mjs"));
  assert.equal(callers.length, 2, "build one plan request and one success-only publish request");
  assert.ok(all.indexOf(callers[0]) < all.indexOf(planner));
  const worker = all.find((s) => /\bwrangler deploy\b/.test(s.executable));
  assert.ok(worker?.id);
  assert.ok(all.indexOf(worker) < all.indexOf(callers[1]) && all.indexOf(callers[1]) < all.indexOf(publisher));
  assert.ok(callers[1].executable.includes(`steps.${planner.id}.outputs.plan`), "publish the saved shared plan, not a fresh allocation");
  assert.ok(callers[1].executable.includes(`steps.${worker.id}.outcome`), "bind actual deploy outcome, not job success or a literal success");
  for (const field of ["github.repository", "github.sha", "github.run_id", "github.run_attempt"]) {
    assert.ok(job.includes(field), `trusted context must bind ${field}`);
  }
  for (const caller of callers) {
    assert.doesNotMatch(runBody(caller), /\$\{\{|CLOUDFLARE|CF_TOKEN|notes-file|npm version|APP_VERSION/);
  }
  assert.match(job, /^    permissions:\s*\n(?:^      [^\n]*\n)*?^      contents: write\s*$/m);
  assert.match(job, /^      actions: read\s*$/m);
  assert.match(job, /persist-credentials: false/);
});

test("offline caller acceptance is wired into an existing required CI path", () => {
  const pkg = JSON.parse(read("../package.json"));
  assert.match(pkg.scripts["test:probe"], /(?:^|\s)scripts\/calver-build\.acceptance\.test\.mjs(?:\s|$)/);
  const { entries } = jobs();
  assert.match(entries.hygiene, /run: npm run test:probe/);
  assert.match(entries["ci-ok"], /needs: \[changes, build, shadow-api-v1, hygiene\]/);
});

test("consumer SemVer numbering, exact annotated tags, CHANGELOG and deprecation promises stay active", () => {
  const policy = read("../docs/VERSIONING.md").replaceAll("**", "").replace(/\s+/g, " ");
  const pkg = JSON.parse(read("../package.json"));
  assert.match(pkg.version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.doesNotMatch(pkg.version, /^20\d{2}\./);
  assert.match(policy, /package\.json#version.*single source of truth.*(?:release|contract)/i);
  assert.match(policy, /info\.version.*src\/lib\/version\.ts/);
  assert.match(policy, /minimum of 30 days/);
  assert.match(policy, /Removal happens only in a major version bump.*never in a minor or patch/);
  assert.match(policy, /CHANGELOG\.md.*replacement.*earliest removal date/);
  assert.match(policy, /annotated.*vX\.Y\.Z.*exactly matching.*package\.json#version/);
  assert.match(policy, /git tag -a vX\.Y\.Z/);
  assert.match(policy, /consumer-facing notes/);
});

test("version policy separates frozen UTC build releases from the unchanged consumer contract and Latest", () => {
  const policy = read("../docs/VERSIONING.md").replace(/\s+/g, " ");
  for (const required of ["BUILD_VERSION", "X-Build-Version", "APP_VERSION", "build/vYYYY.MDD.P", "2026.105.0", "2026.303.0", pin]) {
    assert.ok(policy.includes(required), `document the separate build domain: ${required}`);
  }
  assert.match(policy, /UTC/);
  assert.match(policy, /(?:frozen|freeze)/i);
  assert.match(policy, /(?:independent|separate).*counter/i);
  assert.match(policy, /direct-release/);
  assert.match(policy, /latest[^.]{0,120}never|never[^.]{0,120}Latest|non-Latest/i);
  assert.match(policy, /PRODUCTION_DEPLOY_ENABLED/);
  assert.match(policy, /(?:successful|success-only).*deploy|deploy.*(?:successful|success-only)/i);
  assert.match(policy, /(?:rollback|revert)/i);
  assert.match(policy, /(?:never|not|no)[^.]{0,90}(?:move|mutat|rewrit)[^.]{0,60}tag|immutable[^.]{0,60}tag/i);
  const prefixRule = policy.indexOf("No other prefixes, suffixes, or lightweight tags.");
  if (prefixRule >= 0) {
    assert.match(policy.slice(Math.max(0, prefixRule - 400), prefixRule), /API contract tags|consumer contract tags/i,
      "scope the prefix restriction explicitly to API contract tags, not all build tags");
  }
});

/**
 * Additional admission seam (original acceptance above stays unchanged):
 *   await assertBuildPublicationHistory(context, api)
 * Export from ./calver-build.mjs; context has the original repository/sha/runId/
 * attempt/enabled/eventName/ref fields. Resolve on proven safe admission, throw
 * Error on unsafe OR incomplete evidence. Disabled contexts do no reads. This
 * read-only guard runs BEFORE allocating/stamping a new build under the existing
 * deploy-production lock; it never reconciles by writing a tag/release/deployment.
 *
 * api.request("GET", path) returns Promise<{status, headers, data}>: the ordinary
 * GitHub REST response envelope, with JSON data and lowercase Link headers.
 * Paths are repository-relative (absolute api.github.com pagination URLs are also
 * allowed). Supported reads: workflows/ci.yml/runs (branch=main,event=push), exact
 * runs/:run/attempts/:attempt, attempts/:attempt/jobs, and contents of the exact
 * historical .github/workflows/ci.yml?ref=HEAD_SHA. Lists use per_page=100 and
 * explicit page=1,2,...; Link and total_count must establish complete enumeration.
 * No implicit "latest attempt", time-window cutoff or first-page-only shortcut.
 *
 * Bind the current attempt to its independently read same-repository/main-push
 * metadata, then exclude ONLY that still-running attempt's unfinished jobs.
 * Examine every earlier attempt, including earlier attempts of the current run.
 * The exact same-attempt plan/deploy/publish step names below are the current
 * serialized workflow's contract. A successful publish step is proof only with
 * the matching run/SHA/attempt, unique job/steps and that versioned workflow's
 * frozen-plan wiring; whole-job/workflow success is not publication proof.
 * Legacy runs without build labels require the exact historical workflow source
 * to demonstrate that absence; missing steps in a build-aware workflow are NOT
 * automatically legacy. No newly planned build or an explicitly skipped deploy
 * is safe; a planned build with failed/cancelled/unknown deployment may be live.
 * Missing/masked publication after any such deployment blocks new allocation.
 *
 * CLI integration: invoke `node scripts/calver-build.mjs history` in the EXISTING
 * plan-request step before its `... plan` command. A separate adapter step would
 * violate the original two-caller-step assertion above. Existing job permissions,
 * runner and lock suffice; this adds no job, resource, schedule or write scope.
 */
const historyWorkflow = ".github/workflows/ci.yml";
const historyRoot = `/repos/${repository}`;
const historyNames = Object.freeze({
  job: "Deploy to Cloudflare Workers",
  plan: "Plan deployment build identity",
  deploy: "Deploy Worker",
  publish: "Publish non-Latest deployment build",
});
const historyContext = Object.freeze({ ...context, runId: 9000, attempt: 1, sha: "b".repeat(40) });
const buildAwareWorkflow = `name: CI
on:
  push:
    branches: [main]
jobs:
  deploy:
    name: Deploy to Cloudflare Workers
    environment: production
    concurrency:
      group: deploy-production
      cancel-in-progress: false
    steps:
      - name: Construct build plan request
        id: build-request
        run: node scripts/calver-build.mjs plan
      - name: Plan deployment build identity
        id: build-version
        uses: ${action}
        with:
          runs-on-json: '"ubuntu-latest"'
          request: \${{ steps.build-request.outputs.request }}
      - name: Deploy Worker
        id: worker
        run: npx wrangler deploy --var BUILD_VERSION:"$BUILD_VERSION"
        env:
          BUILD_VERSION: \${{ steps.build-version.outputs.version }}
      - name: Construct successful build publication request
        id: publish-request
        env:
          CALVER_PLAN: \${{ steps.build-version.outputs.plan }}
          CALVER_DEPLOY_OUTCOME: \${{ steps.worker.outcome }}
          BUILD_VERSION: \${{ steps.build-version.outputs.version }}
        run: node scripts/calver-build.mjs publish
      - name: Publish non-Latest deployment build
        uses: ${action}
        with:
          runs-on-json: '"ubuntu-latest"'
          request: \${{ steps.publish-request.outputs.request }}
`;
const legacyWorkflow = `name: CI
on:
  push:
    branches: [main]
jobs:
  deploy:
    name: Deploy to Cloudflare Workers
    steps:
      - name: Deploy Worker
        run: npx wrangler deploy
`;

function historyRun(id, attempt = 1, changes = {}) {
  return {
    id, run_attempt: attempt, workflow_id: 42, path: historyWorkflow,
    repository: { id: 17, full_name: repository }, head_repository: { id: 17, full_name: repository },
    head_sha: id === 9000 ? historyContext.sha : "a".repeat(40), head_branch: "main", event: "push",
    status: "completed", conclusion: "failure",
    created_at: "2026-03-03T01:00:00Z", run_started_at: "2026-03-03T01:00:01Z", updated_at: "2026-03-03T01:05:00Z",
    ...changes,
  };
}
function historyStep(name, number, conclusion) {
  return { name, number, status: conclusion === null ? "in_progress" : "completed", conclusion,
    started_at: "2026-03-03T01:01:00Z", completed_at: conclusion === null ? null : "2026-03-03T01:02:00Z" };
}
function priorAttempt({ id = 8000, attempt = 1, plan = "success", deploy = "success", publish = "failure", legacy = false } = {}) {
  const run = historyRun(id, attempt);
  const job = {
    id: id * 10 + attempt, run_id: id, run_attempt: attempt, head_sha: run.head_sha,
    name: historyNames.job, status: "completed", conclusion: publish === "success" ? "success" : "failure",
    started_at: run.run_started_at, completed_at: run.updated_at,
    steps: legacy ? [historyStep(historyNames.deploy, 1, deploy)] : [
      historyStep(historyNames.plan, 1, plan), historyStep(historyNames.deploy, 2, deploy), historyStep(historyNames.publish, 3, publish),
    ],
  };
  return { run, job, workflow: legacy ? legacyWorkflow : buildAwareWorkflow };
}

function historyFixture(attempts = [], options = {}) {
  const ctx = { ...historyContext, ...options.context };
  const current = historyRun(ctx.runId, ctx.attempt, {
    head_sha: ctx.sha, status: "in_progress", conclusion: null,
    created_at: "2026-03-03T23:00:00Z", run_started_at: "2026-03-03T23:00:01Z", updated_at: "2026-03-03T23:00:01Z",
  });
  const latest = new Map();
  for (const item of attempts) {
    if (!latest.has(item.run.id) || latest.get(item.run.id).run_attempt < item.run.run_attempt) latest.set(item.run.id, item.run);
  }
  latest.set(current.id, current);
  const pages = options.runPages ?? [[...latest.values()]];
  const total = options.total ?? pages.flat().length;
  const calls = [];
  const known = new Map(attempts.map((a) => [`${a.run.id}/${a.run.run_attempt}`, a]));
  const source = new Map(attempts.map((a) => [a.run.head_sha, a.workflow]));
  source.set(ctx.sha, buildAwareWorkflow);
  function pageResponse(rows, page, key, makePath, declaredTotal = rows.flat().length) {
    if (!rows[page - 1]) throw new Error("Unexpected synthetic page");
    const next = page < rows.length ? `<https://api.github.com${makePath(page + 1)}>; rel="next"` : undefined;
    return { status: 200, headers: next ? { link: next } : {}, data: { total_count: declaredTotal, [key]: rows[page - 1] } };
  }
  const api = { async request(method, path) {
    calls.push({ method, path });
    assert.ok(calls.length <= (options.maxRequests ?? 100), "bounded fixture tripwire: pagination must not loop");
    assert.equal(method, "GET", "history admission must never mutate provider state");
    const url = new URL(path, "https://api.github.com");
    assert.equal(url.origin, "https://api.github.com", "do not follow foreign pagination URLs");
    if (url.pathname.startsWith("/repositories/")) {
      assert.ok(calls.slice(0, -1).some((c) => new URL(c.path, url).pathname === historyRoot),
        "numeric pagination requires an independent canonical repository lookup first");
      assert.ok(url.pathname.startsWith("/repositories/17/"), "never read a foreign numeric repository");
      url.pathname = url.pathname.replace("/repositories/17/", `${historyRoot}/`);
    }
    assert.ok(url.pathname === historyRoot || url.pathname.startsWith(`${historyRoot}/`), "history reads stay in this repository");
    if (options.fail?.test(url.pathname)) throw Object.assign(new Error("Synthetic history provider unavailable"), { status: 503 });
    let response;
    const match = url.pathname.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)(\/jobs)?$/);
    if (url.pathname === historyRoot) {
      response = { status: 200, headers: {}, data: {
        id: 17, full_name: repository, name: "routeware-shadow-api", owner: { login: "TogetherWeOwn" },
      } };
    } else if (url.pathname === `${historyRoot}/actions/workflows/ci.yml/runs`) {
      assert.equal(url.searchParams.get("branch"), "main");
      assert.equal(url.searchParams.get("event"), "push");
      assert.equal(url.searchParams.get("per_page"), "100");
      const n = Number(url.searchParams.get("page"));
      response = pageResponse(pages, n, "workflow_runs", (p) => `${options.runPageRoot ?? historyRoot}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100&page=${p}`, total);
    } else if (match) {
      const key = `${match[1]}/${match[2]}`;
      if (!match[3]) {
        const run = key === `${ctx.runId}/${ctx.attempt}` ? current : known.get(key)?.run;
        assert.ok(run, `unexpected attempt selector ${key}`);
        response = { status: 200, headers: {}, data: run };
      } else {
        assert.notEqual(key, `${ctx.runId}/${ctx.attempt}`, "do not require current transaction's unfinished publication");
        const item = known.get(key);
        assert.ok(item, `unexpected job attempt selector ${key}`);
        const rows = item.jobPages ?? [[item.job]];
        assert.equal(url.searchParams.get("per_page"), "100");
        response = pageResponse(rows, Number(url.searchParams.get("page")), "jobs",
          (p) => `${options.jobPageRoot ?? historyRoot}/actions/runs/${match[1]}/attempts/${match[2]}/jobs?per_page=100&page=${p}`, item.jobTotal);
      }
    } else if (url.pathname === `${historyRoot}/contents/${historyWorkflow}`) {
      const ref = url.searchParams.get("ref");
      assert.match(ref ?? "", /^[a-f0-9]{40}$/, "legacy classification uses immutable workflow source, never main/latest");
      assert.ok(source.has(ref), "workflow source must bind a known attempt SHA");
      const text = source.get(ref);
      response = { status: 200, headers: {}, data: {
        type: "file", path: historyWorkflow, sha: "c".repeat(40), encoding: "base64", size: Buffer.byteLength(text),
        content: Buffer.from(text).toString("base64"),
      } };
    } else throw new Error(`Unexpected read in hermetic history fixture: ${url.pathname}`);
    const copy = structuredClone(response);
    return options.transform?.(copy, url) ?? copy;
  } };
  return { ctx, api, calls };
}
async function historyGuard() {
  const { assertBuildPublicationHistory } = await adapter();
  assert.equal(typeof assertBuildPublicationHistory, "function", "missing read-only publication-history admission guard export");
  return assertBuildPublicationHistory;
}
async function historyRefuses(fixture) {
  const guard = await historyGuard(); // A missing export must fail this test, not satisfy assert.rejects below.
  await assert.rejects(async () => guard(fixture.ctx, fixture.api), Error);
  assert.ok(fixture.calls.every((c) => c.method === "GET"));
}
async function historyPermits(fixture) {
  const guard = await historyGuard();
  await guard(fixture.ctx, fixture.api);
  assert.ok(fixture.calls.some((c) => c.path.includes(`/actions/runs/${fixture.ctx.runId}/attempts/${fixture.ctx.attempt}`)),
    "admission must bind current provider identity, not merely return success");
  assert.ok(fixture.calls.some((c) => c.path.includes("/actions/workflows/ci.yml/runs")), "enumerate history before permitting allocation");
  return fixture;
}

describe("unpublished deployment admission", () => {
beforeEach((t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected un-injected network request in history acceptance"); });
});

test("history guard: deploy A then unpublished tag cannot admit allocation for different SHA B", async () => {
  const previous = priorAttempt(); // A may be live, but failed publication left tag history unchanged.
  const fixture = historyFixture([previous]);
  await historyRefuses(fixture);
  assert.ok(fixture.calls.some((c) => c.path.includes("/runs/8000/attempts/1/jobs")), "inspect A's executed steps");
});

for (const publication of ["failure", "cancelled", "skipped", null]) {
  test(`history guard: successful deploy plus ${String(publication)} publication refuses even if the job says success`, async () => {
    const previous = priorAttempt({ publish: publication });
    previous.job.conclusion = "success";
    previous.run.conclusion = "success";
    await historyRefuses(historyFixture([previous]));
  });
}
for (const outcome of ["failure", "cancelled", null]) {
  test(`history guard: planned build with ambiguous deploy ${String(outcome)} and no publication blocks`, async () => {
    await historyRefuses(historyFixture([priorAttempt({ deploy: outcome, publish: "skipped" })]));
  });
}
for (const [name, item] of [
  ["same-attempt successful publication", priorAttempt({ publish: "success" })],
  ["no planned build and skipped deployment", priorAttempt({ plan: "skipped", deploy: "skipped", publish: "skipped" })],
  ["planned build but unambiguously skipped deployment", priorAttempt({ deploy: "skipped", publish: "skipped" })],
]) {
  test(`history guard: ${name} permits continuing under the lock`, async () => {
    const fixture = await historyPermits(historyFixture([item]));
    assert.ok(fixture.calls.some((c) => c.path.includes("/runs/8000/attempts/1/jobs")));
  });
}

test("history guard: a wholly skipped production job with no steps is affirmative no-plan evidence", async () => {
  const prior = priorAttempt();
  Object.assign(prior.job, { conclusion: "skipped", steps: [], started_at: null, completed_at: null });
  await historyPermits(historyFixture([prior]));
});
test("history guard: complete empty prior history permits but excludes the current still-running transaction", async () => {
  await historyPermits(historyFixture());
});
test("history guard: real legacy no-build workflow permits without inventing publication evidence", async () => {
  const fixture = await historyPermits(historyFixture([priorAttempt({ legacy: true })]));
  assert.ok(fixture.calls.some((c) => c.path.includes(`/contents/${historyWorkflow}`) && c.path.includes("a".repeat(40))),
    "prove legacy using the workflow at that run's exact SHA");
});
test("history guard: missing build steps in a build-aware workflow are not classified as legacy", async () => {
  const prior = priorAttempt({ legacy: true });
  prior.workflow = buildAwareWorkflow;
  await historyRefuses(historyFixture([prior]));
});
test("history guard: latest rerun success cannot conceal an earlier deployed-unpublished attempt", async () => {
  const fixture = historyFixture([priorAttempt(), priorAttempt({ attempt: 2, publish: "success" })]);
  await historyRefuses(fixture);
  assert.ok(fixture.calls.some((c) => c.path.includes("/runs/8000/attempts/1/jobs")));
});
test("history guard: only the current attempt is excluded, not an unresolved earlier attempt of the same run", async () => {
  await historyRefuses(historyFixture([priorAttempt({ id: 9000 })], { context: { attempt: 2 } }));
});
test("history guard: a skipped old attempt and published rerun are both examined before permission", async () => {
  const fixture = await historyPermits(historyFixture([
    priorAttempt({ plan: "skipped", deploy: "skipped", publish: "skipped" }), priorAttempt({ attempt: 2, publish: "success" }),
  ]));
  for (const attempt of [1, 2]) assert.ok(fixture.calls.some((c) => c.path.includes(`/runs/8000/attempts/${attempt}/jobs`)));
});

test("history guard: unpublished earlier run on a second run-history page still blocks", async () => {
  const current = historyRun(9000, 1, { head_sha: historyContext.sha, status: "in_progress", conclusion: null });
  const prior = priorAttempt();
  const fixture = historyFixture([prior], { runPages: [[current], [prior.run]] });
  await historyRefuses(fixture);
  assert.ok(fixture.calls.some((c) => c.path.includes("/workflows/ci.yml/runs") && new URL(c.path, "https://api.github.com").searchParams.get("page") === "2"));
});
test("history guard: publication evidence on a second job page is not mistaken for missing publication", async () => {
  const prior = priorAttempt({ publish: "success" });
  prior.jobPages = [[{ ...prior.job, id: 123, name: "Typecheck, test, build", steps: [] }], [prior.job]];
  const fixture = await historyPermits(historyFixture([prior]));
  assert.ok(fixture.calls.some((c) => c.path.includes("/jobs") && new URL(c.path, "https://api.github.com").searchParams.get("page") === "2"));
});

for (const [name, options] of [
  ["truncated run search (including GitHub's search cap)", { total: 1001 }],
  ["run-history provider failure", { fail: /\/workflows\/ci.yml\/runs$/ }],
  ["attempt metadata provider failure", { fail: /\/runs\/8000\/attempts\/1$/ }],
  ["job evidence provider failure", { fail: /\/jobs$/ }],
  ["legacy source provider failure", { fail: /\/contents\// }],
  ["non-success provider envelope", { transform: (r, u) => u.pathname.endsWith("/jobs") ? { ...r, status: 403 } : r }],
  ["missing run collection", { transform: (r, u) => u.pathname.endsWith("/runs") ? { ...r, data: { total_count: 0 } } : r }],
  ["invalid run count", { transform: (r, u) => u.pathname.endsWith("/runs") ? { ...r, data: { ...r.data, total_count: -1 } } : r }],
  ["missing run count", { transform: (r, u) => { if (u.pathname.endsWith("/runs")) delete r.data.total_count; return r; } }],
  ["duplicate run records", { transform: (r, u) => u.pathname.endsWith("/runs") ? { ...r, data: {
    total_count: r.data.total_count + 1, workflow_runs: [...r.data.workflow_runs, r.data.workflow_runs[0]],
  } } : r }],
  ["missing prior attempt (provider 404)", { transform: (r, u) => u.pathname.endsWith("/runs/8000/attempts/1") ? { status: 404, headers: {}, data: { message: "Not Found" } } : r }],
  ["missing jobs", { transform: (r, u) => u.pathname.endsWith("/jobs") ? { ...r, data: { total_count: 0 } } : r }],
  ["truncated job collection", { transform: (r, u) => u.pathname.endsWith("/jobs") ? { ...r, data: { ...r.data, total_count: 2 } } : r }],
  ["foreign next-page origin", { transform: (r, u) => u.pathname.endsWith("/runs") ? { ...r, headers: { link: '<https://foreign.example.test/history?page=2>; rel="next"' } } : r }],
  ["foreign next-page repository", { transform: (r, u) => u.pathname.endsWith("/runs") ? { ...r, headers: { link: '<https://api.github.com/repos/another/project/actions/runs?page=2>; rel="next"' } } : r }],
  ["cyclic next-page link", { transform: (r, u) => u.pathname.endsWith("/runs") ? { ...r, headers: { link: `<https://api.github.com${u.pathname}${u.search}>; rel="next"` } } : r }],
]) {
  test(`history guard: ${name} fails closed rather than treating uncertainty as absence`, async () => {
    const fixture = historyFixture([priorAttempt({ legacy: true })], options);
    await historyRefuses(fixture);
    assert.ok(fixture.calls.length <= 12, "recognize incomplete/cyclic evidence without spinning to the fixture hard stop");
    assert.ok(fixture.calls.every((c) => new URL(c.path, "https://api.github.com").origin === "https://api.github.com"));
    assert.ok(fixture.calls.every((c) => new URL(c.path, "https://api.github.com").pathname.startsWith(`${historyRoot}/`)));
  });
}
for (const [name, change] of [
  ["different run id", { id: 7000 }], ["different SHA", { head_sha: "d".repeat(40) }],
  ["different attempt", { run_attempt: 3 }], ["foreign repository", { repository: { id: 18, full_name: "Another/repo" } }],
  ["foreign head repository", { head_repository: { id: 18, full_name: "Another/repo" } }],
  ["manual event", { event: "workflow_dispatch" }], ["non-main branch", { head_branch: "feature" }],
  ["other workflow", { path: ".github/workflows/other.yml" }],
]) {
  test(`history guard: independently read current metadata with ${name} refuses`, async () => {
    const fixture = historyFixture([], { transform: (r, u) => u.pathname.endsWith("/runs/9000/attempts/1") ? { ...r, data: { ...r.data, ...change } } : r });
    await historyRefuses(fixture);
  });
}
for (const [name, change] of [
  ["foreign context repository", { repository: "Another/repo" }], ["short SHA", { sha: "abcdef0" }],
  ["unsafe attempt", { attempt: Number.MAX_SAFE_INTEGER + 1 }], ["zero run id", { runId: 0 }],
  ["manual current event", { eventName: "workflow_dispatch" }], ["non-main current ref", { ref: "refs/heads/feature" }],
]) {
  test(`history guard: ${name} is refused before provider reads`, async () => {
    const fixture = historyFixture([], { context: change });
    await historyRefuses(fixture);
    assert.deepEqual(fixture.calls, []);
  });
}
for (const [name, change] of [
  ["wrong attempt", { run_attempt: 2 }], ["foreign SHA", { head_sha: "d".repeat(40) }], ["wrong run", { run_id: 8001 }],
]) {
  test(`history guard: published job with ${name} cannot satisfy a different operation`, async () => {
    const prior = priorAttempt({ publish: "success" });
    Object.assign(prior.job, change);
    await historyRefuses(historyFixture([prior]));
  });
}
for (const [name, mutate] of [
  ["missing publication step", (p) => p.job.steps.pop()],
  ["missing deployment step", (p) => p.job.steps.splice(1, 1)],
  ["missing planning step", (p) => p.job.steps.shift()],
  ["duplicate publication step", (p) => p.job.steps.push({ ...p.job.steps[2], number: 4 })],
  ["duplicate production job", (p) => { p.jobPages = [[p.job, { ...p.job, id: 800099 }]]; }],
  ["missing production job without terminal cancellation evidence", (p) => {
    Object.assign(p.run, { status: "in_progress", conclusion: null });
    p.jobPages = [[{ ...p.job, name: "Unrelated successful job" }]];
  }],
  ["missing step statuses", (p) => { delete p.job.steps[1].status; }],
  ["no trustworthy legacy workflow bytes", (p) => { p.workflow = ""; }],
]) {
  test(`history guard: ${name} is ambiguous evidence, not permission`, async () => {
    const prior = priorAttempt({ publish: "success", legacy: name.includes("legacy") });
    mutate(prior);
    await historyRefuses(historyFixture([prior]));
  });
}

test("history guard: a disabled production context performs no reads and cannot create provider writes", async () => {
  const guard = await historyGuard();
  const fixture = historyFixture([], { context: { enabled: false } });
  await guard(fixture.ctx, fixture.api);
  assert.deepEqual(fixture.calls, []);
});
test("history guard: CLI admission runs before the first planner in the same existing serialized request step", () => {
  const { steps: all, planner } = sharedSteps();
  const request = all.find((s) => s.executable.includes("scripts/calver-build.mjs") && all.indexOf(s) < all.indexOf(planner));
  assert.ok(request, "retain the original plan-request step");
  const command = runBody(request);
  const history = command.search(/\bnode scripts\/calver-build\.mjs history\b/);
  const plan = command.search(/\bnode scripts\/calver-build\.mjs plan\b/);
  assert.ok(history >= 0 && plan > history, "reconcile/admit history before requesting any new version");
  assert.doesNotMatch(command, /\|\|\s*true|set\s+\+e|always\s*\(|continue-on-error/);
  const condition = request.executable.match(/^        if:\s*(.*)$/m)?.[1];
  assert.ok(condition === undefined || condition === "success()", "admission cannot be skipped while planning proceeds");
});
});

/**
 * Regression controls exercise the real exported guard and real publication CLI.
 * Provider doubles return only synthetic REST records; no admission decision is
 * stubbed. Numeric Link URLs require a separate GET /repos/:owner/:repo identity
 * lookup. Large fixtures opt into a larger test tripwire, not a live API quota.
 * At most 1,000 listed runs / 20 attempts per run are the bounded history contract;
 * completing eligible history must not silently stop at 100 or 200 reads.
 */
describe("publication admission regression controls", () => {
  beforeEach((t) => {
    t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network in admission regression"); });
  });

  for (const unrelatedJobs of [false, true]) {
    test(`terminal cancellation: complete job enumeration with no production job permits (other jobs=${unrelatedJobs})`, async () => {
      const prior = priorAttempt();
      Object.assign(prior.run, { status: "completed", conclusion: "cancelled" });
      prior.jobPages = [unrelatedJobs ? [{ ...prior.job, name: "Credential-free build", conclusion: "success", steps: [] }] : []];
      await historyPermits(historyFixture([prior]));
    });
  }

  for (const completedAt of [null, "2026-03-03T01:05:00Z"]) {
    test(`terminal cancellation: unstarted production job with empty steps permits (completed_at=${completedAt})`, async () => {
      const prior = priorAttempt();
      Object.assign(prior.run, { status: "completed", conclusion: "cancelled" });
      Object.assign(prior.job, { status: "completed", conclusion: "cancelled", started_at: null, completed_at: completedAt, steps: [] });
      await historyPermits(historyFixture([prior]));
    });
  }

  for (const [name, change] of [
    ["nonterminal run", { status: "in_progress", conclusion: null }],
    ["missing run status", { status: undefined, conclusion: "cancelled" }],
    ["nonterminal status with cancelled conclusion", { status: "queued", conclusion: "cancelled" }],
    ["missing cancellation conclusion", { status: "completed", conclusion: null }],
  ]) {
    test(`terminal cancellation: absent production job with ${name} still refuses`, async () => {
      const prior = priorAttempt();
      Object.assign(prior.run, change);
      prior.jobPages = [[]];
      await historyRefuses(historyFixture([prior]));
    });
  }

  for (const [name, mutate] of [
    ["missing jobs array", (r) => { delete r.data.jobs; }],
    ["null jobs array", (r) => { r.data.jobs = null; }],
    ["incomplete enumeration", (r) => { r.data.total_count = 1; }],
    ["malformed job row", (r) => { r.data.jobs = [null]; r.data.total_count = 1; }],
  ]) {
    test(`terminal cancellation: ${name} is not affirmative no-run evidence`, async () => {
      const prior = priorAttempt();
      Object.assign(prior.run, { status: "completed", conclusion: "cancelled" });
      prior.jobPages = [[]];
      await historyRefuses(historyFixture([prior], { transform: (r, u) => {
        if (u.pathname.endsWith("/jobs")) mutate(r);
        return r;
      } }));
    });
  }

  for (const [name, change] of [
    ["started cancelled job", { started_at: "2026-03-03T01:01:00Z" }],
    ["missing start field", { started_at: undefined }],
    ["missing steps", { steps: undefined }],
    ["null steps", { steps: null }],
    ["an executed deployment step", { steps: [historyStep(historyNames.deploy, 1, "cancelled")] }],
  ]) {
    test(`terminal cancellation: ${name} may have consumed a build and refuses`, async () => {
      const prior = priorAttempt();
      Object.assign(prior.run, { status: "completed", conclusion: "cancelled" });
      Object.assign(prior.job, { status: "completed", conclusion: "cancelled", started_at: null, completed_at: null, steps: [], ...change });
      await historyRefuses(historyFixture([prior]));
    });
  }

  test("queued production job: empty steps, null conclusion and no start permits the current lock holder", async () => {
    const prior = priorAttempt();
    Object.assign(prior.run, { status: "in_progress", conclusion: null });
    Object.assign(prior.job, { status: "queued", conclusion: null, started_at: null, completed_at: null, steps: [] });
    await historyPermits(historyFixture([prior]));
  });

  for (const status of ["in_progress", "pending", "waiting"]) {
    test(`queued production job: ${status} with start evidence is not an unstarted queued job`, async () => {
      const prior = priorAttempt();
      Object.assign(prior.run, { status: "in_progress", conclusion: null });
      Object.assign(prior.job, { status, conclusion: null, completed_at: null, steps: [] });
      await historyRefuses(historyFixture([prior]));
    });
  }

  test("legacy execution: an unfinished legacy-shaped job with an in-progress deploy step refuses", async () => {
    const prior = priorAttempt({ legacy: true, deploy: null });
    Object.assign(prior.job, { status: "in_progress", conclusion: null, completed_at: null });
    const fixture = historyFixture([prior]);
    await historyRefuses(fixture);
    assert.ok(fixture.calls.some((c) => c.path.includes("/runs/8000/attempts/1/jobs")), "inspect the unfinished legacy job");
  });

  test("legacy execution: a completed legacy deployment remains a positive control", async () => {
    await historyPermits(historyFixture([priorAttempt({ legacy: true, deploy: "success" })]));
  });

  for (const collection of ["runs", "jobs"]) {
    test(`numeric pagination: a same-repository numeric next Link completes ${collection} after identity validation`, async () => {
      const prior = priorAttempt({ publish: "success" });
      const options = {};
      if (collection === "runs") {
        options.runPages = [[historyRun(9000, 1, { head_sha: historyContext.sha, status: "in_progress", conclusion: null })], [prior.run]];
        options.runPageRoot = "/repositories/17";
      } else {
        prior.jobPages = [[{ ...prior.job, id: 123, name: "Credential-free build", steps: [] }], [prior.job]];
        options.jobPageRoot = "/repositories/17";
      }
      const fixture = await historyPermits(historyFixture([prior], options));
      assert.ok(fixture.calls.some((c) => new URL(c.path, "https://api.github.com").pathname === historyRoot), "independently resolve canonical repository identity");
      const continuation = fixture.calls.findIndex((c) => {
        const url = new URL(c.path, "https://api.github.com");
        return url.pathname.endsWith(collection === "runs" ? "/workflows/ci.yml/runs" : "/runs/8000/attempts/1/jobs") && url.searchParams.get("page") === "2";
      });
      const identity = fixture.calls.findIndex((c) => new URL(c.path, "https://api.github.com").pathname === historyRoot);
      assert.ok(identity >= 0 && continuation > identity, "consume the numeric Link (canonicalizing its URL is allowed) only after independent identity validation");
    });

    test(`numeric pagination: a foreign numeric repository next Link for ${collection} refuses before foreign reads`, async () => {
      const prior = priorAttempt({ publish: "success" });
      const options = collection === "runs"
        ? { runPages: [[historyRun(9000, 1, { head_sha: historyContext.sha, status: "in_progress", conclusion: null })], [prior.run]], runPageRoot: "/repositories/18" }
        : { jobPageRoot: "/repositories/18" };
      if (collection === "jobs") prior.jobPages = [[{ ...prior.job, id: 123, name: "Credential-free build", steps: [] }], [prior.job]];
      const fixture = historyFixture([prior], options);
      await historyRefuses(fixture);
      assert.ok(!fixture.calls.some((c) => c.path.includes("/repositories/18/")), "reject the foreign Link before sending a read");
    });
  }

  test("numeric pagination: canonical metadata for another repository cannot authorize numeric Links", async () => {
    const prior = priorAttempt({ publish: "success" });
    const fixture = historyFixture([prior], {
      runPages: [[historyRun(9000, 1, { head_sha: historyContext.sha, status: "in_progress", conclusion: null })], [prior.run]],
      runPageRoot: "/repositories/17",
      transform: (r, u) => u.pathname === historyRoot ? { ...r, data: { ...r.data, id: 18, full_name: "Another/repo" } } : r,
    });
    await historyRefuses(fixture);
    assert.ok(!fixture.calls.some((c) => c.path.includes("/repositories/17/")));
  });

  for (const [runCount, attemptCount, maxRequests] of [[110, 1, 10_000], [110, 20, 10_000], [999, 20, 60_000]]) {
    test(`bounded history: all ${runCount} prior runs with ${attemptCount} published attempt(s) admit beyond 200 reads`, async () => {
      const attempts = [];
      for (let id = 8000; id < 8000 + runCount; id++) {
        for (let attempt = 1; attempt <= attemptCount; attempt++) {
          const item = priorAttempt({ id, attempt, publish: "success" });
          item.job.id = id * 100 + attempt;
          attempts.push(item);
        }
      }
      const latest = attempts.filter((a) => a.run.run_attempt === attemptCount).map((a) => a.run);
      const rows = [historyRun(9000, 1, { head_sha: historyContext.sha, status: "in_progress", conclusion: null }), ...latest];
      const fixture = await historyPermits(historyFixture(attempts, {
        runPages: Array.from({ length: Math.ceil(rows.length / 100) }, (_, page) => rows.slice(page * 100, (page + 1) * 100)), maxRequests,
      }));
      assert.ok(fixture.calls.length > 200, "exercise real history larger than an arbitrary 200-read cap");
      assert.ok(fixture.calls.length < maxRequests, "legitimate bounded history must not loop or re-read without bound");
      const reads = new Set(fixture.calls.map((c) => new URL(c.path, "https://api.github.com").pathname));
      for (const item of attempts) {
        assert.ok(reads.has(`${historyRoot}/actions/runs/${item.run.id}/attempts/${item.run.run_attempt}`), "read every exact historical attempt, not only the latest");
        assert.ok(reads.has(`${historyRoot}/actions/runs/${item.run.id}/attempts/${item.run.run_attempt}/jobs`), "read every attempt's publication evidence");
      }
    });
  }

  test("bounded history: a declared attempt count over 20 refuses without truncating to the latest attempt", async () => {
    const prior = priorAttempt({ attempt: 21, publish: "success" });
    const fixture = historyFixture([prior]);
    await historyRefuses(fixture);
    assert.ok(fixture.calls.length <= 6, "refuse unsupported bounds before scanning an incomplete prefix");
  });
});

// Evaluate only the real job/step env mapping used by the publication command.
// Expressions are inert lookup keys, never eval or shell interpolation. The CLI
// receives no ambient credentials and a throwing fetch preload in its own process.
function workflowEnvironment(text, indent, values) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `${" ".repeat(indent)}env:`);
  assert.ok(start >= 0, "the publication caller needs explicit trusted environment data");
  const result = {};
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = line.match(new RegExp(`^ {${indent + 2}}([A-Z_]+): (.*)$`));
    if (!match) break;
    let value = match[2];
    const expression = value.match(/^\$\{\{\s*(.*?)\s*\}\}$/)?.[1];
    if (expression !== undefined) {
      assert.ok(Object.hasOwn(values, expression), `unsupported synthetic Actions expression: ${expression}`);
      value = String(values[expression]);
    } else value = value.replace(/^(['"])(.*)\1$/, "$2");
    result[match[1]] = value;
  }
  return result;
}

function runWorkflowPublication(deployOutcome) {
  const { job, steps: all, planner } = sharedSteps();
  const worker = all.find((s) => /\bwrangler deploy\b/.test(s.executable));
  const caller = all.find((s) => /\bnode scripts\/calver-build\.mjs publish\b/.test(s.executable));
  assert.ok(worker?.id && caller, "find the actual deployment-bound publication CLI step");
  const command = runBody(caller).match(/\bnode (scripts\/calver-build\.mjs) (publish)\b/);
  assert.ok(command, "execute the workflow's real publication CLI, not a pure-function substitute");
  const values = {
    "github.repository": repository, "github.sha": sha, "github.run_id": context.runId,
    "github.run_attempt": context.attempt, "github.event_name": "push", "github.ref": "refs/heads/main",
    "vars.PRODUCTION_DEPLOY_ENABLED == 'true'": true,
    [`steps.${planner.id}.outputs.plan`]: JSON.stringify(frozenPlan),
    [`steps.${planner.id}.outputs.version`]: "2026.303.0",
    [`steps.${worker.id}.outcome`]: deployOutcome ?? "",
  };
  const directory = mkdtempSync(join(tmpdir(), "calver-publication-acceptance-"));
  try {
    const output = join(directory, "output");
    const result = spawnSync(process.execPath, [
      "--import", "data:text/javascript,globalThis.fetch=()=>{throw new Error('Unexpected network in publication CLI acceptance')}",
      fileURLToPath(new URL(`../${command[1]}`, import.meta.url)), command[2],
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 10_000, encoding: "utf8", maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH, HOME: directory, NODE_ENV: "test", GITHUB_OUTPUT: output,
        ...workflowEnvironment(job, 4, values), ...workflowEnvironment(caller.executable, 8, values),
      },
    });
    assert.equal(result.error, undefined, "publication CLI must finish within its local offline bound");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    const content = readFileSync(output, "utf8");
    const requests = [...content.matchAll(/^request=(.*)$/gm)];
    assert.equal(requests.length, 1, "emit exactly one Actions request output");
    return requests[0][1];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("workflow CLI publication: success emits the exact saved-plan request using the actual YAML environment", () => {
  const request = runWorkflowPublication("success");
  assert.notEqual(request, "", "a renamed/missing YAML outcome binding must not silently suppress successful publication");
  assert.deepEqual(JSON.parse(request), { phase: "publish", plan: frozenPlan });
});
for (const outcome of ["failure", "skipped", "cancelled", undefined]) {
  test(`workflow CLI publication: ${String(outcome)} deployment emits no publication request`, () => {
    assert.equal(runWorkflowPublication(outcome), "");
  });
}

/**
 * Read-only repair proof extends the SAME injectable GET seam with ordinary REST
 * /tags?per_page=100&page=N (array + Link), /git/ref/tags/:encodedTag,
 * /git/tags/:objectSha, and /releases/tags/:encodedTag response envelopes.
 * These are publication records AFTER an explicit same-lock shared-writer repair;
 * this suite never performs that repair, allocates a version or invokes a writer.
 *
 * The literal plan/annotation below were produced offline by the ACTUAL engine at
 * the approved pin, for routeware-build:8000:1 / a*40 / 2026-03-02T12:00:00Z with
 * empty tag history. The original 2026.303.0 fixture can coexist on a distinct tag.
 * The annotation fingerprint is shared plan provenance, not a signature or proof
 * of rollout. Admission must cross-bind it to independently read attempt/job/SHA
 * and frozen-plan workflow wiring; an arbitrary operation-shaped string is not
 * sufficient. No allocator or provenance implementation is copied into tests.
 */
const repairedPlan = Object.freeze({
  schema: "calver-plan-v1", repository, version: "2026.302.0", tag: "build/v2026.302.0", date: "2026-03-02",
  channel: "stable", namespace: "build", sha: "a".repeat(40), operation: "routeware-build:8000:1",
  policy: "direct-release", latest: "never", repairDate: null, sourceCanary: null, source: null,
  evidence: null, previousStableTag: null, id: "159d3967a240e855f463351aac0ec44eaa264d975024a037065bab8508b44d62",
});
const repairedAnnotation = 'calver-plan-v1\n{"channel":"stable","date":"2026-03-02","evidence":null,"id":"159d3967a240e855f463351aac0ec44eaa264d975024a037065bab8508b44d62","latest":"never","namespace":"build","operation":"routeware-build:8000:1","policy":"direct-release","previousStableTag":null,"publicationEvidence":null,"repairDate":null,"repository":"TogetherWeOwn/routeware-shadow-api","schema":"calver-plan-v1","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source":null,"sourceCanary":null,"tag":"build/v2026.302.0","version":"2026.302.0"}';
const unrelatedAnnotation = 'calver-plan-v1\n{"channel":"stable","date":"2026-03-03","evidence":null,"id":"deffc3f9994c8309550c9ce413d48ab1847cdf4905ee1a0fff3c986ceb624b01","latest":"never","namespace":"build","operation":"routeware-build:6200345:2","policy":"direct-release","previousStableTag":null,"publicationEvidence":null,"repairDate":null,"repository":"TogetherWeOwn/routeware-shadow-api","schema":"calver-plan-v1","sha":"31cd91285aa6a814c034b66dae6bb17151038d55","source":null,"sourceCanary":null,"tag":"build/v2026.303.0","version":"2026.303.0"}';

const otherAttemptAnnotation = 'calver-plan-v1\n{"channel":"stable","date":"2026-03-03","evidence":null,"id":"7386db26264835dd69114ad0e8f2d87b77b025f9fc3ebce2dc23dfbef88effa0","latest":"never","namespace":"build","operation":"routeware-build:8000:2","policy":"direct-release","previousStableTag":null,"publicationEvidence":null,"repairDate":null,"repository":"TogetherWeOwn/routeware-shadow-api","schema":"calver-plan-v1","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source":null,"sourceCanary":null,"tag":"build/v2026.303.0","version":"2026.303.0"}';
const otherShaAnnotation = 'calver-plan-v1\n{"channel":"stable","date":"2026-03-03","evidence":null,"id":"24ac8098ae0a918de74ddce4a95f8a96b289219a744055ef2289bca73a697c5f","latest":"never","namespace":"build","operation":"routeware-build:8000:1","policy":"direct-release","previousStableTag":null,"publicationEvidence":null,"repairDate":null,"repository":"TogetherWeOwn/routeware-shadow-api","schema":"calver-plan-v1","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","source":null,"sourceCanary":null,"tag":"build/v2026.303.0","version":"2026.303.0"}';

function publicationRecord(plan = repairedPlan, annotation = repairedAnnotation, objectSha = "d".repeat(40)) {
  const tagPath = encodeURIComponent(plan.tag);
  return {
    listItem: {
      name: plan.tag, commit: { sha: plan.sha, url: `https://api.github.com${historyRoot}/commits/${plan.sha}` },
      zipball_url: `https://api.github.com${historyRoot}/zipball/${tagPath}`,
      tarball_url: `https://api.github.com${historyRoot}/tarball/${tagPath}`, node_id: "synthetic-tag-list-node",
    },
    ref: {
      ref: `refs/tags/${plan.tag}`, node_id: "synthetic-ref-node", url: `https://api.github.com${historyRoot}/git/refs/tags/${tagPath}`,
      object: { type: "tag", sha: objectSha, url: `https://api.github.com${historyRoot}/git/tags/${objectSha}` },
    },
    tagObject: {
      sha: objectSha, tag: plan.tag, message: annotation, url: `https://api.github.com${historyRoot}/git/tags/${objectSha}`,
      object: { type: "commit", sha: plan.sha, url: `https://api.github.com${historyRoot}/git/commits/${plan.sha}` },
      tagger: { name: "github-actions[bot]", email: "github-actions[bot]@users.noreply.github.com", date: "2026-03-03T01:10:00Z" },
      verification: { verified: false, reason: "unsigned", signature: null, payload: null },
    },
    release: {
      id: plan.tag === repairedPlan.tag ? 701 : 702,
      url: `https://api.github.com${historyRoot}/releases/${plan.tag === repairedPlan.tag ? 701 : 702}`,
      html_url: `https://github.com/${repository}/releases/tag/${plan.tag}`, tag_name: plan.tag,
      target_commitish: plan.sha, name: plan.version, draft: false, prerelease: false,
      created_at: "2026-03-03T01:10:00Z", published_at: "2026-03-03T01:10:01Z", assets: [],
      body: `### Features\n\n* fixture change ([${plan.sha.slice(0, 7)}](https://github.com/${repository}/commit/${plan.sha}))\n\n\n<!-- calver-plan:${plan.id} -->\n\nSource: ${plan.sha}\n`,
    },
  };
}

function publicationFixture(records = [publicationRecord()], options = {}) {
  // Serve full real workflow bytes as the synthetic attempt's immutable source,
  // not the minimal legacy-classification projection used by the original suite.
  const prior = { ...(options.prior ?? priorAttempt()), workflow: options.workflow ?? read("../.github/workflows/ci.yml") };
  const fixture = historyFixture([prior], options);
  const tagPages = options.tagPages ?? [records];
  const historyRequest = fixture.api.request;
  fixture.api = { async request(method, path) {
    const url = new URL(path, "https://api.github.com");
    const publicationRead = url.pathname === `${historyRoot}/tags`
      || url.pathname.startsWith(`${historyRoot}/git/ref/tags/`)
      || url.pathname.startsWith(`${historyRoot}/git/tags/`)
      || url.pathname.startsWith(`${historyRoot}/releases/tags/`);
    if (!publicationRead) return historyRequest(method, path);
    fixture.calls.push({ method, path });
    assert.equal(method, "GET", "a repaired-publication guard is read-only, never a second release writer");
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(fixture.calls.length <= (options.maxRequests ?? 100), "bounded repair proof must not loop");
    if (options.publicationFail?.test(url.pathname)) throw Object.assign(new Error("Synthetic publication provider unavailable"), { status: 503 });
    let response;
    if (url.pathname === `${historyRoot}/tags`) {
      assert.equal(url.searchParams.get("per_page"), "100");
      const page = Number(url.searchParams.get("page") ?? "1");
      assert.ok(tagPages[page - 1], "request a known publication page");
      response = { status: 200, headers: page < tagPages.length ? {
        link: `<https://api.github.com${historyRoot}/tags?per_page=100&page=${page + 1}>; rel="next"`,
      } : {}, data: tagPages[page - 1].map((r) => r.listItem) };
    } else if (url.pathname.startsWith(`${historyRoot}/git/ref/tags/`)) {
      const tag = decodeURIComponent(url.pathname.slice(`${historyRoot}/git/ref/tags/`.length));
      const record = records.find((r) => r.listItem.name === tag);
      response = record ? { status: 200, headers: {}, data: record.ref }
        : { status: 404, headers: {}, data: { message: "Not Found" } };
    } else if (url.pathname.startsWith(`${historyRoot}/git/tags/`)) {
      const objectSha = url.pathname.slice(`${historyRoot}/git/tags/`.length);
      const record = records.find((r) => r.ref.object.sha === objectSha);
      response = record ? { status: 200, headers: {}, data: record.tagObject }
        : { status: 404, headers: {}, data: { message: "Not Found" } };
    } else {
      const tag = decodeURIComponent(url.pathname.slice(`${historyRoot}/releases/tags/`.length));
      const record = records.find((r) => r.listItem.name === tag);
      response = record?.release ? { status: 200, headers: {}, data: record.release }
        : { status: 404, headers: {}, data: { message: "Not Found" } };
    }
    const copy = structuredClone(response);
    return options.publicationTransform?.(copy, url) ?? copy;
  } };
  return fixture;
}

function assertRepairRecordsRead(fixture) {
  for (const path of ["/tags", "/git/ref/tags/", "/git/tags/", "/releases/tags/"]) {
    assert.ok(fixture.calls.some((c) => new URL(c.path, "https://api.github.com").pathname.includes(path)), `read immutable publication proof: ${path}`);
  }
}

describe("explicit publication repair admission", () => {
  beforeEach((t) => {
    t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network in repaired-publication acceptance"); });
  });

  test("repaired publication: exact immutable annotated tag and matching Release admit after historical publication failure", async () => {
    const fixture = await historyPermits(publicationFixture());
    assertRepairRecordsRead(fixture);
  });

  for (const outcome of ["cancelled", "skipped"]) {
    test(`repaired publication: exact proof is still sufficient after ${String(outcome)} historical publication`, async () => {
      const fixture = await historyPermits(publicationFixture([publicationRecord()], { prior: priorAttempt({ publish: outcome }) }));
      assertRepairRecordsRead(fixture);
    });
  }

  test("repaired publication: immutable proof does not excuse an unfinished historical publication step", async () => {
    await historyRefuses(publicationFixture([publicationRecord()], { prior: priorAttempt({ publish: null }) }));
  });

  test("repaired publication: the matching operation on a second tag page is not hidden by an unrelated Release", async () => {
    const unrelated = publicationRecord(frozenPlan, unrelatedAnnotation, "e".repeat(40));
    const exact = publicationRecord();
    const fixture = await historyPermits(publicationFixture([unrelated, exact], { tagPages: [[unrelated], [exact]] }));
    assertRepairRecordsRead(fixture);
    assert.ok(fixture.calls.some((c) => {
      const u = new URL(c.path, "https://api.github.com");
      return u.pathname.endsWith("/tags") && u.searchParams.get("page") === "2";
    }));
  });

  test("repaired publication: an unrelated valid shared plan and Release cannot clear A's failed publication", async () => {
    await historyRefuses(publicationFixture([publicationRecord(frozenPlan, unrelatedAnnotation)]));
  });

  for (const [name, annotation] of [
    ["same SHA but another run attempt", otherAttemptAnnotation],
    ["same run/attempt operation but another SHA", otherShaAnnotation],
  ]) {
    test(`repaired publication: valid shared provenance for ${name} cannot clear A's failure`, async () => {
      const plan = JSON.parse(annotation.slice("calver-plan-v1\n".length));
      await historyRefuses(publicationFixture([publicationRecord(plan, annotation)]));
    });
  }

  test("repaired publication: conflicting publications for one operation are not resolved by taking the first match", async () => {
    const wrongShaPlan = JSON.parse(otherShaAnnotation.slice("calver-plan-v1\n".length));
    await historyRefuses(publicationFixture([
      publicationRecord(), publicationRecord(wrongShaPlan, otherShaAnnotation, "e".repeat(40)),
    ]));
  });

  for (const [name, workflow] of [
    ["wrong shared action pin", read("../.github/workflows/ci.yml").replaceAll(action, `TogetherWeOwn/.github/actions/calver@${"f".repeat(40)}`)],
    ["publication does not use the saved plan", read("../.github/workflows/ci.yml").replace("steps.build-version.outputs.plan", "steps.unrelated.outputs.plan")],
    ["deployment does not use the planned version", read("../.github/workflows/ci.yml").replace('BUILD_VERSION: ${{ steps.build-version.outputs.version }}', 'BUILD_VERSION: unplanned-version')],
  ]) {
    test(`repaired publication: ${name} cannot prove that historical transaction`, async () => {
      await historyRefuses(publicationFixture([publicationRecord()], { workflow }));
    });
  }

  for (const [name, mutate] of [
    ["lightweight ref", (r) => { r.ref.object = { type: "commit", sha: repairedPlan.sha }; }],
    ["different ref name", (r) => { r.ref.ref = "refs/tags/build/v2026.303.0"; }],
    ["peeled SHA differs from the attempt", (r) => { r.tagObject.object.sha = "b".repeat(40); }],
    ["list peeled SHA differs from the annotated object", (r) => { r.listItem.commit.sha = "b".repeat(40); }],
    ["tag-object identity mismatch", (r) => { r.tagObject.sha = "e".repeat(40); }],
    ["tag version differs from the frozen annotation", (r) => { r.tagObject.tag = "build/v2026.303.0"; }],
    ["malformed annotation JSON", (r) => { r.tagObject.message = "calver-plan-v1\n{not-json}"; }],
    ["missing shared annotation prefix", (r) => { r.tagObject.message = r.tagObject.message.slice("calver-plan-v1\n".length); }],
    ["self-claimed operation without valid provenance", (r) => { r.tagObject.message = r.tagObject.message.replace(repairedPlan.id, "0".repeat(64)); }],
    ["annotation for another repository", (r) => { r.tagObject.message = r.tagObject.message.replace(repository, "TogetherWeOwn/another-product"); }],
    ["annotation for another namespace", (r) => { r.tagObject.message = r.tagObject.message.replace('"namespace":"build"', '"namespace":""'); }],
    ["annotation version was changed after planning", (r) => { r.tagObject.message = r.tagObject.message.replace('"version":"2026.302.0"', '"version":"2026.303.0"'); }],
    ["missing Release", (r) => { r.release = null; }],
    ["Release tag mismatch", (r) => { r.release.tag_name = "build/v2026.303.0"; }],
    ["Release SHA mismatch", (r) => { r.release.target_commitish = "b".repeat(40); }],
    ["draft Release", (r) => { r.release.draft = true; }],
    ["prerelease Release", (r) => { r.release.prerelease = true; }],
    ["Release has another plan marker", (r) => { r.release.body = r.release.body.replace(repairedPlan.id, frozenPlan.id); }],
    ["Release has no plan marker", (r) => { r.release.body = `Source: ${repairedPlan.sha}\n`; }],
  ]) {
    test(`repaired publication: ${name} cannot clear the original transaction`, async () => {
      const record = publicationRecord();
      mutate(record);
      await historyRefuses(publicationFixture([record]));
    });
  }

  for (const [name, options] of [
    ["tag-list provider exception", { publicationFail: /\/tags$/ }],
    ["ref provider exception", { publicationFail: /\/git\/ref\/tags\// }],
    ["annotation provider exception", { publicationFail: /\/git\/tags\// }],
    ["Release provider exception", { publicationFail: /\/releases\/tags\// }],
    ["unavailable tag list", { publicationTransform: (r, u) => u.pathname === `${historyRoot}/tags` ? { ...r, status: 503 } : r }],
    ["malformed tag list", { publicationTransform: (r, u) => u.pathname === `${historyRoot}/tags` ? { ...r, data: {} } : r }],
    ["foreign tag-page Link", { publicationTransform: (r, u) => u.pathname === `${historyRoot}/tags` ? { ...r, headers: { link: '<https://foreign.example.test/tags?page=2>; rel="next"' } } : r }],
    ["cyclic tag-page Link", { publicationTransform: (r, u) => u.pathname === `${historyRoot}/tags` ? { ...r, headers: { link: `<https://api.github.com${u.pathname}${u.search}>; rel="next"` } } : r }],
    ["truncated tag pagination", { publicationTransform: (r, u) => u.pathname === `${historyRoot}/tags` ? { ...r, headers: { link: `<https://api.github.com${historyRoot}/tags?per_page=100&page=2>; rel="next"` } } : r }],
    ["malformed Release", { publicationTransform: (r, u) => u.pathname.includes("/releases/tags/") ? { ...r, data: null } : r }],
  ]) {
    test(`repaired publication: ${name} still refuses rather than waiving the historical failure`, async () => {
      const fixture = publicationFixture([publicationRecord()], options);
      await historyRefuses(fixture);
      assert.ok(fixture.calls.length <= 20, "reject bad continuation evidence before the test transport's hard stop");
      assert.ok(fixture.calls.every((c) => new URL(c.path, "https://api.github.com").origin === "https://api.github.com"), "never send a read to a foreign Link origin");
    });
  }

  test("repaired publication: finding exact proof on page one does not waive an unavailable continuation", async () => {
    const exact = publicationRecord();
    const unrelated = publicationRecord(frozenPlan, unrelatedAnnotation, "e".repeat(40));
    await historyRefuses(publicationFixture([exact, unrelated], {
      tagPages: [[exact], [unrelated]], publicationTransform: (r, u) => u.pathname === `${historyRoot}/tags` && u.searchParams.get("page") === "2" ? { ...r, status: 503 } : r,
    }));
  });
});
