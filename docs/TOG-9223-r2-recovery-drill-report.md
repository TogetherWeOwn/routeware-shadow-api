# TOG-9223 — R2-archive recovery drill report (QA exploratory)

> **Superseded — 2026-10-15.** This is a historical drill report; do not use
> it as current procedure evidence. Superseding re-drill:
> [TOG-25209](/TOG/issues/TOG-25209) (all verdicts PASS, 2026-10-15). Current
> procedure: [R2 snapshot restore runbook §§2–5](R2-RESTORE-RUNBOOK.md#2-create-private-scratch-state-terminal-b)
> (the credential-free reviewer drill starts at §2).

**Date:** 2026-09-28 · **Driller:** QA & Release Engineer · **Scope:** `origin/main`
(`e3749fa` restore runbook + `adc2e9d` integrity manifest), local-only.
**Method:** followed only written docs — `docs/R2-RESTORE-RUNBOOK.md` (R2 → CSV → D1
operator path, TOG-7394) + `docs/BACKFILL-RUNBOOK.md` (FK order, failure table) +
`docs/D1-BACKUP-RESTORE-RUNBOOK.md` (§2 wipe rule). Synthetic drill rows only
(customers 901/902, addresses 991/992, containers 881/882 — no PII). No `--remote`
at any point. The sibling branch already carries TOG-9202
(`GET /api/v1/snapshots/:table/:date`, uncommitted here) — exercised read-only as
H1–H4; no verdict given on it (not this card's deliverable).

## Recovery time (wall clock, timed per step)

| Step | Time |
|---|---|
| Fresh migrate (`db:migrate:local`, 4 migrations) | ~10 s |
| Seed 3 archive CSVs to local R2 (`r2 object put` ×3) | 3 s |
| Key check (`r2 object get --pipe`, byte-identical) | 2 s |
| Download 3 CSVs (`r2 object get --file` ×3) | 4 s |
| FK-ordered `.../import` ×3 (2 rows each) | <1 s |
| Verify (counts 2/2/2, values, 0/0 orphans) | ~5 s |
| Simulated loss (wipe to 0/0/0) → re-restore 2/2/2 identical | <1 s |
| **End-to-end operator time, archive exists → verified restore** | **≈ 1 min** (dominated by `wrangler dev` boot ~10 s, not transfer) |

RTO note: same RTO class as `docs/D1-BACKUP-RESTORE-RUNBOOK.md` §4 (≈10 min operator
time at hundreds–low-thousands of rows); at this fixture size the transfer itself
is sub-second and the dominant cost is locating the right archive date.

## Checks (10/10 pass)

- R1–R3: each import returns `{upserted:2,rowCount:2,deleted:0}`; counts 2/2/2;
  values byte-match the CSV; both orphan counts 0.
- R4 (loss): wipe to 0/0/0 → re-import in FK order → 2/2/2 with identical
  `customer_id`/`company_name` values.
- P1: API token on `.../import` → 401 naming `CUSTOMER_SNAPSHOT_SYNC_SECRET`.
  P2: no token → 401 at the outer gate. P3: container-first on an empty DB → 400
  `Dangling reference: container_snapshot.pickup_address_id=991, 992 … Import
  addresses first`. P4: empty body → 400 `not valid CSV`. Absent R2 key →
  `The specified key does not exist` (distinguishable from misconfigured, as designed).
- H1–H4 (sibling readback route, read-only probes): 200 + CLI-byte-identical
  download; absent date 404 `table=customer date=2000-01-01`; API token 401;
  malformed date 400 `Invalid request param (date)`.

## Findings (1 filed)

1. **TOG-9398 — R2 restore runbook never verifies the integrity manifest before
   import.** The runbook (§2–§3 import, §5 verify) never invokes
   `snapshots/<date>.manifest.json` / `npm run verify:r2-manifest` (TOG-8881), so a
   truncated/tampered CSV would silently upsert bad rows past the count/spot checks
   (`.../import` never deletes). Acceptance: runbook gains a verify-first step with
   `--remote`/`--persist-to` pairing noted; reviewer re-runs the tamper recipe from
   the verify script header.

## Non-findings (checked, already covered — no new card)

- FK-order enforcement, wipe-before-restore, `?dryRun` flag, archive-disabled
  logging, 503-unbound vs 404-absent distinction — all behave as their docs/tests
  claim.

## Cleanup

Scratch R2 keys `snapshots/2026-09-28/{customer,address,container}.csv` deleted
(verified absent after); drill `.dev.vars` (dummy secrets) deleted; `wrangler dev`
stopped and port 18931 verified free (killed workerd PIDs matched by worktree path
only — sibling servers untouched); downloaded CSVs lived only in run scratch. No
PII fetched, logged, or committed at any point.
