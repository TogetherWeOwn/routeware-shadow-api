# Secret rotation runbook — all four Worker secrets

**Status:** runbook only. No rotation is executed in this card and no secret values enter git, issues, PRs, comments, or logs.
**Scope:** `TogetherWeOwn/routeware-shadow-api`, branch `main`. Secrets: `SHADOW_API_TOKEN`, `CUSTOMER_SNAPSHOT_SYNC_SECRET`, `LOGIN_USERNAME`, `LOGIN_PASSWORD`.
**Why now:** rotation was declined 2026-08-07 pre-transfer (`docs/SECURITY-REMEDIATION.md` Step 1) when the repo was private with one collaborator. The transfer to an organization invalidates that premise (`docs/HANDOVER.md` § 5). Values move to the new owner out-of-band only.
**CISO approval (this run):** approved as the rotation plan on 2026-09-27 by the CISO agent. Approval covers this document's order, blast radius, and verification steps. It does not authorize executing a rotation and does not attest to handling any value.

## 0. Rules that apply to every secret

1. **Out-of-band only.** Real values travel via the owner-controlled channel (e.g. password manager / direct handoff), never through this repo, an issue, a PR, a comment, a log, or a CLI argument. `npx wrangler secret put <NAME>` reads from stdin interactively — do not `echo` values through shared shell history.
2. **Placement.** Deployed Workers: `wrangler secret put` (persists across deploys, untouched by deploys). Local dev: `.dev.vars` in the repo root (gitignored, same directory as `wrangler.toml`). Never `[vars]` in `wrangler.toml` — bearer secrets are deliberately absent there so an unconfigured deploy fails closed with 401 (`wrangler.toml:53-57`). Never regenerate `worker-configuration.d.ts` from a TOML containing real values (it bakes `[vars]` into literal string types; `docs/SECURITY-REMEDIATION.md` Step 3 gap).
3. **Revocation is overwrite.** `wrangler secret put` takes effect on the next request without a deploy. The old value is then rejected. There is no versioned dual-secret support — each cutover is atomic, so follow the order below and verify old-rejected / new-accepted per secret.
4. **Local hygiene.** Update `.dev.vars` to match (values never printed; `npm run check:devvars` checks keys only). Shred any temp file holding a value (`shred -u`). `test` env placeholders in `wrangler.toml:95-103` are synthetic and stay as-is.

## 1. Rotation order (do in this sequence)

| Step | Secret | Why here |
|---|---|---|
| 1 | `SHADOW_API_TOKEN` | Smallest blast radius; rehearses the secret-put + verify loop without touching sync automation or the Routeware tenant. |
| 2 | `CUSTOMER_SNAPSHOT_SYNC_SECRET` | Widest bearer blast radius. Do it while step 1's token is set and **distinct**, so general `/api/v1/*` access stays up during the privileged cutover (see `src/lib/auth.ts:54-73`). Single-secret deployments must instead accept a combined outage window. |
| 3 | `LOGIN_USERNAME` + `LOGIN_PASSWORD` together | Routeware tenant credentials. Last because the UI step invalidates upstream sessions immediately and failures are **silent HTML 200, never 401** (`docs/HANDOVER.md` fact 1) — verify on a clean bearer channel from steps 1–2 so bearer and upstream failures are not conflated. |

Precondition for step 2: confirm a distinct `SHADOW_API_TOKEN` is set (general API answers with it while sync routes require the sync secret). Postcondition for step 3: a fresh upstream login succeeds and the old tenant password is dead at the source.

Avoid the daily cron window (`0 7 * * *` UTC, `wrangler.toml:77`) for step 2 — the chained sync authenticates to the Worker itself with the sync secret (`src/lib/snapshot/orchestration.ts:142-144`).

## 2. Per-secret blast radius, rotation, and verification

### 2.1 `SHADOW_API_TOKEN` — general API bearer

- **Gates:** every `/api/v1/*` route except `GET /api/v1/health` (`src/lib/auth.ts:4-12`). Falls back to `CUSTOMER_SNAPSHOT_SYNC_SECRET` when unset (`.dev.vars.example:6-8`).
- **Blast radius:** external API clients presenting the dedicated token. **Not** affected: health checks, callers using the sync secret (`isApiAuthorized` accepts the sync secret even when a distinct API token is configured, `src/lib/auth.ts:69-74`), the daily cron (uses the sync secret).
- **Rotate:** owner generates a new token out-of-band → `npx wrangler secret put SHADOW_API_TOKEN` (this repo's Wrangler via `npx`, not a global Windows install under WSL) → update every API client → update local `.dev.vars`.
- **Verify (no values in output):**
  - `GET /api/v1/health` without auth → 200 (still public).
  - `GET` a read route with the **new** token → 200; with the **old** token → 401 problem+json (`unauthorized`, see `docs/PROBLEMS.md`).
  - Sync/data routes with the sync secret → still 200 (proves the cutover did not bleed into privileged paths).
- **Rollback:** `wrangler secret put SHADOW_API_TOKEN` with the previous value (retained out-of-band until verification passes), then re-verify. Fail-closed default (no token → 401) is the safe intermediate, never a committed placeholder.

### 2.2 `CUSTOMER_SNAPSHOT_SYNC_SECRET` — privileged sync/data bearer

- **Gates:** `.../sync`, `.../import`, `/api/v1/data/*`, `/api/v1/data-snapshot/sync` via the narrower in-handler check on top of the app-wide gate (`src/routes/shared.ts:26-57`; route copy in `src/routes/customerSnapshot.ts:143-166`, `src/routes/dataEntity.ts:28-48`). Also the general-API fallback when `SHADOW_API_TOKEN` is unset.
- **Blast radius (largest bearer):** all snapshot automation (daily cron chains per-table subrequests with this bearer), all sync/import callers, all data-entity clients on fallback deployments. D1/R2 contents are unaffected; only access is cut over.
- **Rotate:** outside the 07:00 UTC cron window → `npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET` → update every sync caller, the cron chain needs no code change (same Worker reads the new secret on the next invocation; mode selection in `src/scheduled.ts`) → update local `.dev.vars`.
- **Verify:**
  - New secret on a sync route → success sync JSON; old secret → 401; unset Worker → 503 `misconfigured` (`requireSnapshotSecret`, `src/routes/shared.ts:60-73`).
  - Manual chain: `POST /api/v1/data-snapshot/sync` with the new secret succeeds (customer → address → container order matters for FKs; `CUSTOMER_SNAPSHOT.md` checklist).
  - Next scheduled run logs `data-snapshot-sync {"outcome":"success",…}` with no auth errors (`npx wrangler tail` or dashboard logs). An `outcome: "unconfigured"` line with `SHADOW_API_PUBLIC_BASE` unset is a config warning, not auth success (`docs/CRON-SYNC-ALARM-RUNBOOK.md` §0).
- **Rollback:** restore the previous value out-of-band via `wrangler secret put`, re-run the manual chain. Keep the old value recoverable out-of-band until one successful scheduled run completes.

### 2.3 `LOGIN_USERNAME` + `LOGIN_PASSWORD` — Routeware tenant login

- **Gates:** every flow that fetches from Routeware: HTTP form login (`src/lib/httpAuth.ts:58-63`) with Browser Rendering fallback (`src/lib/browserAuth.ts:18-19`), including report `QueryExecuteDownload` syncs (`CUSTOMER_SNAPSHOT.md:30`). Session cookies (`.WebRW`, `RCCApi`, `RCCApiRefresh`) are cached in the `AuthSession` Durable Object and never relayed to clients (`docs/CONVENTIONS.md:88-91`).
- **Blast radius:** full tenant access — an attacker with these bypasses the Worker entirely. Rotation-side outage: all upstream-authenticated routes fail **silently as HTML 200** (fact 1), so status codes do not diagnose this step.
- **Rotate (owner-only, Routeware UI first):** change (or create-then-disable) the `API` login in the Routeware tenant UI → `npx wrangler secret put LOGIN_USERNAME` + `npx wrangler secret put LOGIN_PASSWORD` → update local `.dev.vars`. Rotate as a pair; a username change means a new account, not a rename. The next request performs a fresh login — Durable Object state loss is harmless (`docs/HANDOVER.md` § 3B-7); nothing migrates.
- **Verify:**
  - An upstream-backed read returns real JSON (not the login page HTML). On doubt, inspect body shape/content-type, not status.
  - Worker logs show a fresh login then a `data-snapshot-sync {"outcome":"success",…}` line with row counts in `tables`; cookie **names** (never values) are `.WebRW`, `RCCApi`, `RCCApiRefresh`.
  - Old tenant password no longer logs in at the Routeware UI (revocation at source).
- **Rollback:** restore the previous tenant credential in the Routeware UI and re-put the previous Worker secrets. If the username was replaced, re-enable the old account rather than reusing a deleted name.

## 3. After all four

- Confirm deployed Worker authenticates end-to-end, then confirm each **old** bearer is rejected with 401 (the Step-1 containment check from `docs/SECURITY-REMEDIATION.md`).
- One successful scheduled run past the rotation, then shred out-of-band escrow of old values per owner retention policy.
- Still owed outside this card (owner-only, unchanged): delete `Rick7C2/routeware-shadow-api` — its `refs/pull/*` still disclose the pre-rotation values and PII. Rotation contains the incident even while that repo exists; deletion stops future readers.
