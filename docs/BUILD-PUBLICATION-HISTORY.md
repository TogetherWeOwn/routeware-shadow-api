# Complete build publication history discovery

**Production stays off.** This describes read-only admission before the dormant
build planner, not permission to deploy, publish, change credentials or enable a
workflow. The [build/API version contract](VERSIONING.md#separate-deployment-build-identity-dormant),
exclusive deployment lock, per-attempt job proof and repaired-publication
provenance are unchanged.

## Provider contract, not a larger search cap

GitHub's [List workflow runs for a workflow](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow)
endpoint lists all runs of the selected workflow. It documents a maximum of
1,000 results **for searches using** `actor`, `branch`, `check_suite_id`,
`created`, `event`, `head_sha` or `status`. `per_page` supports up to 100 records;
`page` selects the continuation. The guard previously used `branch=main&event=push`,
which imposed that search cap on non-deploying main pushes too.

Discovery now requests only:

```text
GET /repos/TogetherWeOwn/routeware-shadow-api/actions/workflows/ci.yml/runs?per_page=100&page=1
```

It sends **none** of the search filters, follows every validated `rel="next"`,
and selects `event == push && head_branch == main` locally, only after proving
the full workflow inventory. It does not infer skipped deployment from the run
list's status or conclusion. Pull-request, scheduled and other non-main-push
runs are accounted for in the inventory, but are not production transactions.
No date/ID partition, timestamp ordering assumption, age cutoff, persisted
checkpoint, authority-bearing baseline or deletion of obligations is introduced.
Equal timestamps on and across page boundaries have no special meaning.

The provider does not document a transactional snapshot or a sort guarantee.
Accordingly the guard does not rely on either. It requires a valid unchanged
`total_count` on every page, exact unique record cardinality, validated
repository/workflow/SHA identity, and an independently complete second inventory
**after** the attempt proofs. Both inventories must have the identical run IDs,
immutable identities and latest attempt counts; order and advancing execution
status do not matter. A new/deleted run, changed attempt, count drift, missing
record or duplicate (including two versions of a rerun) refuses rather than
collapsing records. This is a completeness proof under the documented all-runs
endpoint and a coherent provider response, not independent detection of a
provider that consistently lies about its own inventory. Two equal inventories
are not an atomic quota reservation or a claim that unrelated CI activity stops.
The existing exclusive production lock remains necessary.

### Retained history is an independent prerequisite

GitHub [supports deleting workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#delete-a-workflow-run).
Deletion/retention before admission is not a lying provider. The guard also
validates the documented [workflow run-number sequence](https://docs.github.com/en/actions/reference/workflows-and-actions/variables):
it starts at 1, increments per new workflow run, and is unchanged on a rerun.
Every row needs a unique run number in `1..total_count`. Together with exact
cardinality this proves a gap-free retained prefix and rejects missing first or
interior records, even when both inventories truthfully omit a deleted record.
No timestamp or unverified ID cutoff substitutes for this check.

That cannot detect a whole deleted suffix (especially when the current run is
an older rerun), or the destruction/recreation of an entire workflow lineage.
The REST listing cannot reconstruct such missing transactions. **Uninterrupted
retention and workflow lineage must be independently qualified before production
activation**; listing success alone is not that evidence. Any known deletion,
expired evidence or replacement of history is NOT READY; absent qualification is
NOT VERIFIED, not permission to allocate from a fresh-looking list. No new
checkpoint, synthetic baseline or deletion of obligations is introduced here.
The dormant gate stays off while that prerequisite is unverified. This is a
retained-history completeness proof, not an all-time deletion-proof ledger.

## Evidence and refusal

Every selected main-push run retains every attempt from 1 through its listed
`run_attempt`, including earlier attempts of the current run. Only the exact
current still-running attempt is excluded from unfinished publication checks,
after its independently read repository/workflow/SHA identity matches.

Each other attempt still needs its exact metadata and complete job inventory,
with the numeric repository ID bound across discovery and independent metadata.
Terminal skipped jobs, unstarted queued/cancelled jobs, exact historical workflow
source and explicit repaired publication retain their existing rules. A queued
job can start later, so its no-start exemption additionally requires exact
reviewed historical workflow bytes proving the same exclusive deployment lock. A whole
run's success/skipped conclusion, a missing deploy job, or a later successful
rerun cannot erase an earlier ambiguous or unpublished deployment. All reads
remain injected GETs. Numeric repository pagination aliases need the independent
canonical repository-ID lookup; foreign origins/repositories, changed filters,
cycles or non-continuing links refuse.

## Explicit bounds and request accounting

The existing physical collection bound is 50 pages at 100 records/page: at most
5,000 **all-workflow runs**, not 5,000 guaranteed deploy transactions. Per-page
record overflow, a declared count above that envelope, absent continuations or
incomplete final totals refuse. This bound limits memory and traversal, not the
provider's search cap: reaching any bound never authorizes a safe-looking prefix.
The existing maximum is 20 attempts/run; job collections retain the same
50-page bound. Memory is O(all workflow runs + selected attempts + one bounded
job collection); there is no unbounded accumulated job history.

For canonical pagination, let `P` be workflow inventory pages, `A` the number of
prior attempts including earlier current-run attempts, and `J` their total job
pages. The ordinary no-repair/no-workflow-read proof costs exactly
`2P + 1 + A + J` GETs. Add immutable workflow reads where classification or
repair needs them, independently validated numeric-link identity lookups, and
all repair inventory/ref/object/Release/original-log reads. Those are not free.
Examples below are hermetic fixture counts, not production API experiments:

| Fixture | Complete discovery GETs (both passes) | Ordinary complete proof GETs |
| --- | ---: | ---: |
| Current run + one prior terminal skipped job | 2 | 5 |
| 1,002 main pushes, 1 attempt each, prior deploy jobs terminal skipped | 22 | 2,025 |
| Same, prior run has 3 attempts and current run has 2 | 22 | 2,031 |
| 5,000 all-workflow records, existing discovery envelope | 100 | Depends on selected attempts |
| 5,000 main pushes × 20 attempts, one job page each (structural maximum) | 100 | 200,099 |

The last row is arithmetic over the fixture shape, **not** a practical supported
admission or an executed 200,099-request test. With 50 job pages/attempt it would
already need 5,100,050 GETs before additional workflow/repair/alias reads.
Practical request/time/rate limits remain an independent, stricter gate. In
particular a 200-GET admission budget cannot prove 1,001 prior main pushes with
this unchanged per-attempt REST evidence: it must return **NOT READY**, never
approve from discovery alone, cache mutable jobs, change credentials, or silently
skip an obligation. Removing the discovery cap is not a claim that such live
history fits a workflow token. Production activation needs separate evidence
and authorization; missing quota/staging/production receipts stay NOT VERIFIED.

The `proveBuildPublicationHistory(context, read)` seam proves metadata with a
strictly bounded injected synthetic reader; it neither constructs a transport
nor allocates/publishes a version. Production uses `assertBuildPublicationHistory`
and the independent practical admission reader without fixture overrides.
A synthetic proof that uses 2,025 reads is not a 200-GET production admission.

Focused synthetic regression entry: `checks/build-history-discovery.cmd`.
The fixtures pin complete >1,000-run discovery/proof, enumeration boundaries,
changing/incomplete inventories, equal timestamps, reruns, terminal skipped
job evidence, ambiguous deployment and missing publication. Existing repair and
lock-wiring controls stay registered. Full verification is GitHub Actions for
the exact PR head; no live workflow dispatch or production load is needed.
