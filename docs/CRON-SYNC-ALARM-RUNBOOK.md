# Cron sync missed/failed alarm runbook

**Status:** runbook only. No new services, no paid tiers, no new secrets, no workflow
changes. Every check below uses observability this repo already has: Workers Logs
(`[observability] enabled = true` in `wrangler.toml`), `wrangler tail`, and
`wrangler d1 execute`.
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Cron `0 7 * * *` UTC
(`[triggers]` in `wrangler.toml`), handler `src/scheduled.ts`, tests `test/scheduled.test.ts`.
**Why:** a silent cron failure used to look identical to "no report paths configured"
(both were free-text log lines). Every run now emits exactly one structured line whose
`outcome` is `success`, `unconfigured`, or `failed` — the alarm keys on that field,
and on the *absence* of any line.

## 0. The signal: one `data-snapshot-sync` JSON line per run

Each cron firing logs a single line to stdout (success / unconfigured) or stderr
(failed), prefixed `data-snapshot-sync ` so it stays greppable while the remainder
parses as JSON. Shape (counts below are illustrative, never real row data — only
counts, durations, and config names ever leave the Worker):

```text
data-snapshot-sync {"event":"data-snapshot-sync","outcome":"success","mode":"chained-http","configSource":"SHADOW_API_PUBLIC_BASE","d1LimitRisk":false,"tables":{"customer":{"upserted":203411,"rowCount":203411,"deleted":12},"address":{"upserted":198002,"rowCount":198002},"container":null},"summary":"customer: 203411 upserted, 203411 rows, 12 deleted; address: 198002 upserted, 198002 rows; container: skipped (no report path configured)","durationMs":41203,"cron":"0 7 * * *","scheduledTime":"2026-09-27T07:00:00.000Z"}
```

| `outcome` | Meaning | Alarm action |
|---|---|---|
| `success` | At least one table ran. Per-table detail in `tables`; skipped tables are explicit `null` with a `skipped (no report path configured)` note in `summary`, never silent omission. | None, unless a table you expect is `null` (config drift — see §3). |
| `unconfigured` | No report paths set at all — a config state, not a pass. | Configure sources (§3), do not celebrate. |
| `failed` | The sync threw before any table result was recorded. `error` carries the step tag (e.g. `[customer snapshot] …`, `[chained address] …`) with the message only — never row data. | Triage per §4. |
| *(no line)* | The platform never invoked `scheduled()`, or the invocation died before logging. Possible causes: cron trigger disabled/misconfigured, deploy in progress at 07:00 UTC, Worker-level crash. | Treat as **failed**. Verify with ground truth (§2), then check trigger state. |

Also watch `d1LimitRisk: true`: the whole job ran in one invocation because
`SHADOW_API_PUBLIC_BASE` is unset — or set to something unusable
(`configSource: "fallback-single-invocation"` either way), so
D1's per-invocation operation budget applies to all three tables as one pool. At ~609k
rows a large export can die partway through. The fix is configuration, not code: set
`SHADOW_API_PUBLIC_BASE` to the Worker's public origin (see `CUSTOMER_SNAPSHOT.md`
§ "D1: Too many API requests"). The handler only accepts a bare `http(s)` origin —
no path, query, fragment, or userinfo (`resolveChainedBase` in `src/scheduled.ts`,
pinned by `test/scheduled.test.ts`): a path-suffixed or malformed value falls back
to single-invocation silently, so a line with `d1LimitRisk: true` despite the var
being "set" means the value failed that validation — re-check it character by
character, don't just check presence.

## 1. Reading the last run's line

Dashboard: Workers & Pages → this Worker → **Logs**, filter text `data-snapshot-sync`,
time range covering 07:00 UTC. Or from any machine with this repo's Wrangler and a
Cloudflare API token (the same access deploys already need — nothing new):

```bash
npx wrangler tail --format json 2>&1 | grep 'data-snapshot-sync'
```

Parse the JSON after the prefix and read `outcome`, `tables`, `durationMs`, and
`error`. One line per run: if you see two lines for one `scheduledTime`, the second
is a platform retry — read the latest.

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

## 4. The daily alarm loop (no paid services: a scheduled human-or-runner check)

Until a log-based alerting tier exists, the alarm is this loop, run once daily after
07:30 UTC by whoever holds the deploy token (or any existing scheduled runner):

1. Pull the last `data-snapshot-sync` line (§1).
2. `outcome: success` with all expected tables non-null → done.
3. `outcome: unconfigured` or an expected table `null` → config drift: fix vars (§3), re-run `POST /api/v1/data-snapshot/sync` manually to verify, confirm tomorrow's line.
4. `outcome: failed` or **no line** → confirm ground truth (§2). Then triage by `error` step tag:
   - `[customer|address|container snapshot] D1_*` — D1 limit or lock. If `d1LimitRisk: true`, set `SHADOW_API_PUBLIC_BASE` and re-run; otherwise split per-table syncs (`CUSTOMER_SNAPSHOT.md` § "D1: Too many API requests").
   - `[chained <table>] POST … → 4xx/5xx` — the chained subrequest was rejected (usually a rotated `CUSTOMER_SNAPSHOT_SYNC_SECRET` that missed the Worker, or an unconfigured table route returning 503). Re-run the named table route manually with the current secret.
   - Upstream HTML-200 failures (session lost, login page) surface inside the step error per `docs/CONVENTIONS.md` fact 1 — verify Routeware credentials, not Worker config.
   - No line at all with fresh `synced_at` — a duplicate/overlapping invocation; note it and watch the next run. No line with stale `synced_at` — the cron did not fire: check the trigger (`wrangler.toml` `[triggers]`), recent deploys around 07:00 UTC, and the Worker's cron history in the dashboard.
5. Record the disposition where the team looks (issue comment or ops log): date, outcome, tables, action taken. Silence is how the next miss goes unnoticed.

## 5. Local missed-run drill (no deploy, no token, no tenant)

Reproduces the `unconfigured` and `failed` alarm keys against the real handler on
local dev. Needs `npm ci --include=dev` first (the worktree may not have
devDependencies), plus a `.dev.vars` with `LOGIN_USERNAME` / `LOGIN_PASSWORD` and
one client token — dummy placeholders are fine, the drill never authenticates
upstream (gitignored, never commit).

```bash
# Terminal A — blanked report vars: deterministic `unconfigured`, no tenant touched.
npx wrangler dev --port 18788 --test-scheduled \
  --var "CUSTOMER_REPORT_EXPORT_PATH: " --var "CUSTOMER_REPORT_QUERY_ID: " \
  --var "ADDRESS_REPORT_EXPORT_PATH: " --var "ADDRESS_REPORT_QUERY_ID: " \
  --var "CONTAINER_REPORT_EXPORT_PATH: " --var "CONTAINER_REPORT_QUERY_ID: "
# Terminal B — fire the cron trigger, read the greppable line in terminal A's log:
curl -s http://localhost:18788/__scheduled
# Expect exactly one line: outcome "unconfigured", all three tables null,
# mode "single-invocation", configSource "fallback-single-invocation".
```

Fire a second server for the `failed` key — chained mode with no sync secret
throws (`CUSTOMER_SNAPSHOT_SYNC_SECRET is not set`) before touching anything:

```bash
npx wrangler dev --port 18789 --test-scheduled \
  --var "SHADOW_API_PUBLIC_BASE: http://localhost:18789" \
  --var "CUSTOMER_REPORT_EXPORT_PATH: " --var "CUSTOMER_REPORT_QUERY_ID: " \
  --var "ADDRESS_REPORT_EXPORT_PATH: " --var "ADDRESS_REPORT_QUERY_ID: " \
  --var "CONTAINER_REPORT_EXPORT_PATH: " --var "CONTAINER_REPORT_QUERY_ID: "
curl -s http://localhost:18789/__scheduled
# Expect exactly one line on stderr: outcome "failed", mode "chained-http",
# error "CUSTOMER_SNAPSHOT_SYNC_SECRET is not set".
```

Apply migrations first (`npm run db:migrate:local`), then re-run the §2 queries
with `--local` (empty tables return `last_sync: NULL, rows: 0` — the missed-run
verdict). Two local quirks, both
expected: `cron` is `""` (the `/__scheduled` test trigger sends no cron field;
production sends `0 7 * * *`), and `wrangler dev` parents orphan `workerd`
listeners on its ports — map them by socket inode (`/proc/net/tcp`) and kill
only those PIDs, never a broad `pkill`.

`success` cannot be drilled locally without the Routeware tenant (a real report
fetch needs session credentials) — it is covered by `test/scheduled.test.ts`
and the hermetic `test/snapshotSyncE2E.test.ts` fixture path instead.

## 6. What this runbook does not cover

- Real-time paging: that needs a log-alerting tier this repo deliberately does not buy (card constraint: no paid services). The daily loop bounds detection latency to ~24h.
- Upstream Routeware outages: Worker-side health is visible only through sync errors (§4 triage); there is no upstream probe.
