# Upstream cookie-jar scoping audit

Auditor: Security Engineer · 2026-09-28 · code at `src/lib/httpAuth.ts`, tests at `test/cookieJarScoping.test.ts`.

## Where the jar lives and flows

- The jar is built per-login in `httpLogin` (memory-local `Record<string,string>`),
  serialized once by `cookieHeaderFrom` and stored in the `AuthSession` DO via
  `storeSession`. It never leaves the server side.
- Replay: `forwardToUpstream` (`src/lib/upstreamForward.ts:51`) sets `Cookie`
  from the stored header; `secureUpstreamResponse` deletes every upstream
  `Set-Cookie` before a client response is built.
- Browser path (`src/lib/browserAuth.ts:96`): the header is built from
  `page.cookies()`; its failure message carries cookie *names* only (fixed
  identifiers, never values).

## Findings

1. **Fixed — no stale-cookie eviction.** `mergeSetCookies` overwrote present
   names only, so an upstream sign-out/rotation (`STALE=; Expires=<past>`)
   lingered as an empty `STALE=` ghost replayed on every forward. Now
   `isExpiredSetCookie` evicts the name on `Max-Age<=0` or a past `Expires`;
   a bare empty value with NO expiry signal is still stored (RFC 6265 §5.3
   step 12 — only an explicit expiry deletes). Severity: medium (stale
   session material replayed upstream).
2. **Documented — Secure/HttpOnly semantics** (doc comment on
   `mergeSetCookies`). `Secure` = HTTPS-only replay; every sessioned forward
   targets `TARGET_ORIGIN` (`https://` in all envs) and a `Secure` tenant
   cookie must never be sent to an `http://` origin. `HttpOnly` holds by
   construction (jar in Worker memory + DO; egress strip). `Domain`/`Path`/
   `SameSite` need no enforcement: single upstream origin, no browser
   context, clients authenticate with a bearer token. `Expires`/`Max-Age`
   ARE enforced (finding 1).
3. **Verified — jar never logged.** `httpAuth.ts` contains zero `console`
   calls; the login-failure throw carries cookie names only (test asserts no
   value bytes survive). Adjacent paths: the `sessionRefreshLock` unlock-failure
   record and the `establishSession` fallback record carry fixed messages only;
   the `Browser authentication failed` record carries the error class as `kind`,
   never the message (jar values flow only into the `storeSession` POST body to the DO).
4. **Accepted — anti-forgery token cache key embeds the full cookie header**
   (`src/lib/customerSaveAutoToken.ts:121`). Isolate-local in-memory `Map`,
   never logged; session rotation evicts by construction (new session = new
   key miss). No change.

## Regression tests pinning this

- `test/cookieJarScoping.test.ts` (7 tests): past-`Expires` eviction,
  `Max-Age=0` eviction, bare-empty-value stored, attribute-only garbage
  ignored, **login-rotation acceptance** (a `STALE` name set by the page GET
  disappears from both the jar and the replayed `Cookie` header after the
  login POST deletes it), success emits no console output, failure message
  names cookies but never values.

## Reviewer acceptance run

```sh
NODE_ENV=development npx vitest run test/cookieJarScoping.test.ts  # 7 passed
```

Repo tests log to stdout (no `test/*.log` files exist); captured stdout
contains zero `FAKE-*` jar values — the `grep -i cookie` equivalent shows
test names only, no jar dumps.
