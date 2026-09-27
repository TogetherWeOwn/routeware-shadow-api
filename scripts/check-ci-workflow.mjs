import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function jobBlock(name) {
  const match = workflow.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`, "m"),
  );
  assert(match, `Missing ${name} job`);
  return match[0];
}

assert.match(workflow, /^  pull_request:\n    branches: \[main\]$/m, "CI must run for pull requests targeting main");

const build = jobBlock("build");
// Vitest thresholds fail the run on regression; the ratchet step fails it on
// improvement without a floor raise. Pin it present so coverage can never
// climb a full point without moving the floors with it.
assert.match(
  build,
  /npm run check:coverage-ratchet/,
  "build must run the coverage ratchet check (TOG-6289)"
);

// A global floor can be masked by well-covered files, so a new module with
// zero tests still passes every aggregate number. Pin the per-file gate
// present so no untested module can hide behind the globals (TOG-6288).
assert.match(
  build,
  /npm run check:per-file-coverage/,
  "build must run the per-file coverage gate (TOG-6288)"
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
const hygieneNode = hygiene.search(/^      - uses: actions\/setup-node@v\d+$/m);
const hygieneInstall = hygiene.search(/^      - run: npm ci$/m);
const hygieneDrift = hygiene.search(/^        run: npm run check:d1-drift$/m);
assert.ok(hygieneNode >= 0, "hygiene must set up Node for the D1 drift check (TOG-6275)");
assert.ok(hygieneInstall > hygieneNode, "hygiene must install dependencies after Node setup (TOG-6275)");
assert.ok(hygieneDrift > hygieneInstall, "hygiene must install dependencies before the D1 drift check (TOG-6275)");

// The 800-line source-file guard counts lines in hand-written src/ files and
// fails on any file over the limit. Pin it present so oversize modules can
// never land without the hygiene gate (TOG-6291).
assert.match(
  hygiene,
  /npm run check:source-file-size/,
  "hygiene must run the source-file-size guard (TOG-6291)"
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
assert.match(
  deploy,
  /node scripts\/check-r2-preflight\.mjs/,
  "deploy must run the R2 bucket-existence preflight (TOG-6290)"
);
assert.match(
  deploy,
  /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  "deploy must source the Cloudflare token from the production environment secret",
);

console.log("OK: build/hygiene are credential-free and production deploy is explicitly gated");
