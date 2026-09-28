/**
 * Saved WebRW login-page markup (TOG-5837).
 *
 * The Browser Rendering login (`src/lib/browserAuth.ts`) drives this page by
 * element id, and the HTTP login (`src/lib/httpAuth.ts`) extracts the
 * anti-forgery token from it. Upstream markup drift fails syncs silently
 * (HTML-200), so every selector/extraction `BROWSER_LOGIN` depends on is
 * asserted against this saved copy in `test/browserAuth.test.ts` — no live
 * browser in CI.
 *
 * Refresh procedure: see `docs/BROWSER-LOGIN-DRIFT.md`.
 *
 * Hygiene: all values are empty or obviously fake. Never save a real
 * username, password, token, or cookie into this fixture (CONVENTIONS.md §4).
 */

/** The anti-forgery token embedded in the fixture below. Obviously fake. */
export const LOGIN_PAGE_TOKEN = "FIXTURE-TOKEN-DO-NOT-USE";

export const LOGIN_PAGE_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>Routeware - Login</title></head>
<body class="x-body">
<form id="login-form" action="/WebRW/Account/Login?returnUrl=%2FWebRW%2F" method="post">
<input type="hidden" name="__RequestVerificationToken" value="${LOGIN_PAGE_TOKEN}" />
<div class="x-field">
<label for="UserName-inputEl">User Name</label>
<input type="text" id="UserName-inputEl" name="UserName" autocomplete="username" value="" />
</div>
<div class="x-field">
<label for="Password-inputEl">Password</label>
<input type="password" id="Password-inputEl" name="Password" autocomplete="current-password" value="" />
</div>
<a id="button-1012" class="x-btn" href="#" role="button"><span>Login</span></a>
</form>
<script src="/WebRW/extnet-init-js/ext.axd?a1b2c3d4"></script>
</body>
</html>`;
