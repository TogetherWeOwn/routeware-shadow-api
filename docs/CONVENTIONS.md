# Project conventions — read before any change

The rules that govern work in this repo: what the project is, what must stay true, what to read
before touching what, and how a change is verified.

Extracted from `CLAUDE.md`, `AGENTS.md` and `.cursor/rules/` on 2026-08-23 so those assistant-harness
files can be deleted without losing the project rules they carried. Same move, same reason, as
[`TEST-INVARIANTS.md`](TEST-INVARIANTS.md), which came out of `CLAUDE.md` on 2026-08-10. **Nothing
here is specific to an assistant or an editor** — it is binding on whoever or whatever is making the
change.

---

## 1. What this is, and the two facts that shape every change

A Cloudflare Worker fronting the Routeware admin site. It serves an OpenAPI-described `/api/v1/*`
surface behind a client auth gate, forwards authenticated traffic upstream, contains the upstream
session cookies in an `AuthSession` Durable Object, and mirrors customer/address/container exports
into D1 snapshots on a cron (archived to R2).

Two facts govern every change here, and neither is obvious from the code:

1. **The upstream signals failure silently.** An expired admin session or a stale anti-forgery token
   comes back as an **HTML page with HTTP 200** — never a 401, never a 4xx. **Code that trusts the
   status code is wrong in this codebase.** Every upstream call must decide success on *content and
   redirect shape*, not on `resp.ok`. The existing guards are the pattern to copy:
   - `isLoginRedirect()` (`src/lib/loginRedirect.ts`) — requires status 302 *and* a `location`
     naming `/Account/Login` or `Login.aspx`.
   - `forwardWithSessionRetry()` (`src/lib/forwardWithSessionRetry.ts`) — re-establishes the session
     and retries once only for a login redirect or an HTTP-200 login form. Other responses do not
     trigger a retry. Client-facing retry passthrough routes use `forwardPassthrough()`
     (`src/lib/forwardPassthrough.ts`): upstream HTTP 400–599 keeps its status but receives a fixed
     local `upstream-error` problem body, never upstream body bytes, headers or status text. This
     applies on both attempts regardless of content type. Successful HTML/JSON and redirects are
     unchanged. Internal save consumers retain the raw helper for their own sanitized envelopes.
   - `src/lib/routewareQueryReportCsv.ts` — throws when a report response body starts `<!DOCTYPE` or
     contains `<html`, because that *is* the failure signal: `"QueryRequestIsComplete returned HTML
     (session lost or error page)"`.

   The interaction between those two is subtle and is pinned by tests; see
   [`TEST-INVARIANTS.md`](TEST-INVARIANTS.md) (the `status !== 200` clause runs before
   `isLoginRedirect`, which requires a 302).

2. **The data in flight is customer PII** — roughly 609,000 customer, address and container rows move
   through the snapshot path. That constrains logging, caching, error bodies, test fixtures and what
   may ever be committed. See § 5.

---

## 2. Read before touching

Binding, not "see also".

| Read | When |
|---|---|
| [`TEST-INVARIANTS.md`](TEST-INVARIANTS.md) | **(a)** Before editing anything under `src/lib/snapshot/` or `src/routes/`, or any of `src/lib/csv*Snapshot.ts` / `detailFullSync.ts` / `entityDataCache.ts` / `addressContainerSaveForm.ts` / `dataEntityHandlers.ts` / `dataEntitySave.ts` / `d1SnapshotSync.ts` / `customerSaveAutoToken.ts` / `r2SnapshotArchive.ts` / `routewareQueryReportCsv.ts` — **and before deleting any test that looks redundant.** `dataEntitySave.ts` is the one that bites: it holds the branch where the upstream save succeeds but the D1 sync throws, which must keep the 200 and fall back to `invalidateDataEntity` **so stale PII is not served from cache**. **(b)** After running `npm run test:coverage`, before reading the numbers — read per-file numbers from `coverage/coverage-summary.json`, **not** the istanbul terminal table, which drops files once they reach 100% and truncates long names. |
| [`HANDOVER.md`](HANDOVER.md) | Before anything touching deploys, Cloudflare resources, the Routeware tenant, or the repo's location/ownership. The inventory of what lives **outside** this repo (accounts, ids, secrets by name, the report query ids) and the transfer runbook. |
| [`SECURITY-REMEDIATION.md`](SECURITY-REMEDIATION.md) | Before any repo-visibility change (blocked on it), and before rotating credentials. |
| [`PROBLEMS.md`](PROBLEMS.md) | When adding or changing an error response — every problem+json `type` is a URL anchoring into it. |
| [`../CUSTOMER_SNAPSHOT.md`](../CUSTOMER_SNAPSHOT.md) | Before changing the snapshot/cron/D1/R2 path. |

---

## 3. Locked invariants — code structure

- **A route module must be an `OpenAPIHono`**, built with `createRouteModule()` (`src/routes/shared.ts`),
  never a plain `Hono`. `OpenAPIHono.route()` merges a sub-app's `openAPIRegistry` into the parent
  **only** for `OpenAPIHono` instances; mounting a plain `Hono` still serves traffic while silently
  dropping every route from `/openapi.json`.
- **The two `app.use("/api/v1/*", …)` middlewares must stay registered before every `app.route(…)`
  mount**, or a route becomes reachable without the client auth gate.

  `test/openapiContract.test.ts` enforces both of the above and is verified to fail when a route is
  dropped.
- **Coverage is a ratchet.** `vitest.config.ts` pins thresholds just under current levels so coverage
  cannot regress — **raise them whenever a change moves the number up.** That is the whole mechanism.
- **No hand-written source file exceeds 800 lines.** (`worker-configuration.d.ts` is generated by
  `wrangler types` and is exempt.) Enforced in CI hygiene by `npm run check:source-file-size`
  (`scripts/check-source-file-size.mjs`, pure logic in `scripts/lib/sourceFileSize.mjs`,
  unit-tested in `test/sourceFileSize.test.ts`) — split the module instead of growing it.
- **No test may reach the network.** See § 8.

---

## 4. Locked invariants — security and sessions

These were `alwaysApply: true` project rules and remain unconditional.

- **Never commit secrets.** Use `wrangler secret put` (deployed) or `.dev.vars` (gitignored, local)
  for `LOGIN_USERNAME`, `LOGIN_PASSWORD`, `SHADOW_API_TOKEN` and `CUSTOMER_SNAPSHOT_SYNC_SECRET`.
  Any value in `wrangler.toml` is a local-dev placeholder only.
- **Never commit Routeware report exports (`*.csv`)** — they contain real customer/address/container
  PII. They are gitignored, and CI has a hygiene check for them.
- **Do not log cookie headers, passwords, or full upstream request/response bodies** in production
  code paths.
- **Upstream Routeware session cookies live only in the `AuthSession` Durable Object** and are never
  relayed to clients — upstream `Set-Cookie` is stripped in `src/lib/upstreamForward.ts`.
- **All `/api/v1/*` routes require `Authorization: Bearer <SHADOW_API_TOKEN>`**, except
  `GET /api/v1/health`. Privileged snapshot/data routes additionally require
  `CUSTOMER_SNAPSHOT_SYNC_SECRET`. **Compare secrets in constant time** (`src/lib/auth.ts`).
- **The `X-Routeware-Shadow-Internal` marker is set only by trusted server-side callers** via
  `forwardToUpstream`'s `internalMarker` option — never copied from client input.
- **Prefer explicit `/api/v1/...` routes with fixed upstream URL templates** over echoing arbitrary
  client path segments toward `/WebRW`.
- A deployed Worker with **no client token set fails closed** (401 on all `/api/v1/*` except health).
  Keep it that way.

---

## 5. Known security debt — do not let this drop

Commit `4e219dd` (the first commit, an ancestor of `main`) originally contained real Routeware
`LOGIN_USERNAME` / `LOGIN_PASSWORD` and a real `CUSTOMER_SNAPSHOT_SYNC_SECRET` in `wrangler.toml`,
plus ~609,000 rows of customer/address/container PII in three `*.csv` exports.

**Purged from all branches on 2026-08-22** with `git-filter-repo`, force-pushed and verified from a
fresh clone: branches are clean and the tree at `main` is byte-identical. **It is not fully closed** —
GitHub's read-only `refs/pull/1..7/head` still carry every CSV blob and all three secrets, and a
force-push cannot rewrite them. [`SECURITY-REMEDIATION.md`](SECURITY-REMEDIATION.md) §&nbsp;"What the
purge actually achieved" has the evidence and the two remaining options.

**Rotation was declined on 2026-08-07** — a decision, not a deferral. Do not re-raise it every
session, and do not treat a merge to `main` as blocked on it. State the residual exposure once when
it is directly relevant, then proceed. That decision rests on the repo being private with one
collaborator, which a transfer to an organization invalidates — see [`HANDOVER.md`](HANDOVER.md)
§&nbsp;5.

---

## 6. Layout

- `src/worker.ts` — Cloudflare Worker default export (`ExportedHandler<Env>`); re-exports
  `AuthSession` and the Hono `app`.
- `src/app.ts` — Hono application, OpenAPI registry, `/api/v1` mounts.
- `src/routes/` — one `OpenAPIHono` module per domain, each mounted at `"/"` so its `createRoute`
  paths stay absolute.
- `src/lib/` — pure helpers (upstream headers, login-redirect detection, problem+json, URL builders,
  session retry, browser auth) and `src/lib/snapshot/` for the D1/R2 snapshot path.
- `src/authSession.do.ts` — Durable Object holding upstream session cookies.
- `test/` — Vitest + `@cloudflare/vitest-pool-workers` (integration + unit).
- `tools/api-discovery/` — headed Playwright recorder for Routeware traffic (NDJSON + aggregation).
- `migrations/d1/` — D1 migrations.

---

## 7. Commands

| Command | What it does |
|---|---|
| `npm run first-run` | Fresh-clone path: `check:devvars`, `db:migrate:local`, `db:seed`, then `smoke:readiness` against a loopback `wrangler dev` that it starts and stops. Stops at the first failing step (`scripts/first-run.mjs`). |
| `npm run help` | Lists every package.json script grouped by namespace (`scripts/help.mjs`). |
| `npm run dev` | `wrangler dev` (local Miniflare; runs `check:devvars` first; no `--remote` needed since HTTP login skips Browser Rendering). |
| `npm run dev:remote` | `wrangler dev --remote` — exercises the Browser Rendering login fallback. |
| `npm run typecheck` | Generates Wrangler declarations, then runs `tsc --noEmit`. |
| `npm test` / `npm run test:watch` | Vitest. |
| `npm run test:coverage` | Vitest + coverage; the CI build job runs it when Actions is enabled. |
| `npm run check:ci-workflow` | Verifies credential-free build/hygiene, the optional staging credential boundary, and fail-closed production deploy gates. |
| `npm run types` | `wrangler types` → `worker-configuration.d.ts` (gitignored, TOG-8373). Run after changing bindings; `npm run typecheck` also runs it automatically. |
| `npm run db:migrate:local` | Apply `migrations/d1/*.sql` to the local D1. |
| `npm run discovery:record` | Playwright harvester (`tools/api-discovery`). |
| `npm run discovery:process` | Harvest → docs, gaps, curls, suggested stubs (artifacts always built; gate last — missing shadow routes fail, stale entries warn unless `--strict`). |
| `npm run discovery:verify` | `discovery:process` + `npm test` — the full loop after a new recording. |

### Deploys are not yours to run

`.github/workflows/ci.yml` can deploy to production on a push to `main`, but only when the
job-level `vars.PRODUCTION_DEPLOY_ENABLED == 'true'` condition matches (case-insensitively). The
`vars` context may include organization-, repository-, or environment-level configuration; do not
infer that the gate is off from a repository-only variable listing. See [`HANDOVER.md`](HANDOVER.md)
§&nbsp;0 for the scope checks. That job targets production only. Do not run `npm run deploy`, `wrangler deploy`, `wrangler secret …`, or
`npm run db:migrate:remote` as part of ordinary development work — they hit production Cloudflare
resources.

CI uses self-hosted runners labeled `two-selfhosted`. On pull requests targeting `main`, changed-area
detection selects the credential-free `build` and optional `shadow-api-v1` jobs when relevant paths
change; docs-only PRs targeting `main` skip both. The `hygiene` job always runs. Without `CF_TOKEN`,
the shadow gate skips contract execution. Deploy remains skipped unless the job-level `vars` value
matches `true`; an unset repository variable alone does not prove that no applicable organization
variable can enable it. Read [`HANDOVER.md`](HANDOVER.md) §&nbsp;0 for the phased scope verification,
enable and stop procedures. If Actions is disabled or runners are unavailable, local verification is not a substitute
for exact-head CI.

### Verification loop

`npm run check:ci-workflow` → `npm run typecheck` → `npm test`. Run `npm run test:coverage` before
pushing. `npm run typecheck` runs two configs: the base `tsconfig.json` and
`tsconfig.src.json` (`noUncheckedIndexedAccess: true` over `src/**/*.ts` plus
`worker-configuration.d.ts`; `test/` stays on the base config).

`npm ci` alone may install no devDependencies (npm's `omit=dev` is set in some environments, which
leaves `tsc` and `vitest` missing); use **`npm ci --include=dev`** if that happens.

When enabled, CI additionally runs `npx wrangler deploy --dry-run`, a hygiene job that fails on
committed `*.csv` / `*:Zone.Identifier` exports or `.dev.vars`, and a blocking full-history secret scan (gitleaks). **There is no lint or
format step — none is configured.**

---

## 8. Conventions by area

### Cloudflare Worker

- Entry is `src/worker.ts`; app wiring lives in `src/app.ts`; pure helpers under `src/lib/`.
- Bindings and `[vars]` are defined in `wrangler.toml`; run `npm run types` after changing bindings.
  **Secrets are never in `[vars]`.**
- Browser Rendering uses `@cloudflare/puppeteer` and the `BROWSER` binding; if local `wrangler dev`
  misbehaves, try `npm run dev:remote`.
- The Durable Object class `AuthSession` is in `src/authSession.do.ts`; **DO migrations stay
  append-only.**

### OpenAPI and the public HTTP surface

- Routes are versioned under `/api/v1`. Each route has a documented OpenAPI operation via
  `@hono/zod-openapi`.
- Machine-readable spec: `GET /openapi.json`. Interactive docs: `GET /docs`. Both
  are served only when `OPENAPI_DOCS_ENABLED` is `"true"`; deployed envs default it to
  `"false"` (fail-closed, 404), local dev enables it via `.dev.vars`, and the Vitest
  `test` env keeps it on for contract tests.
- Errors produced by this Worker use RFC 7807 `application/problem+json` (`src/lib/problem.ts`), and
  every `type` URL anchors into [`PROBLEMS.md`](PROBLEMS.md). Tests pin those strings verbatim.

### Testing

- Use `@cloudflare/vitest-pool-workers` with `cloudflareTest` in `vitest.config.ts` and
  `wrangler.toml` as `wrangler.configPath`.
- Drive integration tests via `exports.default.fetch()` from `cloudflare:workers`.
- Mock outbound Routeware by overriding `globalThis.fetch` in `beforeEach` (restored in `afterEach`).
  The mock matches known `WebRW` URLs and **throws on any unexpected upstream URL** so tests fail
  loudly instead of hitting the network. (`fetchMock` from `cloudflare:test` with
  `assertNoPendingInterceptors` is an acceptable alternative.)
- Send `Authorization: Bearer <SHADOW_API_TOKEN>` on every request except `GET /api/v1/health` — the
  `test` env value is `test-api-token`.
- Unit-test pure helpers in `src/lib/` (and `tools/api-discovery/lib/`) without network. Do not
  require real Browser Rendering in CI.

### API discovery tool

- Run from `tools/api-discovery/`; output is gitignored under `tools/api-discovery/out/`.
- From the repo root: `npm run discovery:record` → `npm run discovery:process` (or
  `npm run discovery:verify` to add `npm test`).
- The recorder writes rich NDJSON (method, `resourceType`, query, bodies, response headers/bodies,
  caps via `HARVEST_MAX_*`); see `tools/api-discovery/README.md`.
- Sensitive headers are omitted by default. Setting `HARVEST_FULL_HEADERS=1` (or
  `HARVEST_REDACT_HEADERS=0`) makes the NDJSON **highly sensitive — never commit it.**
- `POST /api/v1/routeware/customer/save-long-form` can inject `__RequestVerificationToken`
  server-side (`CUSTOMER_SAVE_AUTO_TOKEN` in `wrangler.toml`); see `src/lib/customerSaveAutoToken.ts`.

---

## 9. Not carried over

For the record, so nobody goes looking: the assistant-harness material in the deleted files was
**not** migrated, because the Paperclip process replaces it — model routing and question policy, the
research → plan → TDD → review → commit sequence, delegation and context rules, reviewer selection,
the vendored `.claude/` install and its rules-precedence note, per-machine tool constraints, and
pointers into user-scope assistant configuration. Work tracking lives in Paperclip issues.
