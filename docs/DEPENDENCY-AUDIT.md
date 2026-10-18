# Dependency audit gate and allowlist process

## What runs in CI

The hygiene job runs `npm run check:deps-audit` on every PR and every push
to `main`. It audits **two lockfiles** and fails the build on
any **high or critical** advisory that is not explicitly allowlisted in
`scripts/lib/depsAuditCheck.mjs` (`AUDIT_ALLOWLIST`):

- root `package-lock.json` via `npm audit --omit=dev --json`;
- `tools/api-discovery/package-lock.json` via `npm audit --include=dev --json`.
  That package is not a workspace member, so the root audit
  never sees its tree (playwright, tsx). It has no prod dependencies, so
  `--omit=dev` would audit an empty tree and pass silently forever — the
  full-tree audit is what keeps its 0-vuln baseline (2026-10-15) honest.
  The `--include=dev` is explicit because ambient `NODE_ENV=production`,
  `npm_config_omit=dev` or `npm_config_production=true` would otherwise
  make npm omit devDependencies by default and audit nothing.

The two reports are merged (`combineAuditJson`) into a single verdict with
one shared allowlist and one staleness rule. The PASS log names both
lockfiles with their advisory counts, and every blocking advisory is
annotated with the lockfile(s) that reported it, so the CI log proves both
scopes ran.

Before merging, each report must pass `auditReportProblem`: npm prints
error JSON (e.g. `ENOLOCK` when a lockfile is missing) on stdout with the
same exit code 1 as "vulnerabilities found", so a report carrying an
`error`, lacking a `vulnerabilities` object, or covering 0 dependencies
is an infrastructure failure (exit 2) — never a clean verdict.

- **Prod only (`--omit=dev`).** DevDependencies (vitest, wrangler,
  playwright) never ship to the Worker; auditing them would drown the signal
  for what actually runs in production.
- **High/critical block; moderate/low never block.** The tree historically
  carried ~25 moderate/low advisories, mostly Hono middleware adapters this
  Worker never mounts (JSX, Lambda, `toSSG`, AWS adapters). Gating on those
  would hold the gate permanently red and teach everyone to ignore it. They
  are still counted in the PASS log so drift is visible. After the
  `hono` 4.13.13 bump (`npm audit fix` non-breaking) the tree reports 7
  packages / 3 distinct advisories, all high and allowlisted, 0 below
  threshold.
- **Per-advisory severity, not npm's rollup.** `npm audit` rolls each
  package up to its worst advisory; the gate reads each GHSA's own severity
  instead, so one high advisory in a package does not force-allowlist its
  moderate siblings.

## Dependabot keeps the list shrinking

`.github/dependabot.yml` proposes **weekly (Monday 06:00 UTC)** bumps for
`npm` (minor/patch grouped, limit 5) and `github-actions`, including a
separate `npm` entry for `/tools/api-discovery` so the discovery lockfile
has the same automated fix path as the root tree. Security updates
always break out into their own PRs regardless of grouping. When a bump
clears an allowlisted advisory, the gate's **staleness rule** fails until
the entry is removed — so the allowlist only ever shrinks, and a Dependabot
PR that fixes a vuln must delete its entry (removing the entry is part of
that PR). While Dependabot is parked (`open-pull-requests-limit: 0`), bump
the reporting lockfile by hand (`npm update <pkg>` in the root or in
`tools/api-discovery`).

Dependabot titles use `chore(deps)` / `ci(deps)` prefixes to satisfy the
`pr-lint` Conventional Commits check; link the tracking GitHub issue in the
body when merging, since the bot cannot know it.

## Allowlist process

An allowlist entry is a **reviewed risk acceptance**, not a permanent pass.
Every entry names:

- the GHSA id and affected package,
- *why* it is tolerated (unreachable from Worker code — e.g. browser-only
  tooling chain, adapter never mounted, explicit-origin CORS config),
- the remediation path (almost always "Dependabot proposes the upstream
  fix"),
- the change that added it (`addedIn`).

### Adding an entry (gate is red on a new advisory)

1. Reproduce locally: `npm audit --omit=dev` — confirm the GHSA id,
   severity, and which dependency chain pulls it in
   (`npm ls <package>`).
2. Assess reachability: does Worker request-path code (or its transitive
   runtime) touch the vulnerable function? If yes, **fix instead of
   allowlisting** — bump the dependency in the same PR.
3. If genuinely unreachable, add the entry with reason + remediation +
   provenance, and note the advisory in the PR body.
4. A second pair of eyes sees it in the normal Code Reviewer pass — entries
   are code, reviewed like code.

### Removing an entry (staleness failure after a bump)

Delete the entry. Nothing else changes — the gate goes green when the
advisory is simply gone. If the advisory is gone but the package is still
present (upstream fixed it in place), still delete the entry: an entry
whose GHSA no longer appears is stale by definition.

### Never

- Never allowlist by package name or severity alone — always the GHSA id.
- Never extend an entry "just in case" — if the advisory text changed, it
  is a new risk; re-review it.
- Never gate on `npm audit` exit codes directly — npm exits 1 whenever
  *any* advisory exists, including moderate/lows below the gate threshold.
  The `check-deps-audit` gate is the verdict, not the raw exit code.

## Local commands

| Command | What it does |
|---|---|
| `npm run check:deps-audit` | Full gate: live audits of both lockfiles, allowlist + staleness verdict. |
| `node scripts/check-deps-audit.mjs --audit-json=<path>` | Gate against a saved root audit file (offline debugging; CI always runs npm). |
| `node scripts/check-deps-audit.mjs --discovery-audit-json=<path>` | Gate against a saved discovery audit file (offline debugging; pass both flags to stay fully offline). |
| `npx vitest run test/depsAuditCheck.test.ts` | Unit tests for the pure helpers (fixture JSON only — never touches the registry). |
| `npx vitest run test/checkDepsAudit.test.ts` | Wrapper tests: spawns `check-deps-audit.mjs` against offline fixtures (exit codes, scope attribution, error-JSON rejection). |
