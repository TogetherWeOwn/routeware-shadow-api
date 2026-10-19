import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  assertEveryJobHasTimeout,
  assertFirstPartyActionsPinned,
  assertNodeVersionsMatchNvmrc,
  assertNoPrTriggerSkips,
  parseNvmrcMajor,
} from "./lib/ciWorkflowCheck.mjs";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function jobBlock(name) {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`, "m"),
  );
  assert(match, `Missing ${name} job`);
  return match[0];
}

// The CSV/.dev.vars PII gate only protects main
// when `hygiene` actually runs on every pull request. `build` is a HEAVY job
// gated by the CI-standard `changes` outputs; the skip detector below allows
// only `if: needs.changes.outputs.<area>` on `build` (which `ci-ok` turns
// into a pass) and forbids any skip on `hygiene`. Asserting the
// pull_request trigger alone let a workflow edit add if:/paths-ignore skips
// while the invariant check stayed green.
assertNoPrTriggerSkips(workflow);

// A hung job must fail loudly instead of stalling the PR forever,
// so every job carries timeout-minutes; and first-party actions must pin to a
// commit SHA (with a version comment) so a moved tag can never silently
// change what CI runs.
assertEveryJobHasTimeout(workflow, "ci.yml");
assertFirstPartyActionsPinned(workflow, "ci.yml");

// CI standard: change detection + job-level gating +
// one required aggregator + nightly full suite. Native git diff vs merge
// base (no third-party action); job-level `if: needs.changes.outputs.*`
// (never workflow-level `paths:` on a required check); `ci-ok` with
// `if: always()` as the only required check; full suite on push-to-main,
// nightly schedule, and infra/filter/dep changes.
const changesJob = jobBlock("changes");
assert.match(changesJob, /fetch-depth: 0/, "changes must use fetch-depth: 0 so the merge-base diff sees the base commit");
assert.match(changesJob, /git merge-base/, "changes must diff the PR against its merge base with native git");
assert.match(changesJob, /outputs:\n(?:.*\n)*?.*code:/, "changes must output a code boolean");
assert.match(
  changesJob,
  /^          if echo "\$files" \| grep -qE '\^\(src\/\|test\/\|migrations\/\|tools\/api-discovery\/\|/m,
  "discovery tooling changes must run the build and vitest pins",
);
assert.match(changesJob, /probe:/, "changes must output a probe boolean");
assert.match(changesJob, /infra:/, "changes must output an infra boolean");
assert.match(changesJob, /full:/, "changes must output a full boolean for push/schedule/infra/dep full runs");
assert.ok(
  changesJob.includes("vitest(\\.memory)?\\.config\\.ts$"),
  "code change detection must include the dedicated memory Vitest config",
);
// `.nvmrc` anchors the Node-pin guard that runs in `build`, so a
// PR touching only `.nvmrc` must still run it, not merge green past it.
assert.match(
  changesJob,
  /grep -qE '\^\([^']*\\\.nvmrc\$[^']*\)'; then\n\s+echo "full=true"/,
  "changes must route .nvmrc to a full run so the Node-pin guard sees a .nvmrc-only PR",
);
assert.match(workflow, /- cron: "23 4 \* \* \*"/, "ci must run the nightly full suite on schedule (rule 5)");

const buildGated = jobBlock("build");
assert.match(
  buildGated,
  /^        run: node scripts\/check-r2-deploy-config\.mjs$/m,
  "build must verify R2 preflight against Wrangler's offline deployed bindings",
);
// Vitest thresholds fail the run on regression; the ratchet step fails it on
// improvement without a floor raise. Pin it present so coverage can never
// climb a full point without moving the floors with it. The match anchors on
// the real `run:` line (a bare substring would also match a commented-out
// step or an `echo` impersonator), rejects a `continue-on-error` soft-fail,
// and requires the PR-only gate so a coverage gain can never turn the
// main-branch build red and skip a deploy.
assert.match(
  buildGated,
  /^        run: npm run check:coverage-ratchet$/m,
  "build must run the coverage ratchet check",
);
assert.doesNotMatch(
  buildGated,
  /check:coverage-ratchet\n\s+continue-on-error/,
  "the coverage ratchet must not soft-fail",
);
assert.match(
  buildGated,
  /^        if: github\.event_name == 'pull_request'$/m,
  "the coverage ratchet must run only on pull requests so a coverage gain never blocks main deploys",
);
// A global floor can be masked by well-covered files, so a new module with
// zero tests still passes every aggregate number. Pin the per-file gate
// present so no untested module can hide behind the globals. The match
// anchors on the real `run:` line (a bare substring would also match a
// commented-out step or an `echo` impersonator). Unlike the ratchet, this
// is a regression gate like the Vitest thresholds: it runs on every build
// and must never soft-fail. Slice the whole step block (its header through
// the next step) and reject ANY `continue-on-error` and ANY step-level
// `if:` inside it, regardless of key order — adjacency regexes let
// `continue-on-error` above the run line, below it with a comment between,
// or a PR-only `if:` with another key between slip through.
const perFileRun = /^        run: npm run check:per-file-coverage$/m.exec(buildGated);
assert.ok(perFileRun, "build must run the per-file coverage gate");
const perFileStepStart = buildGated.lastIndexOf("\n      - ", perFileRun.index);
assert.ok(perFileStepStart >= 0, "the per-file coverage gate run line must sit inside a build step");
const perFileStepEnd = buildGated.indexOf("\n      - ", perFileRun.index);
const perFileStep = buildGated.slice(
  perFileStepStart + 1,
  perFileStepEnd === -1 ? undefined : perFileStepEnd,
);
assert.doesNotMatch(
  perFileStep,
  /^ +continue-on-error\s*:/m,
  "the per-file coverage gate must not soft-fail",
);
assert.doesNotMatch(
  perFileStep,
  /^ +if\s*:/m,
  "the per-file coverage gate must run on every build, not only on pull requests",
);
// The gate's own files must route to build: a PR touching only the gate
// script, its lib, or its allowlist would otherwise get code/infra/full
// all false, skip build, and merge without its tests or step ever running.
// Pin each path inside the quoted pattern of both the infra and full
// grep lines (the grep line immediately preceding each
// `echo "<area>=true"`), so a trailing comment naming the path can never
// satisfy the pin.
const changesLines = changesJob.split("\n");
function changesGrepPattern(area) {
  const at = changesLines.findIndex(
    (line, index) =>
      line.includes("grep -qE") && (changesLines[index + 1] ?? "").includes(`echo "${area}=true"`),
  );
  assert.ok(at >= 0, `changes must have a grep pattern routing to ${area}=true`);
  const quoted = changesLines[at].match(/grep -qE '([^']+)'/);
  assert.ok(quoted, `changes ${area} routing must use a single-quoted grep -qE pattern`);
  return quoted[1];
}
for (const gatePath of [
  "scripts/check-per-file-coverage\\.mjs$",
  "scripts/lib/perFileCoverage\\.mjs$",
  "scripts/per-file-coverage-allowlist\\.json$",
]) {
  assert.ok(
    changesGrepPattern("infra").includes(gatePath),
    `changes must route ${gatePath} to infra so a gate-only PR runs build`,
  );
  assert.ok(
    changesGrepPattern("full").includes(gatePath),
    `changes must route ${gatePath} to full so a gate-only PR runs build`,
  );
}
assert.match(buildGated, /needs: \[changes\]/, "build must wait for the changes job");
assert.match(
  buildGated,
  /if: needs\.changes\.outputs\.code == 'true' \|\| needs\.changes\.outputs\.infra == 'true' \|\| needs\.changes\.outputs\.full == 'true'/,
  "build must run only when code, infra, or full changed",
);

const probeGated = jobBlock("shadow-api-v1");
assert.match(probeGated, /needs: \[changes\]/, "shadow-api-v1 must wait for the changes job");
assert.match(
  probeGated,
  /if: needs\.changes\.outputs\.probe == 'true' \|\| needs\.changes\.outputs\.infra == 'true' \|\| needs\.changes\.outputs\.full == 'true'/,
  "shadow-api-v1 must run only when probe, infra, or full changed",
);

const hygieneAlwaysRun = jobBlock("hygiene");
assert.doesNotMatch(hygieneAlwaysRun, /^    if:/m, "hygiene must stay always-run (no if:) so PII + secret scan run on every PR including docs-only");

// The CSV/.dev.vars gates must list with `git ls-files -z` piped through
// `tr '\0' '\n'` (mirroring scripts/check-docs-links.mjs): plain `git ls-files`
// C-quotes non-ASCII paths under the default `core.quotePath`, whose closing
// quote defeats the `$` anchors and lets a PII export or secrets file through
// silently (Résumé.csv and café/.dev.vars missed by plain, caught by `-z`).
assert.match(
  hygieneAlwaysRun,
  /git ls-files -z \| tr '\\0' '\\n' \| grep -iE/,
  "PII CSV gate must use -z/NUL framing so non-ASCII exports cannot slip past the $ anchors",
);
assert.match(
  hygieneAlwaysRun,
  /git ls-files -z \| tr '\\0' '\\n' \| grep -E/,
  ".dev.vars gate must use -z/NUL framing so a non-ASCII dir cannot hide a tracked secrets file",
);
assert.doesNotMatch(
  hygieneAlwaysRun,
  /git ls-files \| grep/,
  "hygiene gates must not use plain git ls-files piping (C-quotes non-ASCII paths fail-open)",
);

const ciOkJob = jobBlock("ci-ok");
assert.match(ciOkJob, /^    if: always\(\)$/m, "ci-ok must use if: always() so gating can never leave the PR hanging");
assert.match(ciOkJob, /needs: \[changes, build, shadow-api-v1, hygiene\]/, "ci-ok must aggregate every gated job");

// pr-lint is the always-run title/body gate (CI standard rule 6). Pin it
// present so a workflow edit can never silently drop title lint.
const prLint = await readFile(new URL("../.github/workflows/pr-lint.yml", import.meta.url), "utf8");
assert.match(prLint, /Conventional Commits/, "pr-lint must enforce Conventional Commits titles");
assertFirstPartyActionsPinned(prLint, "pr-lint.yml");

// pr-lint cancels superseded runs per PR: the concurrency group keys on the
// PR number for pull_request events (a new push cancels that PR's stale
// runs) and on the sha otherwise, so a queued push-to-main run is never
// replaced and every push's commits are linted. Cancel-in-progress applies
// to pull_request only. Pin both so a workflow edit can never silently
// uncancel PR runs or start cancelling main runs. Scope to the pre-jobs
// section with anchored lines so commented-out settings can never satisfy
// the pin, and forbid job-level concurrency that would override it.
const prLintPreJobs = prLint.split(/^jobs:/m)[0];
assert.match(
  prLintPreJobs,
  /^  group: pr-lint-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}$/m,
  "pr-lint concurrency must group per-PR by number with sha fallback",
);
assert.match(
  prLintPreJobs,
  /^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m,
  "pr-lint must cancel in-progress runs on pull_request events only",
);
assert.doesNotMatch(
  prLint.split(/^jobs:/m)[1] ?? "",
  /^\s*concurrency\s*:/m,
  "pr-lint must not define job-level concurrency that overrides the top-level group",
);

// The workers-pool suite stalls past the 30s timeout when an
// unrestricted coverage run shares a CI runner with other CI jobs
// (red main 3657b4f). The CI cap lives in vitest.config.ts, gated on CI.
// Local runs cap at half the core count instead of uncapped, for
// the same oversubscription reason. Pin both present so a config edit can
// never silently uncap CI or local.
const vitestConfig = await readFile(new URL("../vitest.config.ts", import.meta.url), "utf8");
assert.match(
  vitestConfig,
  /maxWorkers:\s*process\.env\.CI\s*\?\s*2\s*:\s*undefined/,
  "vitest.config.ts project options must cap CI at 2 and leave local CLI overrides to Vitest",
);
assert.match(
  vitestConfig,
  /localMaxWorkers\s*=\s*Math\.max\(1,\s*Math\.floor\(os\.availableParallelism\(\)\s*\/\s*2\)\)/,
  "vitest.config.ts must default the root config to half available parallelism locally",
);
assert.match(
  vitestConfig,
  /test:\s*\{\s*maxWorkers:\s*process\.env\.CI\s*\?\s*2\s*:\s*localMaxWorkers/,
  "vitest.config.ts root options must cap CI and provide the local default while allowing CLI overrides",
);

// Workspace projects do not inherit root test options, so each project must
// spread sharedTestOptions (timeouts plus the CI worker cap). A project that
// drops the spread silently runs with default timeouts on an uncapped pool.
// Assert per project — not by global totals — so a commented-out, duplicated
// or misplaced spread in one project can never satisfy another project's pin.
const projectsBlock = vitestConfig.match(/projects:\s*\[([\s\S]*?)\n    \],/);
assert.ok(projectsBlock, "vitest.config.ts must define a projects array");
// Strip comments so only active code counts; split on project boundaries
// (6 spaces + "{" plus rest-of-line, so a single-line inline project counts).
const activeProjects = projectsBlock[1]
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
const projectChunks = activeProjects.split(/^      \{.*$/gm).slice(1);
// Count every top-level projects element (6-space indent, not a closing brace)
// so a string, identifier or spread entry cannot slip past the object-only split.
const elementStarts = (activeProjects.match(/^      [^}\s]/gm) ?? []).length;
assert.equal(
  elementStarts,
  projectChunks.length,
  "vitest.config.ts projects array must contain only object-literal projects counted by this pin (update the pin when adding a project in any form)",
);
assert.equal(
  projectChunks.length,
  2,
  "vitest.config.ts must define exactly two workspace projects (update this pin when adding one)",
);
for (const [index, chunk] of projectChunks.entries()) {
  const testBlock = chunk.match(/\n        test:\s*\{([\s\S]*?)\n        \},/);
  assert.ok(testBlock, `vitest workspace project ${index + 1} must define a test block`);
  assert.match(
    testBlock[1],
    /^\s*\.\.\.sharedTestOptions,?\s*$/m,
    `vitest workspace project ${index + 1} must spread ...sharedTestOptions in its test options`,
  );
}

const hygiene = jobBlock("hygiene");
// The D1 drift check runs credential-free in hygiene (local apply into a
// scratch persist dir + manifest compare; the read-only remote compare only
// runs with --remote plus an ambient token). Pin it present so a migration
// can never land without the journal/manifest compare.
assert.match(
  hygiene,
  /^        run: npm run check:d1-drift$/m,
  "hygiene must run the D1 migration drift check"
);
// Wrangler is a locked dev dependency, not a preinstalled runner tool. Require
// setup and installation in order, before the credential-free local check.
const hygieneNode = hygiene.search(/^      - uses: actions\/setup-node@[0-9a-f]{40} # v\d+$/m);
const hygieneInstall = hygiene.search(/^      - run: npm ci$/m);
const hygieneDrift = hygiene.search(/^        run: npm run check:d1-drift$/m);
assert.ok(hygieneNode >= 0, "hygiene must set up Node for the D1 drift check");
assert.ok(hygieneInstall > hygieneNode, "hygiene must install dependencies after Node setup");
assert.ok(hygieneDrift > hygieneInstall, "hygiene must install dependencies before the D1 drift check");

// The OpenAPI drift check compares declared createRoute() ops against the
// ops published via .openapi() in each mounted module, credential-free. Pin
// it present so a dropped route can never land without the hygiene gate
// (gap G24).
assert.match(
  hygiene,
  /^        run: npm run check:openapi-drift$/m,
  "hygiene must run the OpenAPI drift check"
);

// The vars parity check compares wrangler.toml [vars] keys against
// .dev.vars.example mentions (active or commented), credential-free. Pin it
// present so a var can never land in one file but not the other without the
// hygiene gate failing (gap G20).
assert.match(
  hygiene,
  /^        run: npm run check:vars-parity$/m,
  "hygiene must run the vars parity check"
);

// Gap G30: worker-configuration.d.ts is gitignored (generated by
// `wrangler types`, which bakes wrangler.toml [vars] into literal string
// types). CI must regenerate it via `npm run types` before typecheck (build
// job) and before the baked-secrets gate (hygiene job), and the gate must
// fail closed when the file is absent (a skipped regen must never pass).
const build = jobBlock("build");
const buildRegen = build.search(/^      - name: Regenerate Worker types$/m);
const buildTypecheck = build.search(/^        run: npm run typecheck$/m);
assert.ok(buildRegen >= 0, "build must regenerate worker-configuration.d.ts via npm run types");
assert.ok(buildTypecheck > buildRegen, "build must regenerate types before typecheck");
const hygieneRegen = hygiene.search(/^      - name: Regenerate Worker types$/m);
const hygieneGate = hygiene.search(/^      - name: No real secrets baked into worker-configuration\.d\.ts$/m);
assert.ok(hygieneRegen >= 0, "hygiene must regenerate worker-configuration.d.ts via npm run types");
assert.ok(hygieneGate > hygieneRegen, "hygiene must regenerate types before the baked-secrets gate");

assert.match(
  hygiene,
  /if \[ ! -f worker-configuration\.d\.ts \]; then/,
  "the baked-secrets gate must fail closed when worker-configuration.d.ts is absent",
);

// Fresh checkouts do not contain the gitignored Worker declarations. Keep the
// npm typecheck lifecycle hook responsible for generating them locally while
// preserving the existing standalone types command.
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(packageJson.scripts.pretypecheck, "npm run types", "typecheck must generate Worker declarations first");
assert.equal(packageJson.scripts.types, "wrangler types", "the standalone types command must remain unchanged");

// The changelog gate diffs the PR against origin/main and fails when a
// consumer-visible contract path changed without a referencing bullet under
// CHANGELOG.md ## [Unreleased]. Pin it present so a contract change can
// never land with an empty [Unreleased] (gap G9).
assert.match(
  hygiene,
  /^        run: npm run check:changelog$/m,
  "hygiene must run the changelog gate"
);

// The prod dependency audit gate runs `npm audit --omit=dev` and fails on
// unallowlisted high/critical advisories, with a documented allowlist whose
// stale entries also fail. Pin it present so a vulnerable
// transitive dep can never land without the hygiene gate.
assert.match(
  hygiene,
  /^        run: npm run check:deps-audit$/m,
  "hygiene must run the prod dependency audit gate"
);

// Dependabot bumps npm + GitHub Actions weekly. Pin the config
// present so dependency updates can never silently stop.
const dependabot = await readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
assert.match(
  dependabot,
  /package-ecosystem:\s*"npm"/,
  "dependabot must cover npm"
);
assert.match(
  dependabot,
  /package-ecosystem:\s*"github-actions"/,
  "dependabot must cover GitHub Actions"
);
assert.match(
  dependabot,
  /interval:\s*"weekly"/,
  "dependabot must run weekly"
);

// The 800-line source-file guard counts lines in hand-written src/ files and
// fails on any file over the limit. Pin it present so oversize modules can
// never land without the hygiene gate.
assert.match(
  hygiene,
  /npm run check:source-file-size/,
  "hygiene must run the source-file-size guard"
);

// The docs link + anchor check resolves every relative link in tracked *.md
// files (file must be tracked, #anchor must match a heading slug or <a name>
// anchor). Pin it present so a broken cross-link can never land without the
// hygiene gate.
assert.match(
  hygiene,
  /^        run: npm run check:docs-links$/m,
  "hygiene must run the docs link and anchor check"
);

// The discovery transform pins (node --test suites for route-gap and
// validate-harvest) live outside the root vitest run, and tools-only PRs skip
// the filtered `build` job — so hygiene is the only gate that runs them. Pin
// it present so the route-gap exit-code contract can never regress silently.
assert.match(
  hygiene,
  /^        run: npm run test:discovery$/m,
  "hygiene must run the discovery transform pins"
);
// The R2 lifecycle proposal shape guard validates
// docs/r2-lifecycle-proposal.snapshot-history.json stays a byte-clean S3
// PutBucketLifecycleConfiguration body, credential-free. Pin it present so
// proposal drift can never land without the hygiene gate (R9-05).
assert.match(
  hygiene,
  /npm run check:r2-lifecycle-proposal/,
  "hygiene must run the R2 lifecycle proposal shape guard"
);

// The scheduled post-deploy probe (gap G18) lives in its own
// workflow so deploy verification runs on a schedule. Pin it present: the
// cron, the skip-safe npm script, and the read-only GET-only probe paths.
const probeWorkflow = await readFile(new URL("../.github/workflows/post-deploy-probe.yml", import.meta.url), "utf8");
assertEveryJobHasTimeout(probeWorkflow, "post-deploy-probe.yml");
assertFirstPartyActionsPinned(probeWorkflow, "post-deploy-probe.yml");
assert.match(probeWorkflow, /- cron: "30 7 \* \* \*"/, "post-deploy-probe workflow must run on its daily schedule");
assert.match(probeWorkflow, /run: npm run probe:post-deploy:scheduled/, "post-deploy-probe workflow must use the skip-safe scheduled script");
assert.doesNotMatch(probeWorkflow, /\b(POST|PUT|PATCH|DELETE)\b/, "post-deploy-probe workflow must stay read-only");

// `.nvmrc` is the one place the Node major lives. Every workflow
// `node-version` and the `engines.node` floor must repeat it, so a runtime
// that reached end of life cannot linger in one job (or in the deploy that
// runs `wrangler deploy`) after the rest moved on.
// Every workflow file is read, so a new one cannot bring back an old pin.
const nvmrc = await readFile(new URL("../.nvmrc", import.meta.url), "utf8");
const workflowsDir = new URL("../.github/workflows/", import.meta.url);
for (const name of (await readdir(workflowsDir)).filter((file) => /\.ya?ml$/.test(file)).sort()) {
  assertNodeVersionsMatchNvmrc(await readFile(new URL(name, workflowsDir), "utf8"), nvmrc, name);
}
assert.equal(
  packageJson.engines?.node,
  `>=${parseNvmrcMajor(nvmrc)}`,
  "package.json engines.node must be >= the .nvmrc major",
);

const deploy = jobBlock("deploy");
const shadowProbe = jobBlock("shadow-api-v1");
// The optional staging probe already has a fail-closed CF_TOKEN gate. Allow only
// that existing reference; build/hygiene must still need no credentials.
const credentialFreeProbe = shadowProbe.replace("${{ secrets.CF_TOKEN }}", "");
const nonDeployWorkflow = workflow.replace(deploy, "").replace(shadowProbe, credentialFreeProbe);
assert.doesNotMatch(
  nonDeployWorkflow,
  /CLOUDFLARE_API_TOKEN|secrets\./,
  "Only deploy and the optional staging CF_TOKEN gate may reference credentials",
);
assert.match(deploy, /^    needs: \[build, hygiene\]$/m, "deploy must wait for both blocking checks");
const deployCondition = deploy.match(/^    if: (.+)$/m)?.[1];
assert.equal(
  deployCondition,
  "github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.PRODUCTION_DEPLOY_ENABLED == 'true'",
  "deploy must require push/main and PRODUCTION_DEPLOY_ENABLED",
);
assert.match(deploy, /^    environment: production$/m, "deploy must use the production environment");
// The R2 bucket preflight runs read-only in deploy before migrations go live:
// a missing SNAPSHOTS bucket fails closed naming the fix; R2-disabled deploys
// skip cleanly. Pin it present so the archive leg can never ship unverified.
assert.match(deploy, /^      WRANGLER_CONFIG: wrangler\.toml$/m, "deploy must pin its shared top-level TOML config");
const preflightRun = '        run: node scripts/check-r2-preflight.mjs --config="$WRANGLER_CONFIG"';
const deployRun = '        run: npx wrangler deploy --config "$WRANGLER_CONFIG"';
assert.ok(deploy.includes(preflightRun), "R2 preflight must use the shared deploy config");
assert.ok(deploy.includes(deployRun), "Worker deployment must use the shared preflight config");
const preflightAt = deploy.indexOf(preflightRun);
const migrationsAt = deploy.indexOf("        run: npm run db:migrate:remote");
assert.ok(migrationsAt > preflightAt, "R2 preflight must run before remote migrations");
assert.ok(deploy.indexOf(deployRun) > migrationsAt, "Worker deployment must follow migrations");
assert.match(
  deploy,
  /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  "deploy must source the Cloudflare token from the production environment secret",
);

console.log("OK: build/hygiene are credential-free and production deploy is explicitly gated");
