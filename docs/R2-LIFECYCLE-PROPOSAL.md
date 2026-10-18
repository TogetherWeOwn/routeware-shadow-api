# Proposed R2 lifecycle rule: `snapshot-history/` 30-day expiry

**Status: PROPOSED ONLY — not enabled.** No lifecycle rule is installed, no R2
object is deleted, and no deploy is changed by this proposal. Enablement is
R5-16 work: it needs the staging evidence chain, deletion
approval, and a recorded operator step with the exact command and rollback. Parent context:
`R2-RETENTION.md` (the retention policy those docs call "proposed, not
enabled").

## Proposed rule

File: `r2-lifecycle-proposal.snapshot-history.json`. The JSON body is exactly the
S3 `PutBucketLifecycleConfiguration` request shape from the
[R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
docs — no extra keys, so the file stays a byte-clean S3/REST request body. It is
**not** the shape `wrangler r2 bucket lifecycle set --file` accepts: per those
same docs, `set --file` takes the Cloudflare REST put-object-lifecycle-configuration
body and sets the bucket's **entire** configuration (replacing every existing
rule, including the default 7-day multipart-abort rule), so the file is not
appliable via `set`. The R5-16 apply path is the additive
`wrangler r2 bucket lifecycle add` command (hold procedure, step 4), which adds
one rule and leaves existing rules untouched — with `Status: Enabled` recording
the as-applied intent, not current state. The PROPOSED-ONLY warning lives here
in this doc, not in the JSON:

| Field | Proposed value | Why |
|---|---|---|
| `ID` | `snapshot-history-30d-expiry` | Unique, human-readable; identifies the rule in `lifecycle list` output |
| `Filter.Prefix` | `snapshot-history/` (trailing slash) | Matches per-run history CSVs **and** their per-run manifests, nothing else |
| `Expiration.Days` | `30` | 30-day age threshold; upload-age is the intended policy, but Cloudflare's page does not explicitly document the age anchor (see § Existing-object semantics) |
| `Transitions` | absent | No Infrequent-Access transition is proposed, so no expire-vs-transition precedence question arises |

### Prefix scoping (verified offline)

- `snapshot-history/` matches `snapshot-history/YYYY-MM-DD/<run>/<table>.csv`
  and `<CSV-key>.manifest.json` (key layout in `R2-RETENTION.md#keys-and-compatibility`).
- It does **not** match `snapshots/` (date aliases) or `snapshot-latest/`
  (pointers): the shared `snapshot` stem is not a match — the filter is a
  literal string prefix, and neither alias key starts with `snapshot-history/`.
  The trailing slash additionally excludes any hypothetical
  `snapshot-history2/...` key. Verified with sample keys in § Validation.
- Manifest and CSV expire independently: if upload age is the effective anchor,
  a CSV and its manifest become eligible moments apart (CSV first, uploaded
  moments apart within a single run). Actual removal is typically within
  24 hours of expiration with no documented order, so either object can outlive
  the other. A history CSV with no manifest at all is an incomplete publication.
  Treat an unpaired CSV, or a manifest whose CSV is missing, as unverified
  (per `R2-RETENTION.md`), never as latest.

### Existing-object semantics (per the R2 lifecycle docs)

- The rule applies to **already stored objects**, not just future uploads.
  New uploads reflect `x-amz-expiration` immediately; existing objects are
  migrated to the new configuration, typically within 24 hours but longer for
  large buckets. While migration runs, old/stale rule evaluations may still appear.
- Deletion is **not** at an exact deadline: objects are typically removed within
  24 hours of expiration.
- The R2 lifecycle page describes age-based rules as objects older than the
  configured number of days, but does not explicitly identify the age anchor as
  upload time or `LastModified`. Therefore the proposal's upload-age interpretation
  is an intended policy, not a vendor-verified semantic. Do not claim that key
  dates are ignored or enable the rule until the age anchor is confirmed.
- A deleted object is no longer billable and cannot be restored by removing the
  rule. Cloudflare documents removing a rule, but does not specify whether removal
  cancels expirations already evaluated or pending deletion. Rule removal is a
  configuration rollback only; it is not verified as a guarantee against pending
  deletes or as data recovery.

### What this rule does not do (residual PII, stated plainly)

- Date aliases under `snapshots/` and pointers under `snapshot-latest/` are
  outside the rule and keep serving until a separately approved policy removes
  them. Expiring history alone is **not** a complete PII purge.
- Customer-row erasure (`DELETE /api/v1/customer-snapshot/{customerId}`)
  leaves R2 untouched (see `R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched`);
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
   (outside every lifecycle prefix). For each CSV, compare SHA-256 and byte length
   with the per-run manifest. The per-run manifest describes CSVs, not itself; if
   copying a manifest, compare its copied bytes with the source manifest instead
   of treating it as self-hashed. If a held CSV has no manifest, compare the
   hold copy directly against the source CSV by SHA-256 and byte length; the
   publication still stays unverified, never latest. These are application-level integrity checks,
   not guarantees supplied by R2 lifecycle. The original stays until step 4
   passes — the hold copy is verified first, never assumed.
3. **Inventory before touching anything.** The operator lists existing bucket
   rules (`wrangler r2 bucket lifecycle list <BUCKET>`) and the objects the new
   rule would match, confirms the 30-day window and the hold copies, and
   confirms no unrelated rule is modified. Wrangler 4.84.1 implements `add` as
   GET-current-rules, append the new rule, then PUT the complete list; it is not
   atomic with respect to another lifecycle edit. Serialize lifecycle changes
   through apply and rollback, and compare the full rule set immediately before
   and after. This inventory, the deletion approval, and a synthetic-data restore
   proof in an isolated staging bucket/D1 pair are preconditions, not footnotes
   (see `R2-RETENTION.md`).
4. **Enable only via a recorded R5-16 operator step** (exact command + rollback),
   after the staging evidence chain lands. The command is additive:
   `wrangler r2 bucket lifecycle add <BUCKET> snapshot-history-30d-expiry snapshot-history/ --expire-days 30`
   ([`r2 bucket lifecycle add`](https://developers.cloudflare.com/workers/wrangler/commands/r2/#r2-bucket-lifecycle-add)).
   Never `lifecycle set --file`: `set` replaces the whole configuration and would
   delete the default 7-day multipart-abort rule and any other live rules,
   violating the `R2-RETENTION.md` "do not replace unrelated bucket rules"
   precondition. `set --file` also expects the Cloudflare API shape (a `rules`
   array, rejected otherwise), so the S3-shaped proposal file (`Rules`) is not
   accepted by `set` — verified against the Wrangler 4.84.1 sources. Rollback is
   `lifecycle remove <BUCKET> --name snapshot-history-30d-expiry`; verify via
   `lifecycle list` that the exact prior rule set is restored. This restores
   configuration only and is not proof that already-evaluated expiry work is
   cancelled or that deleted data can be recovered.
5. **Release needs its own approval.** A hold copy is deleted only under a new
   recorded approval naming the matter id; expiry of the hold itself is set at
   hold creation and recorded in the register.

## Validation

Validated offline 2026-10-09/10 with a scratch Node script (no credentials, no
network): the JSON parses and carries no top-level keys besides `Rules`
(byte-clean request body); `Rules` is a 1-entry array (limit 1000); rule `ID`
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
  pre-apply check is `lifecycle list` readback on the **staging** bucket during
  R5-16 (before, to confirm no conflicting rule; after, to confirm the added
  rule): neither `lifecycle add` nor `lifecycle set` offers a dry-run mode.
- Cloudflare's object-lifecycle page does not explicitly identify the age anchor
  used by `Expiration.Days` (for example, upload time or `LastModified`). The
  policy's upload-age meaning is therefore not vendor-verified and must not be
  represented as a confirmed guarantee.
- Cloudflare documents removing a lifecycle rule but does not specify whether
  removing it cancels expirations already evaluated or pending deletion. Wrangler
  readback confirms configuration, not cancellation of queued expiry work.
- Wrangler 4.84.1 CLI syntax and implementation were checked against the
  lockfile-pinned package sources. `add` reads, appends, and PUTs the full rule list;
  `remove` reads, removes the named rule, and PUTs the list. The read-modify-write
  sequence is not atomic against concurrent lifecycle edits, so the operator must
  serialize changes and compare the full rule set before/after. `set --file`
  replaces the full rule list and expects Cloudflare API JSON (`rules`), not this
  S3-shaped `Rules` request file.
- Tag-condition support in R2 lifecycle filters was not verified from the docs;
  the hold procedure therefore avoids tags entirely.
- Live bucket rules were not inspected (no credentials used); the pre-enablement
  inventory in the hold procedure covers this.

## Out of scope (explicit)

Enabling the rule; deleting any R2 object; staging or production deploys;
changing writer, restore, or verifier code; expiring `snapshots/` or
`snapshot-latest/`; any new CI check or scheduled job.
