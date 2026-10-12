# TOG-7393 — Cron-alarm runbook trial drill report

**Date:** 2026-09-28 · **Scope:** `docs/CRON-SYNC-ALARM-RUNBOOK.md` trialled
end-to-end following the doc alone, on local dev (`wrangler dev --test-scheduled`
+ local D1). **Method:** no deploy, no Cloudflare token, no Routeware tenant
touched. Fixes landed in the runbook itself (§5 recipe hardened).

Prior drill: [TOG-6280](TOG-6280-cron-drill-report.md) (2026-09-27, all keys
PASS). This trial re-ran every key and found two recipe gaps that have since
appeared / were never covered.

## Verdicts per alarm key

| Key | Drill result | Evidence |
|---|---|---|
| *(no line)* / missed run | **PASS** — empty local D1 returns `last_sync: NULL` on all three tables, which under §2 triages as **failed** | `wrangler d1 execute … --local` × 3, §2 queries verbatim |
| `unconfigured` | **PASS** — exactly one stdout line: `outcome "unconfigured"`, all tables `null`, `mode "single-invocation"`, `configSource "fallback-single-invocation"`, `d1LimitRisk: true` | Live `GET /__scheduled` against blanked `--var`s |
| `failed` | **PASS** — exactly one stderr line: `outcome "failed"`, `mode "chained-http"`, `error "CUSTOMER_SNAPSHOT_SYNC_SECRET is not set"`, all tables `null` | Live `GET /__scheduled` in chained mode without the sync secret |
| `success` | **PASS (unit + hermetic E2E)** — 35/35 `test/scheduled.test.ts`; 2/2 `test/snapshotSyncE2E.test.ts` | `npx vitest run test/scheduled.test.ts test/snapshotSyncE2E.test.ts`; live `success` needs the tenant (real report fetch) |

## Runbook gaps found and fixed

`wrangler dev` overlays `.dev.vars` under the `--var` CLI overrides, and only
keys present as `--var` win. The §5 recipe blanked the report path/query vars
but not the two vars that decide the drill's outcome class — so any value for
them in the driller's `.dev.vars` (real or dummy placeholder) silently flips
the expected key. Both flips were reproduced live with planted dummy values,
then the fixed recipe was verified to restore the expected outcome:

1. **`failed` drill broken by a leaked sync secret.** With
   `CUSTOMER_SNAPSHOT_SYNC_SECRET` set in `.dev.vars`, the runbook-exact
   Terminal-B recipe yields `outcome "unconfigured"` (all-null plan, no throw)
   instead of the expected `failed` — the chained runner finds a bearer and
   never throws. Fixed: recipe now passes
   `--var "CUSTOMER_SNAPSHOT_SYNC_SECRET: "`, which blanks the override and
   restores `outcome "failed"` / `error "CUSTOMER_SNAPSHOT_SYNC_SECRET is not
   set"` verbatim (verified live).
2. **`unconfigured` drill broken by a leaked public base.** With
   `SHADOW_API_PUBLIC_BASE` set in `.dev.vars`, the runbook-exact Terminal-A
   recipe flips into `mode "chained-http"` and — with no sync secret — yields
   `outcome "failed"` instead of the expected `unconfigured`
   single-invocation line. Fixed: recipe now passes
   `--var "SHADOW_API_PUBLIC_BASE: "`, which restores `mode
   "single-invocation"`, `configSource "fallback-single-invocation"`,
   `d1LimitRisk: true` verbatim (verified live).

Both blanks are annotated load-bearing in §5 with the failure mode stated, so
a future edit does not "simplify" them away.

## Incidental observations (not runbook gaps)

- Ports 18788/18789 were held by live `wrangler dev` pairs from an earlier
  drill (both running this exact recipe). Left untouched; this drill used
  18881–18886. The §5 orphan-listener note (map by socket inode, kill only own
  PIDs, never broad `pkill`) proved accurate and sufficient.
- `.dev.vars` is gitignored (`M` on it never shows in `git status`); all
  planted trap values were removed after the drill. No PII was fetched,
  logged, or committed at any point.

## Not verified (out of drill scope, unchanged from TOG-6280)

- Production log path (§1 dashboard / `wrangler tail --remote`): needs deploy
  token; shape is identical by construction (same `console.log` line).
- Deployed trigger state (`[triggers]`, cron history): covered by code ref only.
- Full `success` with real row counts: tenant-gated.

## Reviewer re-run

Follow runbook §5 top to bottom on a checkout with the fix; every expectation
above should reproduce verbatim except `scheduledTime`/`durationMs`. Reviewer
checks: `npx vitest run test/scheduled.test.ts test/snapshotSyncE2E.test.ts`
(37 green). To prove the blanks matter, set a dummy
`CUSTOMER_SNAPSHOT_SYNC_SECRET` in `.dev.vars` and confirm the Terminal-B
drill still yields `failed`.
