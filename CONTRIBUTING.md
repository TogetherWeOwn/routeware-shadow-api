# Contributing

Thanks for contributing. This repo is a Cloudflare Worker fronting the
Routeware admin site — read the binding project rules first, then follow the
loop below.

## Read before changing anything

- [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) — **binding on every change**:
  what the project is, locked invariants, and the verification loop.
- [`docs/TEST-INVARIANTS.md`](./docs/TEST-INVARIANTS.md) — before touching
  `src/lib/snapshot/`, `src/routes/`, or deleting a test that looks redundant.
- [`docs/SECURITY-REMEDIATION.md`](./docs/SECURITY-REMEDIATION.md) — before any
  repo-visibility change or credential rotation.
- [`docs/HANDOVER.md`](./docs/HANDOVER.md) — before anything touching deploys,
  Cloudflare resources, or the Routeware tenant.
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — the standard we hold each
  other to.

## Dev setup

Requires Node 22+ (`nvm use` picks it up from [`.nvmrc`](./.nvmrc)).

```bash
nvm use                             # Node 22+
npm install                         # add --include=dev if your shell omits devDependencies
cp .dev.vars.example .dev.vars      # then fill in values (never commit this file)
npm run db:migrate:local            # create the local D1 tables (once per clone)
npm run verify:config               # one-command config preflight (devvars + vars-parity + local d1-drift)
npm run dev                         # http://localhost:8787 (runs check:devvars first)
```

**Fast path:** `npm run first-run` runs `check:devvars`, `db:migrate:local`, `db:seed`
and a smoke check in one command. The smoke step starts `wrangler dev` on a free
loopback port, runs `smoke:readiness` against it, stops the server, and exits non-zero
at the first failing step. `npm run help` lists every script, grouped by namespace.

`SHADOW_API_TOKEN` can be any local-only string you invent. `LOGIN_USERNAME` /
`LOGIN_PASSWORD` need real Routeware tenant credentials only for
upstream-backed routes; dummy values work for everything else. See the
[README](./README.md#quick-start-local) for the full walkthrough.

## Verification loop (PR checks)

Every PR must pass, in this order:

```bash
npm run check:ci-workflow
npm run typecheck
npm run lint
npm test
```

Run `npm run test:coverage` before pushing — coverage is a ratchet
(`vitest.config.ts` pins thresholds just under current levels; raise them when
your change moves the number up). If Actions is enabled, CI additionally runs
`wrangler deploy --dry-run` and a hygiene job that fails on committed `*.csv`
exports, `*:Zone.Identifier` files, or `.dev.vars`.

Hard rules (enforced by tests or CI — see `docs/CONVENTIONS.md` §§ 3–4):

- No secrets in commits — use `wrangler secret put` (deployed) or `.dev.vars`
  (gitignored, local). Never commit Routeware report exports (`*.csv`, real PII).
- No test may reach the network — mock upstream `fetch`, throw on unexpected URLs.
- No hand-written source file over 800 lines — split the module instead.
- Route modules must be `OpenAPIHono` via `createRouteModule()`, never plain `Hono`.
- Consumer-visible contract changes (routes, response shapes, wrangler
  routes/vars, D1 schema) need a bullet under `CHANGELOG.md`
  `## [Unreleased]` referencing the GitHub issue (e.g. `- #123: …`) —
  enforced by `npm run check:changelog`. When no issue exists, cite the
  PR number instead (`- #<PR>: …`). Docs-only,
  test-only, script-only and CI-only changes skip the gate.
- Never run `npm run deploy` / `wrangler deploy` / remote migrations as ordinary
  development — deploys target production and are separately gated.

## Conventional commits

PR titles and branch commits follow
[Conventional Commits](https://www.conventionalcommits.org/):

- Header form: `type(scope): summary` — e.g. `fix(auth): refuse expired sudo sessions`.
- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`,
  `chore`, `revert`, `style`, `security`.
- Max 100 characters, no trailing period. The scope is the area of code
  (`auth`, `events`, `sync`) — keep issue numbers out of the title and link
  them in the PR body's Linked Issues section instead (see the PR template).
- Branch names: `type/short-slug`, e.g. `fix/sudo-window`.
- Merging is squash only — each PR lands on `main` as one commit.

## Pull request standards

These follow the upstream paperclipai/paperclip contributor rules, adapted for
this repo. The existing `pr-lint` check enforces them
(`.github/scripts/pr_standards.py`, tests beside it).

- **Title** is a Conventional Commits header, `type(scope): summary`, at most
  100 characters, no trailing period. The squash commit on `main` takes the PR title.
- **Body** uses `.github/pull_request_template.md`. Fill in every section:
  Thinking Path, Linked Issues or Issue Description, What Changed, Verification,
  Risks, Model Used and the Checklist. A PR created through the API gets no
  template, so paste it in. Thinking Path needs at least three real items.
- **Linked issue**: link the GitHub issue in the body (`Fixes #123` or
  `Refs #123`), never in the title or branch name, or describe the problem
  in the Linked Issues section when no issue exists. `docs`, `chore`,
  `build`, `ci`, `style`, `test` and `revert` PRs need no linked-issue
  description or duplicate-search tick.
- **Model Used** names the provider and exact model/version that wrote or helped
  with the change, or says `None - human-authored`.
- **Search first.** Look for an open or recent PR that touches the same area,
  and link what you find.
- **Branch name** is `type/short-slug`, for example `fix/sudo-window`.
- **Enforcement levels**: invalid titles and empty bodies are errors;
  missing template sections, an unticked duplicate search, and internal
  tracker references in the title, body or branch name warn
  (`PR_STANDARDS_MODE: "warn"`). This is a public repo: keep internal
  tracker ids, internal hosts and internal links out of every title, body,
  branch name and commit message — link public GitHub issues instead.

## PR process

1. Fill in the seven-section PR template and its repo-specific checklist.
2. Keep each PR to one logical change.
3. The `pr-lint` check enforces the title/body standard — fix the title or body
   and it re-runs; never weaken or bypass it.
4. Code review: a Code Reviewer pass on the exact head SHA with green CI
   before squash merge. Re-pushes need re-review.
