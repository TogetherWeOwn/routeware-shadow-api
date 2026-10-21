# Cron sync missed/failed alarm runbook

**Status:** runbook only. No new services, no paid tiers, no new secrets, no workflow
changes. Every check below uses observability this repo already has: Workers Logs
(`[observability] enabled = true` in `wrangler.toml`), `wrangler tail`, and
`wrangler d1 execute`.
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Cron `0 7 * * *` UTC
(`[triggers]` in `wrangler.toml`), handler `src/scheduled.ts`, tests `test/scheduled.test.ts`.
**Why:** a silent cron failure used to look identical to "no report paths configured"
(both were free-text log lines). Every run now emits exactly one primary structured record whose
`outcome` is `success`, `unconfigured`, `failed`, or `skipped-overlap` — the alarm keys on that field,
and on the *absence* of any primary record.

## 0. The signal: one primary `data-snapshot-sync` record per run

Each cron firing emits one primary record through the shared logger (`src/lib/logger.ts`):
one object per record, with no text prefix. `msg` is `data-snapshot-sync` at level `info` for
`success`, `unconfigured`, and `skipped-overlap`, and `data-snapshot-sync failed` at level
`error` for `failed`. Match on `msg` and `route` (`scheduled.data-snapshot-sync`). Shape
(counts below are illustrative, never real row data — only counts, durations, and config
names ever leave the Worker):

```json
{"level":"info","msg":"data-snapshot-sync","route":"scheduled.data-snapshot-sync","ms":41203,"event":"data-snapshot-sync","runId":"123e4567-e89b-12d3-a456-426614174000","outcome":"success","mode":"chained-http","configSource":"SHADOW_API_PUBLIC_BASE","d1LimitRisk":false,"tables":{"customer":{"upserted":203411,"rowCount":203411,"deleted":12,"r2":{"status":"stored"}},"address":{"upserted":198002,"rowCount":198002,"r2":{"status":"stored"}},"container":null},"summary":"customer: 203411 upserted, 203411 rows, 12 deleted; address: 198002 upserted, 198002 rows; container: skipped (no report path configured)","durationMs":41203,"cron":"0 7 * * *","scheduledTime":"2026-09-27T07:00:00.000Z"}
```

Every record from one firing — primary, fallback `warn`, persistence-failure
`error`, and `skipped-overlap` — carries the same `runId` (one
`crypto.randomUUID()` minted at `scheduled()` entry; a bare UUID,
PII-free). The id is threaded beyond the scheduled-owned lines: the
`snapshot.orchestration` skip lines and the `snapshot.r2.*` archive lines
carry it too, and on the chained path each per-table sub-invocation receives
it on the `x-run-id` header (UUID-validated at the per-table routes), so a
run's records correlate across invocations. Filter on `runId` to pull a
single run's records together.

Two secondary records can accompany the primary one. Neither changes `outcome`. A `warn`
with msg `SHADOW_API_PUBLIC_BASE is not set; data-snapshot-sync is using one invocation` marks a
single-invocation fallback (see `d1LimitRisk` below). An `error` with msg `data-snapshot-sync
persistence failed` means the readiness write for that run did not land: `cron_sync_state` does
not reflect the run even if its rows moved, so check ground truth (§2).

| `outcome` | Meaning | Alarm action |
|---|---|---|
| `success` | At least one table ran. Per-table detail in `tables`; skipped tables are explicit `null` with a `skipped (no report path configured)` note in `summary`, never silent omission. | None, unless a table you expect is `null` (config drift — see §3). |
| `unconfigured` | No report paths set at all — a config state, not a pass. | Configure sources (§3), do not celebrate. |
| `failed` (`data-snapshot-sync failed`, level `error`) | The sync threw. The allowlisted `table` names the failed step (e.g. `customer`, `address` — absent when unknown); `status` is the HTTP status of a failed chained subrequest (only with `kind` `ChainedHttpError`); `kind` is the class of the root cause (`ChainedHttpError`, `ChainedTimeoutError`, `ChainedInvalidJsonError`, or the local error's class). Exception text never reaches the log, except the R2 archive `reason` under `tables`. Tables that finished before the failure keep their counts; the failing table and tables never attempted are `null`. `summary` is `sync threw before any table result was recorded` when nothing ran (for example, the missing-secret check before any table runs); otherwise it lists all three tables, with `; failed: <table>` appended only when the failing table is known. | Triage per §4. |
| `skipped-overlap` | A previous firing was still in-flight on the same isolate, so this firing did no work (the overlap guard). All tables `null`, fixed literal summary, no `recordCronRun` write — `cron_sync_state` still shows the last run that moved rows. | None if isolated (a slow run overlapped the next firing). If every firing skips, the first run is stuck — triage per §4. |
| *(no primary record)* | The platform never invoked `scheduled()`, the invocation died before logging, or the log was dropped. Possible causes: cron trigger disabled/misconfigured, deploy in progress at 07:00 UTC, Worker-level crash. The record is written after the readiness write, so rows can move with no record. | Treat as **failed**. Verify with ground truth (§2): fresh `synced_at` means the rows moved and only the record is missing. Then check trigger state. |

Two notes on `summary` and `tables`. On a `failed` record with partial progress, a `null` table's `summary` entry still reads `skipped (no report path configured)`, even when that table is configured and failed or never ran; trust `tables` and `failed:`, not that text. A table entry can carry `r2: {status, reason?, key?}` (the R2 archive state); `summary` appends `, r2: <status>` for any status other than `stored`, and `, r2: unknown` when the entry has no archive status.

Also watch `d1LimitRisk: true`: the whole job ran in one invocation because
`SHADOW_API_PUBLIC_BASE` is unset — or set to something unusable
(`configSource: "fallback-single-invocation"` either way), so
D1's per-invocation operation budget applies to all three tables as one pool. The same run logs the `warn` record described above, whose text says "is not set" even when the value is set but rejected, so `configSource` is the authoritative field. At ~609k
rows a large export can die partway through. The fix is configuration, not code: set
`SHADOW_API_PUBLIC_BASE` to the Worker's public origin (see `CUSTOMER_SNAPSHOT.md`
§ "D1: Too many API requests"). The handler only accepts a bare `http(s)` origin —
no path, query, fragment, or userinfo (`resolveChainedBase` in `src/scheduled.ts`,
pinned by `test/scheduled.test.ts`): a path-suffixed or malformed value falls back
to single-invocation silently, so a record with `d1LimitRisk: true` despite the var
being "set" means the value failed that validation — re-check it character by
character, don't just check presence.

## 1. Reading the last run's record

Dashboard: Workers & Pages → this Worker → **Logs**, filter text `data-snapshot-sync`,
time range covering 07:00 UTC. Or from any machine with this repo's Wrangler and a
Cloudflare API token (the same access deploys already need — nothing new):

```bash
npx wrangler tail --format json 2>&1 | grep 'data-snapshot-sync'
```

Unverified: this grep and its `--format json` layout were not checked against a live tail in
this change. A logged object argument may not come out as one line per record. Confirm on one
real invocation first; if the layout differs, parse the object out of the tail output and filter
on `msg` and `route`.

Read the primary record's `outcome`, `tables`, `durationMs`, and `table`
(present only on `data-snapshot-sync failed` when the failed step is known).
One primary record per run: if you see two for one `scheduledTime`, the second
is a platform retry — read the latest. Note the guard serializes
firings per isolate only: two `success` records for adjacent `scheduledTime`s mean
a platform double-fire landed on two isolates and both ran — expected residual,
not a guard failure.

## 2. Ground truth: did rows actually move? (catches missed runs)

Logs can be missed, dropped, or never emitted. The D1 tables cannot lie: every synced
row carries `synced_at` from its run. After the 07:00 UTC window plus a margin for
large exports (allow at least 30 minutes at current row counts):

```bash
npx wrangler d1 execute routeware-customer-snapshot --remote --json \
  --command "SELECT MAX(synced_at) AS last_sync FROM customer_snapshot"
```

(Repeat for `address_snapshot` / `container_snapshot` for the tables you expect to
run.) If `last_sync` is `NULL` (table empty — never synced) or predates today's run,
the sync missed or failed regardless of what the logs say — triage as **failed**.
`NULL` is the drill's core case, not an error in the query. This query reads one
aggregate, no PII.

## 3. Config-drift check: are the report sources even set?

Check the three `*_REPORT_EXPORT_PATH` / `*_REPORT_QUERY_ID` pairs in the Cloudflare
dashboard (Worker → Settings → Variables) or `wrangler.toml` `[vars]` for local/dev.
If a table has neither a path nor a query id, the next cron logs `unconfigured` (or
`success` with that table `null`) — fix the vars per `CUSTOMER_SNAPSHOT.md`
§ "Checklist" before treating any sync as healthy. This distinguishes "nothing
configured" from "configured but broken" without reading logs.

## 4. The daily alarm loop (automated: the 07:30 UTC scheduled probe)

The 07:30 UTC `Post-deploy probe` workflow (`.github/workflows/post-deploy-probe.yml`,
gap O4) asserts cron freshness automatically: probe 3b reads
`GET /api/v1/readiness` → `checks.cron.stale` and **fails the job (exit 1)** when the
verdict is stale, i.e. no cron run recorded within the server-side 48h threshold
(`CRON_STALE_AFTER_MS` in `src/lib/readiness.ts` — the probe never re-implements the
threshold, so probe and server cannot drift). The cron fires at 07:00 UTC, so the probe
runs after it settles; a red job means two consecutive cron misses. Triage a red job
with §1–§3 and the step-tag table below — start at this runbook's §1, not at the
probe script. Probe output names the stale timestamp (`FAIL cron freshness -> STALE
lastRunAt=…`) and points back here.

Schedule note: the probe needs a bearer (`SHADOW_API_TOKEN` secret) to reach
readiness; in skip-safe mode without one the authed probes SKIP and cron freshness
is unchecked — a SKIP-only scheduled run is a monitoring gap, not a pass. Ping the
authored fixture check before trusting green: point the probe at a readiness body
with a >48h-old cron timestamp and confirm it exits 1 (`test/postDeployProbe.test.ts`
pins the verdict mapping; the `evalCronFreshness` unit tests are the runnable spec).

Until a log-based alerting tier exists, the manual fallback is this loop, run once daily after
07:30 UTC by whoever holds the deploy token (or any existing scheduled runner):

1. Pull the last primary record (§1).
2. `outcome: success` with all expected tables non-null → done.
3. `outcome: unconfigured`, or `outcome: success` with an expected table `null` → config drift: fix vars (§3), re-run `POST /api/v1/data-snapshot/sync` manually to verify, confirm tomorrow's record.
4. `outcome: failed` (`data-snapshot-sync failed`) or **no primary record** → confirm ground truth (§2). Then triage by the allowlisted `table` plus `summary` (exception text is intentionally not logged):
   - `table: customer|address|container` with `failed: <table>` in `summary` and prior tables keeping counts — that table's step threw (D1 limit/lock on `… snapshot` steps; 4xx/5xx or timeout on `chained …` steps). If `d1LimitRisk: true`, set `SHADOW_API_PUBLIC_BASE` and re-run; otherwise split per-table syncs (`CUSTOMER_SNAPSHOT.md` § "D1: Too many API requests"). For a chained rejection (`status` 4xx), re-run the named table route manually with the current secret (a rotated `CUSTOMER_SNAPSHOT_SYNC_SECRET` is the usual cause); for a chained timeout (`kind` `ChainedTimeoutError`; per-table budget default 180s, `CHAINED_SYNC_TIMEOUT_MS`), check whether that table's report export is stalled upstream first. A `status` 5xx means the table route itself failed; check its upstream first.
   - No `table` field — the failure happened before any table ran (e.g. missing `CUSTOMER_SNAPSHOT_SYNC_SECRET`) or the step tag was unrecognized. Check Worker config, recent deploys, and platform health; the record deliberately does not identify more.
   - Upstream HTML-200 failures (session lost, login page) surface as the failed table per `docs/CONVENTIONS.md` fact 1 — verify Routeware credentials, not Worker config.
   - No primary record with fresh `synced_at` — the rows moved, but the Worker died before logging or the log was dropped (the record is written after the readiness write). Note it and watch the next run; an overlapping firing is not this case, since it logs `skipped-overlap`. No primary record with stale `synced_at` — the cron did not fire: check the trigger (`wrangler.toml` `[triggers]`), recent deploys around 07:00 UTC, and the Worker's cron history in the dashboard.
5. Record the disposition where the team looks (issue comment or ops log): date, outcome, tables, action taken. Silence is how the next miss goes unnoticed.

## 5. Local missed-run drill (no deploy, no token, no tenant)

Reproduces the `unconfigured` and `failed` alarm keys against the real handler on
local dev. Needs `npm ci --include=dev` first (the worktree may not have
devDependencies), plus a `.dev.vars` with `LOGIN_USERNAME` / `LOGIN_PASSWORD` and
one client token — dummy placeholders are fine, the drill never authenticates
upstream (gitignored, never commit).

```bash
# Terminal A — blanked report vars: deterministic `unconfigured`, no tenant touched.
# The SHADOW_API_PUBLIC_BASE blank is load-bearing: `--var` overrides win over
# `.dev.vars`, and a base leaked from there would flip this run into chained-http.
npx wrangler dev --port 18788 --test-scheduled \
  --var "SHADOW_API_PUBLIC_BASE: " \
  --var "CUSTOMER_REPORT_EXPORT_PATH: " --var "CUSTOMER_REPORT_QUERY_ID: " \
  --var "ADDRESS_REPORT_EXPORT_PATH: " --var "ADDRESS_REPORT_QUERY_ID: " \
  --var "CONTAINER_REPORT_EXPORT_PATH: " --var "CONTAINER_REPORT_QUERY_ID: "
# Terminal B — fire the cron trigger, read the records in terminal A's log:
curl -s http://localhost:18788/__scheduled
# Expect exactly one primary record (msg "data-snapshot-sync", level info): outcome
# "unconfigured", all three tables null, mode "single-invocation", configSource
# "fallback-single-invocation". The fallback `warn` record also appears. Match on `level` and
# `msg`, not on the stream: which stdout/stderr stream each level lands on under `wrangler dev`
# was not checked in this change.
```

Fire a second server for the `failed` key — chained mode with no sync secret
throws (`CUSTOMER_SNAPSHOT_SYNC_SECRET is not set`) before touching anything.
The secret blank is load-bearing: `--var` overrides win over `.dev.vars`, and a
secret leaked from there would run chained instead of throwing — flipping the
expected `failed` into `unconfigured` (any `.dev.vars` value, real or dummy,
breaks the drill either way):

```bash
npx wrangler dev --port 18789 --test-scheduled \
  --var "SHADOW_API_PUBLIC_BASE: http://localhost:18789" \
  --var "CUSTOMER_SNAPSHOT_SYNC_SECRET: " \
  --var "CUSTOMER_REPORT_EXPORT_PATH: " --var "CUSTOMER_REPORT_QUERY_ID: " \
  --var "ADDRESS_REPORT_EXPORT_PATH: " --var "ADDRESS_REPORT_QUERY_ID: " \
  --var "CONTAINER_REPORT_EXPORT_PATH: " --var "CONTAINER_REPORT_QUERY_ID: "
curl -s http://localhost:18789/__scheduled
# Expect exactly one primary record (msg "data-snapshot-sync failed", level error):
# outcome "failed", mode "chained-http", all three tables null (the missing-secret
# check runs before any table, so no `table` field is present).
```

Apply migrations first (`npm run db:migrate:local`), then re-run the §2 queries
with `--local` (empty tables return `last_sync: NULL` — the missed-run
verdict). Two local quirks, both
expected: `cron` is `""` (the `/__scheduled` test trigger sends no cron field;
production sends `0 7 * * *`), and `wrangler dev` parents orphan `workerd`
listeners on its ports — map them by socket inode (`/proc/net/tcp`) and kill
only those PIDs, never a broad `pkill`.

`success` cannot be drilled locally without the Routeware tenant (a real report
fetch needs session credentials) — it is covered by `test/scheduled.test.ts`
and the hermetic `test/snapshotSyncE2E.test.ts` fixture path instead.

## 6. What this runbook does not cover

- Real-time paging: that needs a log-alerting tier this repo deliberately does not buy (project constraint: no paid services). The daily loop bounds detection latency to ~24h.
- Upstream Routeware outages: Worker-side health is visible only through sync errors (§4 triage); there is no upstream probe.
