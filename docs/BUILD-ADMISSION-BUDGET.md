# Build-history admission read budget

**Production stays OFF.** This bounds the dormant guard's availability cost. It
is not production qualification, a quota reservation, authorization to deploy,
or a new supported run-discovery strategy. Keep all existing
[production rehearsal gates](PRODUCTION-DEPLOY-DRY-RUN.md) and
[build-publication provenance requirements](VERSIONING.md#separate-deployment-build-identity-dormant).

## Provider basis and enforced envelope

GitHub's [REST rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
(accessed 2026-11-08) documents **1,000 requests/hour/repository for
GITHUB_TOKEN**, or 15,000 for Enterprise Cloud resources. This implementation
assumes no Enterprise uplift, alternate credential, write permission, paid plan
or quota service. Most GETs cost one secondary point; the documented REST
secondary threshold is 900 points/minute per endpoint, but some costs and limits
are unpublished. Lower limits and unrelated users can still cause refusal.
No live quota experiment or `/rate_limit` sampling is needed or performed.

One enabled admission enforces all of these:

- **200 dispatched GETs maximum** (20% of the baseline hourly capacity). This
  includes run-list pages, exact attempts, every jobs page, numeric repository
  identity normalization, immutable source, tag inventory/refs/objects, original
  planning logs and Release proof. Repair has no separate allowance.
- **100 requests retained as a reserve.** The first ordinary history GET is the
  sole bootstrap request; its headers must show at least **299 remaining**:
  199 for the rest of the maximum admission plus 100 reserve. Every subsequent
  response must fund the unspent maximum plus reserve. A small history still
  needs this conservative full-envelope headroom. This does not reserve capacity
  atomically or guarantee enough capacity for a later shared planner/publisher.
- Each HTTP-200 response requires canonical, safe-integer `x-ratelimit-limit`,
  `x-ratelimit-remaining`, `x-ratelimit-used`, future hourly `x-ratelimit-reset`
  (at most 3,660 seconds ahead, allowing one minute clock skew), and
  `x-ratelimit-resource: core`. Used plus remaining must equal the limit.
  Missing/malformed/inconsistent metadata refuses.
  Our allowance can shrink but never grows when a reset or repeated/higher
  remaining header is observed. No hourly-reset sleep.
- **120 seconds total, 10 seconds per request**, including body consumption
  and final synchronous proof validation; timeout aborts fetch and fails the
  admission. The admission succeeds only after a post-validation deadline
  check on the same admission-local clock, which dispatches no GET. Requests are serial. There are
  **zero retries**. HTTP 403/429, any `retry-after` signal (including malformed),
  other non-200 status, invalid proof and transport errors fail closed. Error
  messages do not echo credential-bearing transport errors or response bodies.
- Fetch uses **manual redirects**, not hidden follow-up GETs. Redirects refuse
  without requesting their destination. In particular GitHub's usual job-log
  download redirect currently makes live repair-log retrieval **NOT READY**;
  a synthetic inline log proves provenance logic, not live download support.
  A future counted, scoped log transport needs review; do not follow signed URLs
  manually or use another identity as recovery.

One admission may reuse only exact SHA-addressed workflow contents and immutable
annotated tag objects. Keys include repository, resource kind and full SHA. The
cache is in memory for this admission only and clones proof bytes/metadata to
prevent caller mutation. Run/attempt/jobs metadata (even terminal), inventories,
repository aliases, mutable refs, Releases and logs are never cached as safe.
Disabled contexts perform zero reads and need no token or quota metadata.

## Representative synthetic request counts

All counts include the current run's independent attempt metadata and the list.
These cases use one jobs page/attempt and no numeric pagination aliases:

| Complete history shape | External GETs | Outcome with valid quota/time metadata |
| --- | ---: | --- |
| Current run only | 2 | Permits |
| 10 prior published attempts | 22 | Permits |
| One published prior attempt, two run/jobs pages and numeric-link lookup | 6 | Permits |
| One failed-publication attempt with complete single-tag inline-log repair proof | 10 | Permits synthetic proof; real log redirect NOT READY |
| 99 prior published attempts, 100 total runs on one page | 200 | Exact supported boundary |
| Same history plus one additional jobs page | 200 dispatched; 201st refused | NOT READY, never a safe prefix |
| 98 finished legacy attempts sharing exact workflow SHA | 199 | Permits, one immutable workflow read instead of 98 |
| 10 finished legacy attempts on distinct SHAs | 32 | Permits, all 10 workflow identities read |
| 110 prior published runs, or large 20-attempt histories | At most 200 | NOT READY |

For ordinary published history, cost is run-list pages + 1 current attempt +
2 per prior attempt, plus any additional jobs pages/normalization reads. Legacy
classification adds one read per distinct exact workflow SHA. Repair adds its
complete inventory, refs and distinct immutable objects plus original logs and
Release proof. A count that fits can still refuse for ambiguity, invalid
provenance, low quota or deadline. The structural 1,000-run / 20-attempt /
10,000-tag bounds do not mean those worst cases fit this budget.

## Refusal and recovery

A refusal stops the history phase before the existing plan command and hence
before version allocation/deploy. Mark unavailable/oversized/ambiguous cases
**NOT READY**, missing live evidence **NOT VERIFIED**. Never treat quota failure,
an incomplete collection, a cached mutable result, or absence of repair evidence
as safe history.

Retain sanitized candidate/run/attempt/SHA, request count from hermetic fixtures,
refusal category and exact-head Actions links. Do not retain tokens, raw provider
bodies or signed log URLs. For low/exhausted quota, end the transaction; a later
separately authorized invocation can reevaluate ordinary native headers after
other usage/reset. Do not sleep under the deploy lock or immediately retry
throttled requests. Honor any provider retry/reset delay outside the admission.

For oversized load, keep production disabled and route the smallest history
proof/discovery redesign through its existing owner. Do not raise this budget,
truncate history, waive an unpublished deployment, or increase token permissions
as an operational workaround. For publication ambiguity, preserve the original
frozen plan/logs and follow the separately authorized same-lock repair policy;
this reader performs no repair writes. Successful synthetic fixtures establish
only this envelope. Actual production/staging receipts remain **NOT VERIFIED**
unless independently established by existing release gates.

Focused fixtures are registered through `scripts/calver-build.acceptance.test.mjs`
and run by existing GitHub Actions test gates. Full suites and dry-run bundles run
in Actions, not locally; `checks/build-admission-budget.cmd` is a focused selector,
not a substitute for exact-head CI or permission to mirror it on a shared host.
