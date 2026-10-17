# Security remediation — leaked credentials & PII in git history

**Status: step 2 COMPLETE as of 2026-08-22 — in THIS repository.** The credentials and the PII are
gone from every ref here, verified by `git clone --mirror` (see below). Step 1 (rotation) was
**declined** on 2026-08-07 and remains declined; that decision predates the change of ownership and
is worth re-taking.

> **One action is still outstanding and it is not ours to take:** the *original* repository,
> `Rick7C2/routeware-shadow-api`, still exposes everything through its `refs/pull/*` and **must be
> deleted**. This repo is its clean replacement.

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

> **That containment reasoning expires on transfer.** Moving this repository to an organization gives
> every org member — and any org-wide access policy — read access to the whole history, including
> `4e219dd`. The purge is also markedly easier **before** a transfer, while one person still owns the
> repo and every clone of it. See [HANDOVER.md](HANDOVER.md) § 5.

## What the purge achieved, and how this repo came to exist (2026-08-22)

`git-filter-repo` was run on a fresh mirror and force-pushed. Verified from a **fresh clone of
GitHub** afterwards, not from the local copy:

| Surface | Result |
|---|---|
| All five branch heads (`main` and the four others) | **Clean** — 0 CSV blobs, 0 secret hits |
| Working tree content at `main` | **Byte-identical** before and after (tree `53a6bb5c…`) |
| Commit count | 82 before, 82 after — nothing dropped |
| **GitHub's `refs/pull/1..7/head`** (old repo) | **STILL EXPOSED — all six CSV blobs and all three secrets** |

**This is the part the runbook did not anticipate, and it is the part that matters.** GitHub creates
a read-only `refs/pull/N/head` for every pull request. Those refs are server-side, they are *not*
branches, and **a force-push cannot rewrite or delete them**. `git clone --mirror` fetches them by
default, so:

```
git clone --mirror https://github.com/<owner>/routeware-shadow-api
```

still yields the ~609,000 PII rows and all three credentials today. `git cat-file -t 4e219dd` on that
clone still returns `commit`.

### Closing the remaining gap — two options, both requiring a decision

1. **GitHub Support request.** Ask them to garbage-collect unreachable objects **and** state
   explicitly that `refs/pull/*` still reference the removed blobs — a plain "please GC" request
   does not necessarily cover PR refs. This keeps issue and PR history intact.
2. **Push the cleaned history into a brand-new empty repository and abandon the old one.** PR refs
   live with the repo, so a new repo simply has none. **Given this project is being transferred
   anyway, this is the option that actually works without depending on a support queue** — transfer
   the clean repo, then delete the old one. The cost is losing the PR and issue history (7 PRs of
   review narrative), which is a real loss and should be a deliberate trade.

**Option 2 was taken on 2026-08-22.** This repository *is* the new one. It was created by pushing a
`git clone --bare` of the cleaned history — `--bare`, not `--mirror`, because `--mirror` would have
copied `refs/pull/*` straight back in.

Verified here by `git clone --mirror` of this repo, which is the exact operation that still leaks on
the old one:

- refs present: five branches, **no `refs/pull/*`**
- CSV / `:Zone.Identifier` blobs: **0**
- literal secret hits: **0** for all three values
- `git cat-file -t 4e219dd` → **`Not a valid object name`** — the poisoned root commit does not exist

**What is still owed:** deleting `Rick7C2/routeware-shadow-api`. Until that happens both repos exist
and the old one still discloses everything to anyone who can read it. Deleting a repository is
irreversible and is the owner's call, not the agent's — a backup mirror of the original, PR refs and
all, is archived off-repo as `rsa-backup-2026-08-22.tar.gz` (11 MB).

**Known cost of this route:** the 9 pull requests of review narrative do not travel. Issue and PR
history lived with the old repository.

### Also worth knowing, if this is ever re-run

The runbook below says to sanity-check that the replacement list has **3 lines**. It does — but the
extraction finds **4** matching assignments, because `CUSTOMER_SNAPSHOT_SYNC_SECRET` appears twice
with the same value. Deduplicate; do not assume the counts match.

**And do not put `LOGIN_USERNAME` through `--replace-text` as a literal.** Its real value is a
3-character string that occurs **2,108 times** across the repo's blobs as an ordinary substring —
inside `OpenAPI`, `api-discovery`, and most documentation. A literal replacement corrupts every one
of them. Anchor it to its assignment with a `regex:` entry instead:

```
regex:(LOGIN_USERNAME\s*=\s*")<value>(")==>\1***REMOVED***\2
```

The long password and the 64-character sync secret are safe as literals.

---

## Order matters

**Rotate first, purge second.** Purging history without rotating is cosmetic: anyone who
cloned before the purge keeps the credentials forever. Rotation is what actually revokes
access; the purge only stops *future* readers.

---

## Step 1 — Rotate (first, and independently of everything else)

> **Status: DECLINED 2026-08-07**, by the maintainer, as a decision rather than a deferral — work
> continued without it and merges to `main` were explicitly not blocked on it. Recorded here because
> this document previously read as though rotation were merely pending, which it was not.
>
> **It is worth re-taking under new ownership.** The decision was made when the repo was private with
> a single collaborator; a transfer changes exactly that premise. Step 2 (the purge) was never part
> of the decision and has always remained open.

Only the repo owner can do this; it is deliberately outside what the agent tooling may run.

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

**One gap, found 2026-08-10, closed.** `worker-configuration.d.ts` is generated by
`wrangler types`, which bakes `wrangler.toml`'s `[vars]` values into the file as **literal string
types** — `LOGIN_USERNAME: "test-user"`, `LOGIN_PASSWORD: "test-password-not-real"`,
`CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-sync-secret"`. Putting a real value in `[vars]` and
regenerating would commit it — the same mechanism that produced `4e219dd`. The file is now
gitignored (`.gitignore:4`) and untracked, so a regenerate cannot commit it. CI regenerates it in
the hygiene job (the Worker-types regeneration step) and the step `No real secrets baked into
worker-configuration.d.ts` fails the job on any non-synthetic value of the four Worker-secret keys.
Never force-add the file.

The gitleaks step is blocking and scans this repository's full history: `Secret scan (blocking)`
in the hygiene job has no `continue-on-error` and runs `gitleaks detect --source . --redact
--config .gitleaks.toml` over `fetch-depth: 0`. This closes the recurrence gap in this repository;
the incident remains open until the original repository is deleted (HANDOVER §5).
