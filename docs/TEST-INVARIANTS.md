# Test invariants and coverage map

What the test suite pins, per file, and **why** — most of it guards behaviour that fails *silently*
in production rather than loudly. Read this before changing any file it names, or before deleting a
test that looks redundant.

Extracted verbatim from `CLAUDE.md` on 2026-08-10 (it was ~11 KB of an always-on file that is read
every session, but is only needed when touching these specific modules). Coverage percentages are as
measured at commit `ad7acde`; re-measure rather than trusting them.

---

## The coverage ratchet

`vitest.config.ts` pins coverage thresholds just under current levels, so coverage **cannot
regress**. Those thresholds are a ratchet, not the goal — **raise them whenever a change moves the
number up.** That is the whole mechanism.

Measured at `ad7acde`: ~90.6% statements, ~82.0% branches, ~93.4% functions, ~91.1% lines — all four
past the ECC 80% standard.

Read per-file numbers from `coverage/coverage-summary.json`, **not** the istanbul terminal table: the
table drops files once they reach 100% and truncates long names.

### Remaining gaps, highest risk first

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

Both mutation-verified.

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

`test/snapshotOrchestration.test.ts` pins it. D1 does not enforce `address.customer_id` or
`container.pickup_address_id`, and a streamed sync spans many `db.batch` calls rather than one
transaction, so **import order (customer → address → container) is the only thing preventing orphan
rows.** Address only runs if customer is configured; container only if both are.

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

### `routes/shared.ts` — the snapshot auth helpers

`requireSnapshotAuth()` / `requireSnapshotSecret()` guard all 13 routes, and
`test/snapshotAuth.test.ts` pins each route's exact problem+json body. The `detail` wording is
deliberately a per-call-site argument rather than fixed in the helper — it is inconsistent between
routes today, and unifying it would change what clients see, so that belongs in its own change.

### `src/app.ts` and the `src/routes/` module rules

`src/app.ts` is **163 lines**; the routes live in `src/routes/*.ts`, one module per domain, each an
`OpenAPIHono` mounted at `"/"` so its `createRoute` paths stay absolute. The two rules governing that
directory are load-bearing enough to also be stated in `CLAUDE.md`, and
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

## File-size ceiling

**No hand-written source file exceeds the 800-line ceiling.** (`worker-configuration.d.ts` is
generated by `wrangler types` and is exempt.) `src/lib/d1SnapshotSync.ts` was the last breach at 817
lines; its implementation now lives in `src/lib/snapshot/` — `tableSql` (SQL + row bindings),
`upsert` (batched upserts + stale-row reconcile), `reportFetch`, `streamSync`, `orchestration` — and
`d1SnapshotSync.ts` is a re-export facade so importers keep one stable entry point.
