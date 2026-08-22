# Handover — transferring this repo to a new organization

Written 2026-08-22, when the project left its original machine and GitHub account. Everything the
outgoing maintainer knew that was **not** already in the repository is written down here. If you are
picking this project up, read this file, then [`README.md`](../README.md) and
[`AGENTS.md`](../AGENTS.md).

Two facts govern every change in this codebase, and neither is obvious from the code:

1. **The upstream signals failure silently.** An expired admin session or a stale anti-forgery token
   comes back as an HTML page with **HTTP 200** — never a 401, never a 4xx. Code that trusts the
   status code is wrong here.
2. **The data in flight is customer PII.** Roughly 609,000 rows of customer, address and container
   records move through the snapshot path.

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
2. **Verify the Actions secret and environment survived.** Both exist today (verified 2026-08-22:
   repository secret `CLOUDFLARE_API_TOKEN`, environment `production`). In the new org confirm
   Settings → Environments → `production` exists and that `CLOUDFLARE_API_TOKEN` resolves for it;
   re-create either if absent. Secret **values** are never readable back, so if the token has to be
   re-created you need a fresh one from Cloudflare — see § 1 for the required scopes.
3. Confirm Actions is enabled for the new org and that `.github/workflows/ci.yml` is allowed to run.
4. **Add branch protection on `main`.** There is none today, and none is possible: the original
   account is on a plan where protection is unavailable for private repos (`gh api
   .../branches/main/protection` returns 403 *"Upgrade to GitHub Pro or make this repository public"*,
   verified 2026-08-22). Since **a merge to `main` deploys straight to production**, nothing currently
   gates a deploy but review discipline. An org plan makes protection available — use it.
5. Do the code change in §4 before the first deploy.
6. Verify: open a throwaway PR and confirm `build` and `hygiene` run; merge it and confirm `deploy`
   runs and the Worker responds on `GET /api/v1/health`.

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

Old clone URLs also appear in prose in `README.md`, `AGENTS.md` and
[`SECURITY-REMEDIATION.md`](SECURITY-REMEDIATION.md); those are documentation, not contract.

---

## 5. The security posture you are inheriting — read before transferring

[`SECURITY-REMEDIATION.md`](SECURITY-REMEDIATION.md) has the full runbook. The part that matters
**for the transfer specifically**:

Commit `4e219dd` — the repo's first commit, an ancestor of `main` — still contains, retrievable by
anyone with read access via `git show`:

- real Routeware `LOGIN_USERNAME`, `LOGIN_PASSWORD` and `CUSTOMER_SNAPSHOT_SYNC_SECRET`;
- ~609,000 rows of real customer / address / container PII in three `*.csv` exports.

Commit `405fad7` removed them from the working tree. **History was never rewritten**, so every blob
is still reachable from `main` and will travel with the repository.

`SECURITY-REMEDIATION.md` justifies leaving this open on the grounds that "the repo is private, has
0 forks, no open PRs, and one collaborator". **A transfer to an organization invalidates that
reasoning** — org members, and any org-wide access policy, inherit read access to the whole history.

On 2026-08-07 the outgoing maintainer decided **not to rotate** these credentials, as a decision
rather than a deferral. That decision was made under the single-collaborator conditions above. It is
worth re-taking under the new ones, by whoever owns the risk now.

**Sequencing matters:** purging history is easiest **before** the transfer, while one person owns
both the repo and every clone. Afterwards it needs a force-push in the new org, coordination with
everyone who has cloned, and a support request to garbage-collect unreachable objects — which stay
reachable by SHA until GitHub runs GC.

---

## 6. State of the work at handover

- `main` is at `d47f625` (PR #6 merged). No unpushed commits, no stashes, no local-only branches.
- **Suite:** 30 files, 549 tests, green. **Coverage:** 85.74% statements / 79.48% branches / 89.09%
  functions / 86.36% lines. (`npm test` runs in a few seconds; `npm run test:coverage` takes ~38s
  here — istanbul instrumentation adds roughly 65%, which is why `testTimeout` is 30s and not the
  5s default.)
- These coverage floors were **re-baselined downward on 2026-08-22**, once, and the reason is
  recorded in [`TEST-INVARIANTS.md`](TEST-INVARIANTS.md) § "The coverage ratchet". Short version: one
  test was reaching the live Routeware host and counting unasserted lines as covered; when upstream
  changed, it hung and the suite stopped producing a coverage report at all. No source line lost a
  real test. **Treat this as a one-time correction — the ratchet only goes up from here.**
- Stale remote branches, safe to delete once you are satisfied: `fix/ecc-audit-hardening` and
  `chore/drop-vendored-ecc-common` (both merged). Do **not** delete
  `claude/codebase-review-jbhgs9` casually — per `SECURITY-REMEDIATION.md` it carries the old PII
  blobs and must be removed *as part of* the history purge, not before it.

### Open tasks, highest value first

1. **§4 — de-hardcode the problem `type` URIs.** Required by the transfer.
2. **§5 — decide on rotation and the history purge**, under the new access conditions.
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

- **Merging to `main` deploys to production.** There is no staging environment.
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
- **`CLAUDE.md` carries binding read-triggers**, not suggestions. If you use a different assistant,
  `AGENTS.md` and `.cursor/rules/` cover the same ground; the invariants in
  `.cursor/rules/project-invariants.mdc` are binding regardless of editor.
