# Test invariants and coverage map

What the test suite pins, per file, and **why** — most of it guards behaviour that fails *silently*
in production rather than loudly. Read this before changing any file it names, or before deleting a
test that looks redundant.

Originally extracted from `CLAUDE.md` on 2026-08-10 (it was ~11 KB of an always-on file that is read
every session, but is only needed when touching these specific modules). Per-file percentages in the
invariant descriptions are historical measurements at commit `ad7acde` unless dated otherwise;
re-measure rather than trusting them. The dated suite-wide measurement below is separate.

**[No test may reach the network](#no-test-may-reach-the-network).** Coverage runs use the local
Vitest `test` bindings and synthetic fixtures, never the live tenant or remote D1. Keep outbound
fetches stubbed, and throw on any unexpected upstream URL.

---

## The coverage ratchet

`vitest.config.ts` pins global coverage thresholds: a run below any floor fails. The floors allow
some slack; they do not catch every regression or guarantee per-file coverage. Those thresholds are
a ratchet, not the goal — **raise them whenever a change moves the number up.**

Read per-file numbers from `coverage/coverage-summary.json`, **not** the istanbul terminal table: the
table drops files once they reach 100% and truncates long names.

### Historical correction (2026-08-22)

These are the **historical** baseline and floors, not the current gate.

| Measured 2026-08-22 (hermetic) | Floor on 2026-08-22 |
|---|---|
| Statements 85.74% (1407/1641) | 85 |
| Branches **79.48%** (833/1048) | 79 |
| Functions 89.09% (188/211) | 89 |
| Lines 86.36% (1374/1591) | 86 |

### Current main measurement (2026-10-08)

Re-measured with `npm run test:coverage` at `origin/main` commit
`7be9be81b416d29965a8cde1942ae7063c3392ca`, which includes
`test/d1TestMigrations.ts` and `test/snapshotSyncE2E.test.ts`. The probe precheck passed (54 tests),
and all 145 Vitest files passed (2,276 tests passed; 3 marked expected-fail). The exact suite totals
from `coverage/coverage-summary.json` were:

| Metric | Measured 2026-10-08 (`origin/main`, `7be9be8`) | Floor in `vitest.config.ts` at that commit |
|---|---:|---:|
| Statements | 96.22% (3006/3124) | 94% |
| Branches | **91.35%** (1955/2140) | 90% |
| Functions | 97.55% (439/450) | 96% |
| Lines | 96.55% (2916/3020) | 95% |

The 2026-08-22 figures above remain a historical baseline, not the current main measurement.

The earlier figures — ~90.6% / ~82.0% / ~93.4% / ~91.1%, measured at `ad7acde` — were **not
reproducible**, and the floors derived from them (90/81/93/91) were not either. One test,
`test/snapshotAuth.test.ts` › *"lets the sync secret past the inner check"*, sent the correct sync
secret and so ran the **real** `POST /api/v1/container-snapshot/sync` body. That file stubbed nothing,
so the request performed a live login against `killeen.routeware.com` and downloaded a live report.
Every line it touched counted as covered while the test asserted nothing about any of it.

By 2026-08-22 upstream no longer completed that flow: the request hung to the 30s `testTimeout`, the
suite failed, and — decisively — `npm run test:coverage` on a clean `main` produced **no coverage
report at all**. There was no 90.6% baseline left to hold.

Stubbing `fetch` in that file (house pattern: throw on any unanticipated upstream URL) dropped the
incidental execution and gave the numbers above. **No source line lost a real test; the code did not
change.** This is a measurement correction, and it is the one time these floors move down.

### Remaining gaps, highest risk first

### Two known weaknesses in the ratchet itself

- **The thresholds are global-only — `vitest.config.ts` does not set `perFile: true`.** A new module
  with no tests at all can be masked by well-covered ones and never trip the gate. Pre-existing, but
  it matters more after a downward re-baseline, because a global floor that has just been lowered is
  exactly where a localized regression hides.
- **"Raise them whenever the number goes up" is prose, not a guardrail.** Nothing enforces the
  re-raise. Making it real needs a CI step comparing `coverage/coverage-summary.json` against the
  configured floors — a comment cannot do it. Compare the dated measurement with its matching
  floors, not the historical re-baseline above.

- **The missing-D1-table / snapshot E2E gap is closed.** `test/d1TestMigrations.ts` exports
  `ensureD1TestTables`, which auto-discovers `migrations/d1/*.sql` and applies them to the local
  test `CUSTOMER_DB` via `applyD1Migrations`. `test/snapshotSyncE2E.test.ts` calls it in `beforeAll`
  and asserts customer → address → container HTTP 200 sync, FK order, the session retry, upserts
  and R2 archives. `httpAuth` is mocked; report polls/downloads are stubbed and unexpected upstream
  calls throw. **Do not recover coverage by letting tests reach the network.**

- The three `csv*Snapshot.ts` parsers — 33–39% statements, 33% functions. The per-row
  `parse*SnapshotRow` half is well covered via `streamSync`; the bulk `parse*SnapshotCsv` half is not.
- `r2SnapshotArchive.ts` — 62.3% statements, 28.6% functions.
- `routewareQueryReportCsv.ts` — 69.8% statements, 51.1% functions.

---

## Per-file invariants

### `dataEntityHandlers.ts` — 93.4% statements / 100% functions

`test/dataEntityHandlers.test.ts` covers the GET/ETag paths; `test/dataEntityPostHandlers.test.ts`
covers the three POST write paths — including the branch where the upstream save succeeds but the D1
sync throws, which must keep the 200 and fall back to `invalidateDataEntity` so stale PII is not
served from cache.

Still open, smaller: several handlers here exceed the 50-line guideline.

### `addressContainerSaveForm.ts` — 100% statements/branches/functions

`test/addressContainerSaveForm.test.ts` mocks only `upstreamForward` and lets the real
`customerSaveAutoToken` helpers run (which also lifted `customerSaveAutoToken.ts` to 84.5%).

Everything it pins fails silently in production: Routeware answers a POST carrying a wrong or stale
`__RequestVerificationToken` with an **HTML error page, not an error status**, so the save quietly
does nothing. Two invariants before touching that file:

1. **`CUSTOMER_SAVE_AUTO_TOKEN` is opt-out.** Only the literals `"false"` and `"0"` disable
   injection, so an unset binding must still inject.
2. **The modal query parameter names are deliberately inconsistent and must not be "tidied".** The
   address create path uses lowercase `customerID` and the container create path lowercase
   `pickupAddressID`, while both edit paths use PascalCase `PickupAddressID` / `ContainerID`.

Mutation-verified six ways, including both casing swaps.

### `detailFullSync.ts` — two test files, split by what they need

- `test/detailFullSyncMapping.test.ts` (pure, no mocks) pins the field mapping: the
  Routeware→snapshot renames (`NameFirst`→`firstName` and friends) and the absent-key defaults, where
  `extrasAllowed` / `enabled` / `gpsLocked` use an explicit `!== undefined` guard — coercing
  `undefined` yields `false` and would silently disable every address.
- `test/detailFullSyncFetch.test.ts` pins the re-auth retry, including that the session is **re-read**
  after `establishSession` rather than the stale one reused.
- Upstream failure text is **never embedded in thrown errors**: `fetchGetCustomerDetailFull`
  throws `GetCustomerDetailFull failed: HTTP <status>` (no body slice), because the message
  reaches API clients verbatim inside `localSync.reason`. Same for
  `fetchReportCsvByQueryId` (`QueryExecuteDownload failed: HTTP <status>` — the cron log
  is the sink). `test/piiScrub.test.ts` pins both against PII-shaped HTML, plus the
  anti-forgery modal 502s (status + modal path only) and fixture hygiene. See the
  audit table at the top of that file for the full `console.*` / problem+json sweep.

Both mutation-verified.

### `upstreamTimeout.ts` / bounded upstream budgets (TOG-5835)

`test/upstreamTimeout.test.ts` (11 tests) pins the retry-budget split the whole
change rests on: a hung upstream throws `UpstreamTimeoutError` within budget
(never-settling mock + 50ms timer), and `forwardWithSessionRetry` maps it to
502 problem+json with exactly one attempt — the single retry stays reserved for
the login redirect, because retrying a timeout could double-execute a
non-idempotent POST. Budgets: 15s interactive / 60s report CSV (overridable via
`UPSTREAM_TIMEOUT_MS` / `UPSTREAM_REPORT_TIMEOUT_MS`). A caller abort with the
timer unfired rethrows verbatim so a client disconnect is never misreported as
a 502. `app.onError` is the backstop for direct `forwardToUpstream` callers.

### `snapshot/reportFetch.ts` — 100% on all four metrics

`test/snapshotReportFetch.test.ts`, 19 tests, mutation-verified six ways. This is the single door
every scheduled snapshot pulls its CSV through, and its guards are **asymmetric on purpose**: the
*retry* trigger is `resp.status !== 200` while the *throw* guard is `!resp.ok`, so a 204 retries once
and is then accepted.

The retry re-reads the session after `establishSession` rather than reusing the stale one — reusing
it would make the retry fail identically to the first attempt, since Routeware signals an expired
admin session with a login redirect or an HTML error page, **never a 401**.

The `accept: text/csv` header is load-bearing: without it Routeware content-negotiates to the HTML
report viewer, which parses to zero rows.

`fetchGetCustomerDetailFull` has the same shape.

### `entityDataCache.ts` — the error asymmetry is deliberate

Pinned by `test/entityDataCache.test.ts`: `putCachedDataEntity` swallows and logs its failures (the
response is already valid — a failed cache write must not turn a 200 into a 500), while
`invalidateDataEntity` lets them propagate (a silently failed invalidation serves superseded PII).
**Do not "harmonise" the two.**

`test/scheduled.test.ts` pins the matching property one level up: the cron handler must never reject,
since it runs inside `ctx.waitUntil` where an escaping error becomes an unattributed platform failure
instead of a log line.

### `getDataSnapshotPlan` — the referential-integrity guard

`test/snapshotOrchestration.test.ts` pins it. D1 enforces `address.customer_id` and
`container.pickup_address_id` unconditionally (a dangling reference is rejected with
400 `bad-request`, never written as an orphan), and a streamed sync spans many
`db.batch` calls rather than one transaction, so **import order
(customer → address → container) is enforced both by the database and by the plan.**
Address only runs if customer is configured; container only if both are.

That file also pins the `[step]` error tagging, which is what tells you which table a scheduled-run
failure came from.

### `streamSync.ts` — 96.9% statements / 95.2% branches

`test/snapshotStreamSync.test.ts` is a `describe.each` over all three tables rather than
customer-only, which took the module from 57.3%/44.4% (mutation-verified six ways). The point of
parameterising it: every guard has to hold on all three paths, and a reconcile guard present only on
the customer function still lets a bad address export wipe `address_snapshot`.

### `snapshot/upsert.ts` and the two snapshot invariants

- `test/snapshotUpsert.test.ts` asserts that each table's column list, placeholder count and binding
  count agree, and that rows-per-statement × bindings-per-row stays within D1's **100 bound-parameter
  ceiling** — adding a column without updating the matching `*Bindings` and `*_NCOLS` otherwise fails
  only at runtime, mid-cron.
- `test/snapshotStreamSync.test.ts` pins the reconcile guard
  (`options.reconcile && cols && dataRows > 0`): an export that yields zero parseable rows must
  **not** delete anything, or a bad upstream export wipes the table.

Both mutation-verified. The shared recording `D1Database` double lives in `test/snapshotDbFake.ts`.

### `routes/*Snapshot.ts` — ~96% statements / ~94% branches

`test/snapshotRoutes.test.ts`, a `describe.each` over one spec per module, mutation-verified nine
ways. What it pins is the **WHERE-clause / bind-array correspondence**: each filter pushes a SQL
fragment and a bind value in two separate statements, and `limit`/`offset` are appended *after* the
caller's binds — swap that order and D1 binds a customer id as a LIMIT, **returning another
customer's rows with a 200**.

The container module diverges on two points that must not be unified with the other two:

- its `INNER JOIN address_snapshot` is **conditional** on `customerId` (joining unconditionally
  silently drops every container whose address row is missing);
- its free-text `q` binds the same value **twice**, once per column in the
  `location_address OR serial_number` clause — one bind for two placeholders shifts every later bind
  by one.

### `routes/dataEntity.ts` (100% all four) and `routes/dataSnapshot.ts` (92.3% / 75%)

`test/dataRoutes.test.ts` covers the wiring — the layer between `snapshotAuth.test.ts` (their 401
bodies) and `dataEntity*.test.ts` (the handlers). Two things it pins:

- `/api/v1/data-snapshot/sync` derives its chain origin from `new URL(c.req.url).origin`, because
  that route chains three internal HTTP calls back to this same Worker and **a hardcoded origin would
  let a preview deployment drive production D1**.
- The `id` guards are **deliberately asymmetric**: the customer route takes `id` *or* the
  `customerId` alias (`q.id ?? q.customerId`, and `id` must win), while address and container require
  `id` and additionally reject `0` and negatives, which `z.coerce.number().int()` accepts on its own.
  An `id=0` reaching D1 is a silent empty aggregate returned as a 200, not an error.

Mutation-verified four ways.

### `migrations/d1/0003_text_filter_indexes.sql` — container/address `q` indexes

`test/snapshotTextFilterIndexes.test.ts` applies the committed migration files
verbatim against the real pool D1, seeds rows, and runs the exact WHERE shapes
from `src/routes/*Snapshot.ts` through `EXPLAIN QUERY PLAN` before and after
0003. What it pins: `enabled + q` SELECT and COUNT go from SCAN to SEARCH on
the new composite `(enabled, lower(...))` indexes; `q`-alone (`enabled=any`)
still SCANs — no B-tree can serve a mid-string `instr()` substring match, so a
"fix" adding a bare expression index changes nothing (it only ever reports
`USING COVERING INDEX` for the same full scan). Two pool-D1 constraints shape
the helper, not the migration: `db.exec()` takes single-line statements only,
so the test splits `;`-separated statements through `prepare().run()`
(`wrangler d1 migrations apply` splits them itself — the files stay
multi-line); `console.log` is swallowed in the pool, so every observation is
an assertion. The `*.sql?raw` / `cloudflare:test` declarations live in
`test/sqlRaw.d.ts` (no precedent existed; the `?raw` import was probe-verified
in-pool before use).

TOG-7383 full-table audit (2026-09-27): every list/filter shape in
`src/routes/{customer,address,container}Snapshot.ts` (23 shapes: plain list,
id lookups, `q`-alone, `enabled`-alone, `enabled + q` SELECT + COUNT, and the
container `customerId` join composed with `enabled + q`) was run through
`EXPLAIN QUERY PLAN` before and after 0003 under `node:sqlite`
(SQLite 3.53.4, same engine family as D1; full 146-line matrix attached to
[TOG-7383](/TOG/issues/TOG-7383)). Post-0003 plans: customer `enabled + q`
`SEARCH customer_snapshot USING INDEX idx_customer_snapshot_enabled
(enabled=?)` — 0001 already served it, 0003 is a no-op there (pinned by
before/after equality assertions); address `enabled + q` `SEARCH
address_snapshot USING INDEX idx_address_snapshot_enabled_address_lower
(enabled=?)` (COUNT is covering); container `enabled + q` `SEARCH c USING
INDEX idx_container_snapshot_enabled_serial_lower (enabled=?)`; the container
join shape seeks the serial composite on `c` and `SEARCH a USING COVERING
INDEX idx_address_snapshot_customer_id` on `a`. All three `q`-alone shapes
still SCAN. Verdict: **no missing-index gaps, no migration 0004** — the
deliverable is this doc note plus the extended pins. Two cautions for the next
reader: (1) SEARCH here means fewer rows examined on skewed `enabled`, not
lower latency — at 100k synthetic rows with uniform 95/5 data the post-0003
container `enabled + q` SELECT timed ~15–26ms vs ~13ms pre-0003 (noise +
rowid hops); the `enabled=0` minority shape did improve 13→3.5ms. (2)
`idx_customer_snapshot_company_lower` (0001) and `idx_address_snapshot_zip`
(0002) match no current WHERE clause — dead weight kept, not dropped, in this
change; removing them is a separate decision.

### `routes/shared.ts` — the snapshot auth helpers

`requireSnapshotAuth()` / `requireSnapshotSecret()` guard all 16 privileged
routes (13 at TOG-7030 plus the 3 `GET ...-snapshot/export` downloads,
TOG-8361), and `test/snapshotAuth.test.ts` pins the canonical inner 401/503
body every route shares. The per-call-site `detail` wording was unified in
the helpers by TOG-7030 (one 401 detail naming the sync secret, one 503
detail naming the secret config, each with the remedy-doc link and
`instance`). `test/authGateResweep.test.ts` (TOG-8386) pins the privileged
inventory itself from the live router, so a new sync/import/export/data route
without `requireSnapshotAuth` fails there instead of slipping past the outer
gate on the general API token.

### `src/app.ts` and the `src/routes/` module rules

`src/app.ts` is **163 lines**; the routes live in `src/routes/*.ts`, one module per domain, each an
`OpenAPIHono` mounted at `"/"` so its `createRoute` paths stay absolute. The two rules governing that
directory are load-bearing enough to also be stated in [`CONVENTIONS.md`](CONVENTIONS.md), and
`test/openapiContract.test.ts` enforces both plus the full generated document (verified to fail when
a route is dropped).

---

## Deliberate dead branches — do not "clean up"

Each of these is unreachable defence in depth, kept on purpose. Removing them is behaviour-neutral
but is **not** a test-only change.

- **`streamSync.ts:49`, `:111`, `:173`** — the `if (!cols) continue;` guards. Line 0 either sets
  `cols` via `mapCsvHeaders` or throws, so no later line can see a null `cols`.
- **`addressSnapshot.ts:107`, `customerSnapshot.ts:123`, `containerSnapshot.ts:106`** — the
  `!Number.isFinite(id)` 400 guard in all three by-id handlers. `z.coerce.number().int()` on the path
  param rejects `abc` and `4.5` at the schema first, so the handler never sees a non-integer.
- **`shared.ts:67`** — `requireSnapshotSecret()` can never fire on a sync route. It runs *after*
  `requireSnapshotAuth()`, which calls `bearerMatches(req, env.CUSTOMER_SNAPSHOT_SYNC_SECRET)`; with
  the secret unset that returns false and 401s first, so the 503 is unreachable from these routes.
- **`snapshot/reportFetch.ts:26`** — the `|| isLoginRedirect(resp)` clause can never contribute,
  because `isLoginRedirect` requires status 302 and the `status !== 200` clause has already
  short-circuited. Pre-existing, **not** a bug.

---

## No test may reach the network

Every test runs against stubs. `test/integration.test.ts` sets the house pattern: replace
`globalThis.fetch` in `beforeEach`, restore it in `afterEach`, and **throw** on any upstream URL the
test did not anticipate, so a leak fails loudly instead of silently calling
`killeen.routeware.com`.

**`test/snapshotAuth.test.ts` must keep its stub.** Fifteen of its sixteen tests are rejected at the
auth gate and never reach a handler body, which is why the file had no stub for a long time. The
sixteenth — *"lets the sync secret past the inner check"* — sends the **correct** secret, so by
design it runs the real sync body, and `[env.test.vars]` sets `CONTAINER_REPORT_QUERY_ID = "25"`, so
the 503 "not configured" short-circuit does not save it either. Unstubbed, that one request logged in
against the live tenant. It passed for months, then upstream changed and it hung to the 30s timeout,
failing the suite and suppressing the coverage report entirely (see § "The coverage ratchet").

The assertion `expect(upstreamFetch).toHaveBeenCalled()` is load-bearing: reaching the sync body at
all is what proves the inner check was cleared. Mutation-verified 2026-08-22 — forcing
`requireSnapshotAuth` to always deny turns that test red in 5ms.

---

## File-size ceiling

**No hand-written source file exceeds the 800-line ceiling.** (`worker-configuration.d.ts` is
generated by `wrangler types` and is exempt.) `src/lib/d1SnapshotSync.ts` was the last breach at 817
lines; its implementation now lives in `src/lib/snapshot/` — `tableSql` (SQL + row bindings),
`upsert` (batched upserts + stale-row reconcile), `reportFetch`, `streamSync`, `orchestration` — and
`d1SnapshotSync.ts` is a re-export facade so importers keep one stable entry point.
