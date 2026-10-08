# PR preview Worker recipe

This is a **manual, disposable, synthetic-only preview**, not production activation.
Adding this document does not deploy a Worker, create credentials, enable CI deploys,
or authorize a later deployment. Keep `PRODUCTION_DEPLOY_ENABLED` and the production
approval gates unchanged. No new paid plan or service is part of this recipe.

## Scope and prerequisites

- Use a reviewed PR checkout, Node 20+, and `NODE_ENV=development npm ci`.
  Invoke the repository-local Wrangler installed from `package-lock.json` (currently
  4.84.1), never a global executable or `@latest`.
- A live preview requires separately authorized staging access to an existing
  Cloudflare account. Confirm the account and granted capability before deploying;
  if access is missing or a plan upgrade is required, stop. Do not copy/export a
  production token or obtain another credential after an authentication failure.
- This restricted preview proves Worker bundling, public liveness and fail-closed
  auth. It intentionally has **no D1, R2, Browser Rendering or report sources**.
  It is not a snapshot E2E, readiness, upstream-login or production-parity test.
- Do not use `npm run deploy`, bare `wrangler deploy`, the committed `wrangler.toml`
  with only `--name`, or `--env test`. Those are not isolation: the committed config
  includes upstream URLs, report IDs, storage targets and a cron; `test` still
  points at the real upstream. Missing/dummy login credentials do not prevent an
  initial upstream request. Do not run the generic post-deploy probe here either.

## 1. Prepare a new name and an independent config (local only)

Run the blocks in the same Bash session, from the reviewed checkout. Set `PR_NUMBER`
to the actual PR number. Outside Paperclip, set `PAPERCLIP_RUN_SCRATCH_DIR` to an
approved private scratch directory outside the checkout before starting.

```bash
set -euo pipefail
: "${PR_NUMBER:?Set the actual PR number}"
[[ "$PR_NUMBER" =~ ^[1-9][0-9]{0,8}$ ]]
REPO_ROOT="$(git rev-parse --show-toplevel)"
PREVIEW_SHA="$(git rev-parse --short=12 HEAD)"
PREVIEW_NONCE="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(4).toString("hex"))')"
PREVIEW_WORKER="routeware-shadow-api-pr-${PR_NUMBER}-${PREVIEW_SHA}-${PREVIEW_NONCE}"
PREVIEW_DIR="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:?}/worker-preview.XXXXXX")"
[[ -d "$PREVIEW_DIR" ]]
PREVIEW_CONFIG="$PREVIEW_DIR/wrangler.json"
WRANGLER="$REPO_ROOT/node_modules/wrangler/bin/wrangler.js"
export REPO_ROOT PREVIEW_SHA PREVIEW_WORKER PREVIEW_DIR PREVIEW_CONFIG WRANGLER
mkdir "$PREVIEW_DIR/auth-home"
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT, PREVIEW_WORKER, PREVIEW_CONFIG } = process.env;
const config = {
  name: PREVIEW_WORKER,
  main: path.join(REPO_ROOT, 'src/worker.ts'),
  tsconfig: path.relative(path.dirname(PREVIEW_CONFIG), path.join(REPO_ROOT, 'tsconfig.json')),
  compatibility_date: '2025-01-01',
  compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
  workers_dev: true,
  preview_urls: false,
  routes: [],
  triggers: { crons: [] },
  durable_objects: { bindings: [{ name: 'AUTH_SESSION', class_name: 'AuthSession' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['AuthSession'] }],
  vars: {
    TARGET_ORIGIN: 'https://preview.invalid',
    TARGET_BASE_PATH: '/WebRW',
    LOGIN_URL: 'https://preview.invalid/WebRW/Account/Login',
    AUTH_MODE: 'http',
    OPENAPI_DOCS_ENABLED: 'false',
    CUSTOMER_SAVE_AUTO_TOKEN: 'false',
    CUSTOMER_REPORT_EXPORT_PATH: '',
    CUSTOMER_REPORT_QUERY_ID: '',
    ADDRESS_REPORT_EXPORT_PATH: '',
    ADDRESS_REPORT_QUERY_ID: '',
    CONTAINER_REPORT_EXPORT_PATH: '',
    CONTAINER_REPORT_QUERY_ID: '',
    SHADOW_API_PUBLIC_BASE: '',
    SNAPSHOTS_R2_ENABLED: 'false',
    THROTTLE_TRUST_XFF: 'false'
  }
};
fs.writeFileSync(PREVIEW_CONFIG, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
NODE
```

The random suffix prevents reuse between runs of the same PR/head. Verify in the
selected account's Workers list that this exact name is **absent** before its first
deploy; if it already exists, stop and prepare a fresh name/config. A new name is
important because redeploying an existing Worker can preserve its old secrets.

The config is generated from an allowlist, not copied from production. Its directory
has no `.dev.vars` or `.env`; do not add any, pass `--env-file`/`--secrets-file`, or set
`CLOUDFLARE_INCLUDE_PROCESS_ENV=true`. No bearer or login secrets are configured.
The same-script `AUTH_SESSION` binding is required by the API middleware even for
public health. Omitting `script_name` keeps it in the temporary Worker's namespace;
`new_sqlite_classes` creates a fresh SQLite-backed namespace rather than copying
production's legacy KV migration or any existing session data. SQLite also supports
the Durable Object key-value storage API used by `AuthSession`.

## 2. Review the plan and dry-run (no account access needed)

Review the complete generated config. It must contain only the settings above:
no `account_id`, named environments, external DO `script_name`, D1/R2/KV/service
bindings, Browser binding, custom routes, cron schedules, credentials, real upstream
host, report IDs or paid CPU limit. Paths must point at the reviewed checkout.

```bash
env -i PATH="$PATH" HOME="$PREVIEW_DIR/auth-home" \
  WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  node "$WRANGLER" deploy --config "$PREVIEW_CONFIG" \
  --dry-run --outdir "$PREVIEW_DIR/bundle"
```

Require exit 0 and inspect the reported bindings: only `AUTH_SESSION` and the
synthetic vars above. Wrangler's dry-run compiles/checks without uploading; the
clean environment and scratch HOME avoid using a cached account login. It does
**not** prove account authorization, successful namespace creation or live smoke.
Save the PR/head, Worker name, config and dry-run result as reviewer evidence.

## 3. Optional manual deployment (separate staging authorization)

Only after the staging authorization and dry-run review above: use already-granted
credentials through the approved credential mechanism, not a file in this repo.
Set `CLOUDFLARE_ACCOUNT_ID` to the verified preview account through that mechanism.
Keep the config/name unchanged; never substitute the stable production name.

```bash
: "${CLOUDFLARE_ACCOUNT_ID:?Verified preview account required}"
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" WRANGLER_SEND_METRICS=false \
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  node "$WRANGLER" deploy --config "$PREVIEW_CONFIG" --name "$PREVIEW_WORKER"
```

This activates **only the temporary Worker** on its own `workers.dev` URL. Record
that exact URL, account ID, head SHA and deployment/version ID. Inspect the temporary
Worker's dashboard: no routes/custom domains or cron; no secrets; no D1/R2/Browser
bindings; `AUTH_SESSION` belongs to this Worker. Stop on unexpected bindings or an
authentication error; do not retry with another credential or edit production.

### Allowlisted smoke (GET only, no bearer)

Set `PREVIEW_URL` to the exact URL emitted by this deployment, with no trailing slash.
Confirm its hostname starts with `${PREVIEW_WORKER}.` and ends in `.workers.dev`
before issuing requests. Never substitute a production or generic staging URL.

```bash
: "${PREVIEW_URL:?Set the URL emitted by this deployment}"
node - "$PREVIEW_URL" "$PREVIEW_WORKER" <<'NODE'
const assert = require('node:assert/strict');
const [raw, worker] = process.argv.slice(2);
const u = new URL(raw);
assert.equal(u.protocol, 'https:');
assert.equal(u.port, '');
assert.equal(raw, u.origin);
const labels = u.hostname.split('.');
assert.equal(labels.length, 4);
assert.equal(labels[0], worker);
assert.equal(labels.slice(2).join('.'), 'workers.dev');
NODE
curl --disable --fail --silent --show-error --max-time 15 \
  "$PREVIEW_URL/api/v1/health" -o "$PREVIEW_DIR/health.json"
node -e 'const h = require(process.env.PREVIEW_DIR + "/health.json"); if (h.status !== "ok" || h.service !== "routeware-shadow-api") process.exit(1)'
status="$(curl --disable --silent --show-error --max-time 15 -o /dev/null \
  -w '%{http_code}' "$PREVIEW_URL/api/v1/shadow/health")"
[[ "$status" == 401 ]]
```

Expected: public health returns 200/`status: ok`; protected shadow health returns
401 because no bearer secret is configured. One auth rejection can write synthetic
throttle state in the temporary DO; it does not fetch upstream or touch snapshots.
Do not loop the rejection probe (the throttle can return 429). Do not call proxy,
login, sync/import, data-entity write or archive routes. `/docs` and `/openapi.json`
remain disabled. No readiness claim is made: data bindings/report sources are
intentionally missing. Do not add real data or credentials to make this preview pass.

## 4. Teardown / undo (temporary target only)

Before deleting anything, inspect the account, exact Worker and recorded deployment
above. Retain non-secret evidence outside the scratch directory. Ensure no other
Worker consumes this disposable DO and no valuable data was introduced. Deletion
permanently removes this temporary Worker's associated state; unexpected shared or
real data means **stop**, not force deletion. This is not a production rollback.

```bash
: "${CLOUDFLARE_ACCOUNT_ID:?Use the same verified preview account}"
node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const c = JSON.parse(fs.readFileSync(process.env.PREVIEW_CONFIG, 'utf8'));
assert.match(process.env.PREVIEW_WORKER, /^routeware-shadow-api-pr-[1-9][0-9]{0,8}-[0-9a-f]{12}-[0-9a-f]{8}$/);
assert.equal(c.name, process.env.PREVIEW_WORKER);
assert.deepEqual(c.routes, []);
assert.deepEqual(c.triggers.crons, []);
assert.deepEqual(c.durable_objects.bindings, [{ name: 'AUTH_SESSION', class_name: 'AuthSession' }]);
NODE
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" WRANGLER_SEND_METRICS=false \
  node "$WRANGLER" delete "$PREVIEW_WORKER" --config "$PREVIEW_CONFIG"
```

Keep Wrangler's confirmation prompt; verify the temporary name/account, never use
`--force`. Confirm the Worker and its associated namespace are gone in the selected
account and the recorded URL no longer serves this deployment. Record teardown
outcome and release the local scratch directory through normal workspace cleanup.
There are no separately created D1 databases or R2 buckets to delete. Production
config, data, routes, credentials and activation gates remain untouched throughout.

## Reviewer-checkable acceptance

- [ ] Only documentation changed; production activation/approval gates are unchanged.
- [ ] Name includes PR, reviewed SHA and random suffix; first-deploy collision check is required.
- [ ] Independent config contains synthetic vars, `.invalid` upstream, fresh same-Worker DO, empty routes/cron and no production resources/secrets.
- [ ] Credential-free `deploy --dry-run` passes before any separately authorized manual deployment.
- [ ] Smoke is explicitly limited to liveness/auth rejection, with no data/readiness/parity claim.
- [ ] Teardown validates the exact temporary target, retains confirmation and records removal.

## Official references

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/): explicit config, routes, `workers_dev`, cron, vars and same-script DO bindings.
- [Wrangler deploy/delete commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/): `--config`, `--name`, `--dry-run`, `--outdir` and deletion semantics. Use the pinned executable's `--help` for version-specific options.
- [Local and deployed secrets](https://developers.cloudflare.com/workers/configuration/secrets/): config-directory dotenv loading and preservation of existing deployed secrets.
- [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/): legacy `new_sqlite_classes` migration and Worker/environment namespace isolation. The newer declarative `exports` flow is not required by this pinned Wrangler recipe.
- [SQLite-backed storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/): SQLite-backed objects support the key-value storage API.
