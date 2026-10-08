# Dependency audit gate and allowlist process (TOG-8904)

## What runs in CI

The hygiene job runs `npm run check:deps-audit` on every PR and every push
to `main`. It executes `npm audit --omit=dev --json` and fails the build on
any **high or critical** advisory that is not explicitly allowlisted in
`scripts/lib/depsAuditCheck.mjs` (`AUDIT_ALLOWLIST`).

- **Prod only (`--omit=dev`).** DevDependencies (vitest, wrangler,
  playwright) never ship to the Worker; auditing them would drown the signal
  for what actually runs in production.
- **High/critical block; moderate/low never block.** The tree carries ~25
  moderate/low advisories, mostly Hono middleware adapters this Worker never
  mounts (JSX, Lambda, `toSSG`, AWS adapters). Gating on those would hold
  the gate permanently red and teach everyone to ignore it. They are still
  counted in the PASS log so drift is visible.
- **Per-advisory severity, not npm's rollup.** `npm audit` rolls each
  package up to its worst advisory; the gate reads each GHSA's own severity
  instead, so one high advisory in `hono` does not force-allowlist its 20+
  moderate siblings.

## Dependabot keeps the list shrinking

`.github/dependabot.yml` proposes **weekly (Monday 06:00 UTC)** bumps for
`npm` (minor/patch grouped, limit 5) and `github-actions`. Security updates
always break out into their own PRs regardless of grouping. When a bump
clears an allowlisted advisory, the gate's **staleness rule** fails until
the entry is removed — so the allowlist only ever shrinks, and a Dependabot
PR that fixes a vuln must delete its entry (removing the entry is part of
that PR).

Dependabot titles use `chore(deps)` / `ci(deps)` prefixes to satisfy the
`pr-lint` Conventional Commits check; add `Refs: TOG-xxxx` to the body when
merging, since the bot cannot know the card.

## Allowlist process

An allowlist entry is a **reviewed risk acceptance**, not a permanent pass.
Every entry names:

- the GHSA id and affected package,
- *why* it is tolerated (unreachable from Worker code — e.g. browser-only
  tooling chain, adapter never mounted, explicit-origin CORS config),
- the remediation path (almost always "Dependabot proposes the upstream
  fix"),
- the card that added it (`addedIn`).

### Adding an entry (gate is red on a new advisory)

1. Reproduce locally: `npm audit --omit=dev` — confirm the GHSA id,
   severity, and which dependency chain pulls it in
   (`npm ls <package>`).
2. Assess reachability: does Worker request-path code (or its transitive
   runtime) touch the vulnerable function? If yes, **fix instead of
   allowlisting** — bump the dependency in the same PR.
3. If genuinely unreachable, add the entry with reason + remediation +
   your card id, and note the advisory in the PR body (`Refs:`).
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
  *any* advisory exists, including the 25 moderate/lows we accept. The
  `check-deps-audit` gate is the verdict, not the raw exit code.

## Local commands

| Command | What it does |
|---|---|
| `npm run check:deps-audit` | Full gate: live `npm audit --omit=dev`, allowlist + staleness verdict. |
| `node scripts/check-deps-audit.mjs --audit-json=<path>` | Gate against a saved audit file (offline debugging; CI always runs npm). |
| `npx vitest run test/depsAuditCheck.test.ts` | Unit tests (fixture JSON only — never touches the registry). |
