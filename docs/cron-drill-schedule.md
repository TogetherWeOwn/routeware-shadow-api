# Cron alarm drill schedule + firing evidence

**Date:** 2026-09-29 · **Scope:** Gap G23 ("Cron alarm drill is manual (runbook hardened in #105; no schedule)").
**Method:** ops-only, read-only. No deploy, no token, no tenant, no config changed.
Evidence is read from `origin/main` refs and the scheduled workflow's own run
history. Fixes nothing; records the cadence and the last firing.

Prior drills: [cron drill report](cron-drill-report.md) (2026-09-27, all keys
PASS), [cron-alarm drill report](cron-alarm-drill-report.md) (2026-09-28, §5 recipe
hardened). Last cron success: 2026-09-27 07:00 UTC (read-only D1 ground
truth). This report adds what those lack: the standing schedule and today's
automated-alarm firing.

## 1. Recorded drill cadence

| Layer | Schedule | Source (all `origin/main`) |
|---|---|---|
| Daily cron | `0 7 * * *` UTC daily | `wrangler.toml:95` `[triggers]` `crons = ["0 7 * * *"]`, handler `src/scheduled.ts`, persists per-table rows to `cron_sync_state` (`recordCronRun` at `src/scheduled.ts:220` and `:270`, `migrations/d1/0004_cron_sync_state.sql`) |
| Daily automated alarm | `30 7 * * *` UTC daily, after the cron settles | `.github/workflows/post-deploy-probe.yml:11`, probe 3b `evalCronFreshness` (`scripts/post-deploy-probe.mjs:275-291`) against `GET /api/v1/readiness` → `checks.cron.stale`, server threshold `CRON_STALE_AFTER_MS` 48h (`src/lib/readiness.ts:79`); red job = two consecutive misses |
| Manual fallback | Once daily after 07:30 UTC, disposition recorded | `docs/CRON-SYNC-ALARM-RUNBOOK.md` §4 steps 1–5 (step 5: record date, outcome, tables, action — silence is how the next miss goes unnoticed) |
| Local drill | On demand, after any runbook/`scheduled.ts` change | Runbook §5 two-server recipe (`/__scheduled` + `--local` D1 `NULL` check); reviewer re-run in [cron-alarm drill report](cron-alarm-drill-report.md) § Reviewer re-run |

Detection bound stays ~24h by design (runbook §6: no paid log-alerting tier —
owner constraint). The schedule above is the G23 closure: drills are no longer
manual-only; the automated layer fires daily and the manual layers have a
standing cadence.

## 2. Last firing evidence

### 2a. Cron 07:00 UTC — last success 2026-09-27 (read-only)

`customer_snapshot` MAX(`synced_at`)=2026-09-27T07:00:52Z (109,894 rows);
`address_snapshot` 2026-09-27T07:05:55Z (111,620 rows); `container_snapshot`
2026-09-27T07:11:19Z (388,735 rows total, 44,279 touched that day). Sequential
per-table stamps ⇒ chained-http mode working; all three tables ran ⇒
structured-line outcome `success`. Live trigger verified `0 7 * * *`
(Cloudflare API, modified 2026-08-22); no deploy near 07:00 UTC that day.
Full evidence: the read-only D1 query results summarised above.

### 2b. Automated alarm 07:30 UTC — fired today, path degraded (config, not cron)

- Run: [Post-deploy probe #36580632939](https://github.com/TogetherWeOwn/routeware-shadow-api/actions/runs/36580632939) ·
  event `schedule`, branch `main`, head `0eb24e9026c9847c2b6cd996c995000ff8df2ef8`,
  created 2026-09-29T14:10:15Z, conclusion `failure`, job `Probe deployed Worker (skip-safe)`.
- Probe output (read-only log retrieval, values redacted server-side):
  `FAIL GET /api/v1/health -> TypeError: fetch failed` against
  `http://localhost:8787`; `SKIP GET /api/v1/shadow/health` and
  `SKIP GET /api/v1/readiness` (no bearer, `--skip-if-no-token`);
  `post-deploy probe: 1 probe(s) failed`. Env in the run:
  `SHADOW_API_BASE` empty, `SHADOW_API_TOKEN` empty.
- Verdict: **schedule FIRES, alarm path DEGRADED.** With no `SHADOW_API_BASE`
  the probe falls back to the localhost default and fails the public probe
  before ever reaching the cron-freshness check (probe 3b). This is the exact
  monitoring gap the runbook §4 schedule note names: a SKIP-only (here
  fail-on-localhost) scheduled run checks no cron freshness. Operator follow-up
  is setting the effective `vars.SHADOW_API_BASE` value (repository or applicable
  organization scope) plus the bearer secret —
  deliberately **not** done here (read-only scope; secrets/vars are
  owner-gated). No cron-miss signal is implied: the 07:00 cron evidence stands
  per §2a, and the probe failure is a prober-config failure.

## 3. Reviewer re-run (acceptance, all read-only)

```bash
git show origin/main:wrangler.toml | grep -A1 '\[triggers\]'          # crons = ["0 7 * * *"]
git show origin/main:.github/workflows/post-deploy-probe.yml | grep 'cron:'  # "30 7 * * *"
git show origin/main:src/lib/readiness.ts | grep CRON_STALE_AFTER_MS  # 48h
gh run view 36580632939 --json conclusion,event,createdAt,headSha,url
gh api repos/TogetherWeOwn/routeware-shadow-api/actions/runs/36580632939/jobs --jq '.jobs[] | {name, conclusion}'
# full step log via the company-bot get-job-logs (failed_only, run 36580632939):
# expect FAIL .../health -> TypeError: fetch failed / SKIP .../shadow/health / SKIP .../readiness
```

Docs-only: one new file, no `src/`/`wrangler.toml`/workflow edits, so the
changelog gate skips (`scripts/lib/changelogCheck.mjs` contract paths) and
`npm run check:ci-workflow` stays green. Reviewer merges on green CI per the
review economy (single Code Reviewer pass; docs-only).
