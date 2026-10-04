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

Requires Node 20+ (`nvm use` picks it up from [`.nvmrc`](./.nvmrc)).

```bash
nvm use                             # Node 20+
npm install                         # add --include=dev if your shell omits devDependencies
cp .dev.vars.example .dev.vars      # then fill in values (never commit this file)
npm run db:migrate:local            # create the local D1 tables (once per clone)
npm run verify:config               # one-command config preflight (devvars + vars-parity + local d1-drift)
npm run dev                         # http://localhost:8787 (runs check:devvars first)
```

`SHADOW_API_TOKEN` can be any local-only string you invent. `LOGIN_USERNAME` /
`LOGIN_PASSWORD` need real Routeware tenant credentials only for
upstream-backed routes; dummy values work for everything else. See the
[README](./README.md#quick-start-local) for the full walkthrough.

## Verification loop (PR checks)

Every PR must pass, in this order:

```bash
npm run check:ci-workflow
npm run typecheck
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
  routes/vars, D1 schema) need a `TOG-…` bullet under `CHANGELOG.md`
  `## [Unreleased]` — enforced by `npm run check:changelog`. Docs-only,
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
  (`auth`, `events`, `sync`) — keep the card ID out of the title and put it on
  the PR body's `Refs:` line instead (see the PR template).
- Branch names: `type/short-slug`, e.g. `fix/sudo-window`.
- Merging is squash only — each PR lands on `main` as one commit.

## PR process

1. Fill in the PR template (Summary, Changes, Testing, `Refs: TOG-…`).
2. Keep each PR to one logical change.
3. The `pr-lint` check enforces the title/body standard — fix the title or body
   and it re-runs; never weaken or bypass it.
4. Code review: a Code Reviewer pass on the exact head SHA with green CI, and
   the approving reviewer merges. Re-pushes need re-review.
