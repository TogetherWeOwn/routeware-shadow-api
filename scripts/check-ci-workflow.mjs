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
