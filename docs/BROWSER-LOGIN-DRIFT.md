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

## User-Agent and browser-header bumps

`src/lib/upstreamHeaders.ts` sets a static `User-Agent` and related
`Sec-CH-UA*` values for requests to Routeware WebRW. Treat a change as a
compatibility change, not a routine version refresh: Chromium warns that a
changed User-Agent format can cause server rejection and that related client
hints may also need to change ([Chromium User-Agent guidance](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_agent/README.md)).

### Verify against Routeware

1. Use an already-authorized Routeware WebRW session in the supported Chrome
   profile. Open DevTools **Network** before using the WebRW screen that
   normally makes a known read-only request; do not manually replay or mutate
   an upstream request.
2. Filter the Network list for `/WebRW/`, select that request, and open
   **Headers → Request Headers**. Chrome documents this view in its
   [DevTools Network reference](https://developer.chrome.com/docs/devtools/network/reference#headers).
3. Confirm the request came from the expected read-only screen and the screen
   loaded its expected result; HTTP 200 alone is not success for this upstream
   (an expired session can return an HTML login page with 200; see
   [`CONVENTIONS.md`](CONVENTIONS.md#1-what-this-is-and-the-two-facts-that-shape-every-change)).
4. Compare the observed `User-Agent`, `Sec-CH-UA`, `Sec-CH-UA-Mobile`, and
   `Sec-CH-UA-Platform` with the values in `src/lib/upstreamHeaders.ts`. Use
   only values actually sent by the supported browser to this Routeware tenant.
   Chrome can reduce the User-Agent and exposes additional browser details
   through User-Agent Client Hints; do not infer a new string from a version
   list or fabricate a matching header ([Chromium reduction reference](https://www.chromium.org/updates/ua-reduction/),
   [Chrome User-Agent Client Hints](https://developer.chrome.com/docs/privacy-security/user-agent-client-hints)).
5. If the successful request does not provide a clear, consistent baseline,
   leave the current value unchanged and record that more upstream evidence is
   needed. Do not save or share a HAR: it may contain cookies, authorization
   headers, or customer data. Record only the browser version, date, and the
   observed UA-related header values in the review evidence.

### Deliberate bump

1. Update the `User-Agent` in `src/lib/upstreamHeaders.ts` to the verified
   browser value. Review the `Sec-CH-UA*` values in the same function and
   change them only when the captured request supports the change.
2. Update the exact User-Agent expectation in
   `test/sessionVersionUpstream.test.ts` in the same change. That pin is
   intentional: changing the implementation without a reviewed test update
   makes the focused test fail.
3. Run `npm test -- test/sessionVersionUpstream.test.ts`, inspect the diff, and
   confirm the verification evidence contains no cookies, credentials, or
   customer data.

## What not to do

- Never paste a real token, cookie value, username, or password into the
  fixture (repo hygiene + PII rules).
- Never "fix" a red selector test by weakening the assertion — the red test
  *is* the drift signal. Update the selector to match verified fresh markup.
