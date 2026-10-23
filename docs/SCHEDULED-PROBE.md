# Scheduled post-deploy probe

`Post-deploy probe` runs daily and on `workflow_dispatch`. Both use
`npm run probe:post-deploy:scheduled`, which requires a configured remote HTTPS
origin. GitHub `schedule` events enforce the same requirement even if the CLI
flag is omitted. Missing/blank, malformed, non-HTTPS, local, URL-credential,
non-root path, query, or fragment values fail before any fetch; there is no
scheduled localhost fallback. A root slash and explicit HTTPS port are allowed.
The hermetic CLI suite also runs in the always-run CI hygiene job, so probe-only
changes cannot skip these regressions when the filtered build is skipped.

## Staging prerequisite

An operator must first identify an **approved, deployed nonproduction Worker**,
with isolated staging bindings and no production data or upstream mutation.
Then set an Actions variable `SHADOW_API_BASE` in the repository scope for a
repository-specific target, or in an applicable organization scope only if the
target is intentionally shared. Verify the workflow's effective
`vars.SHADOW_API_BASE` resolves to the approved origin. A valid-looking URL is
not approval: do not copy a workers.dev example or a production deployment URL.
Repository documentation currently records no staging deployment; check
applicable repository and organization scopes before concluding the variable is
missing, and keep its effective value missing (so the monitor stays red) until
this prerequisite is resolved. Do not disable the workflow or add a
success/skip condition to hide the dependency.

`SHADOW_API_TOKEN` remains optional in scheduled mode. Without it the public
`GET /api/v1/health` still runs and the two authenticated GETs log explicit
SKIP lines. With a token, shadow health, readiness, and cron freshness all
retain their existing failure gates. Never paste token values into logs or
issues. The probe does not deploy, migrate, rotate secrets, or issue writes.

## Agent plans and machine results

For an effect-free inspection, use either plan format (no target grants are implied):

```sh
node scripts/post-deploy-probe.mjs --dry-run --json
node scripts/post-deploy-probe.mjs --dry-run
```

These commands validate the existing target/scheduled rules but do not fetch,
resolve tokens (even supplied ones), read `.dev.vars`, write files or start
subprocesses. They plan exactly three GETs: `public-health` → `/api/v1/health`,
`shadow-health` → `/api/v1/shadow/health`, and `readiness` → `/api/v1/readiness`.
The public check is `planned`; the authenticated checks remain `unresolved`,
not passed or skipped. `ok: true` means **valid plan**, not healthy service.
Explicit target wins over `SHADOW_API_BASE`, then the manual local default.
Manual URLs normalize to their origin; scheduled runs still require a bare
remote HTTPS origin. Validation is not a hostname approval allowlist or remote
probe authority. Do not use these examples to justify live execution.

For separately authorized execution, `--json` is composable with existing
`--token-env`, `--timeout-ms`, `--skip-if-no-token`, and `--scheduled` options.
Use the Node entrypoint for machine output (npm adds its own banner). It emits
exactly one compact JSON line on stdout, with empty stderr, including refusals.
The version-1 envelope has `schemaVersion`, `command`, `mode`, `ok`, `target`,
`checks`, `errorCode`, and `nextAction`. Each fixed check has `id`, `method`,
`path`, `outcome`, `errorCode`, `httpStatus`, `httpClass`, `retryable`,
`nextAction`, and `cron`. Run outcomes are `pass`/`fail`/`skip`; HTTP family is
`1xx`–`5xx` or null before a response. `cron` is null unless evaluated on
readiness, then `fresh`/`stale`/`absent`/`malformed`. Help with `--json` returns
an empty successful envelope, not health evidence.

Allowlisted error codes: `invalid_arguments`, `invalid_target`, `missing_token`,
`http_auth`, `http_client`, `http_server`, `http_redirect`, `http_status`,
`network_error`, `timeout`, `invalid_json`, `invalid_health`, `invalid_readiness`,
`cron_stale`, `malformed_readiness`. Fixed `nextAction` text gives the inspection
step; `retryable` is guidance only, never an automatic retry. Redirects are not
followed. Fetch and body read share the per-check timeout. All three checks are
collected even after a failure; missing-token skip/fail policy is unchanged.
Exit 1 / `ok: false` indicates a refusal or failed check. Explicit skip-safe
execution can exit 0 with two skipped checks; that is still a monitoring gap.

Output is bounded to 8192 bytes using fixed rows/diagnostics and a normalized
origin limited to 1024 characters. Response bodies, exception messages/stacks,
cron timestamps/details, bearer values and URL credentials/query/fragment are
never included. **This is an output bound, not a bounded response-body reader**:
the current reader still buffers the response before evaluation.

Hermetic checks only (injected fetch and synthetic environments; no live calls):

```sh
node --test scripts/post-deploy-probe-json.acceptance.test.mjs scripts/post-deploy-probe.test.mjs
npx --no-install vitest run test/postDeployProbe.test.ts
npm run test:probe
```

## Verification and rollback

Run `npm run test:probe` for hermetic CLI tests (all fetches are fixtures), then
run the scheduled command only against the operator-approved staging origin.
Record the exact head SHA, run URL, and probe result. Until staging is approved,
record the explicit configuration failure and the first-class dependency, not
a staging PASS. Ordinary CI success is not a successful scheduled monitor.

Local development keeps `npm run probe:post-deploy -- http://localhost:8787`
and the manual localhost default. To undo the code change, revert its scoped
commit. To undo newly configured Actions variables, restore the prior metadata
through the authorized operator; do not delete live data or alter deployment
gates.
