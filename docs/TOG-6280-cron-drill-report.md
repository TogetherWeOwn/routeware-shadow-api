# TOG-6280 — Cron runbook missed-run drill report

**Date:** 2026-09-27 · **Scope:** `docs/CRON-SYNC-ALARM-RUNBOOK.md` executed
end-to-end on local dev (`wrangler dev --test-scheduled` + local D1).
**Method:** no deploy, no Cloudflare token, no Routeware tenant touched.
Fixes landed in the runbook itself (§5 is the new reproducible drill).

## Verdicts per alarm key

| Key | Drill result | Evidence |
|---|---|---|
| *(no line)* / missed run | **PASS** — empty local D1 returns `last_sync: NULL, rows: 0` on all three tables, which under §2 triages as **failed** | `wrangler d1 execute … --local` × 3, §2 queries verbatim |
| `unconfigured` | **PASS** — exactly one stdout line: `outcome "unconfigured"`, all tables `null`, `mode "single-invocation"`, `configSource "fallback-single-invocation"`, `d1LimitRisk: true` | Live `GET /__scheduled` against blanked `--var`s (full line in runbook §5) |
| `failed` | **PASS** — exactly one stderr line: `outcome "failed"`, `mode "chained-http"`, `error "CUSTOMER_SNAPSHOT_SYNC_SECRET is not set"`, all tables `null` | Live `GET /__scheduled` in chained mode without the sync secret |
| `success` | **PASS (unit)** — 33/33 `test/scheduled.test.ts`, incl. per-table counts, explicit-`null` skips, bare-controller fallback, non-Error rejections | `npx vitest run test/scheduled.test.ts`; live `success` needs the tenant (real report fetch), covered hermetically by `test/snapshotSyncE2E.test.ts` |

## Runbook gaps found and fixed

1. **No local drill existed.** `wrangler tail` needs a deployed Worker + token;
   nothing told a reviewer how to reproduce the keys locally. Added §5 with the
   exact two-server recipe, expected lines, and the `npm ci --include=dev`
   prerequisite (this worktree lacked devDependencies).
2. **`resolveChainedBase` (TOG-6285) undocumented.** A malformed
   `SHADOW_API_PUBLIC_BASE` (path suffix, userinfo, non-http) falls back to
   single-invocation *silently* — same `configSource` as unset. The `d1LimitRisk`
   paragraph now says to re-check the value character-by-character, not just
   presence.
3. **`NULL last_sync` unexplained.** §2 said "predates today's run" but the
   never-synced case returns NULL — now named as the drill's core case.
4. **Brittle line refs.** `wrangler.toml:10-12` / `:81` replaced with section
   names (`[observability]`, `[triggers]`).
5. **Local quirks pinned:** `/__scheduled` sends no `cron` field (expect `""`,
   not `0 7 * * *`); `wrangler dev` orphans `workerd` listeners — kill by socket
   inode, never broad `pkill` (shared machine).

## Not verified (out of drill scope)

- Production log path (§1 dashboard / `wrangler tail --remote`): needs deploy
  token; shape is identical by construction (same `console.log` line).
- Deployed trigger state (`[triggers]`, cron history): covered by code ref only.
- Full `success` with real row counts: tenant-gated; no PII was fetched,
  logged, or committed at any point in this drill.

## Reviewer re-run

Follow runbook §5 top to bottom; every expectation above should reproduce
verbatim except `scheduledTime`/`durationMs`. Reviewer check:
`npx vitest run test/scheduled.test.ts` (33 green).
