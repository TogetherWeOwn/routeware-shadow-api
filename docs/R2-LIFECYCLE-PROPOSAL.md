# Proposed R2 lifecycle rule: `snapshot-history/` 30-day expiry (TOG-19231)

**Status: PROPOSED ONLY — not enabled.** No lifecycle rule is installed, no R2
object is deleted, and no deploy is changed by this proposal. Enablement is
R5-16 work: it needs the staging evidence chain (TOG-18890..92), deletion
approval, and an `Operator:` card with the exact command and rollback. Parent context:
`R2-RETENTION.md` (the retention policy those docs call "proposed, not
enabled").

## Proposed rule

File: `r2-lifecycle-proposal.snapshot-history.json`. The JSON body is the
S3 `PutBucketLifecycleConfiguration` request shape from the
[R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
docs (the same shape `wrangler r2 bucket lifecycle set --file` accepts), with
`Status: Enabled` recording the as-applied intent — not current state:

| Field | Proposed value | Why |
|---|---|---|
| `ID` | `snapshot-history-30d-expiry` | Unique, human-readable; identifies the rule in `lifecycle list` output |
| `Filter.Prefix` | `snapshot-history/` (trailing slash) | Matches per-run history CSVs **and** their per-run manifests, nothing else |
| `Expiration.Days` | `30` | 30 days from object upload, matching the window in `R2-RETENTION.md` |
| `Transitions` | absent | No Infrequent-Access transition is proposed, so no expire-vs-transition precedence question arises |

### Prefix scoping (verified offline)

- `snapshot-history/` matches `snapshot-history/YYYY-MM-DD/<run>/<table>.csv`
  and `<CSV-key>.manifest.json` (key layout in `R2-RETENTION.md#keys-and-compatibility`).
- It does **not** match `snapshots/` (date aliases) or `snapshot-latest/`
  (pointers): the shared `snapshot` stem is not a match — the filter is a
  literal string prefix, and neither alias key starts with `snapshot-history/`.
  The trailing slash additionally excludes any hypothetical
  `snapshot-history2/...` key. Verified with sample keys in § Validation.
- Manifest and CSV expire independently: they have separate upload times, moments
  apart within a single run (CSV first, manifest second), so they expire moments
  apart — never a publication interval apart, and the CSV always goes first. A
  history CSV with no manifest at all is an incomplete publication. Treat an
  unpaired CSV as unverified (per `R2-RETENTION.md`), never as latest.

### Existing-object semantics (per the R2 lifecycle docs)

- The rule applies to **already stored objects**, not just future uploads.
  New uploads reflect `x-amz-expiration` immediately; existing objects are
  migrated to the new configuration, typically within 24 hours but longer for
  large buckets. While migration runs, old/stale rule evaluations may still appear.
- Deletion is **not** at an exact deadline: objects are typically removed within
  24 hours of expiration.
- Age is counted from **object upload (LastModified), never from the timestamp
  embedded in the key**. Key dates and upload dates differ for backfills and
  republished runs; only upload age matters.
- A deleted object is no longer billable. Disabling/removing the rule stops
  **future** expiry only — it never recovers deleted objects.

### What this rule does not do (residual PII, stated plainly)

- Date aliases under `snapshots/` and pointers under `snapshot-latest/` are
  outside the rule and keep serving until a separately approved policy removes
  them. Expiring history alone is **not** a complete PII purge.
- Customer-row erasure (`DELETE /api/v1/customer-snapshot/{customerId}`)
  leaves R2 untouched (see `R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched-tog-18933`);
  erased rows reappear on re-sync/restore while upstream holds them.

## Hold procedure for legal/owner keeps

Held data must be excluded from expiry **before** the rule is enabled. R2
lifecycle filters are prefix-based in the documented examples; tag-filter
support is unverified (see § Validation gaps), so holds use a hold prefix, not
object tags:

1. **Register the hold out of band.** Owner/legal records the matter id, the
   held scope (date ranges and/or exact history keys), and a review cadence in a
   hold register outside the repo (holds, like erased `customerId`s, are not
   tracked by the API). No exports belong in logs, issues, or git — held keys
   contain customer PII.
2. **Copy held objects aside.** Before enablement, the authorized operator
   copies each held object to `legal-hold/<matter-id>/<original-key-suffix>`
   (outside every lifecycle prefix) and verifies SHA-256 + byte length against
   the per-run manifest. The original stays until step 4 passes — the hold copy
   is verified first, never assumed.
3. **Inventory before touching anything.** The operator lists existing bucket
   rules (`wrangler r2 bucket lifecycle list <BUCKET>`) and the objects the new
   rule would match, confirms the 30-day window and the hold copies, and
   confirms no unrelated rule is modified. This inventory, the deletion
   approval, and a synthetic-data restore proof in an isolated staging bucket/D1
   pair are preconditions, not footnotes (see `R2-RETENTION.md`).
4. **Enable only via the R5-16 `Operator:` card** (exact command + rollback),
   after TOG-18890..92 staging evidence lands.
5. **Release needs its own approval.** A hold copy is deleted only under a new
   recorded approval naming the matter id; expiry of the hold itself is set at
   hold creation and recorded in the register.

## Validation

Validated offline 2026-10-09 with a scratch Node script (no credentials, no
network): the JSON parses; `Rules` is a 1-entry array (limit 1000); rule `ID`
is non-empty and unique; `Status` is `Enabled`; `Filter.Prefix` is the string
`snapshot-history/`; `Expiration` carries exactly one of `Days`/`Date`
(`Days: 30`, positive integer); no `Transitions` element; sample keys confirm
`snapshot-history/2026-10-09/<run>/customer.csv` (+ `.manifest.json`) match
while `snapshots/2026-10-09/customer.csv` and
`snapshot-latest/customer.json` do not.

### Validation gaps (stated, not hidden)

- Validated against the **documented S3 shape and constraints** in the R2
  lifecycle docs, not against a published machine-readable R2 lifecycle schema —
  Cloudflare publishes no downloadable JSON Schema for it. The authoritative
  pre-apply check remains `wrangler r2 bucket lifecycle set --file` dry-run
  output plus `lifecycle list` readback on the **staging** bucket during R5-16.
- Tag-condition support in R2 lifecycle filters was not verified from the docs;
  the hold procedure therefore avoids tags entirely.
- Live bucket rules were not inspected (no credentials used); the pre-enablement
  inventory in the hold procedure covers this.

## Out of scope (explicit)

Enabling the rule; deleting any R2 object; staging or production deploys;
changing writer, restore, or verifier code; expiring `snapshots/` or
`snapshot-latest/`; any new CI check or scheduled job.
