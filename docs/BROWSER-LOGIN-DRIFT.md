# WebRW login drift checklist

Both login paths depend on the WebRW login-page markup, and upstream drift
fails syncs **silently** (HTML-200 — CONVENTIONS.md fact 1):

- Browser Rendering (`src/lib/browserAuth.ts`) types into
  `BROWSER_LOGIN.usernameSelector` / `passwordSelector`, clicks
  `submitSelector`, and proves the session with `requiredCookies`.
- HTTP login (`src/lib/httpAuth.ts`) extracts `__RequestVerificationToken`
  from the login HTML (or the Ext.NET init script) and posts the form.

`test/browserLoginPageFixture.ts` is the saved copy of that markup; three
contract test files assert against it (or against the login flow it feeds)
with no live browser in CI:

- `test/browserAuth.test.ts` — guards the selector/extraction contract: every
  `BROWSER_LOGIN` selector resolves to exactly one element in the saved
  markup, and the anti-forgery token extracts from it.
- `test/browserAuthLoginForm.test.ts` — guards the login-form branch added by
  #246 (R7-01): trimmed credentials typed username-then-password, submit
  clicked, 2 s settle delay, then cookies read and the session stored.
- `test/browserAuthFailureKind.test.ts` — guards failure classification: every
  browser-login failure logs a record whose `kind` is the error class, with no
  credential or cookie values in the logs.
- `test/browserLoginPageFixture.ts` — the saved login-page markup all of the
  above run against (form, fields, submit control, token, init script).

## When this fires

- `npm test` → `test/browserAuth.test.ts`,
  `test/browserAuthLoginForm.test.ts`, or
  `test/browserAuthFailureKind.test.ts` goes red, or
- syncs start failing with "session cookies missing after headless login" /
  "Anti-forgery token not found", or
- a manual Routeware login shows a changed login form.

## Refresh procedure

1. **Capture fresh markup.** Log in to Routeware manually and save the login
   page HTML (View Source on the login form; **no credentials, tokens, or
   cookies** — empty the field/table values and replace the token with
   `FIXTURE-TOKEN-DO-NOT-USE`-style text). Re-capture the full
   form-branch surface added by #246, not just the token: the `<form>`
   element (currently `id="login-form"`, posting to the
   `loginPathFragment`), both fields (currently `#UserName-inputEl` /
   `#Password-inputEl` with `name="UserName"` / `name="Password"` and empty
   values), the submit control (currently `#button-1012`), and the Ext.NET
   init script tag the HTTP login follows.
2. **Update the fixture** (`test/browserLoginPageFixture.ts`) with the fresh
   markup, keeping all values fake (the "no real credentials" test enforces
   this; CONVENTIONS.md §4).
3. **Update the contract** (`BROWSER_LOGIN` in `src/lib/browserAuth.ts`) for
   any renamed ids, changed submit control, moved login path, or new
   required cookies. Keep the `resolveIdSelector` helper `#id`-shaped —
   extend it only if the markup genuinely needs richer selectors. If the
   login flow itself changed (e.g. no longer username → password → submit →
   2 s settle → cookies, or ExtJS now navigates on submit instead of
   tolerating the navigation timeout), the change belongs in
   `establishSessionWithBrowser` plus `test/browserAuthLoginForm.test.ts` —
   out of scope for a fixture-only refresh, so stop and card it.
4. **Update dependents** if markers moved: `isRoutewareLoginPageHtml`
   (`src/lib/customerSaveAutoToken.ts`) keys on the same ids, and
   `extractAntiForgeryFromExtNet` (`src/lib/httpAuth.ts`) keys on the token
   markup.
5. **Verify:** break one selector in the fixture, confirm
   `test/browserAuth.test.ts` red; restore, then run the full contract —
   `npx vitest run test/browserAuth.test.ts
   test/browserAuthLoginForm.test.ts test/browserAuthFailureKind.test.ts` —
   green, plus `npm run typecheck` clean. (Full `npm test` is the same suite;
   no code changes ride along with a fixture refresh.)

## What not to do

- Never paste a real token, cookie value, username, or password into the
  fixture (repo hygiene + PII rules).
- Never "fix" a red selector test by weakening the assertion — the red test
  *is* the drift signal. Update the selector to match verified fresh markup.
