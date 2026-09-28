# WebRW login drift checklist

Both login paths depend on the WebRW login-page markup, and upstream drift
fails syncs **silently** (HTML-200 — CONVENTIONS.md fact 1):

- Browser Rendering (`src/lib/browserAuth.ts`) types into
  `BROWSER_LOGIN.usernameSelector` / `passwordSelector`, clicks
  `submitSelector`, and proves the session with `requiredCookies`.
- HTTP login (`src/lib/httpAuth.ts`) extracts `__RequestVerificationToken`
  from the login HTML (or the Ext.NET init script) and posts the form.

`test/browserLoginPageFixture.ts` is the saved copy of that markup;
`test/browserAuth.test.ts` asserts every selector and extraction against it
with no live browser in CI.

## When this fires

- `npm test` → `test/browserAuth.test.ts` goes red, or
- syncs start failing with "session cookies missing after headless login" /
  "Anti-forgery token not found", or
- a manual Routeware login shows a changed login form.

## Refresh procedure

1. **Capture fresh markup.** Log in to Routeware manually and save the login
   page HTML (View Source on the login form; **no credentials, tokens, or
   cookies** — empty the field/table values and replace the token with
   `FIXTURE-TOKEN-DO-NOT-USE`-style text).
2. **Update the fixture** (`test/browserLoginPageFixture.ts`) with the fresh
   markup, keeping all values fake (the "no real credentials" test enforces
   this; CONVENTIONS.md §4).
3. **Update the contract** (`BROWSER_LOGIN` in `src/lib/browserAuth.ts`) for
   any renamed ids, changed submit control, or new required cookies. Keep the
   `resolveIdSelector` helper `#id`-shaped — extend it only if the markup
   genuinely needs richer selectors.
4. **Update dependents** if markers moved: `isRoutewareLoginPageHtml`
   (`src/lib/customerSaveAutoToken.ts`) keys on the same ids, and
   `extractAntiForgeryFromExtNet` (`src/lib/httpAuth.ts`) keys on the token
   markup.
5. **Verify:** break one selector in the fixture, confirm red; restore,
   `npm test` green, `npm run typecheck` clean.

## What not to do

- Never paste a real token, cookie value, username, or password into the
  fixture (repo hygiene + PII rules).
- Never "fix" a red selector test by weakening the assertion — the red test
  *is* the drift signal. Update the selector to match verified fresh markup.
