# Security remediation — leaked credentials & PII in git history

**Status: OUTSTANDING.** Nothing in this document has been executed. It exists so the work
is not lost, and so it is done in the right order.

## What is exposed

Commit `4e219dd` (the repo's first commit, an ancestor of `main`) still contains,
retrievable today by anyone with read access via `git show`:

| Item | Detail |
|---|---|
| `LOGIN_USERNAME`, `LOGIN_PASSWORD` | Real Routeware tenant credentials, in `wrangler.toml` |
| `CUSTOMER_SNAPSHOT_SYNC_SECRET` | Real value; gates the privileged `/api/v1/data/*` and sync routes |
| 3 × `*.csv` report exports | ~609,000 rows of real customer / address / container PII |

Commit `405fad7` ("secret/PII purge") removed these from the working tree but **did not
rewrite history**, so every blob is still reachable from `main`.

Current exposure is limited — the repo is **private**, has **0 forks**, **no open PRs**, and
**one collaborator** (`Rick7C2`) — but the values have left the trust boundary and must be
treated as compromised.

## Order matters

**Rotate first, purge second.** Purging history without rotating is cosmetic: anyone who
cloned before the purge keeps the credentials forever. Rotation is what actually revokes
access; the purge only stops *future* readers.

---

## Step 1 — Rotate (first, and independently of everything else)

Only the repo owner can do this; it is deliberately outside what the agent tooling may run
(`wrangler secret put` is denied in `.claude/settings.json`).

1. Change the Routeware tenant password for the `API` login in the Routeware UI.
2. Push the new values as Worker secrets — never into `wrangler.toml`:
   ```bash
   npx wrangler secret put LOGIN_USERNAME
   npx wrangler secret put LOGIN_PASSWORD
   npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET
   npx wrangler secret put SHADOW_API_TOKEN
   ```
3. Update your local `.dev.vars` (gitignored) to match.
4. Confirm the deployed Worker still authenticates, then confirm the **old** sync secret is
   now rejected with a 401.

After step 1 the incident is contained even if step 2 never happens.

## Step 2 — Purge the blobs from history

### Use `git-filter-repo`, not `sed`

This was tested on a throwaway clone. A hand-rolled `git filter-branch` + `sed` filter
**silently fails** on the real password, because it contains `@@$$` — `$` is a regex
metacharacter, so the substitution never matches and the credential survives while the run
reports success. Removing the CSVs that way works fine; scrubbing the credential does not.

`git-filter-repo --replace-text` does **literal** (non-regex) replacement and is the correct
tool. It is not installed here and `pip install` is blocked by PEP 668, so install it into a
venv or via your package manager:

```bash
python3 -m venv ~/.venvs/filter-repo && ~/.venvs/filter-repo/bin/pip install git-filter-repo
export PATH="$HOME/.venvs/filter-repo/bin:$PATH"
# or: sudo apt install git-filter-repo
```

### Run it on a fresh mirror

```bash
# 1. Back up first — this is irreversible.
git clone --mirror https://github.com/Rick7C2/routeware-shadow-api rsa-backup.git
tar czf rsa-backup-$(date +%F).tar.gz rsa-backup.git

# 2. Fresh mirror to rewrite.
git clone --mirror https://github.com/Rick7C2/routeware-shadow-api rsa-purge.git
cd rsa-purge.git

# 3. Build the literal replacement list. Extract the real values into an UNTRACKED file —
#    never commit it, shred it afterwards. Sanity-check it has 3 lines.
git show 4e219dd:wrangler.toml \
  | grep -E '^(LOGIN_USERNAME|LOGIN_PASSWORD|CUSTOMER_SNAPSHOT_SYNC_SECRET)' \
  | sed -E 's/^[A-Z_]+ *= *"?([^"]*)"?$/\1==>***REMOVED***/' > /tmp/replacements.txt

# 4. Rewrite: drop the PII exports and scrub the credentials.
git filter-repo --force \
  --path-glob '*.csv' --path-glob '*:Zone.Identifier' --invert-paths \
  --replace-text /tmp/replacements.txt

# 5. Verify BEFORE pushing — expect 0 CSVs and 0 literal hits.
git log --all --diff-filter=A --name-only --pretty=format: -- '*.csv' | grep -c csv

shred -u /tmp/replacements.txt
```

### Push and clean up

```bash
git push --force --all && git push --force --tags
```

Then:

- Delete the stale branch `origin/claude/codebase-review-jbhgs9` — it also carries the old
  blobs and would resurrect them.
- Every existing clone must be **deleted and re-cloned**, not pulled. A pull merges the old
  history straight back in.
- Ask GitHub Support to garbage-collect unreachable objects. Force-pushing does not remove
  them from GitHub's storage; they stay reachable by SHA until GC runs.

## Step 3 — Keep it from recurring

Already in place:

- `.gitignore` blocks `*.csv` and `*:Zone.Identifier`.
- CI (`.github/workflows/ci.yml`) fails on any tracked `*.csv` or `.dev.vars`.
- `wrangler.toml` deliberately omits the bearer secrets, so an unconfigured deploy fails
  closed (401) rather than trusting a committed placeholder.

**One gap, found 2026-08-10, not yet closed.** `worker-configuration.d.ts` is tracked and is
generated by `wrangler types`, which bakes `wrangler.toml`'s `[vars]` values into the file as
**literal string types** — today `LOGIN_USERNAME: "test-user"`, `LOGIN_PASSWORD:
"test-password-not-real"`, `CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-sync-secret"`. Nothing is leaked
now, but that holds only while those vars stay synthetic: putting a real value in `[vars]` and
regenerating commits it — the same mechanism that produced `4e219dd`. Neither `.gitignore` nor the
CI hygiene check would catch it, because both look for `*.csv` and `.dev.vars`, not `.d.ts`. Close
it by keeping the placeholder discipline explicit in `wrangler.toml` and by ensuring the gitleaks
step scans `worker-configuration.d.ts`.

Worth adding once history is clean: promote the gitleaks step in CI from
`continue-on-error: true` to blocking, and drop `--no-git` so it scans history too. It is
non-blocking today *precisely because* history is dirty — flipping it is the signal that
this remediation is complete.
