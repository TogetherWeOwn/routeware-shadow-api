# Auth-throttle fail-open alarm runbook

**Status:** runbook + alert-rule proposal only. No production activation
performed, no new services, no paid tiers, no new secrets, no workflow
changes, no deploy (deploy stays off per owner rule). Every check below uses
observability this repo already has: Workers Logs (`[observability]
enabled = true` in `wrangler.toml`), `wrangler tail`, and the existing
throttle metrics (401/429 volume).
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Signal in
`src/lib/authThrottle.ts` (`logFailOpenOnce`, `recordAuthFailure`); contract
pinned by `test/authThrottleFailOpenAlarm.test.ts` plus the dedup cases in
`test/authThrottle.test.ts`.
**Why:** throttle storage errors fail OPEN to the pre-throttle 401 behavior —
auth itself stays enforced, only the brute-force counting degrades. While the
throttle DO is down, token-guessing is not slowed and `429`s stop entirely.
Without an alarm that degraded state is invisible: every request still gets a
correct 401/404, so nothing looks broken.

## 0. The signal: one structured JSON event per window

Fail-opens emit at most one error-level structured event per window, per
isolate. Its `msg` is fixed, `reason` is a separate allowlisted category, and
`ms` is `null` because no duration is measured (never an IP, token, header, or
body):

```json
{"level":"error","msg":"AUTH THROTTLE FAIL-OPEN","route":"authThrottle.failOpen","ms":null,"reason":"do_error"}
```

| Reason | Meaning |
|---|---|
| `do_error` | The throttle DO fetch threw (DO unreachable / storage error). |
| `do_non_ok status=N` | The DO answered non-OK (N is the HTTP status only). |
| `do_malformed` | The DO answered OK but the verdict JSON was malformed. |

A down throttle DO would otherwise emit one event per failed request (up to
brute-force volume); the event is deduped per isolate to at most one per
`AUTH_THROTTLE_WINDOW_MS` (60 seconds), then fires again after the window
edge. Absence of the event is the healthy state — it only ever appears during
an active throttle-storage failure.

## 1. Reading the event (log query)

Dashboard: Workers & Pages → this Worker → **Logs**, filter text
`AUTH THROTTLE FAIL-OPEN`, time range covering the suspect window. Or from
any machine with this repo's Wrangler and a Cloudflare API token (the same
access deploys already need — nothing new):

```bash
npx wrangler tail --format json 2>&1 | grep -A 3 'AUTH THROTTLE FAIL-OPEN'
```

(`console.error` receives the event object. `--format json` pretty-prints each
tail event across several lines and nests the object under the log's
`message` array, so `msg` is not a top-level field. The grep matches the
`"msg"` line; `-A 3` shows the `reason` that follows it.) At most one event
per 60s window per isolate while the outage lasts: events spaced about 60s
apart mean the DO is still failing, not that separate incidents occurred.

## 2. Alert-rule proposal (operator-applied; NOT activated)

Until a log-based alerting tier exists, the alarm is this loop, run at least
daily (and after every deploy touching `src/lib/authThrottle.ts`,
`src/app.ts`, or the `AUTH_SESSION` binding) by whoever holds the deploy
token or any existing scheduled runner:

1. Pull the last 24h of `AUTH THROTTLE FAIL-OPEN` events (§1).
2. Zero events → healthy, done.
3. Any event → triage per §3, record the disposition where the team looks
   (issue comment or ops log): date, reason category, cause, action taken.

If the operator has log alerting (outside this repo — deliberately not bought
here), the equivalent rule is: `count(error-level events where message
contains "AUTH THROTTLE FAIL-OPEN") > 0 over 5 minutes` → warn/major with this
runbook's link, auto-resolve after 30 minutes quiet. Detection latency of the
manual loop is bounded at ~24h; the automated rule bounds it at ~5 minutes.

## 3. Triage when it fires

1. Read the reason category (§0 table) — it names the failure class.
2. Confirm auth is still enforced: gated routes must still return 401s for
   bad tokens (fail-open only skips counting, never the bearer check). A 500
   or an unauthenticated 200 alongside the line is a different, worse bug —
   treat as an auth incident, not a throttle incident.
3. Expect `429` volume to drop to zero during the outage (nothing is counted,
   so nothing trips the block). `429`s resuming after the lines stop is a
   recovery signal, not a new attack.
4. Check throttle-DO health: dashboard → Durable Objects → `AuthSession`
   error rate; recent deploys around the first line's timestamp (a bad deploy
   touching the gate/DO wiring is the most likely cause — rollback per the
   deploy runbook); Cloudflare status for platform-wide DO issues.
5. Remediate per cause (rollback, config fix, or wait out the platform), then
   verify the clear: no new `AUTH THROTTLE FAIL-OPEN` event for > 60 seconds
   plus 401/429 behavior back to normal.
6. Never brute-force-probe production to "test" recovery — the contract is
   proven by `test/authThrottleFailOpenAlarm.test.ts`, not by live guessing.

## 4. Local drill (no deploy, no token, no tenant)

Proves the alarm contract against the real `recordAuthFailure` with a dead
DO stub. Needs `npm ci --include=dev` first (the worktree may not have
devDependencies):

```bash
NODE_ENV=development npx vitest run test/authThrottleFailOpenAlarm.test.ts
# Expect green: a 5-failure burst inside one window emits exactly one
# `AUTH THROTTLE FAIL-OPEN` event with `reason: "do_error"` (all verdicts
# open), and the next failure past the window edge emits exactly one more.
```

## 5. What this runbook does not cover

- Real-time paging: that needs a log-alerting tier this repo deliberately
  does not buy (project constraint: no paid services). The §2 loop bounds
  detection latency to ~24h; §2's automated rule is a proposal only.
- Production activation: no alert rule, monitor, or dashboard was created or
  enabled by this runbook — applying §2 is an explicit operator step.
