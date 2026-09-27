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

## 0. Do this first — enable PR CI before enabling production deploys

**Verification and production authorization are separate.** CI uses self-hosted runners labeled
`two-selfhosted`. The credential-free `build` and `hygiene` jobs run on PRs; `shadow-api-v1`
evaluates an optional `CF_TOKEN` gate and skips its contract step without that token. The `deploy`
job fails closed unless the repository variable `PRODUCTION_DEPLOY_ENABLED` is exactly `true`.

The clean replacement repository initially had Actions disabled on 2026-08-22 (see § 5). Actions
runs have since executed, including main run [36231264777](https://github.com/TogetherWeOwn/routeware-shadow-api/actions/runs/36231264777)
on 2026-09-26. Do not infer current settings, secrets, or environments from the historical snapshot;
verify them with authorized access. Keep production deploys disabled until setup is explicitly approved.

### Observed runner/gate behavior (verified 2026-09-27, read-only — no settings changed)

- **Actions execute** (administratively enabled in practice). The permissions API returned 403 for the
  verification token, so the enabled flag was not read directly; runs executing is the evidence.
  - Main push run [36231264777](https://github.com/TogetherWeOwn/routeware-shadow-api/actions/runs/36231264777)
    (2026-09-26, head `8f9eaed`, pre-fail-closed-gate): **completed / failure** —
    `Typecheck, test, build` success, `Repo hygiene & secret scan` success, `shadow-api-v1`
    success, `Deploy to Cloudflare Workers` **failure** at step `Apply D1 migrations (remote)`
    with `Deploy Worker` skipped.
  - Main push run [36285555015](https://github.com/TogetherWeOwn/routeware-shadow-api/actions/runs/36285555015)
    (2026-09-27, head `db89be6`): **completed / success** — build, hygiene and `shadow-api-v1`
    success, deploy **skipped**. The fail-closed gate works: a push to `main` no longer attempts a
    deploy while `PRODUCTION_DEPLOY_ENABLED` is not exactly `true`. The variables API returned 403
    for the verification token, so variable presence was not read directly; the skipped conclusion
    is the observable evidence.
- **Runners:** every CI job carries labels `[self-hosted, two-selfhosted]` (verified in
  `.github/workflows/ci.yml` and on both runs above). Runner host names rotate
  (`coolify-vps-1/2` on the 2026-09-26 run, `ci-rbx1-*/ci-w2494-*` on 2026-09-27 runs) — the labels
  are the stable contract, not the host names.
- **`shadow-api-v1` gate (no `CF_TOKEN`):** step `Evaluate operator credential gate` succeeds and
  step `Execute versioned API contract tests` concludes **skipped**; the job stays green. That is the
  expected PR behavior without operator credentials.
- **PR behavior:** success ex
  [36283643912](https://github.com/TogetherWeOwn/routeware-shadow-api/actions/runs/36283643912)
  (build/hygiene/shadow success, deploy skipped — deploy never runs on PRs); failure ex
  [36289128920](https://github.com/TogetherWeOwn/routeware-shadow-api/actions/runs/36289128920)
  (build **failure** at `Test (with coverage ratchet)`, downstream validate steps skipped, deploy
  skipped). Red build is the blocking signal — do not open a review card for a red-CI PR.
- **Branch protection (read-only):** `GET branches/main` returns `protected: false` (verified
  2026-09-27). `GET branches/main/protection` returned 403 for the verification token, so detailed
  rules could not be read — treat `main` as **unprotected** and complete Phase 1 step 4 before any
  production deploy.
- **Environment:** the `production` environment exists (created 2026-09-21) with `protection_rules:
  []` — no required reviewers. Secret/variable values returned 403 for the verification token and
  were not inferred.

### Phase 1 — turn on credential-free PR verification

1. **Leave `PRODUCTION_DEPLOY_ENABLED` unset.** Its absence is the production safety gate.
2. **Re-enable Actions:**
   ```bash
   gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=true
   ```
   or Settings → Actions → General → *Allow all actions and reusable workflows*. Confirm with:
   ```bash
   gh api repos/<owner>/<repo>/actions/permissions --jq .enabled     # expect: true
   ```
   If the new owner is an organization, an **org-level** policy can still block Actions even when the
   repo says enabled — check Organization Settings → Actions → General as well.

   **Re-enabling does not retroactively build anything.** Verified 2026-08-22 by toggling it on this
   repo: no runs were created for the pushes made while it was off. Nothing will run until the next
   push or PR.
3. **Verify without shipping anything.** Open a throwaway PR touching only a comment. Confirm
   `Typecheck, test, build` and `Repo hygiene & secret scan` both run and pass on the self-hosted
   runners. Without `CF_TOKEN`, `shadow-api-v1` must report its gate reason and skip contract execution.
   The production deploy job must be skipped on the PR and remains skipped on pushes to `main` while
   the enable variable is absent.
4. **Add branch protection on `main`** and require both PR jobs before merging real changes.

### Phase 2 — intentionally enable production deploys

Only after the production Cloudflare account, resources and Worker secrets are ready:

1. **Create the Cloudflare API token** (skip if you are keeping the existing one — but note its value
   cannot be read back out of the old repo, so if you do not have it saved, you need a new one).
   Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template. **Confirm
   `D1 : Edit` is included** — the deploy job applies D1 migrations and fails without it. Do **not**
   use the Global API Key.
2. **Create the `production` environment.** Repo → Settings → Environments → New environment →
   name it exactly `production`. Add required reviewers here if the plan supports them.
3. **Add the environment secret** named exactly `CLOUDFLARE_API_TOKEN`:
   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --env production --repo <owner>/<repo>
   ```
4. **Set the repository variable last**, after production setup is complete:
   ```bash
   gh variable set PRODUCTION_DEPLOY_ENABLED --body true --repo <owner>/<repo>
   ```
5. Push a reviewed commit to `main`; confirm both blocking jobs pass, the deploy job runs, and
   `GET /api/v1/health` responds afterwards. Then run the post-deploy probe
   (`scripts/post-deploy-probe.mjs`, `npm run probe:post-deploy`), which hits
   `GET /api/v1/health` (public) and `GET /api/v1/shadow/health` (authed) and exits 0
   only when both pass:
   ```bash
   npm run probe:post-deploy -- https://<worker-url>
   # local dev: npm run dev in one shell, then
   npm run probe:post-deploy -- http://localhost:8787
   ```
   The bearer is read from `SHADOW_API_TOKEN` (else `CUSTOMER_SNAPSHOT_SYNC_SECRET`),
   `--token-env=NAME`, or local `.dev.vars` — it is never logged and never committed.

**Emergency stop / rollback:** delete `PRODUCTION_DEPLOY_ENABLED` or set it to anything other than
`true`; the next workflow run skips deploy without disabling PR checks. Keep the code-level variable
gate in place. If production setup is later abandoned entirely, remove the deploy job rather than
removing its fail-closed condition.

**The four Worker secrets are a separate matter** and are not set through GitHub. They live in
Cloudflare via `npx wrangler secret put …`, are untouched by deploys, and are listed by name in § 1.
`CLOUDFLARE_API_TOKEN` is the only secret GitHub Actions needs.

---

## 1. What lives outside this repository

The code is complete and self-contained. These are not, and none of them travel with a `git push`.

| System | What it is | Consequence if not carried over |
|---|---|---|
| Cloudflare account `209cf7dd678adfb683947dd7874d05af` | Owns the Worker, D1, R2, the Durable Object namespace and the cron trigger | Nothing deploys; §3 Scenario B applies |
| Cloudflare API token | GitHub Actions secret `CLOUDFLARE_API_TOKEN`, scoped *Edit Cloudflare Workers* **plus D1 : Edit** | The `deploy` job fails; merges to `main` stop shipping |
| GitHub environment `production` | Scopes that secret; the place to add required reviewers | Deploy job cannot resolve the secret |
| Routeware tenant `killeen.routeware.com` | The upstream this Worker fronts | The Worker has nothing to talk to |
| Routeware admin login | `LOGIN_USERNAME` / `LOGIN_PASSWORD`, a real tenant account | Every authenticated route fails (silently — see fact 1) |
| Routeware custom reports **23 / 24 / 25** | Customer, Address and Container exports, built by hand in the Routeware UI | Snapshot sync has no source; these are tenant-specific and must be rebuilt or re-pointed |
| `.dev.vars` (local, gitignored) | The real values of the four secrets for local dev | Local dev cannot log in; recreate from `.dev.vars.example` |

**The four Worker secrets**, by name only — they are deliberately absent from `wrangler.toml` so an
unconfigured deploy fails closed with a 401 rather than trusting a placeholder:
`SHADOW_API_TOKEN`, `CUSTOMER_SNAPSHOT_SYNC_SECRET`, `LOGIN_USERNAME`, `LOGIN_PASSWORD`.

> The real values must move to the new owner **out of band** — not through this repository, an issue,
> or a PR. Note §5: three of the four are also recoverable from this repo's own git history, which is
> a problem to close, not a transfer mechanism to use.

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
2. **Re-enable Actions for PR verification while leaving `PRODUCTION_DEPLOY_ENABLED` unset.** See
   **§ 0** for the exact commands. The build and hygiene jobs need no credentials; the production
   deploy remains skipped.
3. **Add branch protection on `main`.** There is none today, and none is possible: the original
   account is on a plan where protection is unavailable for private repos (`gh api
   .../branches/main/protection` returns 403 *"Upgrade to GitHub Pro or make this repository public"*,
   verified 2026-08-22). An org plan makes protection available — use it before production deploys
   are enabled.
4. Do the code change in §4 before the first deploy.
5. Create the `production` environment and token, then set `PRODUCTION_DEPLOY_ENABLED=true` last as
   described in § 0.
6. Verify: open a throwaway PR and confirm `build` and `hygiene` run while deploy is skipped; after
   production is intentionally enabled, merge a reviewed change and confirm `deploy` runs and the
   Worker responds on `GET /api/v1/health`.

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

- `main` is at `5ec4516`. No unpushed commits, no stashes, no local-only branches. Note that SHAs
  differ from any pre-2026-08-22 reference: the history rewrite renumbered every commit.
- **Historical snapshot (2026-08-22):** Actions were disabled with no secrets or environments.
  Do not use this snapshot as current administrative state. The reconciled workflow separates
  credential-free build/hygiene from production opt-in; **§ 0 has the phased procedure.**
- **Suite:** 30 files, 549 tests, green. **Coverage:** 85.74% statements / 79.48% branches / 89.09%
  functions / 86.36% lines. (`npm test` runs in a few seconds; `npm run test:coverage` takes ~38s
  here — istanbul instrumentation adds roughly 65%, which is why `testTimeout` is 30s and not the
  5s default.)
- These coverage floors were **re-baselined downward on 2026-08-22**, once, and the reason is
  recorded in [`TEST-INVARIANTS.md`](TEST-INVARIANTS.md) § "The coverage ratchet". Short version: one
  test was reaching the live Routeware host and counting unasserted lines as covered; when upstream
  changed, it hung and the suite stopped producing a coverage report at all. No source line lost a
  real test. **Treat this as a one-time correction — the ratchet only goes up from here.**
- Stale remote branches, all now carrying **rewritten** (clean) history and safe to delete once you
  are satisfied: `fix/ecc-audit-hardening`, `chore/drop-vendored-ecc-common`, and
  `claude/codebase-review-jbhgs9`. The old warning about the last one carrying PII blobs no longer
  applies to the branch itself — that content now survives only in `refs/pull/*` (§5).

### Open tasks, highest value first

1. **§4 — de-hardcode the problem `type` URIs.** Required by the transfer.
2. **§5 — delete the old repository** (`Rick7C2/routeware-shadow-api`), which is the last surface
   still exposing the credentials and the PII. Then re-take the rotation decision under the new
   access conditions.
3. **Recover branch coverage above the ECC 80% standard** (79.48% today). The blocking gap is that
   `vitest.config.ts` never applies the D1 migrations, so `CUSTOMER_DB` has no tables in tests and no
   route test can drive a snapshot sync to a 200. Fix that first; the end-to-end sync test then
   becomes straightforward. Details in `TEST-INVARIANTS.md`. **Until it is done, CI goes green on a
   branch-coverage number that violates the project's own stated 80% standard, and no other gate
   catches that** — the floor is the only check, and the floor was moved to match reality.
4. **Close the `worker-configuration.d.ts` leak vector.** `wrangler types` bakes `wrangler.toml`
   `[vars]` values into that tracked file as literal string types. Values are synthetic today, so
   nothing is exposed — but a real value plus a regenerate commits it, which is exactly how `4e219dd`
   happened. Neither `.gitignore` nor the CI hygiene check looks at `.d.ts`.
5. **Promote the CI gitleaks step to blocking** and drop `--no-git`. It is `continue-on-error: true`
   today *because* history is dirty; flipping it is the signal that §5 is finally complete.

---

## 7. Conventions worth keeping

- **A push to `main` deploys to production only when `PRODUCTION_DEPLOY_ENABLED` is exactly `true`.**
  There is no staging environment; leave or restore the variable as unset to stop deploys without
  disabling PR checks.
- **Coverage is a ratchet.** Floors sit just under current numbers; raise them whenever a change
  moves the number up. That is the whole mechanism.
- **A route module must be an `OpenAPIHono`** built with `createRouteModule()`, never a plain `Hono`.
  Mounting a plain `Hono` still serves traffic while silently dropping every route from
  `/openapi.json`. `test/openapiContract.test.ts` enforces this and is verified to fail when a route
  is dropped.
- **No test may reach the network.** See `TEST-INVARIANTS.md`; this is what §6's coverage note is
  about.
- **PRs were merged with merge commits, not squashed**, to preserve the per-commit record of what
  each test pins and how it was mutation-verified.
- **[`CONVENTIONS.md`](CONVENTIONS.md) carries binding read-triggers**, not suggestions, and its
  security/session invariants bind regardless of which editor or assistant is in use. It replaced
  `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/`, which carried the same rules before 2026-08-23.
