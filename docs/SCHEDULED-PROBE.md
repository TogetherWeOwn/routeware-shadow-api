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
Then set the repository Actions variable `SHADOW_API_BASE` to that origin.
A valid-looking URL is not approval: do not copy a workers.dev example or a
production deployment URL. Repository documentation currently records no
staging deployment; configuration must remain missing (and the monitor red)
until this prerequisite is resolved. Do not disable the workflow or add a
success/skip condition to hide the dependency.

`SHADOW_API_TOKEN` remains optional in scheduled mode. Without it the public
`GET /api/v1/health` still runs and the two authenticated GETs log explicit
SKIP lines. With a token, shadow health, readiness, and cron freshness all
retain their existing failure gates. Never paste token values into logs or
issues. The probe does not deploy, migrate, rotate secrets, or issue writes.

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
