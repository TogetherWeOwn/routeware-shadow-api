# Handover — transferring this repo to a new organization

Written 2026-08-22, when the project left its original machine and GitHub account. Everything the
outgoing maintainer knew that was **not** already in the repository is written down here. If you are
picking this project up, read this file, then [`README.md`](../README.md) and
[`CONVENTIONS.md`](CONVENTIONS.md).

Two facts govern every change in this codebase, and neither is obvious from the code:

1. **The upstream signals failure silently.** An expired admin session or a stale anti-forgery token
   comes back as an HTML page with **HTTP 200** — never a 401, never a 4xx. Code that trusts the
   status code is wrong here.
2. **The data in flight is customer PII.** Roughly 609,000 rows of customer, address and container
   records move through the snapshot path.

---

## 0. Do this first — verify PR CI before enabling production deploys

**Verification and production authorization are separate.** CI uses GitHub-hosted `ubuntu-latest`
runners. On PRs to `main`, changed-area detection selects the credential-free `build` and
optional `shadow-api-v1` jobs; `hygiene` always runs. Docs-only PRs targeting `main` skip build and
shadow. Pushes to `main` and nightly runs select the full verification suite; `ci-ok` aggregates these
jobs, accepting intentional skips but failing on failures or cancellations. When selected, `shadow-api-v1`
evaluates an optional `CF_TOKEN` gate and skips its contract step without that token. The `deploy`
job requires successful build and hygiene, a push to `main`, and the expression
`vars.PRODUCTION_DEPLOY_ENABLED == 'true'`; it never runs on PRs or nightly schedules. GitHub
[compares strings case-insensitively](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#operators),
so `TRUE` and `True` also enable this gate. The [`vars` context](https://docs.github.com/en/actions/learn-github-actions/variables)
can include organization-, repository-, and environment-level configuration variables. Since a job-level
`if` is evaluated before a runner is assigned, and GitHub documents environment variables as becoming
available after environment declaration, do not infer the gate's effective value from a repository-only
listing; check applicable organization/repository scopes and inspect `production` separately. For a
repository-scoped stop, set this repository's variable to `false`; that overrides an organization-level
value for this repository. Do not change a shared organization variable unless an organization-wide
stop is intended. An environment-level variable is unavailable to this job-level `if`, so do not rely on
an environment value to disable the gate.

The clean replacement repository initially had Actions disabled on 2026-08-22 (see § 6), but
`GET actions/permissions` returned `enabled: true` on 2026-10-09. Re-check the current repository or
new owner's settings instead of unconditionally re-enabling Actions. Do not infer secrets or
production readiness from successful runs; keep production deploys disabled until setup is explicitly approved.

### Observed runner/gate behavior (verified 2026-10-09, read-only — no settings or deployments changed)

- **Actions are enabled:** `GET actions/permissions` returned `enabled: true` and
  `allowed_actions: all`. Successful main and PR runs below confirm execution, not production approval.
- **Main push:** run [37950235679](https://github.com/TogetherWeOwn/routeware-shadow-api/actions/runs/37950235679)
  (2026-10-09, head `eaec84e`, after #224/#227/#229): **completed / success** —
  `Detect changed areas`, `Typecheck, test, build`, `Repo hygiene & secret scan`,
  `shadow-api-v1` and `ci-ok` succeeded; `Deploy to Cloudflare Workers` was **skipped**.
  The repository variables list returned `total_count: 0`; that endpoint covers
  repository-scoped variables only. Organization and `production` environment scopes were not
  inspected, so this does not establish that the effective `vars.PRODUCTION_DEPLOY_ENABLED`
  value was absent. The skipped deploy is the observed result for this run. This is a pinned
  completed run, not a claim that every newer main run has finished or passed.
- **Docs-only PR:** run [37757808298](https://github.com/TogetherWeOwn/routeware-shadow-api/actions/runs/37757808298)
  (2026-10-08, head `24153bc`, link re-verified 2026-10-09): **completed / success** —
  changed-area detection, hygiene and `ci-ok` succeeded; build, `shadow-api-v1` and deploy
  were **skipped**. A green docs-only run does not mean typecheck, coverage or remote contract
  tests executed.
- **Runners:** every CI job on both runs carries labels `[self-hosted, two-selfhosted]`, matching
  `.github/workflows/ci.yml` (re-verified on the 2026-10-09 main run). That was the
  stable contract then, not individual host names; CI has since moved to
  `ubuntu-latest`.
- **Optional contract gate:** on the 2026-10-09 main run, `Evaluate operator credential gate`
  succeeded and `Execute versioned API contract tests` was **skipped** while `shadow-api-v1`
  stayed green.
  A successful gate/job is not evidence that the credentialed contract tests ran. No secret values
  were read during verification.
- **Main protection:** `GET branches/main` returned `protected: true`. `GET rules/branches/main`
  returned active required checks: organization rule `Paperclip Review`; repository rules `pr-lint`,
  `ci-ok` and `Repo hygiene & secret scan`. The classic `GET branches/main/protection` endpoint
  returned 404 (`Branch not protected`); that does **not** negate the active rulesets. Re-check the
  effective rules after a transfer rather than treating this repository as unprotected.
- **Environment:** `production` still exists (created 2026-09-21), with `protection_rules: []`
  and no deployment branch policy. It has no environment-required reviewers; its existence and
  successful CI do not authorize enabling deploys or prove production credentials/resources are ready.

### Phase 1 — verify credential-free PR checks after a transfer

1. **Keep this repository's production gate off.** Set the repository-scoped
   `PRODUCTION_DEPLOY_ENABLED` variable to `false`; it overrides an organization-level value for this
   repository. Do not change a shared organization variable unless an organization-wide stop is
   intended. An empty repository-variable list does not rule out an organization value becoming
   effective. Inspect `production` separately for secrets and protections; because the job-level `if`
   is evaluated before a runner is assigned, an environment-level variable cannot stop this gate. If
   you cannot verify the applicable organization scope, have an authorized administrator check it.
2. **Check whether Actions are enabled:**
   ```bash
   gh api repos/<owner>/<repo>/actions/permissions --jq .enabled     # expect: true
   ```
   This repository was already enabled at verification. Only if the destination has Actions disabled,
   have an authorized administrator enable them using Settings → Actions → General or:
   ```bash
   gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=true
   ```
   Then confirm the enabled flag again. If the new owner is an organization, an **org-level** policy
   can still block Actions even when the repo says enabled — check Organization Settings → Actions →
   General as well.

   **Re-enabling does not retroactively build anything.** Verified 2026-08-22 by toggling it on this
   repo: no runs were created for pushes made while it was off, and GitHub does not replay those missed
   push events after re-enabling. Future scheduled workflows run independently: CI is nightly and the
   post-deploy probe is daily; the probe also supports manual `workflow_dispatch`.
3. **Verify without shipping anything.** Inspect a recent run from a pull request targeting `main` for
   the reviewed head, or use a documentation-only pull request targeting `main` after a transfer.
   Expect changed-area detection, `Repo hygiene & secret scan`, and `ci-ok` to pass on the
   GitHub-hosted runners; docs-only PRs targeting `main` intentionally skip build and shadow. For a PR
   selecting
   build/shadow, confirm build passes and, without `CF_TOKEN`, the shadow gate reports its reason and
   skips contract execution. The deploy job must be skipped on pull requests targeting `main` and remain
   skipped on pushes to `main` unless the effective repository/organization value matches `true`
   case-insensitively. Any failed or cancelled required check blocks merging; do not interpret optional
   skips as executed tests.
4. **Verify effective rules on `main`**, including organization rulesets:
   ```bash
   gh api repos/<owner>/<repo>/rules/branches/main
   ```
   At verification, the required contexts were `Paperclip Review`, `pr-lint`, `ci-ok` and
   `Repo hygiene & secret scan`. After a transfer, have an authorized administrator restore the
   intended rules if needed. Require the aggregate `ci-ok`, not a build job that intentionally skips
   on docs-only PRs targeting `main`, and finish this check before any production deploy.

For an offline rehearsal that leaves production off, use the
[production deploy dry-run checklist](PRODUCTION-DEPLOY-DRY-RUN.md). It is not
permission to execute Phase 2 or to test production.

### Phase 2 — intentionally enable production deploys

Only after the production Cloudflare account, resources and Worker secrets are ready:

1. **Create the Cloudflare API token** (skip if you are keeping the existing one — but note its value
   cannot be read back out of the old repo, so if you do not have it saved, you need a new one).
   Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template. **Confirm
   `D1 : Edit` and R2 read are included** — the deploy job applies D1 migrations and fails without
   `D1 : Edit`. Its R2 preflight (`.github/workflows/ci.yml:307-314`) runs `wrangler r2 bucket info`
   with this same token, so R2 read is needed too. Do **not** use the Global API Key.
2. **Create the `production` environment.** Repo → Settings → Environments → New environment →
   name it exactly `production`. Add required reviewers here if the plan supports them.
3. **Add the environment secret** named exactly `CLOUDFLARE_API_TOKEN`:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --env production --repo <owner>/<repo>
   ```
4. **Set the repository variable last.** Keep the repository value `false` while configuring the
   production environment, token, resources, and Worker secrets; this overrides any organization-level
   value for this repository. Do not change a shared organization variable unless an organization-wide
   change is intended. The job-level `if` is evaluated before the production environment is assigned,
   so an environment-level variable does not control this gate. After production setup is ready and
   explicitly approved, set the repository value to `true`:
   ```bash
   gh variable set PRODUCTION_DEPLOY_ENABLED --body true --repo <owner>/<repo>
   ```
5. Push a reviewed commit to `main`; confirm all required checks pass, the deploy job runs, and
   `GET /api/v1/health` responds afterwards. As part of the approved release, run the strict
   post-deploy probe (`scripts/post-deploy-probe.mjs`, `npm run probe:post-deploy`), which checks
   `GET /api/v1/health` (public), `GET /api/v1/shadow/health` and
   `GET /api/v1/readiness` (both authenticated). It exits 0 only when all three pass,
   including readiness and cron-freshness checks when cron metadata is present:
   ```bash
   npm run probe:post-deploy -- https://<worker-url>
   # local dev: npm run dev in one shell, then
   npm run probe:post-deploy -- http://localhost:8787
   ```
   The bearer is read from `SHADOW_API_TOKEN` (else `CUSTOMER_SNAPSHOT_SYNC_SECRET`),
   `--token-env=NAME`, or local `.dev.vars` — it is never logged and never committed.

**Stop future deploys for this repository:** set `PRODUCTION_DEPLOY_ENABLED` to `false` in this
repository's variable scope. A repository-level `false` overrides an organization-level value for this
repository; do not change a shared organization variable unless intending to stop deploys for all
inheriting repositories. Deleting the repository variable can expose an organization-level `true`. The
`production` environment scopes deployment secrets and protections, but its variables are unavailable
to the job-level `if`, which is evaluated before a runner is assigned; do not rely on an environment
variable alone to disable the gate. Future workflow evaluations then skip deploy without disabling PR
checks. Changing only the variable's capitalization is not a stop because the comparison is
case-insensitive. This does not cancel an already-running deploy or roll back an already-deployed
Worker. Keep the code-level variable gate in place. If production setup is later abandoned entirely,
remove the deploy job rather than removing its fail-closed condition.

**The four Worker secrets are a separate matter** and are not set through GitHub. They live in
Cloudflare via `npx wrangler secret put …`, are untouched by deploys, and are listed by name in § 1.
`CLOUDFLARE_API_TOKEN` is the deployment job's secret. Optional contract verification separately
references `CF_TOKEN`; the scheduled/manual post-deploy probe references `SHADOW_API_TOKEN` and
`vars.SHADOW_API_BASE`, which may come from repository or applicable organization scope. Check both
scopes and verify the effective value is the approved staging origin. The probe workflow is not
chained to deployment; both its scheduled and manual-dispatch runs require a configured, approved
remote HTTPS staging origin. A missing or invalid target fails before any fetch (see
[`SCHEDULED-PROBE.md`](SCHEDULED-PROBE.md)).
With a valid target but no auth token, it skips authenticated checks, not public health. These
optional paths do not require adding production credentials to ordinary PR verification.

---

## 1. What lives outside this repository

The code is complete and self-contained. These are not, and none of them travel with a `git push`.

| System | What it is | Consequence if not carried over |
|---|---|---|
| Cloudflare account `209cf7dd678adfb683947dd7874d05af` | Owns the Worker, D1, R2, the Durable Object namespace and the cron trigger | Nothing deploys; §3 Scenario B applies |
| Cloudflare API token | GitHub Actions secret `CLOUDFLARE_API_TOKEN`, scoped *Edit Cloudflare Workers* **plus D1 : Edit and R2 read** | The `deploy` job fails; merges to `main` stop shipping |
| GitHub environment `production` | Scopes that secret; the place to add required reviewers | Deploy job cannot resolve the secret |
| Routeware tenant `killeen.routeware.com` | The upstream this Worker fronts | The Worker has nothing to talk to |
| Routeware admin login | `LOGIN_USERNAME` / `LOGIN_PASSWORD`, a real tenant account | Every authenticated route fails (silently — see fact 1) |
| Routeware custom reports **23 / 24 / 25** | Customer, Address and Container exports, built by hand in the Routeware UI | Snapshot sync has no source; these are tenant-specific and must be rebuilt or re-pointed |
| `.dev.vars` (local, gitignored) | The real values of the four secrets for local dev | Local dev cannot log in; recreate from `.dev.vars.example` |

**The four Worker secrets**, by name only — they are deliberately absent from the production `[vars]`
block of `wrangler.toml` so an unconfigured deploy does not trust a placeholder: the bearer gates answer
401 (`src/app.ts:148`, `src/routes/shared.ts:102`), and an unset `LOGIN_USERNAME` or `LOGIN_PASSWORD`
makes the upstream-backed routes error instead (`src/lib/httpAuth.ts:156`). `[env.test.vars]` holds
dummy values for the test environment only:
`SHADOW_API_TOKEN`, `CUSTOMER_SNAPSHOT_SYNC_SECRET`, `LOGIN_USERNAME`, `LOGIN_PASSWORD`.

> The real values must move to the new owner **out of band** — not through this repository, an issue,
> or a PR. Note §5: three of the four are still recoverable from the original repository's history and
> `refs/pull/*`, not from this clean repository. That is a problem to close, not a transfer mechanism to use.

---

## 2. Cloudflare inventory

Transcribed from [`wrangler.toml`](../wrangler.toml); that file remains the source of truth.

| Resource | Binding | Name / id |
|---|---|---|
| Worker | — | `routeware-shadow-api` |
| D1 (production) | `CUSTOMER_DB` | `routeware-customer-snapshot` — `2f6b26b2-6810-4d15-a2a0-fcbe273c56d2` |
| D1 (`env.test`) | `CUSTOMER_DB` | `routeware-customer-snapshot-test` — `739233bb-575a-4ac0-98e1-ecd5ea0f313e` |
| R2 (production) | `SNAPSHOTS` | `routeware-csv-snapshots` |
| R2 (`env.test`) | `SNAPSHOTS` | `routeware-csv-snapshots-test` |
| Durable Object | `AUTH_SESSION` | class `AuthSession`, migration tag `v1` |
| Browser Rendering | `BROWSER` | login fallback when `AUTH_MODE` is `auto` or `browser` |
| Cron trigger | — | `0 7 * * *` (UTC) — the daily snapshot chain |

**This needs a paid Workers plan.** `[limits] cpu_ms = 300_000` (snapshot runs stream large CSVs into
D1), Durable Objects, and Browser Rendering are all beyond the free tier. A free-tier account will
fail at deploy, not at runtime.

`compatibility_flags` includes `global_fetch_strictly_public` deliberately: the chained
`/data-snapshot/sync` calls this Worker's own public URL, and without that flag the subrequest hits
the origin and returns a 404 with Cloudflare error 1042.

---

## 3. Transfer runbook

### Scenario A — GitHub org changes, Cloudflare account stays

1. Transfer the repository. Update every local clone's remote (`git remote set-url origin …`).
2. **Check whether Actions are enabled; do not re-enable them unconditionally.** Follow § 0, Phase 1,
   step 2. If Actions are disabled at the destination, have an authorized administrator enable them.
   Set this repository's `PRODUCTION_DEPLOY_ENABLED` variable to `false` to keep its deploy gate closed;
   do not change a shared organization value unless an organization-wide stop is intended. Inspect the
   `production` environment scope as described in § 0, Phase 1, step 1.
3. **Verify the effective rules on `main`**, including organization rulesets, using § 0, Phase 1,
   step 4. Do not infer that `main` is unprotected from a 403 or 404 on the classic
   `branches/main/protection` endpoint. If required rules are missing after transfer, have an
   authorized administrator restore them before any production deploy.
4. Do the code change in §4 before the first deploy.
5. **Verify PR checks without shipping.** Inspect a recent run from a pull request targeting `main`
   for the reviewed head, or use a documentation-only PR targeting `main` and confirm
   `Repo hygiene & secret scan` and `ci-ok` pass while build, shadow and deploy are intentionally
   skipped. For a PR that selects build or shadow, inspect those
   selected checks too. Keep this repository's `PRODUCTION_DEPLOY_ENABLED` value `false` during this
   check; it overrides the organization-level value for this repository. Leave a shared organization
   variable unchanged unless an organization-wide stop is intended; see § 0, Phase 1, steps 1 and 3.
6. Only after production setup is explicitly approved, create the `production` environment and token,
   then set `PRODUCTION_DEPLOY_ENABLED` to `true` last as described in § 0, Phase 2. Push a reviewed
   commit to `main`; confirm the deploy runs and `GET /api/v1/health` responds.

### Scenario B — the Cloudflare account also changes

Everything in Scenario A, plus — in this order, because each step depends on the one before:

1. Create the resources in the new account and **copy the new ids into `wrangler.toml`**:
   ```bash
   npx wrangler d1 create routeware-customer-snapshot
   npx wrangler d1 create routeware-customer-snapshot-test
   npx wrangler r2 bucket create routeware-csv-snapshots
   npx wrangler r2 bucket create routeware-csv-snapshots-test
   ```
   Replace `account_id` and both `database_id` values. The bucket names are referenced by name, so
   they only need to match.
2. Set the four Worker secrets (`npx wrangler secret put <NAME>` for each). Use **this repo's**
   Wrangler via `npx`, not a global install — under WSL a global Windows Wrangler pulls
   `workerd-windows-64` and fails on Linux.
3. Apply the D1 schema: `npm run db:migrate:remote`.
4. Deploy, then verify `GET /api/v1/health`.
5. **Re-populate the snapshot.** D1 starts empty; run the customer sync first, then address, then
   container — `pickup_address_id` and `customer_id` are foreign keys and the order matters. See
   [`CUSTOMER_SNAPSHOT.md`](../CUSTOMER_SNAPSHOT.md).
6. Confirm the cron trigger is registered (`0 7 * * *` UTC) and set `SHADOW_API_PUBLIC_BASE` in
   `[vars]` to the new Worker URL — the daily chain calls itself by public URL and silently does
   nothing useful if that is empty.
7. **Durable Object state does not transfer.** `AuthSession` holds only cached upstream session
   cookies, so losing it is harmless: the next request performs a fresh login. Nothing to migrate.
8. Decommission the old account's Worker and cron **last**, and only after the new one has completed
   a successful scheduled run — otherwise both accounts poll the same Routeware tenant on the same
   schedule with the same credentials.

---

## 4. The one code change the transfer requires

The problem+json `type` URIs are **client-visible API contract**. They hardcode the old owner:

```
https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#<slug>
```

There are **28 occurrences across 11 files** (verified 2026-08-22):

```bash
grep -rn "rick7c2" --include=*.ts src/ test/
```

[`src/lib/problem.ts`](../src/lib/problem.ts) already exposes the right seam — `PROBLEM_TYPE_BASE`
and `problemType(slug)` — but 27 of the 28 sites bypass it with an inline string literal. **Route
them all through `problemType()` first, then change the constant once.** Doing it the other way means
28 edits every time the URL moves again.

> **Update (2026-09-28): done.** All call sites now use
> `problemType(slug, env)` / `foreignKeyProblem(err, env)` and the base
> resolves from the `PROBLEM_TYPE_BASE` wrangler var (default `""` = the
> committed `TogetherWeOwn/.../PROBLEMS.md#` URL). **Transfer step: set
> `PROBLEM_TYPE_BASE` to the new repo's docs URL** (trailing `#` included) —
> no code or test change needed; defaults keep every existing `type` value
> byte-identical. Open-task #1 below is struck.

Two things to know before you start:

- Tests pin these strings **verbatim**, deliberately (see [`TEST-INVARIANTS.md`](TEST-INVARIANTS.md)):
  `test/snapshotAuth.test.ts` asserts `UNAUTHORIZED_TYPE` exactly. Update tests with the source.
- The URLs are only dereferenceable if the repo is **public**. It is private today, so they resolve
  to a 404 for every client already. GitHub redirects a transferred path, but that redirect breaks
  the moment anyone creates a new repo at the old `rick7c2/routeware-shadow-api` path — at which
  point these URIs silently point at a stranger's repository. Fix them at transfer time.

Old clone URLs also appear in prose in `README.md` and
[`SECURITY-REMEDIATION.md`](SECURITY-REMEDIATION.md); those are documentation, not contract.

---

## 5. The security posture you are inheriting — read before transferring

[`SECURITY-REMEDIATION.md`](SECURITY-REMEDIATION.md) has the full runbook. The part that matters
**for the transfer specifically**:

Commit `4e219dd` — the repo's first commit, an ancestor of `main` — still contains, retrievable by
anyone with read access via `git show`:

- real Routeware `LOGIN_USERNAME`, `LOGIN_PASSWORD` and `CUSTOMER_SNAPSHOT_SYNC_SECRET`;
- ~609,000 rows of real customer / address / container PII in three `*.csv` exports.

**Remediated 2026-08-22 — and this repository is the clean one.** `git-filter-repo` cleared every
branch of the original repo, but GitHub's read-only `refs/pull/*` kept every blob and a force-push
cannot rewrite those. So the cleaned history was pushed into **this** repository
(`routeware-shadow-api-clean`), created fresh so it has no PR refs at all.

Verified here by `git clone --mirror` — the exact operation that still leaks on the original: no
`refs/pull/*`, **0** CSV blobs, **0** hits for any of the three secrets, and `git cat-file -t
4e219dd` reports the poisoned root commit does not exist. The working tree is byte-identical to the
original and all 82 commits are intact.

> ⚠️ **Outstanding, and owner-only: delete `Rick7C2/routeware-shadow-api`.** The original repo still
> discloses all three credentials and the ~609,000 PII rows through `refs/pull/1..7/head` to anyone
> who can read it. This repo replaces it. A full backup of the original — PR refs and all — is
> archived off-repo as `rsa-backup-2026-08-22.tar.gz`.

**Cost of this route, stated plainly:** the 9 pull requests of review narrative did not travel. Issue
and PR history lives with the repository it was created in.

On 2026-08-07 the outgoing maintainer decided **not to rotate** these credentials, as a decision
rather than a deferral. That decision was made under the single-collaborator conditions above. It is
worth re-taking under the new ones, by whoever owns the risk now.

**Sequencing:** the clean repo exists and is the one to transfer. Delete the original **before or
immediately after** the transfer — every day both exist is a day the old one is still readable.

---

## 6. State of the work at handover

- The handover was written against `main` at `5ec4516` on 2026-08-22, with no unpushed commits, stashes or local-only branches
  (not re-checked for this refresh; `main` has moved since). Note that SHAs differ from any
  pre-2026-08-22 reference: the history rewrite renumbered every commit.
- **Historical snapshot (2026-08-22):** Actions were disabled with no secrets or environments.
  Do not use this snapshot as current administrative state. The reconciled workflow separates
  credential-free build/hygiene from production opt-in; **§ 0 has the phased procedure.**
- **Suite (2026-08-22 snapshot):** 30 files, 549 tests, green. **Coverage (same snapshot):** 85.74%
  statements / 79.48% branches / 89.09% functions / 86.36% lines — historical, not current figures.
  **Current (2026-10-16):** 173 `*.test.ts` files at `efa883b` (187 at this
  head); coverage 97.85% statements / 93.93% branches /
  98.65% functions / 98.15% lines, as recorded in [`vitest.config.ts`](../vitest.config.ts)
  (not re-run for this refresh). See [`TEST-INVARIANTS.md`](TEST-INVARIANTS.md#the-coverage-ratchet)
  for the dated table and matching floors. **No test may reach the network.** (`npm test` runs in a
  few seconds; `npm run test:coverage` takes ~38s here — istanbul instrumentation adds roughly 65%,
  which is why `testTimeout` is 30s and not the 5s default.)
- These coverage floors were **re-baselined downward on 2026-08-22**, once, and the reason is
  recorded in [`TEST-INVARIANTS.md`](TEST-INVARIANTS.md) § "The coverage ratchet". Short version: one
  test was reaching the live Routeware host and counting unasserted lines as covered; when upstream
  changed, it hung and the suite stopped producing a coverage report at all. No source line lost a
  real test. **Treat this as a one-time correction — the ratchet only goes up from here.**
- As of 2026-08-22 (not re-checked for this refresh), stale remote branches, all carrying **rewritten**
  (clean) history and safe to delete once you are satisfied: `fix/ecc-audit-hardening`,
  `chore/drop-vendored-ecc-common`, and
  `claude/codebase-review-jbhgs9`. The old warning about the last one carrying PII blobs no longer
  applies to the branch itself — that content now survives only in `refs/pull/*` (§5).

### Open tasks, highest value first

1. ~~**§4 — de-hardcode the problem `type` URIs.** Required by the transfer.~~
   **Done (2026-09-28):** every `type` URI now resolves through
   [`problemType(slug, env)`](../src/lib/problem.ts) from the `PROBLEM_TYPE_BASE`
   wrangler var (`wrangler.toml` `[vars]`, default `""` = the committed
   `TogetherWeOwn/.../PROBLEMS.md#` URL, unchanged by default). **At transfer
   time, set `PROBLEM_TYPE_BASE` to the new owner's docs URL** (trailing `#`
   included, e.g. `https://github.com/<new-owner>/routeware-shadow-api/blob/main/docs/PROBLEMS.md#`)
   via `wrangler.toml` `[vars]`, `.dev.vars`, or `wrangler secret put` — no code
   change needed. Pinned by `test/problemTypeBase.test.ts` (override + fallback)
   and the verbatim-default tests (`test/problemAnchors.test.ts`,
   `test/problemsAnchorCoverage.test.ts`).
2. **§5 — delete the old repository** (`Rick7C2/routeware-shadow-api`), which is the last surface
   still exposing the credentials and the PII. Then re-take the rotation decision under the new
   access conditions.
3. ~~**Recover branch coverage above the ECC 80% standard.**~~ **Done (2026-09-27; ratcheted
   2026-10-16):** `test/d1TestMigrations.ts` applies the D1 migrations to the test
   `CUSTOMER_DB`, and `test/snapshotSyncE2E.test.ts` drives the login → download → parse → upsert path
   with assertions. Branch coverage is 93.93% against a floor of 93 (`vitest.config.ts:171-176`; the
   history is at `vitest.config.ts:119-169`). `docs/TEST-INVARIANTS.md` § "The coverage ratchet"
   records the 2026-10-16 measurement with the 2026-08-22 figures kept explicitly historical.
4. ~~**Close the `worker-configuration.d.ts` leak vector.**~~ **Done:** `wrangler types` bakes
   `wrangler.toml` `[vars]` values into that generated file as literal string types. A real value plus a
   regenerate committed it, which is how `4e219dd` happened in the old repository. The file is gitignored
   (`.gitignore:4`), is not tracked, and the hygiene job fails on any non-synthetic value of the four
   Worker-secret keys in it (`.github/workflows/ci.yml:209-226`). Never force-add it.
   `docs/SECURITY-REMEDIATION.md` Step 3 records it as closed.
5. ~~**Promote the CI gitleaks step to blocking** and drop `--no-git`.~~ **Done:** the step has no
   `continue-on-error` and runs without `--no-git` over the full history (`.github/workflows/ci.yml:262-270`).
   `docs/SECURITY-REMEDIATION.md` Step 3 records it as blocking. §5 (deleting the old repository) is
   still open.

---

## 7. Conventions worth keeping

- **A push to `main` deploys to production only when the job-level
  `vars.PRODUCTION_DEPLOY_ENABLED == 'true'` condition matches (case-insensitively).** There is no
  staging environment; set this repository's variable to `false` to stop its deploys, which overrides
  an organization-level value for this repository. Do not change a shared organization variable unless
  an organization-wide stop is intended. The `production` environment scopes secrets and protections,
  but its variables are unavailable to the job-level `if`; see § 0. Changing only capitalization does
  not stop deploys, and removing/disabling the gate does not roll back an already-deployed Worker.
- **Coverage is a ratchet.** Floors sit just under current numbers; raise them whenever a change
  moves the number up. That is the whole mechanism.
- **A route module must be an `OpenAPIHono`** built with `createRouteModule()`, never a plain `Hono`.
  Mounting a plain `Hono` still serves traffic while silently dropping every route from
  `/openapi.json`. `test/openapiContract.test.ts` enforces this and is verified to fail when a route
  is dropped.
- **No test may reach the network.** See `TEST-INVARIANTS.md`; this is what §6's coverage note is
  about.
- **Merging is squash only** ([`CONTRIBUTING.md`](../CONTRIBUTING.md), Conventional Commits section):
  each PR lands on `main` as one commit, and the squash commit takes the PR title.
- **[`CONVENTIONS.md`](CONVENTIONS.md) carries binding read-triggers**, not suggestions, and its
  security/session invariants bind regardless of which editor or assistant is in use. It replaced
  `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/`, which carried the same rules before 2026-08-23.
