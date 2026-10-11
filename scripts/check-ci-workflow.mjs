import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertEveryJobHasTimeout, assertFirstPartyActionsPinned, assertNoPrTriggerSkips } from "./lib/ciWorkflowCheck.mjs";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function jobBlock(name) {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`, "m"),
  );
  assert(match, `Missing ${name} job`);
  return match[0];
}

// TOG-6539 (+ TOG-14898): the CSV/.dev.vars PII gate only protects main
// when `hygiene` actually runs on every pull request. `build` is a HEAVY job
// gated by the CI-standard `changes` outputs; the skip detector below allows
// only `if: needs.changes.outputs.<area>` on `build` (which `ci-ok` turns
// into a pass) and forbids any skip on `hygiene`. Asserting the
// pull_request trigger alone let a workflow edit add if:/paths-ignore skips
// while the invariant check stayed green.
assertNoPrTriggerSkips(workflow);

// TOG-19017: a hung job must fail loudly instead of stalling the PR forever,
// so every job carries timeout-minutes; and first-party actions must pin to a
// commit SHA (with a version comment) so a moved tag can never silently
// change what CI runs.
assertEveryJobHasTimeout(workflow, "ci.yml");
assertFirstPartyActionsPinned(workflow, "ci.yml");

// TOG-14898 (CI standard TOG-14877): change detection + job-level gating +
// one required aggregator + nightly full suite. Native git diff vs merge
// base (no third-party action); job-level `if: needs.changes.outputs.*`
// (never workflow-level `paths:` on a required check); `ci-ok` with
// `if: always()` as the only required check; full suite on push-to-main,
// nightly schedule, and infra/filter/dep changes.
const changesJob = jobBlock("changes");
assert.match(changesJob, /fetch-depth: 0/, "changes must use fetch-depth: 0 so the merge-base diff sees the base commit (TOG-14898)");
assert.match(changesJob, /git merge-base/, "changes must diff the PR against its merge base with native git (TOG-14898)");
assert.match(changesJob, /outputs:\n(?:.*\n)*?.*code:/, "changes must output a code boolean (TOG-14898)");
assert.match(changesJob, /probe:/, "changes must output a probe boolean (TOG-14898)");
assert.match(changesJob, /infra:/, "changes must output an infra boolean (TOG-14898)");
assert.match(changesJob, /full:/, "changes must output a full boolean for push/schedule/infra/dep full runs (TOG-14898)");
assert.match(workflow, /- cron: "23 4 \* \* \*"/, "ci must run the nightly full suite on schedule (TOG-14877 rule 5)");

const buildGated = jobBlock("build");
assert.match(
  buildGated,
  /^        run: node scripts\/check-r2-deploy-config\.mjs$/m,
  "build must verify R2 preflight against Wrangler's offline deployed bindings",
);
assert.match(buildGated, /needs: \[changes\]/, "build must wait for the changes job (TOG-14898)");
assert.match(
  buildGated,
  /if: needs\.changes\.outputs\.code == 'true' \|\| needs\.changes\.outputs\.infra == 'true' \|\| needs\.changes\.outputs\.full == 'true'/,
  "build must run only when code, infra, or full changed (TOG-14898)",
);

const probeGated = jobBlock("shadow-api-v1");
assert.match(probeGated, /needs: \[changes\]/, "shadow-api-v1 must wait for the changes job (TOG-14898)");
assert.match(
  probeGated,
  /if: needs\.changes\.outputs\.probe == 'true' \|\| needs\.changes\.outputs\.infra == 'true' \|\| needs\.changes\.outputs\.full == 'true'/,
  "shadow-api-v1 must run only when probe, infra, or full changed (TOG-14898)",
);

const hygieneAlwaysRun = jobBlock("hygiene");
assert.doesNotMatch(hygieneAlwaysRun, /^    if:/m, "hygiene must stay always-run (no if:) so PII + secret scan run on every PR including docs-only (TOG-6539/TOG-14898)");

const ciOkJob = jobBlock("ci-ok");
assert.match(ciOkJob, /^    if: always\(\)$/m, "ci-ok must use if: always() so gating can never leave the PR hanging (TOG-14877)");
assert.match(ciOkJob, /needs: \[changes, build, shadow-api-v1, hygiene\]/, "ci-ok must aggregate every gated job (TOG-14877)");

// pr-lint is the always-run title/body gate (CI standard rule 6). Pin it
// present so a workflow edit can never silently drop title lint.
const prLint = await readFile(new URL("../.github/workflows/pr-lint.yml", import.meta.url), "utf8");
assert.match(prLint, /Conventional Commits/, "pr-lint must enforce Conventional Commits titles (TOG-14898)");
assertFirstPartyActionsPinned(prLint, "pr-lint.yml");

// TOG-7666: the workers-pool suite stalls past the 30s timeout when an
// unrestricted coverage run shares a self-hosted runner with other CI jobs
// (red main 3657b4f). The cap lives in vitest.config.ts, gated on CI so
// local runs keep full speed. Pin it present so a config edit can never
// silently uncap CI.
const vitestConfig = await readFile(new URL("../vitest.config.ts", import.meta.url), "utf8");
assert.match(
  vitestConfig,
  /maxWorkers:\s*process\.env\.CI\s*\?\s*2\s*:\s*undefined/,
  "vitest.config.ts must cap maxWorkers at 2 on CI (TOG-7666)",
);

const hygiene = jobBlock("hygiene");
// The D1 drift check runs credential-free in hygiene (local apply into a
// scratch persist dir + manifest compare; the read-only remote compare only
// runs with --remote plus an ambient token). Pin it present so a migration
// can never land without the journal/manifest compare.
assert.match(
  hygiene,
  /^        run: npm run check:d1-drift$/m,
  "hygiene must run the D1 migration drift check (TOG-6275)"
);
// Wrangler is a locked dev dependency, not a preinstalled runner tool. Require
// setup and installation in order, before the credential-free local check.
const hygieneNode = hygiene.search(/^      - uses: actions\/setup-node@[0-9a-f]{40} # v\d+$/m);
const hygieneInstall = hygiene.search(/^      - run: npm ci$/m);
const hygieneDrift = hygiene.search(/^        run: npm run check:d1-drift$/m);
assert.ok(hygieneNode >= 0, "hygiene must set up Node for the D1 drift check (TOG-6275)");
assert.ok(hygieneInstall > hygieneNode, "hygiene must install dependencies after Node setup (TOG-6275)");
assert.ok(hygieneDrift > hygieneInstall, "hygiene must install dependencies before the D1 drift check (TOG-6275)");

// The OpenAPI drift check compares declared createRoute() ops against the
// ops published via .openapi() in each mounted module, credential-free. Pin
// it present so a dropped route can never land without the hygiene gate
// (TOG-6282, gap G24).
assert.match(
  hygiene,
  /^        run: npm run check:openapi-drift$/m,
  "hygiene must run the OpenAPI drift check (TOG-6282)"
);

// The vars parity check compares wrangler.toml [vars] keys against
// .dev.vars.example mentions (active or commented), credential-free. Pin it
// present so a var can never land in one file but not the other without the
// hygiene gate failing (TOG-8367, gap G20).
assert.match(
  hygiene,
  /^        run: npm run check:vars-parity$/m,
  "hygiene must run the vars parity check (TOG-8367)"
);

// TOG-8373 (gap G30): worker-configuration.d.ts is gitignored (generated by
// `wrangler types`, which bakes wrangler.toml [vars] into literal string
// types). CI must regenerate it via `npm run types` before typecheck (build
// job) and before the baked-secrets gate (hygiene job), and the gate must
// fail closed when the file is absent (a skipped regen must never pass).
const build = jobBlock("build");
const buildRegen = build.search(/^      - name: Regenerate Worker types \(TOG-8373\)$/m);
const buildTypecheck = build.search(/^        run: npm run typecheck$/m);
assert.ok(buildRegen >= 0, "build must regenerate worker-configuration.d.ts via npm run types (TOG-8373)");
assert.ok(buildTypecheck > buildRegen, "build must regenerate types before typecheck (TOG-8373)");
const hygieneRegen = hygiene.search(/^      - name: Regenerate Worker types \(TOG-8373\)$/m);
const hygieneGate = hygiene.search(/^      - name: No real secrets baked into worker-configuration\.d\.ts$/m);
assert.ok(hygieneRegen >= 0, "hygiene must regenerate worker-configuration.d.ts via npm run types (TOG-8373)");
assert.ok(hygieneGate > hygieneRegen, "hygiene must regenerate types before the baked-secrets gate (TOG-8373)");

// Fresh checkouts do not contain the gitignored Worker declarations. Keep the
// npm typecheck lifecycle hook responsible for generating them locally.
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(packageJson.scripts.pretypecheck, "npm run types", "typecheck must generate Worker declarations first");

assert.match(
  hygiene,
  /if \[ ! -f worker-configuration\.d\.ts \]; then/,
  "the baked-secrets gate must fail closed when worker-configuration.d.ts is absent (TOG-8373)",
);

// The changelog gate diffs the PR against origin/main and fails when a
// consumer-visible contract path changed without a TOG-1234 bullet under
// CHANGELOG.md ## [Unreleased]. Pin it present so a contract change can
// never land with an empty [Unreleased] (TOG-8385, gap G9).
assert.match(
  hygiene,
  /^        run: npm run check:changelog$/m,
  "hygiene must run the changelog gate (TOG-8385)"
);

// The prod dependency audit gate runs `npm audit --omit=dev` and fails on
// unallowlisted high/critical advisories, with a documented allowlist whose
// stale entries also fail (TOG-8904). Pin it present so a vulnerable
// transitive dep can never land without the hygiene gate.
assert.match(
  hygiene,
  /^        run: npm run check:deps-audit$/m,
  "hygiene must run the prod dependency audit gate (TOG-8904)"
);

// Dependabot bumps npm + GitHub Actions weekly (TOG-8904). Pin the config
// present so dependency updates can never silently stop.
const dependabot = await readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
assert.match(
  dependabot,
  /package-ecosystem:\s*"npm"/,
  "dependabot must cover npm (TOG-8904)"
);
assert.match(
  dependabot,
  /package-ecosystem:\s*"github-actions"/,
  "dependabot must cover GitHub Actions (TOG-8904)"
);
assert.match(
  dependabot,
  /interval:\s*"weekly"/,
  "dependabot must run weekly (TOG-8904)"
);

// The 800-line source-file guard counts lines in hand-written src/ files and
// fails on any file over the limit. Pin it present so oversize modules can
// never land without the hygiene gate (TOG-6291).
assert.match(
  hygiene,
  /npm run check:source-file-size/,
  "hygiene must run the source-file-size guard (TOG-6291)"
);

// The scheduled post-deploy probe (TOG-8365, gap G18) lives in its own
// workflow so deploy verification runs on a schedule. Pin it present: the
// cron, the skip-safe npm script, and the read-only GET-only probe paths.
const probeWorkflow = await readFile(new URL("../.github/workflows/post-deploy-probe.yml", import.meta.url), "utf8");
assertEveryJobHasTimeout(probeWorkflow, "post-deploy-probe.yml");
assertFirstPartyActionsPinned(probeWorkflow, "post-deploy-probe.yml");
assert.match(probeWorkflow, /- cron: "30 7 \* \* \*"/, "post-deploy-probe workflow must run on its daily schedule (TOG-8365)");
assert.match(probeWorkflow, /run: npm run probe:post-deploy:scheduled/, "post-deploy-probe workflow must use the skip-safe scheduled script (TOG-8365)");
assert.doesNotMatch(probeWorkflow, /\b(POST|PUT|PATCH|DELETE)\b/, "post-deploy-probe workflow must stay read-only (TOG-8365)");

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
