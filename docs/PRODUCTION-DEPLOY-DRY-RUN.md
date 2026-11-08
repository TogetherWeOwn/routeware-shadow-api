# Production deploy dry-run checklist

**Production stays OFF.** Keep the repository-scoped
`PRODUCTION_DEPLOY_ENABLED` variable set to `false` throughout this rehearsal; it
overrides an applicable organization-level value for this repository. This checklist
is not go-live approval: it neither enables deployment nor authorizes production tests,
migrations, probes, credential changes, or spend.

Use the [credential-free Actions workflow](../.github/workflows/offline-rehearsal.yml)
on the exact candidate with locked development dependencies. **Full rehearsal,
builds, bundling and suites run in GitHub Actions only**, never on the shared host.
Do not run the handover's activation steps. Record the candidate
SHA, UTC observation time, command results and evidence links; never record
credential values, request/response bodies, customer rows, or raw CSVs.

## 1. Confirm the gate remains off

- [ ] Verify that the repository-scoped `PRODUCTION_DEPLOY_ENABLED` value is
  `false`; it overrides an applicable organization-level value for this repository.
  An absent repository value does not establish that the effective gate is off.
  Inspect other applicable repository and organization variable **names only**.
  If the repository value is present and not `false`, record **NOT READY**; if it
  is missing or inaccessible, record **NOT VERIFIED**. Stop in either case. Do not
  add, edit or delete a variable as part of this rehearsal.
- [ ] Inspect the candidate's [CI workflow](../.github/workflows/ci.yml).
  The deploy job must require successful `build` and `hygiene`, the exact condition
  `github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.PRODUCTION_DEPLOY_ENABLED == 'true'`,
  the `production` environment, and job-level deployment serialization with
  `cancel-in-progress: false`. Also inspect workflow-level concurrency: the
  workflow must group by `ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}`
  with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`, so a new push
  to a PR cancels that PR's superseded runs but a main push never cancels
  an in-flight workflow during migrations/deploy. A global `cancel-in-progress: true`
  would let a newer main push cancel an older workflow despite the job-level setting;
  record that deviation as interruption risk **NOT READY** for unattended activation.
  Job serialization is not an uncancelable-deploy guarantee. Do not change a
  gate or concurrency setting for rehearsal.
- [ ] Read an existing push-to-main CI receipt: record head SHA, run URL and the
  deploy job's **skipped** conclusion. A PR's skipped deploy only proves the PR
  trigger is excluded, not that the enable variable is absent. A queued run has
  no verdict; an older successful run is not evidence for the candidate head.

Read-only metadata commands (substitute the repository, not a token). The first
command prints only a status label, not the deploy variable value; the others print
names only:

```bash
gh api repos/<owner>/<repo>/actions/variables/PRODUCTION_DEPLOY_ENABLED --jq 'if .value == "false" then "repository gate: false" else "repository gate: NOT FALSE" end'
gh api repos/<owner>/<repo>/actions/variables --paginate --jq '.variables[].name'
gh api orgs/<org>/actions/variables --paginate --jq '.variables[].name'
gh api repos/<owner>/<repo>/environments/production/variables --paginate --jq '.variables[].name'
gh api repos/<owner>/<repo>/actions/secrets --paginate --jq '.secrets[].name'
gh api repos/<owner>/<repo>/environments/production/secrets --paginate --jq '.secrets[].name'
```

A missing repository variable or denied read is **NOT VERIFIED**; do not fall back to
an organization-level setting for a one-repository stop. Have an authorized
administrator set the repository-scoped value to `false` before the rehearsal.

Have an authorized operator attest applicable organization-variable names and
repository visibility if that scope is unavailable. Environment variables are
not available to the job-level gate before its environment starts, but record
their names too. A denied metadata read is **NOT VERIFIED**; stop that read,
never try another credential. Secret-name presence does not prove a usable value.

## 2. Check configuration without retrieving secrets

- [ ] Review non-secret `wrangler.toml` configuration against the intended account
  and resources: Worker name, account ID, `CUSTOMER_DB` database ID and migration
  directory, `AUTH_SESSION` binding and Durable Object migration, `BROWSER`,
  `SNAPSHOTS` bucket, cron schedule, target origin/base/login paths, report query
  IDs or export paths, and `SHADOW_API_PUBLIC_BASE` for chained cron syncs.
  Empty public base or missing required resource configuration means **NOT READY**.
  Keep deployed `OPENAPI_DOCS_ENABLED` false unless separately authorized.
- [ ] Record GitHub secret-name metadata for `CLOUDFLARE_API_TOKEN` in the
  `production` environment and optional `CF_TOKEN` for the contract-test gate.
  Separately obtain an existing, authorized Worker secret-name inventory for
  `SHADOW_API_TOKEN`, `CUSTOMER_SNAPSHOT_SYNC_SECRET`, `LOGIN_USERNAME`, and
  `LOGIN_PASSWORD`; see [handover](HANDOVER.md). Do not fetch values, mint tokens,
  run secret setters, or use a token just to test permissions.
- [ ] Run the local checks below. Vars parity proves key documentation matches;
  it does not prove production secrets, account permissions, paid-plan capacity,
  deployed bindings, or correct operational values. Mark these **NOT VERIFIED**
  unless a separate authorized receipt establishes them.

## 3. Rehearse the local bundle and migrations

The executable implementation is [deploy-rehearsal.mjs](../scripts/deploy-rehearsal.mjs),
using the existing workflow/parity checks and D1 drift helpers. Push a draft PR;
the offline workflow automatically checks out its **head SHA**, not a synthetic
merge SHA. It has no environment, variable/secret lookup, live workflow dispatch,
deploy, remote migration or probe step. Metadata gaps in §1 stop live acceptance,
not this independently isolated offline job; no gate is changed to make it run.

The legacy shell below is retained as a hermetically stub-tested specification,
**not a local execution instruction**. Its full execution is Actions-only; the
workflow uses the stricter Node runner, isolated HOME/XDG, fixed commands and a
kernel network namespace with loopback only. The runner rejects a dirty/mismatched
candidate, non-absolute/missing/root/internal/ancestor scratch paths, every scratch
symlink component, and local credential files/symlinks before tool execution.
`REHEARSAL_SCRATCH` is the Actions runner's external temporary directory. Each run
allocates a fresh child for HOME, XDG, local D1 and the bundle, then removes that
child in `finally` on success/failure. Cancellation/timeout destroys the ephemeral
GitHub-hosted runner; a cancelled or missing receipt is never a completed rehearsal.

Legacy specification only (do not paste into a shared-host terminal):

```bash
env -i PATH="$PATH" PAPERCLIP_RUN_SCRATCH_DIR="${PAPERCLIP_RUN_SCRATCH_DIR:-}" sh -eu <<'REHEARSAL'
case "$PAPERCLIP_RUN_SCRATCH_DIR" in
  /*) [ -d "$PAPERCLIP_RUN_SCRATCH_DIR" ] || exit 1 ;;
  *) printf '%s\n' 'Set an existing absolute external scratch directory; stop.' >&2; exit 1 ;;
esac
PAPERCLIP_RUN_SCRATCH_DIR=$(CDPATH= cd "$PAPERCLIP_RUN_SCRATCH_DIR" && pwd -P)
checkout_root=$(pwd -P)
case "$PAPERCLIP_RUN_SCRATCH_DIR/" in
  //|"$checkout_root/"*) printf '%s\n' 'Scratch must be outside the checkout; stop.' >&2; exit 1 ;;
esac
for file in .env .env.* .dev.vars .dev.vars.*; do
  if { [ -e "$file" ] || [ -L "$file" ]; } && [ "$file" != .dev.vars.example ]; then
    printf '%s\n' 'Local credential files present; stop.' >&2
    exit 1
  fi
done
[ ! -L .dev.vars.example ] || exit 1
export PAPERCLIP_RUN_SCRATCH_DIR
rehearsal_home=$(mktemp -d "$PAPERCLIP_RUN_SCRATCH_DIR/rehearsal-home.XXXXXX") || exit 1
env -i PATH="$PATH" HOME="$rehearsal_home" \
  XDG_CONFIG_HOME="$rehearsal_home/.config" \
  PAPERCLIP_RUN_SCRATCH_DIR="$PAPERCLIP_RUN_SCRATCH_DIR" \
  WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false \
  sh -c '
    npm run check:ci-workflow &&
    npm run check:vars-parity &&
    npm run check:d1-drift &&
    npx --no-install wrangler deploy --dry-run --env="" --outdir "$PAPERCLIP_RUN_SCRATCH_DIR/worker-dry-run"
  '
REHEARSAL
```

The first `env -i` starts a noninteractive shell without inherited glob settings,
so `GLOBIGNORE` or disabled globbing cannot hide local credential files. It validates
the physical scratch path before allocation or tools, including symlinks back into
the checkout. Both `env -i` invocations drop inherited credentials (including legacy
`CF_API_TOKEN`, `CF_API_KEY`, and `CF_EMAIL`); fresh HOME/XDG directories isolate
Wrangler's OAuth cache. Rejecting all local dotenv/dev-vars files except the committed
non-symlink example also blocks `.env.local` and environment-specific credential loading.
The explicit empty environment selects the top-level production configuration
for **bundling only**; it does not execute or deploy the Worker.

- [ ] `check:ci-workflow` and `check:vars-parity` exit 0.
- [ ] `check:d1-drift` reports manifest hashes match and a fresh **local** D1
  migration journal matches all committed `migrations/d1/*.sql` files. It applies
  only to a throwaway local database under `PAPERCLIP_RUN_SCRATCH_DIR`, not local
  developer state. Do not regenerate the checksum manifest to hide drift.
- [ ] Record its remote compare as **SKIPPED / NOT VERIFIED**. Local success does
  not establish that production migrations are current. Compare only an existing
  authorized production journal receipt (migration names, candidate SHA and time,
  no customer data); if unavailable or stale, leave production state **NOT VERIFIED**.
  Do not pass `--remote` during this rehearsal.
- [ ] The Worker bundle dry run exits 0 and produces inspectable output. It compiles
  without deploying to live servers; it does not exercise the Worker, Routeware
  login, cron, remote D1/R2, or production permissions. Never omit `--dry-run`.

## 4. Check probe evidence, not production

- [ ] Inspect an existing approved **staging** probe receipt with target, head SHA,
  UTC time and individual results for `GET /api/v1/health`,
  `GET /api/v1/shadow/health`, and `GET /api/v1/readiness`.
  Require all three to run, the overall `post-deploy probe: all three probes passed`
  summary and exit 0, readiness HTTP 200 with `status: "ok"`, and
  `PASS cron freshness -> fresh`. Individual endpoint PASS lines are insufficient:
  degraded/503 readiness or stale cron is **FAIL**;
  an unknown cron verdict is **NOT VERIFIED**, not proof of fresh cron.
- [ ] Authed probes skipped for missing credentials are **SKIPPED**, never green
  readiness. A `shadow-api-v1` job whose credential-gated contract step was skipped
  is not a live probe pass either. Do not dispatch workflows or invoke a probe in
  this checklist. Missing approved staging target/receipt means **NOT VERIFIED**;
  never substitute production or runner localhost. See the scheduled probe
  workflow and `scripts/post-deploy-probe.mjs` at the candidate SHA.

## 5. Record what would happen later (do not execute)

A separately authorized future push to `main`, with the enable variable exactly
`true` and blocking CI successful, would enter the `production` environment,
install locked dependencies, apply remote D1 migrations, then deploy the Worker.
The deploy job uses `CLOUDFLARE_API_TOKEN`; it does not set the four Worker secrets.
Post-deploy probes are a separate workflow, not a step that automatically rolls
back a failed deployment. This rehearsal executes none of those live operations.

The [handover emergency-stop guidance](HANDOVER.md#phase-2--intentionally-enable-production-deploys)
describes stopping **future** deployments. That does not roll back an already
published Worker or undo D1 changes. Any actual stop, rollback, or activation
requires separate authority; never delete data or migration history as rehearsal.

## Actions receipt and evidence classification

The `offline-rehearsal-<candidate SHA>-<attempt>` artifact contains only sanitized
JSON: exact candidate SHA, command arrays, UTC start/finish, child exits/conclusions,
manifest SHA-256, committed migration names/hashes, verified fresh local journal,
bundle digest and cleanup outcome. No child stdout/stderr, HOME/OAuth cache,
SQLite database, bundle bytes, credentials or response bodies are uploaded. The
job summary explicitly labels its result **offline, not live readiness**. Link the
exact-head Actions run, job and artifact URLs in the review record; a plan or
ordinary green CI is not a substitute. Missing/failed/cancelled artifact evidence
is a gate failure, not a reason to run a local mirror.

[The data-only recorder](../scripts/classify-probe-evidence.mjs) takes one saved
JSON filename, not a URL or token. It never runs the probe or resolves auth. Input
is a non-symlink regular file limited to 64 KiB with these fields:

- `kind`: `staging-probe` or `synthetic` (ordinary CI is not probe evidence).
- `candidateSha`: exact 40-character lowercase Git SHA; `observedAt`: UTC with `Z`.
- `exitCode`: the observed probe process exit; `probe`: its existing version-1
  `probe:post-deploy` JSON envelope, including all three ordered fixed GET rows.
- `approvedStagingOrigin`: an already approved nonproduction origin for real
  staging receipts. This is provenance supplied by the authorized evidence owner,
  **not an approval created or verified by the classifier**. Attach the approval
  and original Actions receipt to the review record; untrusted JSON alone proves
  neither approval nor that a probe ran. Classification is not probe authorization.

Invoke `node scripts/classify-probe-evidence.mjs <saved-receipt.json>` for a
read-only classification. No raw input fields, target, response or next-action text
are echoed. `PASS` requires the executed v1 envelope's all-three success, exit 0,
HTTP 200 on each check, null error codes, and fresh cron. The existing v1 evaluator
only emits a readiness `pass` at HTTP 200 when the body has `status: "ok"`; legacy
text logs without that machine evidence remain NOT VERIFIED. Missing token is
SKIPPED; actual failed/degraded/stale checks are FAIL (even beside a skip); unknown
cron or absent approved staging target is NOT VERIFIED. Plans, ordinary CI,
public-only results and localhost never establish readiness. Exit codes are
0 PASS, 1 FAIL, 2 NOT VERIFIED, 3 SKIPPED. A synthetic fixture can validate the
classification logic with `classification: PASS`, but always retains
`liveReadiness: NOT VERIFIED`. Synthetic PASS is never deployed health evidence.

## Owned acceptance matrix and residual holds

The review record links the assigned owning cards, observable release condition,
UTC deadline and timeout action for every live gap. Source delivery is separate
from any future Release Manager decision. The source PR creates no resources,
no always-on exception, cost, credential, production change or probe authority.

| Evidence | Owner | Acceptance / release condition | Current scope |
| --- | --- | --- | --- |
| Offline workflow/parity + bundle | DevOps | Exact-head Actions job and receipt PASS; cleanup PASS | Reproducible offline only |
| Manifest + LOCAL D1 journal | DevOps | Original hashes match; fresh throwaway journal matches all files | Reproducible offline only |
| Explicit-false production gate metadata | Release Manager, authorized metadata owner | Existing authorized repository-scope `false` receipt; never add/set it in this PR | NOT VERIFIED: repository read returned 404 |
| Production migration journal | Release Manager | Existing authorized candidate-bound names/time receipt; no remote query here | NOT VERIFIED |
| Approved isolated staging target + probe receipt | Product Lead (environment scope), Release Manager (execution acceptance) | Existing approved target, isolated bindings, separately authorized exact-SHA receipt; classifier PASS and fresh cron | NOT VERIFIED: no approved deployed target recorded |
| Production-capable merge classification | Final reviewer + Release Manager | Inspect automatic workflow paths AND default-head provider deployments/checks; exact-head acceptance if capable/unknown | Separate merge gate, never deploy readiness |

Live-gap diagnostic deadline: **2026-11-08T18:00:00Z**. At expiry the owning
assigned card must publish its exact missing evidence and route the actionable
prerequisite to the existing authorized owner, or the new environment/product
scope to Product Lead. Do not silently extend a hold, provision staging, fetch
credentials, probe production or claim readiness. See the
[safe historical evidence record](offline-readiness-evidence.json); its observations
are historical facts, not proof of current credentials, effective gate or health.

## Zero-idle-cost staging and preview (future acceptance, not provisioning)

Any separately proposed staging/preview must use approved **nonproduction,
isolated bindings** and incur **no recurring always-on runtime cost when idle**.
Before acceptance, inventory every applicable Worker, Container, Durable Object
and its alarms, cron/scheduled Workers, Stream input, keep-alive/probe mechanism,
Browser Rendering and database compute; mark each applicable/not-applicable with
evidence. A sleeping Container alone is not proof of no idle charge. The current
production binding inventory is in [HANDOVER.md](HANDOVER.md#2-cloudflare-inventory);
this PR creates no staging copy and changes nothing in production.

Trusted pipeline-owned on-demand startup and readiness must precede qualification
and e2e, bound to the tested SHA and environment. Grant a bounded active-use
window; retain startup/readiness and expiry evidence. Use native stop/scale-to-zero
and native cleanup/expiry after **success, failure and cancellation**, including
alarms/cron/keep-alive, Stream inputs and database compute. No host timer or new
scheduler. No alarm, periodic probe or schedule may resurrect or sustain idle
resources outside that window. Preserve health/security/qualification checks
during authorized active use, exact-head Actions, artifact, migration/rollback,
Security/QA and Release Manager gates. Unsupported lifecycle controls are a real
prerequisite, not a PASS or permission to weaken checks. Any always-on exception
requires explicit dated owner authorization on its assigned card, resource and
environment scope, recurring cost, and expiry/review date. No such exception is
authorized here; production is untouched.

## Reviewer acceptance record

Fill this out in the review work product, not with sensitive values in this file:

| Check | Required evidence | Outcome |
| --- | --- | --- |
| Deploy remains off | Applicable variable-name inventory + existing main run with deploy skipped | PASS / NOT VERIFIED |
| CI/configuration | Candidate SHA, gate review, vars parity, binding/secret-name inventory | PASS / NOT READY / NOT VERIFIED |
| Bundle rehearsal | Dry-run command, exit status, output location | PASS / FAIL |
| Migrations | Manifest + fresh local journal; production journal evidence separately | Local PASS / FAIL; production NOT VERIFIED unless evidenced |
| Probe readiness | Approved staging receipt; all three ran, overall exit 0, readiness HTTP 200/ok and fresh cron | PASS / FAIL / SKIPPED / NOT VERIFIED |
| Hypothetical ordering | Remote migrations before Worker deploy; gates and rollback limits unchanged | PASS / FAIL |

Report **REHEARSAL COMPLETE — PRODUCTION STILL OFF** only when the offline checks
pass and every missing live prerequisite is explicitly recorded. This is not a
production-readiness PASS. Unverified items stay open on their existing dependency
cards; completing the checklist does not clear or bypass them.
