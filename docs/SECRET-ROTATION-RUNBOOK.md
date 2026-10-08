# Secret-rotation runbook — `SHADOW_API_TOKEN` / `CUSTOMER_SNAPSHOT_SYNC_SECRET`

**Status:** documentation only; local dummy-secret overlap and rollback drilled on 2026-10-08 (see §5). No code, schema, or tracked config changes. No new services, real secrets, or paid tiers. **This doc grants no permission to rotate real secrets — every production step remains operator-gated.**
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Secrets `SHADOW_API_TOKEN` (general) and `CUSTOMER_SNAPSHOT_SYNC_SECRET` (privileged).
**Why:** the dual-secret gate (`src/lib/auth.ts`, `src/routes/shared.ts`, pinned by `test/dualSecretMatrix.test.ts`) is documented in `docs/PROBLEMS.md#authentication`, but there was no operator checklist for rotating either secret without dropping legitimate traffic (round-3 gap, [TOG-8601](https://workforce.infextion.net/TOG/issues/TOG-8601) gap list).

## 0. The honest mechanism (read this first)

Each secret name holds **exactly one value** — `bearerMatches` (`src/lib/auth.ts`) compares the presented bearer against a single configured string. There is no `_PREVIOUS`/`_NEXT` slot, so "set new, verify, retire old" **cannot** mean two values live in one slot. The overlap lives in two places this repo already provides:

1. **Client-side dual-hold.** New values are distributed to every consumer *before* the Worker cutover. Consumers retain both values and make at most one alternate-token attempt **only on a verified Worker auth rejection**, not on an arbitrary error. Production consumers should prefer old before the agreed cutover and new afterward. A `401`-only fallback is insufficient under shared-NAT concurrency: 20 rejected first attempts can race ahead of their valid fallbacks, making the twentieth response the outer gate's `429`. Consumer readiness must cover that specific pre-handler rejection too (see §3); the serial dummy helper in §2a deliberately does not. Holding a matching value alone is not a hitless guarantee. Neither production availability nor concurrent-consumer behavior was established by this local drill, and a local dev-server restart interrupts its listener.
2. **Cross-secret outer gate.** General `/api/v1/*` routes accept *either* secret (`isApiAuthorized`, `src/lib/auth.ts`). So while `SHADOW_API_TOKEN` rotates, any general-route consumer that also holds the sync secret keeps working even mid-cutover — and the internal chained snapshot sync (which authenticates with the sync secret, `src/lib/snapshot/orchestration.ts`) is unaffected by an API-token rotation entirely. A separately configured `SHADOW_API_READ_TOKEN` can also authorize GET requests at the outer gate; it cannot pass privileged inner checks and is outside this two-secret drill.

What is **not** hitless without client cooperation: swapping `CUSTOMER_SNAPSHOT_SYNC_SECRET` while a privileged-route consumer only holds the old value — its next call 401s at the outer gate unless that value independently matches another active outer token. An API or read-only token can clear the outer gate but cannot clear the privileged inner check. That is why distribution (§3 step 1) precedes every cutover, and why §2 rehearses the exact probes that prove both values' states.

Related history: `docs/SECURITY-REMEDIATION.md` step 1 (rotate-first-then-purge) was declined 2026-08-07 under single-owner premises and is worth re-taking under new ownership — this runbook is the *how* for that decision, not the decision itself.

## 1. Local rehearsal prerequisites

- Repo root, dependencies installed (`NODE_ENV=development npm ci --include=dev` if `wrangler`/`vitest` are missing).
- Use a disposable checkout with no existing `.dev.vars` or `.dev.vars.test`; do not overwrite another developer's credential file. Environment-specific files take precedence (see [Cloudflare local secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/#local-development-with-secrets)), so verify which file is active before drilling.
- A scratch `.dev.vars` beside `wrangler.toml` with **dummy** values (gitignored, never commit — `npm run dev` runs `check:devvars` first and refuses without a client token):
  ```
  LOGIN_USERNAME=rehearsal-user
  LOGIN_PASSWORD=rehearsal-password-not-real
  SHADOW_API_TOKEN=rehearsal-api-old
  CUSTOMER_SNAPSHOT_SYNC_SECRET=rehearsal-sync-old
  ```
  (`SESSION_TTL_SECONDS`, `TARGET_ORIGIN`, `LOGIN_URL`, `AUTH_MODE` already have defaults in `wrangler.toml` `[vars]`; only the four keys above are needed.)
- Two terminals: **A** runs the Worker, **B** runs commands. No D1 migration is needed: every probe below answers at the auth layer without touching D1, R2, or upstream (same hermetic routes `test/dualSecretMatrix.test.ts:127-132` uses).

Terminal A (blocking — leave it running; port `8791` avoids clashing with another checkout's server on the default `8787`, see `docs/BACKFILL-RUNBOOK.md` §1):

```bash
npx wrangler dev --port 8791
```

Terminal B, for the local rehearsal (§§1–2a) only:

```bash
BASE=http://127.0.0.1:8791
API_OLD=rehearsal-api-old
SYNC_OLD=rehearsal-sync-old
```

Restart `wrangler dev` after every `.dev.vars` edit — dev does not hot-reload it (`docs/BACKFILL-RUNBOOK.md` §7). On shutdown, `wrangler dev` may orphan `workerd` listeners on the port: map them by socket inode (`/proc/net/tcp`) and kill only those PIDs, never a broad `pkill`.

## 2. Baseline probes (proves the verification commands before anything changes)

General-route probe — `GET /api/v1/shadow/health` answers 200 directly with no D1/R2/upstream (`src/routes/shadow.ts:25-29`):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $API_OLD" "$BASE/api/v1/shadow/health"
# expect 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $SYNC_OLD" "$BASE/api/v1/shadow/health"
# expect 200 (outer gate accepts either secret)
```

Privileged-route probe — `GET /api/v1/data/customer` with the id omitted 400s on the missing-id guard **after** the inner check, so the status and problem detail prove auth state without D1/R2/upstream access. The outer auth gate may still update local throttle Durable Object state:

```bash
curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $SYNC_OLD" "$BASE/api/v1/data/customer"
# expect HTTP 400 {"type":".../bad-request",...,"detail":"Query `id` or `customerId` (customer_id) is required. ..."}
curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $API_OLD" "$BASE/api/v1/data/customer"
# expect HTTP 401 with the INNER detail ("Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>...")
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $SYNC_OLD" "$BASE/api/v1/data/customer"
# expect 400: valid outer auth clears the throttle, despite the missing-id response
curl -sS -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer wrong-token" "$BASE/api/v1/shadow/health"
# expect HTTP 401 with the OUTER detail (mentions SHADOW_API_TOKEN)
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $API_OLD" "$BASE/api/v1/shadow/health"
# expect 200: clear the counter after the deliberate outer denial
curl -sS -w '\nHTTP %{http_code}\n' "$BASE/api/v1/health"
# expect HTTP 200, no token (control: the server is up)
# Curl exit 0 alone does not prove HTTP 200/400/401; read the printed status.
```

**Throttle caution:** only rejected **outer-gate** checks count per client IP — 20 failures in 60 s returns `429` for 60 s (`docs/PROBLEMS.md#rate-limited`, `src/lib/authThrottle.ts`). A request with a valid outer token passes that gate and attempts to **reset** the counter before the handler, even if its handler then returns the expected missing-id `400` or the privileged inner gate returns `401`. Persistence/reset is best-effort on Durable Object errors; a valid outer token still passes a blocked counter. Issue each expected-401 **once**, then follow with a valid-token request. Never loop a stale-token probe; shared-NAT concurrency can exhaust the IP's budget before valid fallbacks arrive (§3).

### 2a. Independent local overlap and rollback drill (dummy values only)

**Do not execute §3's remote commands for this rehearsal.** Keep `BASE=http://127.0.0.1:8791`, edit only the scratch `.dev.vars` created in §1, and restart Terminal A after each edit. Wait for the public §2 health control to return `200` before each phase. Record UTC start/ready/verification/cleanup times. A restart interrupts the local listener; do not measure that as production secret-propagation time or claim uninterrupted traffic.

Terminal B uses these additional **dummy** values and a read-only client-fallback probe:

```bash
API_NEW=rehearsal-api-new
SYNC_NEW=rehearsal-sync-new

dual_probe() {
  local path="$1" new="$2" old="$3" expected="$4" first status
  first=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $new" "$BASE$path") || return
  status="$first"
  if [ "$first" = 401 ]; then
    status=$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $old" "$BASE$path") || return
  fi
  printf 'first=%s final=%s expected=%s\n' "$first" "$status" "$expected"
  test "$status" = "$expected"
}
```

This helper is only for the **serial dummy local drill's** two GET probes. It does not retry transport errors, `429`, or server errors; it is not a production consumer implementation and does not prove shared-NAT concurrency safety. A fallback's valid old-token request passes the outer gate and attempts to clear its failed new-token check. Stop on an unexpected final status; do not loop retries.

| Phase | Terminal A: `.dev.vars` state (restart after edits) | Terminal B: auth/consumer evidence |
|---|---|---|
| Baseline and API distribution | API `rehearsal-api-old`; sync `rehearsal-sync-old` | Run §2; then `dual_probe /api/v1/shadow/health "$API_NEW" "$API_OLD" 200` → first `401`, final `200`. This simulates distributing new while retaining old. |
| API cutover | Change **only** API to `rehearsal-api-new` | Same dual probe → direct `200`. API-new general `200`, unchanged sync general `200` and privileged `400`; API-old general **one** outer `401`, then API-new `200`. API-new privileged → inner `401`, then valid sync `400`. |
| API rollback | Restore **only** API to `rehearsal-api-old` | Same dual probe → `401 → 200`; API-old general `200`, sync privileged `400`. Retaining old in the client permits rollback. |
| API restored and sync distribution | API `rehearsal-api-new`; sync still `rehearsal-sync-old` | API-new general `200`; `dual_probe /api/v1/data/customer "$SYNC_NEW" "$SYNC_OLD" 400` → `401 → 400`. |
| Sync cutover | Change **only** sync to `rehearsal-sync-new` | Same privileged dual probe → direct `400`. Sync-new privileged `400`, general `200`; sync-old privileged **one** `401`, then sync-new `400`. The retired sync bearer is rejected at the **outer** gate because neither active secret matches it. API-new general stays `200`; API-new privileged stays inner `401`, then sync-new `400`. |
| Sync rollback | Restore **only** sync to `rehearsal-sync-old`; API stays new | Privileged dual probe → `401 → 400`; sync-old privileged `400`, API-new general `200`. |
| Sync restored | API `rehearsal-api-new`; sync `rehearsal-sync-new` | Sync-new privileged `400`; API-new general `200`. |

For each direct probe use §2's commands with the named variable substituted, printing status and the inner/outer detail where applicable. The privileged `400` is only an **auth success sentinel**, not a successful data read. None of these probes supplies an id, runs a migration, or triggers a scheduled sync. The auth gate can update local throttle Durable Object state; "no D1/R2/upstream" is not "no local storage writes."

After final verification, stop Terminal A, confirm port `8791` is no longer listening (§1 shutdown caution), and remove **only this drill's dummy file**. Never remove an existing developer credential file. With scratch credentials absent, run:

```bash
npx vitest run test/dualSecretMatrix.test.ts test/snapshotAuth.test.ts
```

A local drill passes on the independent auth/cross-secret/fallback/rollback checks above plus cleanup. It does **not** satisfy §6's real-consumer attestation or next-cron requirement; those remain part of a separately authorized real rotation.

## 3. Production rotation sequence (operator-gated — do not run from this doc alone)

**Operator target setup (required before any cutover):** use a separate approved shell, not rehearsal Terminal B. Set `BASE` to the approved deployed **HTTPS Worker origin**, never `127.0.0.1`, `localhost`, the Routeware upstream, or a dummy/rehearsal endpoint. Confirm that this origin maps to the same Cloudflare account, Worker and environment targeted by each `secret put` command. The commands below select the top-level Worker; for a named environment, append `--env <approved-environment>` consistently. Disable shell tracing **before** loading real old/new API and sync values from approved secret stores into non-exported `API_OLD`, `API_NEW`, `SYNC_OLD`, `SYNC_NEW` shell variables. Do not reuse rehearsal values or put credentials in command history, files or logs. Confirm the public health control against this deployed `BASE` before continuing. If the target/environment or real-consumer distribution cannot be verified, stop; local probe results do not verify a remote cutover.

**Real-token probe transport:** §2's `curl -H "Authorization: Bearer ..."` commands and §2a's helper are **dummy-only**: expanding a real value into a process argument exposes it to argv inspection. For every authenticated production probe below, use this GET-only helper instead, with tracing still disabled. It sends the header through stdin using [curl's documented `--header @-`](https://curl.se/docs/manpage.html#-H), not argv or a temporary file. [`-q` is the first curl option](https://curl.se/docs/manpage.html#-q) so a default curl configuration cannot enable tracing or redirects. Do not add verbose/trace output or redirect-following flags; inspect the printed HTTP status and problem detail rather than curl's exit code alone.

```bash
set +x  # before loading secrets or invoking the helper; never use shell tracing
rotation_get() {
  local token="$1" path="$2"
  builtin printf 'Authorization: Bearer %s\n' "$token" |
    curl -q -sS --header @- --write-out '\nHTTP %{http_code}\n' "$BASE$path"
}
# After separately approved target/secret setup, examples of the new-value probes:
rotation_get "$API_NEW" /api/v1/shadow/health  # expect 200
rotation_get "$SYNC_NEW" /api/v1/data/customer  # expect 400 with missing-id detail
```

**Distinct-slot precondition:** confirm non-empty API and sync bindings have distinct values, and that neither the old nor proposed new value aliases another active API/sync/read-only binding. A blank API binding can fall back to the sync value (`getShadowApiToken`); a read-only alias can keep an old sync bearer valid for general GET even after privileged access is denied. If slots alias, stop and obtain a separately authorized alias-aware revocation plan; this two-secret checklist does not authorize changing the read-only token. Record the comparison outcome, never the values. Retirement must prove the old bearer fails the **general outer gate**, not just a privileged inner check.

**Consumer fallback precondition:** attest readiness for a bounded alternate-token attempt on the Worker's canonical `401` auth problem or its **outer auth-throttle** `429` (`application/problem+json`, documented `#rate-limited` type and failed-authentication detail, matching request instance; `src/app.ts`). That `429` is emitted before the handler; a valid alternate token passes despite the IP's blocked counter. Do not retry a generic/handler `429`, upstream error, transport failure or server error, and never loop after a failed alternate attempt. For mutating consumer operations, the rejection must be positively identified as pre-handler before any retry; if that cannot be established, stop rather than risk duplicate execution. The dummy helper is not a production client implementation, and this drill did not verify concurrent consumers. If consumer readiness cannot be attested, stop before cutover.

Agree the rollback window before rotation. Both operator **and consumers** retain the old value throughout that window and through acceptance; an operator copy alone cannot preserve client fallback after rollback.

Rotate the two secrets **independently**, one at a time; each is a full distribute → cutover → verify → retire cycle. Avoid the daily cron window (07:00 UTC ± 30 min): a chained run captures `CUSTOMER_SNAPSHOT_SYNC_SECRET` once for its outgoing requests (`src/lib/snapshot/orchestration.ts`). A cutover while it is in flight can make later receiving invocations reject that retained bearer. This is not per-leg credential rereading, and local restart timings do not verify remote propagation.

### 3a. `SHADOW_API_TOKEN`

1. **Distribute first.** Generate the new token (32+ random bytes, e.g. `openssl rand -hex 32` — never reuse a value that lived in git history). Hand it to every general-route consumer; each stores old+new and meets §3's bounded auth/throttle-fallback precondition, preferring old before the agreed cutover and new afterward. Consumers that also hold the distinct sync secret are already covered by the outer gate even before they migrate.
2. **Cutover.** Operator only:
   ```bash
   npx wrangler secret put SHADOW_API_TOKEN
   # paste the NEW value when prompted; never put secrets in wrangler.toml [vars]
   ```
3. **Verify (new).** Using `rotation_get`, check the §2 general baseline → 200 with new, 200 with sync secret (unchanged).
4. **Verify (old retired).** Exactly one general probe with the old token → 401 outer detail; follow immediately with a new-token 200 to reset the throttle counter. The chained snapshot sync is untouched (it never presents the API token) — confirm tomorrow's `data-snapshot-sync` log line per `docs/CRON-SYNC-ALARM-RUNBOOK.md` §1.
5. **Retire.** Operator and consumers retain the old token until step 4 passes and the agreed rollback window ends. Only then delete the old copies from all stores. Before retirement, rollback is re-putting the retained old value (step 2 with the old value); the consumers' retained fallback then matches again.

### 3b. `CUSTOMER_SNAPSHOT_SYNC_SECRET`

Same cycle, wider blast radius: this secret gates the privileged snapshot/data routes **and** the chained cron subrequests, so every privileged consumer (sync clients, `/api/v1/data/*` readers/writers, import pipelines) must hold new+old before cutover.

1. **Distribute first** to every privileged consumer, with the same preference and bounded auth/throttle fallback as §3a step 1.
2. **Cutover.** Operator only: `npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET` with the new value.
3. **Verify (new).** With `rotation_get`, privileged probe with new → 400 missing-id (inner check cleared); general probe with new → 200.
4. **Verify (old retired).** With `rotation_get`, issue exactly one **general** probe with old → 401 **outer** detail, immediately followed by a new-secret general 200. Then one privileged probe with old → 401 **outer** detail, immediately followed by new-secret missing-id 400. A general 200 or privileged **inner** 401 means another active slot may still authorize old: stop; this is not retirement. Privileged consumers still on old-only fail here — finish their migration or use the retained-value rollback if a consumer cannot migrate promptly.
5. **Cron watch, then retire.** Consumers keep **both** values and the operator retains old offline until the next 07:00 UTC cron logs `success` (not `failed` with a `[chained …] 401` step tag — that tag means a subrequest missed the new secret, `docs/CRON-SYNC-ALARM-RUNBOOK.md` §4). Before acceptance, rollback is re-putting old; consumers must still hold it for their fallback to work. Delete all old copies only after the new-value/retired-old probes and next-cron acceptance pass and the agreed rollback window ends.

Update local `.dev.vars` to match after either rotation (gitignored, never commit).

## 4. Failure table

| Symptom | Cause | Fix |
|---|---|---|
| General probe 401s with a token you just distributed | `.dev.vars` edited but dev server not restarted (rehearsal), or `secret put` targeted the wrong environment (production) | Restart `wrangler dev` (§1); check the Worker environment in the dashboard |
| Privileged probe 401s with a valid API token | Expected — the inner check requires the sync secret specifically (§2). Not a rotation failure | Use the sync secret for privileged routes |
| `429 rate-limited` during verification | Expected-401 probes or concurrent shared-NAT attempts burned the 20/min/IP budget (§2 caution) | A valid-token request passes and attempts the reset; reset persistence is best-effort. Do not loop stale probes; otherwise wait 60 s and probe once |
| Mixed old/new 401s right after cutover | A consumer was missed in step-1 distribution | Finish that consumer's migration; rollback (re-put old) only if a privileged consumer cannot migrate promptly |
| `[chained <table>] POST … → 401` in the next cron line | Chained subrequest presented a stale sync secret (cutover landed mid-sync or env propagation lagged) | Re-run the named table route manually with the current secret; confirm the following cron (§3b step 5) |
| `503 misconfigured` on a `.../sync` route | Sync secret blanked rather than replaced | Re-put a non-empty value; blank is unconfigured, not empty-token (`test/dualSecretMatrix.test.ts:96-101`) |
| Auth tests 401 after a rehearsal (`Using secrets defined in .dev.vars` in the output) | The scratch `.dev.vars` overrides `[env.test.vars]` in the workers test pool, so `test-api-token`/`test-sync-secret` no longer match | In this disposable drill, remove only the owned dummy file before `npx vitest run` (§2a). Never delete an existing developer credential file; use a clean disposable checkout instead |

## 5. Rehearsal evidence

2026-09-28, local `wrangler dev` only (never production): dummy `.dev.vars` (§1) → §2 baseline green (200/200/400/inner-401/outer-401/public-200) → edited `.dev.vars` to `-new` dummy values, restarted dev → new-value probes green, old-value probes single-401-then-reset → `npx vitest run test/dualSecretMatrix.test.ts test/snapshotAuth.test.ts` green (no behavior change). Full drill log attached to [TOG-8901](https://workforce.infextion.net/TOG/issues/TOG-8901). No real secret was created, changed, or transmitted at any point.

2026-10-08, local-only independent drill on source `600ecb42ad4aa50c7ed33144cb75da2cc2602c01`: API old → new → rollback → restored, then sync old → new → rollback → restored. **28 HTTP status/detail assertions and 6 dual-hold client assertions passed** across seven Worker starts. Auth PASS at 10.902 s; cleanup complete at 11.064 s (05:40:05.196–05:40:16.260 UTC), dummy file removed, port free. The §2a helper reproduces the client-fallback probe; the actual drill used a bounded Python HTTP wrapper. The two §2a auth test files then passed **49/49** tests in 3.14 s. [Full timed report and gap dispositions](TOG-9226-secret-rotation-drill-report.md); timestamped assertions, wrapper and test output are attached to [TOG-9226](https://workforce.infextion.net/TOG/issues/TOG-9226). Neither production availability nor next-day cron nor real-consumer distribution was verified. The tested source is stated explicitly; do not treat these timings as verification of a later PR head or production deployment.

## 6. Done criteria

Rotation of one secret is accepted when: §3's distinct-slot and consumer auth/throttle-fallback preconditions are attested; every consumer held new+old before cutover; new-value probes using the stdin-header helper return §2 baselines; the old bearer fails general authorization with exactly one **outer** 401 and, for a sync rotation, also fails the privileged probe with an outer 401 (each followed by a valid request); the next cron after a sync-secret rotation logs `success`; and both the operator's offline copy and consumers' fallback copies of the old value survive until acceptance and the agreed rollback window end, then are destroyed at retirement. An inner-only denial does not prove an aliased bearer is retired, and the serial dummy drill does not attest production consumer concurrency.
