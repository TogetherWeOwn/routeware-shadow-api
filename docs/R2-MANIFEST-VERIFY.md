# Daily R2 manifest verifier

Use `npm run verify:r2-manifest -- --help` for flags. This read-only verifier
checks the v1 daily sidecar `snapshots/YYYY-MM-DD.manifest.json`, not
`snapshot-history/` or latest pointers. Archive writes/layout are unchanged.

## Choose coverage before reading

Default verification is **listed-only (partial)**: every listed entry must pass,
but the manifest may list only one table. PASS does **not** prove omitted tables
were archived. For an intentional one-table recovery, use `--expect=customer`.
For full-chain coverage, explicitly require all three tables:

```bash
node scripts/verify-r2-manifest.mjs --date="$DATE" --bucket="$BUCKET" \
  --persist-to "$RUN/state" --expect=customer,address,container --json
```

`--expect` accepts a nonempty, unique subset of the bare table names, in any order.
Unknown names, duplicates, empty selections and invalid dates exit 2 **before any
object read or child process**. A missing expected entry fails even if the manifest
omitted it; coverage failures stop before CSV reads. All listed files are checked,
including listed files outside an explicit expected subset.

Local mode is the credential-free default. For an **already authorized** remote
read, replace `--persist-to "$RUN/state"` with `--remote`. Remote execution requires
`CLOUDFLARE_API_TOKEN` injected in the environment and forbids `--persist-to`.
Never pass or print the token. This command provides no new remote authorization.

Add `--dry-run` to validate the requested date, mode and expected coverage with
**zero child processes, object reads or artifact changes**, even with `--remote`
and no token. `dryRun:true, ok:true` means a valid plan, not archive verification;
`verifiedTables` is empty. Dry-run never grants remote authorization.

## Interpretation and recovery

The parser validates the requested real canonical calendar date, nonempty map,
recognized names, exact `snapshots/<requested-date>/<table>.csv` key, 64-digit
lowercase SHA-256 and safe nonnegative integer byte count **before CSV reads**.
The pure comparison also rejects duplicate/ambiguous observations and compares
actual keys, not just names/hashes. Zero verified entries cannot pass.

PASS proves key/hash/byte coverage only: not cross-table consistency, trusted
provenance, import compatibility, row count or permission to restore. Daily keys
are mutable. Follow [the recovery runbook](R2-RESTORE-RUNBOOK.md) and verify the
**specific downloaded bytes** to be imported; an earlier audit is not a lock.
Stop on failure. Never repair/regenerate a sidecar to make an archive pass.

## Machine results (v1)

Direct `node ... --json` emits one JSON object on stdout and no stderr. Avoid
`npm run` banners when stdout is a machine transport. The checked-in contract is
[r2-manifest-result.schema.json](r2-manifest-result.schema.json).

- `schemaVersion:1`, `checkId:"r2-manifest"`, `ok`, validated `date` (or `null` on
  argument errors), `mode:"local"|"remote"`, `dryRun`.
- `coverage:{kind:"listed-only"|"expected-tables", expectedTables, verifiedTables}`;
  arrays contain sorted bare table names. Listed-only has `expectedTables:[]`.
- `checks:[{id,status:"pass"|"fail"}]` records stages actually reached, not implied
  passes for skipped stages. IDs: `r2-manifest.arguments`, `.plan` (dry-run only),
  `.credentials`, `.manifest`, `.coverage`, `.object.<table>`.
- `findings:[{id,code,message,retryable:false,next_action,table?}]` has fixed IDs,
  codes and remediation; only recognized table names enter per-table findings.
  Arrays are bounded to 32 entries each (currently at most seven checks and three
  findings), messages/actions to 256 characters. Total output is below 32 KiB.
  No CSV bytes, unvalidated manifest values, raw driver stderr, persistence paths or tokens
  appear. Human hash diagnostics contain only validated hex digests and counts.

| Code | Finding suffix | Action |
|---|---|---|
| `R2_ARGUMENT_INVALID` | `.arguments` | Fix flags from `--help`; no execution occurred. |
| `R2_REMOTE_CREDENTIAL_REQUIRED` | `.credentials` | Use local mode or authorized environment injection; never switch credentials after an auth failure. |
| `R2_OBJECT_MISSING` | `.manifest-read` or `.object.<table>` | Stop; privately confirm object availability and reader access. Any reader failure uses this code: it means **missing or unreadable**, not confirmed absence. |
| `R2_MANIFEST_INVALID` | `.manifest-schema` | Stop; select a known-good daily archive and investigate publication, not sidecar repair. |
| `R2_EXPECTED_TABLE_MISSING` | `.expected.<table>` | Stop full-chain recovery; choose a complete archive, not an unapproved narrower expectation. |
| `R2_HASH_MISMATCH` | `.object.<table>` | Stop; object identity/hash/size mismatch makes the archive suspect. |

Every suffix is prefixed by `r2-manifest`. Codes and IDs do not incorporate
untrusted values. Exit 0 = PASS or valid plan; 1 = verification/credential failure;
2 = invalid arguments. Reads use installed Wrangler only (`npx --no-install`),
with a 120-second timeout, 64 KiB sidecar bound and the existing 256 MiB CSV
in-memory bound per child. No automatic retry occurs; an oversize/failed reader
fails closed. Large-object streaming is not added.

## Hermetic acceptance check

```bash
npm run check:r2-manifest
```

Runs protected pure fixture tests plus the fake-npx CLI suite; **no Wrangler/R2
operations or credentials**. CLI tests detect child attempts, network access and
even temporary artifact mutations. The CLI suite is also part of `test:probe`
(and therefore `npm test`, coverage and CI hygiene). Both CLI and parser share
`scripts/lib/r2ManifestVerify.mjs` for date/key/schema validation; do not add a
second validator to a wrapper or runbook.
