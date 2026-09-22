/**
 * Credential gate for the staging-only versioned API probe.
 *
 * Keep this check separate from the probe itself: missing operator credentials
 * must produce an explicit skip, never a false API pass or a secret leak.
 */

export const CHECK_NAME = "shadow-api-v1";
export const SKIP_REASON = "operator:cloudflare-creds";
export const OPERATOR_TODO = "TOG-135";

/**
 * Checks intentionally skipped by the workflow until the operator credential
 * card is complete. Keep the check name and reason stable for CI consumers.
 */
export const SKIPPED_CHECK_ALLOWLIST = Object.freeze({
  [CHECK_NAME]: SKIP_REASON,
});

export function evaluateGate(cfToken = "") {
  return cfToken.trim()
    ? { status: "ready", reason: null, todo: null }
    : { status: "skipped", reason: SKIP_REASON, todo: OPERATOR_TODO };
}

export function missingTokenError() {
  return new Error(`${CHECK_NAME}: missing CF_TOKEN`);
}

export function requireToken(cfToken = "") {
  if (!cfToken.trim()) throw missingTokenError();
  return { status: "ready", reason: null, todo: null };
}

export function formatSkipLog({ reason, todo } = {}) {
  const skipReason = reason ?? SKIP_REASON;
  const operatorTodo = todo ?? OPERATOR_TODO;
  return [
    `${CHECK_NAME}: SKIPPED`,
    `reason: ${skipReason}`,
    `TODO: ${operatorTodo} — provide the operator Cloudflare credential before unskipping`,
  ].join("\n");
}
