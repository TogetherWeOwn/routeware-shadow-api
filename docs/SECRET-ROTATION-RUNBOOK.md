# Secret-rotation runbook — `SHADOW_API_TOKEN` / `CUSTOMER_SNAPSHOT_SYNC_SECRET`

**Status:** runbook only. No code, schema, or config changes. No new services, secrets, or paid tiers. **No rotation is executed by this doc — every production step is operator-gated.**
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Secrets `SHADOW_API_TOKEN` (general) and `CUSTOMER_SNAPSHOT_SYNC_SECRET` (privileged).
**Why:** the dual-secret gate (`src/lib/auth.ts`, `src/routes/shared.ts`, pinned by `test/dualSecretMatrix.test.ts`) is documented in `docs/PROBLEMS.md#authentication`, but there was no operator checklist for rotating either secret without dropping legitimate traffic (round-3 gap, [TOG-8601](/TOG/issues/TOG-8601) gap list).

## 0. The honest mechanism (read this first)

Each secret name holds **exactly one value** — `bearerMatches` (`src/lib/auth.ts:49-56`) compares the presented bearer against a single configured string. There is no `_PREVIOUS`/`_NEXT` slot, so "set new, verify, retire old" **cannot** mean two values live in one slot. The overlap lives in two places this repo already provides:

1. **Client-side dual-hold.** New values are distributed to every consumer *before* the Worker cutover. During the window each consumer tries the new value first and falls back to the old one. The cutover is then hitless: whichever value the Worker currently holds, every migrated consumer presents a matching one.
2. **Cross-secret outer gate.** General `/api/v1/*` routes accept *either* secret (`isApiAuthorized`, `src/lib/auth.ts:74-79`). So while `SHADOW_API_TOKEN` rotates, any general-route consumer that also holds the sync secret keeps working even mid-cutover — and the internal chained snapshot sync (which authenticates with the sync secret, `src/lib/snapshot/orchestration.ts:167-175`) is unaffected by an API-token rotation entirely.

What is **not** hitless without client cooperation: swapping `CUSTOMER_SNAPSHOT_SYNC_SECRET` while a privileged-route consumer only holds the old value — its next call 401s at the inner check. That is why distribution (§3 step 1) precedes every cutover, and why §2 rehearses the exact probes that prove both values' states.

Related history: `docs/SECURITY-REMEDIATION.md` step 1 (rotate-first-then-purge) was declined 2026-08-07 under single-owner premises and is worth re-taking under new ownership — this runbook is the *how* for that decision, not the decision itself.

## 1. Local rehearsal prerequisites

- Repo root, dependencies installed (`npm ci --include=dev` if `wrangler`/`vitest` are missing).
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

Terminal B, for the rest of the doc:

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

Privileged-route probe — `GET /api/v1/data/customer` with the id omitted 400s on the missing-id guard **after** the inner check, so the status alone proves auth state with zero side effects:

```bash
curl -s -H "Authorization: Bearer $SYNC_OLD" "$BASE/api/v1/data/customer"; echo
# expect 400 {"type":".../bad-request",...,"detail":"Query `id` or `customerId` (customer_id) is required. ..."}
curl -s -H "Authorization: Bearer $API_OLD" "$BASE/api/v1/data/customer"; echo
# expect 401 with the INNER detail ("Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>...")
curl -s -H "Authorization: Bearer wrong-token" "$BASE/api/v1/shadow/health"; echo
# expect 401 with the OUTER detail (mentions SHADOW_API_TOKEN)
curl -s "$BASE/api/v1/health"; echo
# expect 200, no token (control: the server is up)
```

**Throttle caution (applies to every 401 below):** failed checks count per client IP — 20 failures in 60 s returns `429` for 60 s (`docs/PROBLEMS.md#rate-limited`). A request with a valid token always passes and **resets** the counter. So: issue each expected-401 **once**, then follow with a valid-token request. Never loop a stale-token probe; behind shared-NAT egress one client's bad token burns the whole IP's budget (a valid request from any client on that IP still passes and clears it).

## 3. Production rotation sequence (operator-gated — do not run from this doc alone)

Rotate the two secrets **independently**, one at a time; each is a full distribute → cutover → verify → retire cycle. Avoid the daily cron window (07:00 UTC ± 30 min): the chained sync reads `CUSTOMER_SNAPSHOT_SYNC_SECRET` from env live on each invocation, so no Worker restart is needed, but a cutover landing mid-sync turns that run's subrequests into a mixed old/new sequence that is harder to read in the logs.

### 3a. `SHADOW_API_TOKEN`

1. **Distribute first.** Generate the new token (32+ random bytes, e.g. `openssl rand -hex 32` — never reuse a value that lived in git history). Hand it to every general-route consumer; each stores old+new and tries new first, falling back to old. Consumers that also hold the sync secret are already covered by the outer gate even before they migrate.
2. **Cutover.** Operator only:
   ```bash
   npx wrangler secret put SHADOW_API_TOKEN
   # paste the NEW value when prompted; never put secrets in wrangler.toml [vars]
   ```
3. **Verify (new).** §2 baseline with the new token: general probe → 200 with new, 200 with sync secret (unchanged).
4. **Verify (old retired).** Exactly one general probe with the old token → 401 outer detail; follow immediately with a new-token 200 to reset the throttle counter. The chained snapshot sync is untouched (it never presents the API token) — confirm tomorrow's `data-snapshot-sync` log line per `docs/CRON-SYNC-ALARM-RUNBOOK.md` §1.
5. **Retire.** Consumers delete the old token from their stores only after step 4. Operator retains the old value offline until then — rollback is re-putting it (step 2 with the old value).

### 3b. `CUSTOMER_SNAPSHOT_SYNC_SECRET`

Same cycle, wider blast radius: this secret gates all 13 privileged routes **and** the chained cron subrequests, so every privileged consumer (sync clients, `/api/v1/data/*` readers/writers, import pipelines) must hold new+old before cutover.

1. **Distribute first** to every privileged consumer (new-first, old-fallback), same as §3a step 1.
2. **Cutover.** Operator only: `npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET` with the new value.
3. **Verify (new).** Privileged probe with new → 400 missing-id (inner check cleared); general probe with new → 200.
4. **Verify (old retired).** Exactly one privileged probe with the old secret → 401; follow with a new-secret request to reset throttle. Privileged consumers still on old-only will 401 here — that is the signal to finish their migration, not a rollback trigger, provided step 1 covered them.
5. **Retire + cron watch.** Consumers delete old; operator keeps it offline until the next 07:00 UTC cron logs `success` (not `failed` with a `[chained …] 401` step tag — that tag means a subrequest missed the new secret, `docs/CRON-SYNC-ALARM-RUNBOOK.md` §4).

Update local `.dev.vars` to match after either rotation (gitignored, never commit).

## 4. Failure table

| Symptom | Cause | Fix |
|---|---|---|
| General probe 401s with a token you just distributed | `.dev.vars` edited but dev server not restarted (rehearsal), or `secret put` targeted the wrong environment (production) | Restart `wrangler dev` (§1); check the Worker environment in the dashboard |
| Privileged probe 401s with a valid API token | Expected — the inner check requires the sync secret specifically (§2). Not a rotation failure | Use the sync secret for privileged routes |
| `429 rate-limited` during verification | Expected-401 probes burned the 20/min/IP budget (§2 caution) | One valid-token request clears it immediately; otherwise wait 60 s and probe once |
| Mixed old/new 401s right after cutover | A consumer was missed in step-1 distribution | Finish that consumer's migration; rollback (re-put old) only if a privileged consumer cannot migrate promptly |
| `[chained <table>] POST … → 401` in the next cron line | Chained subrequest presented a stale sync secret (cutover landed mid-sync or env propagation lagged) | Re-run the named table route manually with the current secret; confirm the following cron (§3b step 5) |
| `503 misconfigured` on a `.../sync` route | Sync secret blanked rather than replaced | Re-put a non-empty value; blank is unconfigured, not empty-token (`test/dualSecretMatrix.test.ts:96-101`) |
| Auth tests 401 (`Using secrets defined in .dev.vars` in the output) | That message is expected and harmless: `vitest.config.ts` builds the test bindings from `wrangler.toml [env.test.vars]`, so a local `.dev.vars` never affects `npx vitest run` — look at the test/`[env.test.vars]` tokens instead, not the scratch file | No `.dev.vars` move needed for tests; keep the gitignored file for the next `wrangler dev` |

## 5. Rehearsal evidence

2026-09-28, local `wrangler dev` only (never production): dummy `.dev.vars` (§1) → §2 baseline green (200/200/400/inner-401/outer-401/public-200) → edited `.dev.vars` to `-new` dummy values, restarted dev → new-value probes green, old-value probes single-401-then-reset → `npx vitest run test/dualSecretMatrix.test.ts test/snapshotAuth.test.ts` green (no behavior change). Full drill log attached to [TOG-8901](/TOG/issues/TOG-8901). No real secret was created, changed, or transmitted at any point.

## 6. Done criteria

Rotation of one secret is accepted when: every consumer held new+old before cutover (§3 step 1 attested by the operator); new-value probes return §2 baselines; old-value probes return exactly one 401 each followed by a resetting valid request; the next cron after a sync-secret rotation logs `success`; and the old value survives offline until retirement, then is destroyed with the consumers' copies.
