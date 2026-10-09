# R2 archive history and retention

## Keys and compatibility

After D1 succeeds, each table's report is copied to a new key:

```text
snapshot-history/YYYY-MM-DD/<UTC-ISO-timestamp-with-colons-and-dot-replaced-by-hyphens>-<UUID>/<table>.csv
```

For example, the timestamp portion is `2026-10-08T12-34-56-789Z`. The random
UUID prevents same-millisecond reruns from sharing a key. Date and timestamp
come from one clock read before sync, including runs that cross UTC midnight.
The writer never reuses a history key; these are append-only by convention,
not R2 object-lock enforcement. Tables are `customer`, `address`, `container`.

Each history CSV has a sidecar at `<CSV-key>.manifest.json`, in the existing
version-1 manifest format: `{ version, date, files: { "<table>.csv":
{ key, sha256, bytes } } }`. It records the exact stored bytes, not row data.

Publication order:

1. Write the history CSV, then copy the same bytes to
   `snapshots/YYYY-MM-DD/<table>.csv` (the **date alias**).
2. Write the immutable per-run integrity manifest next to the history CSV.
3. Update `snapshots/YYYY-MM-DD.manifest.json` with the date alias key.
4. Replace `snapshot-latest/<table>.json` with the per-run manifest. Its
   `files["<table>.csv"].key` is the history key, not the date alias.

The existing date read endpoint and `restoreSnapshotCsvFromR2` are unchanged:
they serve the last successfully copied CSV for that date. The date verifier
(`npm run verify:r2-manifest`) still verifies the mutable daily aliases. To
verify a historical run, read its sidecar and compare the referenced object's
SHA-256 and byte length. To select latest, read the per-table pointer and then
its referenced object; no bucket listing is needed.

A D1 failure writes no R2 objects. An R2 failure never undoes successful D1
work. The archive outcome is `failed` if either CSV copy (history or date
alias) did not land; the `reason` is prefixed `daily alias:` for the alias, and
the outcome `key` still names the history object. A failed run can leave a
history CSV with no sidecar and no pointer to it: treat it as unverified and do
not select it as latest. The outcome is `stored` plus a `reason` of the form
`manifest: <stage>: <message>` when both CSVs landed but the history sidecar,
the daily manifest or the latest pointer did not. That is an incomplete
publication, **not** a clean backup; earlier history remains recoverable. Latest
only advances after all writes above succeed. Overlapping writers are
last-completed-publication wins, not timestamp-sorted. Pointers and the daily
manifest do **not** promise a consistent three-table checkpoint; restore must
respect customer → address → container foreign-key order.

## Proposed retention policy — not enabled by this change

- **History:** propose expiration after **30 days from object upload** for the
  exact `snapshot-history/` prefix, including CSVs and their sidecars. R2 object
  age is not derived from the timestamp in the key. The CSV and sidecar have
  separate upload times and may expire at slightly different times.
- **Compatibility archives:** `snapshots/` stays outside this rule. One CSV per
  table per UTC date plus its daily manifest continues to be retained. This
  preserves the existing date-based restore contract; it is **not** a complete
  PII-retention solution. Any expiration of legacy daily aliases requires its
  own approved policy and restore-contract review.
- **Latest pointers:** `snapshot-latest/` stays outside the expiration prefix.
  These contain metadata only. After more than 30 days without a successful
  publication, a pointer can reference expired history: check object existence
  and report it as expired/unavailable, never as a successful backup. A retained
  daily alias may be used through the existing date restore path after verification.
- Keep the bucket private; CSVs contain customer PII. Access remains privileged,
  and no exports belong in logs, issues, or git. Held data must be excluded from
  expiry under an approved hold procedure before enabling the rule.

**No lifecycle rule is installed, no R2 delete is called, and no production sync is
run by this code change. Live bucket rules were not inspected.** Before enabling
expiration, an authorized operator must inventory the existing bucket rules and
matching objects, confirm the 30-day window and legal-hold treatment, obtain
required deletion approval, and prove restore using synthetic data in an isolated
staging bucket/D1 pair. Do not replace unrelated bucket rules.

R2 lifecycle rules can affect **already stored objects**. Objects are typically
removed within 24 hours of expiration, not at an exact deadline. Enabling a rule
can therefore permanently delete old matching data; removing/disabling a rule
only stops future expiry and cannot recover deleted objects. Do not activate
retention as part of an ordinary deploy or rollback.

## Verification and rollback

`npm test -- test/r2SnapshotHistory.test.ts` runs two real local D1/R2 syncs
with a frozen millisecond, checks both CSVs and both integrity sidecars remain,
and proves daily and latest pointers select the second run. It also covers UTC
offsets, a midnight boundary, and publication failures. No upstream fetch or
remote binding is used; test bindings must remain synthetic.

Rollback the code with a reviewed revert: the old writer continues using daily
aliases, while new history objects remain untouched. Latest pointers then stop
advancing and must be treated as stale. Code rollback does not remove lifecycle
rules; rule changes require their own authorized rollback and do not restore
expired data.

## Official references

- [R2 Workers API: put, metadata, and consistency](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 object lifecycles: prefixes, existing objects, and expiry timing](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
