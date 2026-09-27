# TOG-6278 — Throttle burst verification + secret-residual audit

**Date:** 2026-09-27 · **Scope:** post-TOG-5820 throttle (`20 failures / 60 s window / 60 s block`)
**Result: zero secret / bearer / PII hits.** Test placeholders only.

## Burst tests — `test/throttleBurst.test.ts` (7 tests, all passing)

Beyond `test/authThrottle.test.ts` (window math, DO endpoints, fail-open) and
`test/authGateSweep.test.ts` (33-route 401 sweep, threshold 429, health/OPTIONS):

- per-IP isolation with independent budgets (attacker blocked, victim burns own 20)
- valid token bypasses an **active** block and resets (`GET /api/v1/shadow/health` → 200, next bad → 401)
- partial-count reset: 5 failures + valid pass + 19×401, 20th 429s (shared-NAT case)
- failures across routes share one per-IP bucket
- OPTIONS interleaved with failures never consumes budget (10 + 20×OPTIONS + 9 → 20th 429s)
- 401/429 bodies never echo the submitted bearer (distinct probe tokens asserted absent)
- health-probe burst (20×) never consumes budget

Fresh `203.0.113.211–217` / `192.0.2.211` IPs; `npm test` reviewer check.

## Secret-residual audit — files checked, zero hits

**Throttle/auth core:** `src/app.ts` (gate, 429+`Retry-After`, generic 500),
`src/lib/auth.ts` (constant-time compare, no logging),
`src/lib/authThrottle.ts` (IP only as DO name `auth-throttle:<ip>`, never logged),
`src/authSession.do.ts` (`/throttle/*`, session keys, no logging).

**Upstream/session:** `src/lib/upstreamForward.ts` (strips `Set-Cookie`),
`src/lib/upstreamHeaders.ts` (static UA), `src/lib/httpAuth.ts` (errors list
cookie **names** only), `src/lib/browserAuth.ts`, `src/lib/establishSession.ts`,
`src/lib/sessionRefreshLock.ts` (`err.message` only, no credentials),
`src/lib/customerSaveAutoToken.ts`, `src/lib/forwardWithSessionRetry.ts`
(no logging).

**Data/snapshot:** `src/lib/snapshot/orchestration.ts` (chained `fetch` builds
`Bearer` server-side, never logged; logs config-skips + counts),
`src/lib/r2SnapshotArchive.ts` (R2 key + message), `src/lib/entityDataCache.ts`
(entity/id on cache-put fail — IDs only, no rows),
`src/lib/dataEntityHandlers.ts`, `src/scheduled.ts` (counts/summary/duration only).

**Routes/errors:** `src/routes/shared.ts`, `customer.ts`, `address.ts`,
`container.ts` (502 `detail` = static prep messages + status, no token/body),
`dataSnapshot.ts`, `dataEntity.ts`, snapshot routes (401/503 name the var, no value),
`src/routes/routeware.ts` allowlist noted (sibling TOG-6270's dirty diff, untouched here).

**Spec/config/docs:** OpenAPI snapshot (scheme names vars, no values/cookies),
`wrangler.toml` (`[vars]` omits bearer secrets by design; `[env.test.vars]` holds
labeled dummies `test-api-token` / `test-sync-secret` / `test-password-not-real`),
`docs/PROBLEMS.md`, `README.md`, `test/*.ts` (test tokens only).

**Sweeps run:** secret-value patterns (`ghp_`, `AKIA`, `BEGIN PRIVATE KEY`,
`password\s*[:=]\s*['"]…`) → 0 in `src/`; bearer-echo grep → 0; row-content in
`console.*` → 0 (only counts/IDs/keys). Client-visible 401/429 bodies are static
strings + numeric `Retry-After`; proven bearer-free by the new echo test.
