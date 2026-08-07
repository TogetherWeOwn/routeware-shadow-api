# CLAUDE.md

Project context lives in two files that are already maintained — read them, don't duplicate them here.

- **[AGENTS.md](AGENTS.md)** — repo layout, every npm script, secrets handling, OpenAPI endpoints.
- **[.cursor/rules/project-invariants.mdc](.cursor/rules/project-invariants.mdc)** — security and session invariants (auth on `/api/v1/*`, cookie containment in the `AuthSession` DO, PII in report exports). These are binding regardless of which editor is in use. The sibling rules cover Workers (`cloudflare-worker.mdc`), tests (`testing-vitest.mdc`), OpenAPI (`openapi-contracts.mdc`), and the discovery tool (`tools-discovery.mdc`).

## ECC rules are binding here

This repo follows **ECC (Everything Claude Code)** conventions. The rulesets below are checked into the repo and apply to every change — read them before writing code, not after:

- **[.claude/rules/ecc/common/](.claude/rules/ecc/common/)** — the language-agnostic standard:
  - [`coding-style.md`](.claude/rules/ecc/common/coding-style.md) — immutability, KISS/DRY/YAGNI, files <800 lines, functions <50 lines, nesting ≤4, no magic numbers, explicit error handling.
  - [`testing.md`](.claude/rules/ecc/common/testing.md) — **80% coverage target**, TDD (RED → GREEN → REFACTOR), AAA structure, behavior-describing test names.
  - [`security.md`](.claude/rules/ecc/common/security.md) — no hardcoded secrets, validate all input, no sensitive data in errors.
  - [`code-review.md`](.claude/rules/ecc/common/code-review.md) — review after every change; CRITICAL blocks merge, HIGH warns.
  - [`agents.md`](.claude/rules/ecc/common/agents.md) — delegate to `code-reviewer` / `security-reviewer` / `typescript-reviewer` / `tdd-guide`; run independent reviews in parallel; **if you delegate, you own collecting the results** — never end a turn with work still in flight.
  - [`development-workflow.md`](.claude/rules/ecc/common/development-workflow.md) — research & reuse → plan → TDD → review → commit.
  - Also: [`git-workflow.md`](.claude/rules/ecc/common/git-workflow.md) (conventional commits), [`patterns.md`](.claude/rules/ecc/common/patterns.md), [`performance.md`](.claude/rules/ecc/common/performance.md), [`hooks.md`](.claude/rules/ecc/common/hooks.md).
- **[.claude/rules/ecc/typescript/](.claude/rules/ecc/typescript/)** — TypeScript specifics: explicit types on exported APIs, `unknown` (never `any`) for untrusted input, Zod at boundaries, immutable updates. Language-specific rules win where they conflict with `common/`.

Only `common/` and `typescript/` are tracked. The rest of `.claude/` is a vendored ECC install (agents, skills, commands, scripts) that is **gitignored on purpose** — it duplicates the user-level `ecc@ecc` plugin and must not enter this repo's history. `.gitignore` and a CI hygiene check both enforce this.

## Verification loop

`npm run typecheck` → `npm test`. Use `npm run test:coverage` before pushing — CI runs it, and `vitest.config.ts` pins coverage thresholds just under current levels so coverage **cannot regress**.

Those thresholds are a ratchet, not the goal. Measured coverage is ~79.4% statements and ~89.6% functions — **functions are past the ECC 80% standard**; statements, lines (~79.6%) and branches (~68.3%) are not. **Raise the thresholds whenever a change moves the number up** — that is the whole mechanism. The biggest untested modules, highest-risk first: `lib/snapshot/streamSync.ts` (57.3%), `r2SnapshotArchive.ts` (62.3%), and the three near-identical `routes/*Snapshot.ts` modules (~26–30% statements, 6–18% branches — now the largest single block of missing branch coverage).

Read per-file numbers from `coverage/coverage-summary.json`, not the istanbul terminal table: the table drops files once they reach 100% and truncates long names.

`dataEntityHandlers.ts` is now at 93.4% statements / 100% functions: `test/dataEntityHandlers.test.ts` covers the GET/ETag paths and `test/dataEntityPostHandlers.test.ts` covers the three POST write paths — including the branch where the upstream save succeeds but the D1 sync throws, which must keep the 200 and fall back to `invalidateDataEntity` so stale PII is not served from cache.

`addressContainerSaveForm.ts` is at 100% statements/branches/functions via `test/addressContainerSaveForm.test.ts`, which mocks only `upstreamForward` and lets the real `customerSaveAutoToken` helpers run (that also lifted `customerSaveAutoToken.ts` to 84.5%). Everything it pins fails silently in production: Routeware answers a POST carrying a wrong or stale `__RequestVerificationToken` with an HTML error page, not an error status, so the save quietly does nothing. The two invariants worth knowing before touching that file are (a) `CUSTOMER_SAVE_AUTO_TOKEN` is **opt-out** — only the literals `"false"` and `"0"` disable injection, so an unset binding must still inject; and (b) the modal query parameter names are **not** consistent and must not be "tidied": the address create path uses lowercase `customerID` and the container create path lowercase `pickupAddressID`, while both edit paths use the PascalCase `PickupAddressID` / `ContainerID`. Mutation-verified six ways, including both casing swaps.

`detailFullSync.ts` is covered by two files, split by what they need: `test/detailFullSyncMapping.test.ts` (pure, no mocks) pins the field mapping — the Routeware→snapshot renames (`NameFirst`→`firstName` and friends) and the absent-key defaults, where `extrasAllowed`/`enabled`/`gpsLocked` use an explicit `!== undefined` guard because coercing `undefined` yields `false` and would silently disable every address. `test/detailFullSyncFetch.test.ts` pins the re-auth retry, including that the session is **re-read** after `establishSession` rather than the stale one reused. Both were mutation-verified.

`snapshot/reportFetch.ts` is at 100% on all four metrics via `test/snapshotReportFetch.test.ts` (19 tests, mutation-verified six ways). It is the single door every scheduled snapshot pulls its CSV through, and its guards are asymmetric on purpose: the **retry** trigger is `resp.status !== 200`, while the **throw** guard is `!resp.ok`, so a 204 retries once and is then accepted. The retry re-reads the session after `establishSession` rather than reusing the stale one — reusing it would make the retry fail identically to the first attempt, since Routeware signals an expired admin session with a login redirect or an HTML error page, never a 401. The `accept: text/csv` header is load-bearing: without it Routeware content-negotiates to the HTML report viewer, which parses to zero rows. Note a pre-existing dead clause, **not** a bug: line 26's `|| isLoginRedirect(resp)` can never contribute, because `isLoginRedirect` requires status 302 and the `status !== 200` clause has already short-circuited. `fetchGetCustomerDetailFull` has the same shape. Removing either is behavior-neutral but is not a test-only change.

The `entityDataCache` error asymmetry is deliberate and pinned by `test/entityDataCache.test.ts`: `putCachedDataEntity` swallows and logs its failures (the response is already valid — a failed cache write must not turn a 200 into a 500), while `invalidateDataEntity` lets them propagate (a silently failed invalidation serves superseded PII). Do not "harmonise" the two. `test/scheduled.test.ts` pins the matching property one level up — the cron handler must never reject, since it runs inside `ctx.waitUntil` where an escaping error becomes an unattributed platform failure instead of a log line.

`getDataSnapshotPlan` is the referential-integrity guard and `test/snapshotOrchestration.test.ts` pins it: D1 does not enforce `address.customer_id` or `container.pickup_address_id`, and a streamed sync spans many `db.batch` calls rather than one transaction, so import order (customer → address → container) is the only thing preventing orphan rows. Address only runs if customer is configured; container only if both are. That file also pins the `[step]` error tagging, which is what tells you which table a scheduled-run failure came from.

Two snapshot invariants are now pinned by tests and must not be weakened. `test/snapshotUpsert.test.ts` asserts that each table's column list, placeholder count and binding count agree, and that rows-per-statement × bindings-per-row stays within D1's 100 bound-parameter ceiling — adding a column without updating the matching `*Bindings` and `*_NCOLS` otherwise fails only at runtime, mid-cron. `test/snapshotStreamSync.test.ts` pins the reconcile guard (`options.reconcile && cols && dataRows > 0`): an export that yields zero parseable rows must **not** delete anything, or a bad upstream export wipes the table. Both were mutation-verified. The shared recording `D1Database` double lives in `test/snapshotDbFake.ts`.

**No hand-written source file now exceeds the 800-line ceiling.** (`worker-configuration.d.ts` is generated by `wrangler types` and is exempt.) `src/lib/d1SnapshotSync.ts` was the last breach at 817 lines; its implementation now lives in `src/lib/snapshot/` — `tableSql` (SQL + row bindings), `upsert` (batched upserts + stale-row reconcile), `reportFetch`, `streamSync`, `orchestration` — and `d1SnapshotSync.ts` is a re-export facade so importers keep one stable entry point.

Still open, smaller: several handlers in `dataEntityHandlers.ts` exceed the 50-line guideline.

The snapshot 401/503 auth-check duplication is fixed: `requireSnapshotAuth()` / `requireSnapshotSecret()` in `src/routes/shared.ts` now guard all 13 routes, and `test/snapshotAuth.test.ts` pins each route's exact problem+json body. The `detail` wording is deliberately a per-call-site argument rather than fixed in the helper — it is inconsistent between routes today, and unifying it would change what clients see, so that belongs in its own change.

`src/app.ts` was the other breach and is now **163 lines**: the routes live in `src/routes/*.ts`, one module per domain, each an `OpenAPIHono` mounted at `"/"` so its `createRoute` paths stay absolute. Two rules govern that directory:

- A route module **must** be an `OpenAPIHono` (build it with `createRouteModule()`), never a plain `Hono`. `OpenAPIHono.route()` merges a sub-app's `openAPIRegistry` into the parent only for `OpenAPIHono` instances; mounting a plain `Hono` still serves traffic while silently dropping every route from `/openapi.json`.
- The two `app.use("/api/v1/*", …)` middlewares must stay registered **before** every `app.route(…)` mount, or a route becomes reachable without the client auth gate.

`test/openapiContract.test.ts` enforces both, plus the full generated document, and is verified to fail when a route is dropped.

CI (`.github/workflows/ci.yml`) additionally runs `npx wrangler deploy --dry-run` and hygiene checks for committed `*.csv` exports, `.dev.vars`, and bulk `.claude/` content. There is no lint or format step — none is configured.

## Known security debt — do not let this drop

Commit `4e219dd` (the first commit, an ancestor of `main`) still contains, retrievable via `git show`:

- real Routeware `LOGIN_USERNAME` / `LOGIN_PASSWORD` and a real `CUSTOMER_SNAPSHOT_SYNC_SECRET` in `wrangler.toml`;
- ~609,000 rows of customer/address/container PII in three `*.csv` exports.

Commit `405fad7` removed them from the working tree but **did not rewrite history**. Rotating those credentials and purging the blobs is still outstanding — see **[docs/SECURITY-REMEDIATION.md](docs/SECURITY-REMEDIATION.md)** for the ordered runbook (rotate first, then purge with `git-filter-repo --replace-text`; a `sed`-based filter was tested and silently fails on the password). Treat any repo-visibility change as blocked on it.

## Deploys are not yours to run

Merging to `main` auto-deploys via CI. Never run `npm run deploy`, `wrangler deploy`, `wrangler secret put`, or `npm run db:migrate:remote` — these hit production Cloudflare resources and are denied in `.claude/settings.json`.
