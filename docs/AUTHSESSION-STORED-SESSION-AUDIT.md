# AuthSession stored-session audit

Date: 2026-10-08. Scope: `src/authSession.do.ts`,
`src/lib/sessionRefreshLock.ts`, and `src/lib/sessionState.ts`.

## Verdict

**Session-cookie TTL eviction is not implemented, and unconditional no-cookie-value
logging cannot be certified.** The 120-second refresh-lock TTL is effective on
lock acquisition, but it is not session expiry or credential deletion. Normal
session operations are console-silent; the failed-unlock warning accepts
arbitrary exception text. A failed refresh also allows a waiting caller to accept
an expired cookie as a completed refresh.

This is an audit, not remediation or launch approval. Each defect has its own
filed card. No production incident or live credential exposure was established.
The requested review is one Code Reviewer pass over this report and its pinned
tests at the handoff's exact commit SHA. Remediation cards remain in backlog;
filing them does not authorize restarting parked venture work.

## Reproducible scope and method

- Assigned-source snapshot: `5e451d4a6eefa896ff6b0500ce51c03f2037e6ff`.
  **All source line coordinates below refer to this snapshot.**
- Current-main cross-check: `3ac5a209edaef39dc1b638e5693332f0ebd406c9`.
  The same 13 audit cases pass against an archive of this main snapshot. Main
  differs in waiter timeout (90 seconds rather than the assigned snapshot's
  20 seconds) and problem-type plumbing; neither changes the three findings.
- Tests: `test/authSessionStoredSessionAudit.test.ts` drives the actual DO and
  actual state/refresh helpers through a Map-backed storage fake and a delegating
  stub. Fake clocks exercise the boundary, expiry plus one millisecond, and
  expiry plus 24 hours. Reconstruction reuses the same storage map.
- The only cookie fixture is explicitly synthetic and is never a real credential.
  Console spies intercept exception-evidence cases; those cases do not emit their
  sentinel to real logs. Network login, browsers, upstream data, and production
  resources are not used.
- Static check:
  `rg -n 'console\.|storage.delete|storage.put|alarm\(' src/authSession.do.ts src/lib/sessionRefreshLock.ts src/lib/sessionState.ts`.
  It finds one console call, in the unlock-error path; no session-key deletion or
  alarm handler exists in these files.

**Interpretation of passing tests:** cases prefixed `F1 evidence`, `F2 evidence`,
or `F3 evidence` deliberately characterize an unfixed defect. Their passing
result proves the reproduction, not a secure invariant. Remediation must replace
those expectations with secure behavior rather than retaining them as policy.

## Stored-session lifecycle

1. `sessionExpiryMs` validates the configured positive finite TTL and computes an
   absolute expiry (`sessionState.ts:26-33`). It does not schedule deletion.
2. `storeSession` sends cookie and expiry only to the DO `/set`
   (`sessionRefreshLock.ts:83-91`). Its explicit non-OK write error includes a
   numeric status and fixed advice, not the response body or cookie (`:92-97`).
3. `/set` checks nonempty string/finite expiry, persists cookie/expiry, clears
   `refreshing`, and deletes only `lockedAt` (`authSession.do.ts:29-40,81-93`).
   Finite past expiries are accepted.
4. `/get` returns both stored fields without an expiry comparison or eviction
   (`authSession.do.ts:72-78`). `readSessionState` simply deserializes this result
   (`sessionState.ts:7-11`).
5. `/lock` uses `lockedAt` and 120,000 milliseconds to recover a crashed holder
   (`authSession.do.ts:96-110`). Recovery happens on a later acquisition request,
   not an alarm. `/unlock` preserves the previous cookie and expiry (`:113-116`).
6. The adjacent forwarding path calls `sessionNeedsRefresh` before a proactive
   refresh (`forwardWithSessionRetry.ts:61-78,103-122`). That controls use on this
   path, not idle storage retention; local TTL is not upstream cookie revocation.
   After establishment returns, forwarding rereads state without another expiry
   check (`:121-136,167-170`).

## Findings and filed remediation

### F1 — expired cookie survives in durable storage and `/get`

**Severity: medium.** Credential retention exceeds the configured lifetime.
There is no cookie/expiry deletion, no `setAlarm`, and no alarm handler. An expired
cookie remains readable after object reconstruction and after 24 hours in the
hermetic storage model. A successful later `/set` overwrites the old cookie, but
idle objects and failed refreshes have no cleanup path.

- Source: `authSession.do.ts:72-78,89-92`; `sessionState.ts:7-11`.
- Evidence: three `F1 evidence` cases retain both keys at expiry, expiry+1ms,
  and expiry+24h; assert no deletion and no scheduled alarm.
- Filed bug: [TOG-18118](/TOG/issues/TOG-18118).
- Required fix evidence: documented cleanup deadline; active-read eviction and
  idle alarm cleanup; recreation; renewal/old-alarm race safety; no clobbering of
  independent refresh/throttle state. Deleting local storage would still not
  prove upstream credential revocation.

### F2 — failed-holder unlock is mistaken for a fresh published session

**Severity: medium.** A waiter treats `!refreshing && cookieHeader` as success,
ignoring the expiry. If a holder fails before publishing and unlocks, the
retained old cookie satisfies that predicate. A cookie with missing expiry does
also. `establishSession` returns success, allowing its caller to reread and
forward with the old session. Upstream rejection/login HTML is possible; these
unit cases do not claim a particular live upstream response.

- Source: `sessionRefreshLock.ts:114-116`; `authSession.do.ts:113-116`;
  adjacent `establishSession.ts:73-79` and `forwardWithSessionRetry.ts:121-136`.
- Evidence: two `F2 evidence` cases start the real waiter while a lock is held,
  release the failed holder, advance one poll, and observe successful settlement
  with the unchanged expired/missing-expiry cookie.
- Filed bug: [TOG-18119](/TOG/issues/TOG-18119).
- Required fix evidence: only a validated unexpired publication counts as
  success; failed-holder/malformed-expiry paths fail closed or perform bounded
  recovery, preserving serialization. Add an integration assertion that stale
  cookies are not forwarded. This is distinct from the already-fixed
  deadline-success bug [TOG-6526](/TOG/issues/TOG-6526).

### F3 — failed-unlock warning serializes arbitrary exception text

**Severity: medium, conditional leakage risk.** The warning passes
`err.message` or `String(err)` verbatim to the logger. Error, string, and custom
object-stringification rejections all copy the synthetic cookie sentinel into
captured warning arguments. That falsifies unconditional redaction at this
boundary. It does **not** establish that Cloudflare's natural `/unlock` failures
contain a credential: the normal unlock request contains no cookie body.

- Source: `sessionRefreshLock.ts:63-71`, especially `:67-70`.
- Evidence: three `F3 evidence` cases capture warning arguments and prove the
  byte-for-byte echo, without emitting the sentinel to actual logs.
- Filed bug: [TOG-18121](/TOG/issues/TOG-18121).
- Required fix evidence: fixed, allowlisted warning/classification only; never
  arbitrary exception text/object; retain best-effort release without masking
  the original auth failure; turn sentinel cases into negative log assertions.
- The broader adjacency assertion in `docs/TOG-9207-cookie-jar-audit.md:35-41`
  is not adequate proof for this failed-unlock path. This report narrows that
  assertion rather than certifying adjacent auth logging.

## Verified positive controls

| Control | Pinned passing evidence |
| --- | --- |
| Stored session reads correctly immediately before expiry | `returns a stored session just before its TTL boundary` in the audit test |
| Fresh lock denied at TTL minus 1ms; takeover exactly at 120 seconds | `recovers the refresh lock exactly at 120 seconds, not the session cookie TTL` |
| Normal set/get/lock/unlock/wait and malformed `/set` are console-silent | `emits no console output on normal session, lock, and rejected-payload paths` |
| Explicit non-OK `/set` error excludes cookie and response body | `does not echo cookie bytes or a rejected write response body in its error` |
| Still-refreshing holder reaches a fixed-shape, cookie-free timeout error | `fails closed with a fixed-shape error when a holder remains refreshing` |
| Invalid `/set` fields and invalid TTL bindings are rejected | Existing rejection cases in `test/authSession.do.test.ts` |
| Established-session serialization and caller deadline handling | Existing cases in `test/establishSession.test.ts` and `test/forwardWithSessionRetry.test.ts` |

## Verification receipt

With normal development dependencies installed:

```sh
NODE_ENV=development npm test -- \
  test/authSessionStoredSessionAudit.test.ts test/authSession.do.test.ts \
  test/establishSession.test.ts test/forwardWithSessionRetry.test.ts
npm run typecheck
```

Results on the clean assigned-source archive plus this audit test:
**4 files / 64 tests passed; TypeScript passed.** Separately, on the current-main
archive plus this audit test: **1 file / 13 audit tests passed.**

The repository-required pre-push checks also completed on the clean assigned
archive: `check:ci-workflow`, TypeScript, and the full coverage suite all exited
0. Coverage run: **117 files; 1,671 passed and 2 pre-existing expected failures**
(1,673 cases total), with no unexpected failures. The expected-failure probes are
`B1` and `B2` in `test/authThrottleXffProbe.test.ts:74,93`; they were not changed
or converted by this audit. Global JSON coverage: statements 94.29%, branches
90.55%, functions 95.98%, lines 94.79%. All configured coverage thresholds passed.
Captured verification output contained zero audit-cookie sentinel occurrences.

Local fresh-context pre-review scored **5/5 for this two-file audit slice**,
covering the report, 13 cases, referenced source/caller logic and matching source
blobs. It did not independently rerun the tests or verify control-plane cards;
those receipts are provided by the executor. This is not the required independent
Code Reviewer acceptance. Risk prioritization was separately sent to the CISO in
[TOG-18126](/TOG/issues/TOG-18126).

The first direct workspace invocation failed with `vitest: not found`; the
existing workspace dependency tree was not replaced. Dependencies were installed
from the tracked package lock outside the synced tree in the run-owned scratch
area. Verification used clean `git archive` snapshots, copied only this new test,
and linked the isolated dependencies. Vitest retained the repository's normal
Cloudflare/workerd test config. Initial new-fixture TypeScript errors were fixed
and both checks rerun successfully. No check or gate was disabled.

## Limits and review handoff

- No live DO storage, production logs, Cloudflare alarm delivery, backups,
  upstream cookie invalidation, or actual credentials were inspected. The Map
  model demonstrates the application's missing eviction path, not physical
  retention behavior of the provider's internal backups.
- No arbitrary storage-error redaction claim is made for `storeSession`,
  `readSessionState`, browser/HTTP login loggers, or downstream cron error logs.
  Only the three scoped files and the identified adjacent caller logic were
  audited. The real no-cookie-value invariant needs safe error boundaries, not
  an assumption that all caught exceptions are harmless.
- Atomicity, stale-holder ownership races, cross-request interleavings, and
  provider crash recovery beyond the modeled reconstruction are not certified
  by this audit.
- Source runtime code is unchanged. The shared branch's unrelated changes are
  not part of this audit slice. The handoff work product pins the exact pushed
  audit commit; review only its report and new test, and reverify source blobs
  against the snapshot above. Independent review is pending, not claimed passed.
