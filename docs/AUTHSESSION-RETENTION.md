# AuthSession retention and expiry cleanup

## Contract and cleanup deadline

`expiresAtMs` is an absolute millisecond timestamp. A session is live only while
`Date.now() < expiresAtMs`; equality is expired. There is no application-level
retention grace period.

- A successful future `/set` atomically persists the cookie, expiry and a durable
  alarm scheduled for **exactly `expiresAtMs`**, then clears the refresh lock as
  before. A finite expiry already at or before now is rejected with **409**, not
  acknowledged as usable authentication. Existing expired material is removed;
  a valid renewal and its refresh lock are not replaced by the rejected write.
  The publisher checks non-OK status and propagates pre-publication failure
  through authentication's error/unlock path. **200 acknowledges the committed
  write and lock release, not usable authentication.** If expiry crosses during
  commit, the scheduled alarm or the next read cleans the stored material.
  `establishSession` verifies a live session after successful publication, outside
  its failed-login unlock catch. Late expiry therefore fails authentication without
  releasing a lock that a newer holder acquired after publication.
- An expired or malformed session is neither returned nor left in application
  storage after successful `/get` cleanup. Both `cookieHeader` and `expiresAtMs`
  are deleted before the response. Expiry is rechecked after transaction completion;
  if it crossed during commit, a second transaction reconciles current storage
  without deleting a valid concurrent renewal, and the captured cookie is withheld.
  A failed cleanup transaction fails the request rather than returning expired material.
- An idle session is removed when its expiry alarm's first successful cleanup
  transaction completes, without needing a read request. The alarm handler
  inspects the **current** stored expiry: an old, early or retried alarm preserves
  a valid renewal and rearms its expiry. Completed cleanup leaves no repeating
  alarm.
- On activation, the constructor gates incoming events while it reconciles the
  stored session. It deletes expired/malformed legacy material, or arms an
  unexpired legacy session that lacks the matching alarm. This is lazy repair,
  not a production migration. An old object that has never activated under this
  version and was stored without an alarm cannot be retroactively awakened by
  code alone.

**Scheduling is not a hard wall-clock deletion SLA.** Cloudflare documents that
alarm execution can be delayed during maintenance/failover; failures receive
bounded retries. The application deadline is the first successful cleanup
transaction, with an alarm scheduled at the expiry and fail-closed active reads
from that boundary. No finite maximum retention during provider unavailability,
retry exhaustion, or for never-reactivated legacy objects is claimed. A strict
physical-erasure SLA would need a separately approved provider/operations control.

Expiry cleanup deletes only the cookie and its expiry (and the session alarm),
never `refreshing`, `lockedAt`, or per-IP throttle state. It does not release a
refresh holder's lock. `/set` still clears that lock on publication. Storage
transactions serialize publication and cleanup and roll back a failed alarm
schedule together with the corresponding session write.

Local deletion does **not** revoke the upstream Routeware cookie or prove erasure
from provider backups, logs, or a response already returned before expiry.

## Pinned verification

Only explicitly synthetic cookies are used; no credentials, upstream requests,
production test, production migration or deployment are required.

- `test/authSessionExpiry.test.ts`: exact-expiry scheduling; active reads at
  expiry, +1ms and +24h; idle cleanup after reconstruction; renewal/stale-alarm
  and concurrent cleanup safety; immediate discard of expired writes; malformed
  legacy/active state; lazy alarm repair; refresh/throttle preservation; rollback
  on scheduling or cleanup failure.
- `test/authSessionExpiryRuntime.test.ts`: the real local Durable Object storage
  and alarm handler, including early-alarm rearming, idle deletion, active-read
  deletion, and concurrent renewal. This uses the repository's Cloudflare test
  environment and test-only storage fixtures, not Cloudflare production.
- `test/authSessionStoredSessionAudit.test.ts`: former `F1 evidence` retention
  assertions are secure eviction assertions. The DO-backed failed-holder cases
  now assert timeout with no retained/readable expired or missing-expiry cookie.
  This does not substitute for independent waiter validation against a malformed
  stub or broaden the scope to arbitrary auth-error redaction.
- `test/authSessionTestState.ts`: a Map-backed test fake with serialized,
  rollback-capable transactions, durable alarm state and a constructor gate.
  Recreation reuses storage but constructs a new application object. This is not
  provider-process crash/retry or backup-erasure certification.
- `test/authSessionExpiryIntegration.test.ts`: real publication/auth-lock and
  post-save detail-read wiring with synthetic login/network fixtures. Expiry
  eviction triggers authentication before a detail request, and late publication
  fails authentication rather than forwarding anonymously. Session reads after
  login must still contain a live cookie before forwarding.

Run the focused checks with normal development dependencies:

```sh
npm test -- test/authSessionExpiry.test.ts test/authSessionExpiryRuntime.test.ts \
  test/authSessionStoredSessionAudit.test.ts test/authSession.do.test.ts \
  test/authThrottle.test.ts test/establishSession.test.ts \
  test/forwardWithSessionRetry.test.ts test/authSessionExpiryIntegration.test.ts \
  test/detailFullSyncFetch.test.ts test/detailFullReconciliation.test.ts
npm run typecheck
npm run check:ci-workflow
```

The independent review handoff pins the candidate and verification receipt;
local verification is not independent merge approval. Deployment and production alarm delivery are not inferred from local
verification.

References: [Cloudflare alarm API](https://developers.cloudflare.com/durable-objects/api/alarms/)
and [storage/alarm timing](https://developers.cloudflare.com/durable-objects/api/storage-api/).
The original audit remains a historical finding report at its documented source
snapshot: [stored-session audit](https://github.com/TogetherWeOwn/routeware-shadow-api/blob/00eccdd055961a2879a7fc15c07e6335888b879f/docs/AUTHSESSION-STORED-SESSION-AUDIT.md).
