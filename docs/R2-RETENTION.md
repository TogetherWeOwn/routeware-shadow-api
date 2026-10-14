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

Each history CSV has a per-run manifest at `<CSV-key>.manifest.json`, in the existing
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
verify a historical run, read its per-run manifest and compare the referenced object's
SHA-256 and byte length. To select latest, read the per-table pointer and then
its referenced object; no bucket listing is needed.

A D1 failure writes no R2 objects. An R2 failure never undoes successful D1
work. The archive outcome is `failed` if either CSV copy (history or date
alias) did not land; the `reason` is prefixed `daily alias:` for the alias, and
the outcome `key` still names the history object. A failed run can leave a
history CSV with no per-run manifest and no pointer to it: treat it as
unverified and do not select it as latest. The outcome is `stored` plus a `reason` of the form
`manifest: <stage>: <message>` when both CSVs landed but the per-run
manifest, the daily manifest or the latest pointer did not. That is an incomplete
publication, **not** a clean backup; earlier history remains recoverable. When
the `history manifest` or `daily manifest` stage fails, the date alias holds
this run's bytes while `snapshots/YYYY-MM-DD.manifest.json` still records the
previous run's hash, so `npm run verify:r2-manifest` reports a mismatch for that
table until a later publication for the same UTC date succeeds. The cron summary
line prints no `r2:` suffix for `stored`, so read the `reason` in the JSON
line. Latest only advances after all writes above succeed. Overlapping writers are
last-completed-publication wins, not timestamp-sorted. Pointers and the daily
manifest do **not** promise a consistent three-table checkpoint; restore must
respect customer → address → container foreign-key order.

## Proposed retention policy — not enabled by this change

- **History:** propose expiration after **30 days from object upload** for the
  exact `snapshot-history/` prefix, including CSVs and their per-run manifests. R2 object
  age is not derived from the timestamp in the key. The CSV and its manifest have
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

The proposed rule JSON and hold procedure are recorded in
`R2-LIFECYCLE-PROPOSAL.md` (TOG-19231); the rule remains not enabled.

## Customer-row erasure leaves R2 untouched (TOG-18933)

`DELETE /api/v1/customer-snapshot/{customerId}` writes an id-only D1
tombstone and deletes the D1 `customer_snapshot` row in the same D1 batch, then
evicts the data-entity cache entry. If the customer has address children, the
FK rejects the delete and the batch rolls back, so neither the customer nor a
new tombstone is left changed. An absent customer still returns 404. A D1
tombstone suppresses the customer on later sync, proxy-save refresh, and
CSV/archive import. D1 triggers enforce this at the table write boundary,
including direct customer upserts. The existing `upserted` and `rowCount`
results count candidate input rows, including suppressed rows, not the number of
rows retained in D1. Verify the stored row state rather than treating those
counts as proof of restoration.

**Current implementation limitation:** only customer writes are suppressed.
If a later upstream report, detail-full refresh, or archive also contains
addresses for a suppressed customer, those writes still fail the existing D1
foreign key. A combined sync or restore stops at that address failure and does
not reach containers; a proxy-save refresh reports its existing sync-failure
outcome. Suppression does not bypass FKs or silently delete/skip descendants.
Do not treat successful customer-only regression tests as proof that a complete
three-table replay succeeds. Descendant handling requires an explicit scope
choice before this candidate is ready for release.

This is local cache suppression, not upstream Routeware erasure. Tombstones
contain only `customer_id` and `erased_at`; they have no automatic expiry and
remain until explicitly removed. Do not remove one while upstream or any
retained archive/backup can return the customer; once the data sources and
recovery windows have been verified clear, removal of the marker permits future
imports again. No operation here deletes upstream data or decides a legal
retention period for the marker.

It does not remove R2 history CSVs, daily aliases, latest pointers, or the
archived-CSV readback. Those copies keep serving through the existing date read
endpoint and restore path until a separately approved retention rule removes
them. Other edge locations and clients may keep serving the erased PII until the
60 s cache TTL expires. A CSV/R2 import into a database with the
suppression schema skips tombstoned customer rows. Restoring a D1 backup from
before the erasure can restore both the customer row and a schema without the newer
tombstone table/triggers; after D1 Time Travel or backup restore, verify the
schema, reconcile the suppression list from a retained source, and re-apply
erasures before serving traffic. Time Travel can restore data for up to 30 days
(7 days on the Workers Free plan).

This route removes only the `customer_snapshot` row: the customer's
`address_snapshot` and `container_snapshot` rows are not removed by this
route. There is no address or container DELETE route.

## Verification and rollback

`npm test -- test/r2SnapshotHistory.test.ts` runs two real local D1/R2 syncs
with a frozen millisecond, checks both CSVs and both per-run manifests remain,
and proves daily and latest pointers select the second run. It also covers UTC
offsets, a midnight boundary, and publication failures. No upstream fetch or
remote binding is used; test bindings must remain synthetic.

Rollback the code with a reviewed revert: the old writer continues using daily
aliases, while new history objects remain untouched. Latest pointers then stop
advancing and must be treated as stale. Code rollback does not remove lifecycle
rules; rule changes require their own authorized rollback and do not restore
expired data.

## Suppression rollback and recovery

The migration is additive. Rolling application code back does not remove the
`tombstone` rows or the D1 triggers, so markers already recorded continue to
suppress writes. The rolled-back DELETE handler will not record tombstones for
new erasures; do not use it for new erasure requests unless a separate approved
procedure covers suppression. Do not drop the table or triggers as part of an
application rollback: doing so discards suppression state and reopens every
write path. A full D1 restore may also rewind schema and markers; verify both
before normal writers resume and restore suppression from the authorized
retained source. A reviewed application revert is the rollback; schema/data
removal is not an automatic rollback step.

## Official references

- [R2 Workers API: put, metadata, and consistency](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 object lifecycles: prefixes, existing objects, and expiry timing](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
