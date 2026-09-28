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
const hygieneNode = hygiene.search(/^      - uses: actions\/setup-node@v\d+$/m);
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
assert.match(
  deploy,
  /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  "deploy must source the Cloudflare token from the production environment secret",
);

console.log("OK: build/hygiene are credential-free and production deploy is explicitly gated");
