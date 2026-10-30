import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

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
