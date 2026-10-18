# Local dual-secret rotation drill — 2026-10-08

**Result: local auth overlap and rollback PASS; production rotation not performed.**

Both API and privileged sync secrets were changed independently, rolled back, and restored using disposable local values. The local listener was stopped between configurations: this verifies client auth fallback, **not zero-downtime deployment**. Real consumer distribution, environment propagation, and the next scheduled cron remain unverified.

## Scope and provenance

- The runbook's prerequisite rotation support was verified complete before the drill.
- Tested checkout: `600ecb42ad4aa50c7ed33144cb75da2cc2602c01`.
- Instructions used for the drill: `docs/SECRET-ROTATION-RUNBOOK.md` §§0–4, pre-edit SHA-256 `644fad6cd879773e3760ec7d5b1be04243003469a46a89e3a03ee3b655761746`. No application-code inspection was used to choose the probe routes or expected results; source was read after the drill to cross-check the documentation fixes.
- Runtime: Node `v24.21.0`, Wrangler `4.84.1`, Vitest `4.1.10`, dependencies installed from the lockfile with `NODE_ENV=development npm ci --include=dev`.
- No `.dev.vars` or `.dev.vars.test` existed before rehearsal. Port `8791` was checked free. The workspace had no configured managed runtime services, so a bounded foreground Python wrapper launched/stopped `npx wrangler dev --port 8791` for each phase.
- Only the runbook's four dummy bindings were written to the gitignored `.dev.vars`. No real secret was fetched, rotated, displayed, or distributed; no `wrangler secret put`, remote development, deployment, or migration command was executed.
- The wrapper used HTTP GET equivalents of the §2 probes and checked HTTP status/detail, not just curl exit status. A dummy dual-hold client tried new once, fell back to old only on `401`, and checked the final response. No retries with real credentials occurred.
- The only application paths requested were `/api/v1/health`, `/api/v1/shadow/health`, and `/api/v1/data/customer` **without an id**. No application mutating route, D1 query/migration, R2 operation, scheduled sync, or upstream-data request was invoked. Auth checks may update the **local throttle Durable Object**; this was not a completely storage-free exercise.

## Timings (UTC)

From the 59-row timestamped assertion artifact (internal drill record, not published; its SHA-256 is in Evidence). Times include the local runtime startup, not production secret propagation. Startup seconds run from launcher invocation to the first public-health `200`; the final column is elapsed from drill start.

| Phase | Bindings written at | Worker ready at | Startup seconds | Phase assertions complete (elapsed seconds) |
|---|---|---|---:|---:|
| Baseline: API old / sync old | 05:40:05.196 | 05:40:07.176 | 1.953 | 2.073 |
| API cutover: API new / sync old | 05:40:07.382 | 05:40:09.032 | 1.622 | 3.865 |
| API rollback: API old / sync old | 05:40:09.165 | 05:40:10.288 | 1.104 | 5.110 |
| API restored: API new / sync old | 05:40:10.400 | 05:40:11.413 | 0.996 | 6.236 |
| Sync cutover: API new / sync new | 05:40:11.539 | 05:40:12.880 | 1.316 | 7.714 |
| Sync rollback: API new / sync old | 05:40:13.004 | 05:40:14.438 | 1.414 | 9.285 |
| Sync restored: API new / sync new | 05:40:14.620 | 05:40:16.050 | 1.402 | 10.899 |

Auth-drill PASS recorded at **05:40:16.097 UTC / 10.902 s**. Cleanup complete at **05:40:16.260 UTC / 11.064 s**. All seven local listeners stopped; no orphaned listeners were observed. The dummy `.dev.vars` was removed and port `8791` was free.

## Reviewer-checkable results

**28 explicit HTTP status/detail assertions + 6 dual-hold client assertions; all 34 passed.** The six client assertions include four expected new-token `401` responses followed immediately by a valid old-token fallback; these are expected single attempts, not repeated stale-token probing.

| Check | Expected and observed |
|---|---|
| Baseline general API / sync | `200` / `200` |
| Baseline privileged sync, id omitted | `400`, detail says `id` or `customerId` is required |
| API token on privileged GET | `401`, **inner** detail names `CUSTOMER_SNAPSHOT_SYNC_SECRET` |
| Unknown bearer on general GET | `401`, **outer** detail names `SHADOW_API_TOKEN` |
| Public health without bearer | `200` |
| New-first API client before / after API cutover | `401 → 200` fallback / direct `200` |
| API old after cutover | Exactly one `401` outer denial, followed by API-new `200` |
| Sync during API cutover and rollback | General `200`; privileged `400`; no sync binding change |
| API rollback and restoration | Dual-hold client `401 → 200`; old valid again; restored new `200` |
| New-first sync client before / after sync cutover | `401 → 400` fallback / direct `400` |
| Sync old after cutover | Exactly one `401` **outer** denial, followed by sync-new `400` |
| API during sync cutover and rollback | General `200`; still denied at privileged inner gate |
| Sync rollback and restoration | Dual-hold client `401 → 400`; old valid again; restored new `400` |

The privileged `400` is deliberately a success sentinel **for authentication only**: the id guard rejects the request before data access. A valid-token request followed every deliberate denial; no `429` was observed. This does not independently exercise the 20-failure throttle boundary or prove persistence/reset internals.

## Every documentation snag and its disposition

All fixes are included in the accompanying runbook patch; there is no application behavior change.

| Snag / missing instruction | Fix in `SECRET-ROTATION-RUNBOOK.md` |
|---|---|
| Only §3 describes cutover/retirement, but its commands mutate remote secrets and are operator-gated. A local driller has to translate that sequence and invent independent rollback steps. | New §2a makes local-only editing, API-first/sync-second state transitions, new-first fallback, rollback and restoration explicit. It never uses `secret put`. |
| Privileged baseline examples printed JSON but not the HTTP status they ask the reader to verify. Curl normally exits zero for an expected `400`/`401`. | §2 prints `HTTP %{http_code}` beside every JSON/body probe. |
| The throttle caution says all failed checks count. The API-only inner `401` already cleared the outer gate; only rejected **outer** checks increment the counter. | §2 distinguishes outer failures from inner denials and explains why a privileged missing-id `400` is a valid resetting request. Cross-check: `src/lib/authThrottle.ts:10-18`, `src/app.ts:85-162` outer gate and successful-token reset. |
| The old evidence changed both dummy values together and had no per-secret timings or rollback results. "Hitless" language could also be mistaken for a claim about local restart availability. | §0 bounds auth-overlap claims; §2a states listener interruption; §5 links this independent, timed drill and explicitly leaves cron/real deployment unverified. |
| A scratch credential file must not overwrite an existing developer file or contaminate the test environment. | §1/§2a now require a clean disposable credential file, check environment-specific files, and clean up before running the recorded auth tests. Existing §4 already described the test override snag; this run avoided it. |

### Additional publication pre-review corrections

Author pre-review identified two existing production-checklist defects; both are fixed in the same docs-only slice without executing a real rotation:

- Local `BASE` and dummy variables were described as applying to the rest of the document. §3 now requires a separate approved deployed HTTPS origin, matching account/Worker/environment and real credential variables before any remote cutover or verification. Local probes cannot establish remote success.
- Consumers were told to delete the old sync secret before next-cron acceptance, defeating the documented rollback fallback. §§3a/3b/6 now retain the operator **and consumer** old copies through acceptance and the agreed rollback window, then retire them together.

A further fresh-context author check during scoped publication identified four standing findings, fixed in the same two-document slice:

- Real-token probes must not expand bearer credentials into curl process arguments. §3 now supplies a stdin-header GET helper, disables default curl configuration and requires tracing off before secret loading/calls. §2/§2a argv examples are explicitly dummy-only.
- The serial `401`-only dummy fallback does not cover concurrent shared-NAT attempts reaching the auth-throttle `429`. Production consumer readiness now requires a bounded alternate-token attempt only for positively identified pre-handler Worker auth/throttle rejections; generic/handler errors are not retryable. No concurrent-consumer experiment was added, and that readiness is not attested by this drill.
- An old sync value aliased to an active read/API token can remain usable for general GET while failing the privileged inner check. §3 requires distinct active slots and both general/privileged **outer** retirement denials; aliases stop this checklist and require a separately authorized plan.
- Root-relative task/artifact URLs did not resolve from GitHub. The historical assertion artifact still has the recorded 59 rows and SHA-256 (see Evidence). No timings, assertion counts or historical test results were changed.

Current-source review also narrowed reset claims to best-effort Durable Object persistence and clarified that a chained run captures its outbound sync bearer once, rather than rereading it for each leg. These are publication documentation corrections, not newly observed drill behavior.

## Verification and limits

- `npx vitest run test/dualSecretMatrix.test.ts test/snapshotAuth.test.ts`: **2 files, 49 tests passed**, duration **3.14 s**, started **05:40:41 UTC**, with no scratch credential file present.
- Documentation checks at that point: `git diff --check` passed; all **7 then-existing Bash code blocks** in the runbook passed `bash -n`. The later-added production `rotation_get` stdin-header helper was syntax-checked separately, not executed as part of the timed drill; the equivalent dummy fallback behavior was exercised by the uploaded wrapper.
- `npm ci` reported **18 dependency audit findings** (1 low, 5 moderate, 12 high). This is the existing lockfile install output, not a new defect caused by this docs-only slice; no packages were changed and no audit fix was run.
- At the original 05:40 drill, the inherited task branch was 44 commits behind / 13 ahead of `main`; a read-only merge preview found eight conflicts in unrelated source/tests. This drill remains evidence for the named tested checkout, **not a claim that current main or a future PR head was drilled**. Publication must apply only the two-document patch to current `main`, verify its auth claims against that source and run the relevant checks there before the single Code Reviewer pass. Do not merge the entire shared branch or overwrite sibling edits.
- The initially clean drill workspace subsequently acquired concurrent changes to source, scripts, package metadata, workflows and other documents. The observed changed source-file mtimes were after the 05:40:16 drill completion (05:40:51); this is not an immutable-worktree attestation. During that original drill workspace, no concurrent contributor's changes were staged, reverted, overwritten, or committed, and no branch switch, reset, rebase, or merge was performed. The later scoped publication ran in a separate workspace; its current-main integrations are publication history, not drill evidence. The portable PR patch remains restricted to this runbook and report.
- Publication was initially held on the red scheduled-probe repair. Observed failed run: [37638221376](https://github.com/TogetherWeOwn/routeware-shadow-api/actions/runs/37638221376), main SHA `3ac5a209edaef39dc1b638e5693332f0ebd406c9`; build/hygiene/`ci-ok` were green but the deployed probe was red. The blocker reached `done` and its repair is on `main` as `2d1df58765cdfdfd10babf985f9ca4b1ea0f7be7` when publication resumed at 08:00 UTC. The latest main CI was still queued/pending; that alone is not proof of green CI or a successful live probe. No duplicate repair or production probe was created.
- Neither next-day cron success nor real-consumer distribution was tested. The production acceptance in runbook §6 remains unmet and still needs its normal approval/operator route. This drill does **not** authorize that work.

## Evidence

- Timestamped assertions, 59 JSON rows, SHA-256 `6d140cf2357b13e2e601d61dfae210ee04ee66eb2d4611fcdbc17790c3faafa8`.
- The exact disposable wrapper and 49-test verification output were kept with the internal drill record (not published) so the operations and test result could be inspected without this workspace. The wrapper is run-owned scratch tooling, not a new project service or CI dependency.
- Report and runbook edits are local work products pending publication. No PR is claimed opened, reviewed, merged, or deployed by this report.
