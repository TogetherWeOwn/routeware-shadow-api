# Cron local re-drill report — 2026-10-21 (Node 24)

**Date:** 2026-10-21 · **Scope:** `docs/CRON-SYNC-ALARM-RUNBOOK.md` §5
re-executed verbatim on current `main` after the Node pin moved 22 → 24
(PR #294).
**Method:** local/synthetic only — `wrangler dev --test-scheduled` + local D1.
No deploy, no Cloudflare token, no Routeware tenant, no remote mutation.

**Base:** `main` at `aea01c5` (PR #299) · **Node:** `v24.22.0`
(`.nvmrc` holds `24`; CI `node-version: "24"` in `ci.yml` and
`post-deploy-probe.yml`) · **wrangler:** `4.84.1` (repo-pinned).

Prior drills: [cron drill report](cron-drill-report.md) (2026-09-27, all keys
PASS), [cron-alarm drill report](cron-alarm-drill-report.md) (2026-09-28, §5
recipe hardened), and the 2026-10-15 re-drill (all keys PASS, recorded
off-repo). Current procedure:
[Cron sync missed/failed alarm runbook §5 — Local missed-run
drill](CRON-SYNC-ALARM-RUNBOOK.md#5-local-missed-run-drill-no-deploy-no-token-no-tenant).

## Verdicts per alarm key

| Key | Drill result | Evidence |
|---|---|---|
| *(no line)* / missed run | **PASS** — empty local D1 returns `last_sync: NULL, rows: 0` on all three tables, which under §2 triages as **failed** | `wrangler d1 execute … --local` × 3, §2 queries verbatim (after `npm run db:migrate:local`) |
| `unconfigured` | **PASS** — exactly one primary record: `outcome "unconfigured"`, all tables `null`, `mode "single-invocation"`, `configSource "fallback-single-invocation"`, `d1LimitRisk: true`, `cron ""`; plus the single-invocation fallback `warn`, same `runId` | Live `GET /__scheduled` on port 18788 against blanked `--var`s, runbook §5 recipe verbatim |
| `failed` | **PASS** — exactly one primary record: `outcome "failed"`, `mode "chained-http"`, `configSource "SHADOW_API_PUBLIC_BASE"`, all tables `null`, `summary "sync threw before any table result was recorded"`, `kind "Error"`, no `table` field, no exception text | Live `GET /__scheduled` on port 18789 in chained mode with the sync secret blanked |
| `success` | **PASS (unit + hermetic E2E)** — 46/46 across `test/scheduled.test.ts` and `test/snapshotSyncE2E.test.ts` | `npx vitest run test/scheduled.test.ts test/snapshotSyncE2E.test.ts`; live `success` needs the tenant (real report fetch) |

## Runbook deviations

None required a runbook change — the §5 recipe ran verbatim. Observations:

1. **Failed-record shape has evolved since the September reports.** Those quote
   an `error "CUSTOMER_SNAPSHOT_SYNC_SECRET is not set"` field; the live
   record now carries `kind: 'Error'` with no exception text. That matches the
   current runbook §0 ("Exception text never reaches the log"), so the runbook
   is correct and the September quotes are stale history (those reports are
   already marked superseded). No edit made.
2. **Orphan-`workerd` quirk reproduced.** Stopping `wrangler dev` left the
   `workerd` listener on the drill port; the §5 socket-inode mapping found the
   exact PID (verified as this checkout's `workerd` via `/proc` cmdline) and
   killing only that PID freed the port. No broad `pkill` used.
3. **Record layout under `wrangler dev` is pretty-printed objects**, not one
   JSON object per line. Matching on `level` + `msg` per §5 held; no stream
   assumptions needed.

No code or runbook edits were needed (no trivial-fix diff); nothing larger to
file. The `.dev.vars` used dummy placeholders only
(`LOGIN_USERNAME`/`LOGIN_PASSWORD`/`SHADOW_API_TOKEN`); the drill never
authenticated upstream. Ports 18788/18789 were verified free before and after;
no PII was fetched, logged, or committed.

## Not verified (out of drill scope, unchanged from prior drills)

- Production log path (§1 dashboard / `wrangler tail --remote`): needs deploy
  token; shape is identical by construction (same logger line).
- Deployed trigger state (`[triggers]`, cron history): covered by code ref only.
- Full `success` with real row counts: tenant-gated.

## Reviewer re-run

Tenant-free checks only — live `success` needs the tenant (real report
fetch) and is covered by unit + hermetic E2E instead, so it is excluded
here. Run runbook §5 top to bottom for the missed-run, `unconfigured`,
and `failed` expectations above; each should reproduce verbatim except
`scheduledTime`/`durationMs`/`runId`. Reviewer checks, separately:

- Empty-D1 triage (§2 queries verbatim with `--local`, after
  `npm run db:migrate:local`):
  `npx wrangler d1 execute routeware-customer-snapshot --local --json --command "SELECT MAX(synced_at) AS last_sync FROM customer_snapshot"`
  (repeat for `address_snapshot` / `container_snapshot`; expect
  `last_sync: NULL, rows: 0`).
- `npx vitest run test/scheduled.test.ts test/snapshotSyncE2E.test.ts`
  (46 green on the drilled head).
