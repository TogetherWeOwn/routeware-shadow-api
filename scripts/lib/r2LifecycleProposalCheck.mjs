/**
 * Pure helpers for the R2 lifecycle proposal shape guard (TOG-25213, R9-05).
 *
 * Gap: nothing pinned `docs/r2-lifecycle-proposal.snapshot-history.json` to
 * its byte-clean S3 `PutBucketLifecycleConfiguration` shape — silent drift
 * (a widened prefix, an extra key, a dropped field) would only surface at
 * apply time against a live bucket. This guard fails closed on any drift so
 * CI catches it instead.
 *
 * Shape under guard (per `docs/R2-LIFECYCLE-PROPOSAL.md`): exactly one rule
 * with `ID` `"snapshot-history-30d-expiry"`, `Status` `"Enabled"`,
 * `Filter.Prefix` exactly `"snapshot-history/"`, `Expiration.Days` 30, no
 * `Transitions` element, and no extra keys at any level.
 *
 * Everything here is pure (value in, verdict out) so it is unit-testable
 * without Wrangler, credentials, or network access. The impure wrapper lives
 * in `scripts/check-r2-lifecycle-proposal.mjs`.
 */

export const CHECK_NAME = "r2-lifecycle-proposal";

const EXPECTED_RULE_ID = "snapshot-history-30d-expiry";
const EXPECTED_PREFIX = "snapshot-history/";
const EXPECTED_EXPIRATION_DAYS = 30;

const TOP_LEVEL_KEYS = ["Rules"];
const RULE_KEYS = ["ID", "Status", "Filter", "Expiration"];
const FILTER_KEYS = ["Prefix"];
const EXPIRATION_KEYS = ["Days"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed `docs/r2-lifecycle-proposal.snapshot-history.json` body
 * against the byte-clean S3 `PutBucketLifecycleConfiguration` shape.
 *
 * Returns `{ ok: true, errors: [] }` on success or
 * `{ ok: false, errors: string[] }` with one human-readable reason per
 * violation. The committed proposal file must evaluate `ok: true` as-is.
 *
 * @param {unknown} value
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function evaluateR2LifecycleProposal(value) {
  const errors = [];

  if (!isPlainObject(value)) {
    return {
      ok: false,
      errors: [`${CHECK_NAME}: proposal must be an object with exactly { Rules }`],
    };
  }

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push(
        `${CHECK_NAME}: Extra top-level key "${key}" — the S3 request body allows only { Rules }`
      );
    }
  }

  if (!("Rules" in value)) {
    errors.push(`${CHECK_NAME}: Missing Rules — the proposal must define exactly one lifecycle rule`);
    return { ok: errors.length === 0, errors };
  }

  const rules = value.Rules;
  if (!Array.isArray(rules) || rules.length !== 1) {
    const count = Array.isArray(rules) ? rules.length : typeof rules;
    errors.push(
      `${CHECK_NAME}: Rules must be an array with exactly one rule, got ${count}`
    );
    return { ok: false, errors };
  }

  const rule = rules[0];
  if (!isPlainObject(rule)) {
    errors.push(`${CHECK_NAME}: rule must be an object with { ID, Status, Filter, Expiration }`);
    return { ok: false, errors };
  }

  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.includes(key)) {
      if (key === "Transitions") {
        errors.push(
          `${CHECK_NAME}: Extra rule key "Transitions" — Transitions are not proposed for this rule (no Infrequent-Access transition)`
        );
      } else {
        errors.push(
          `${CHECK_NAME}: Extra rule key "${key}" — the rule allows only { ID, Status, Filter, Expiration }`
        );
      }
    }
  }

  if (rule.ID !== EXPECTED_RULE_ID) {
    errors.push(
      `${CHECK_NAME}: ID must be "${EXPECTED_RULE_ID}", got ${JSON.stringify(rule.ID)}`
    );
  }

  if (rule.Status !== "Enabled") {
    errors.push(
      `${CHECK_NAME}: Status must be "Enabled" (records the as-applied intent), got ${JSON.stringify(rule.Status)}`
    );
  }

  if (!isPlainObject(rule.Filter)) {
    errors.push(
      `${CHECK_NAME}: Missing Filter — the rule must define Filter with Prefix exactly "${EXPECTED_PREFIX}"`
    );
  } else {
    for (const key of Object.keys(rule.Filter)) {
      if (!FILTER_KEYS.includes(key)) {
        errors.push(
          `${CHECK_NAME}: Extra Filter key "${key}" — Filter allows only { Prefix }`
        );
      }
    }
    if (rule.Filter.Prefix !== EXPECTED_PREFIX) {
      errors.push(
        `${CHECK_NAME}: Filter.Prefix must be exactly "${EXPECTED_PREFIX}" (trailing slash), got ${JSON.stringify(rule.Filter.Prefix)}`
      );
    }
  }

  if (!isPlainObject(rule.Expiration)) {
    errors.push(
      `${CHECK_NAME}: Missing Expiration — the rule must define Expiration with Days = ${EXPECTED_EXPIRATION_DAYS}`
    );
  } else {
    for (const key of Object.keys(rule.Expiration)) {
      if (!EXPIRATION_KEYS.includes(key)) {
        errors.push(
          `${CHECK_NAME}: Extra Expiration key "${key}" — Expiration allows only { Days }`
        );
      }
    }
    if (rule.Expiration.Days !== EXPECTED_EXPIRATION_DAYS) {
      errors.push(
        `${CHECK_NAME}: Expiration.Days must be ${EXPECTED_EXPIRATION_DAYS}, got ${JSON.stringify(rule.Expiration.Days)}`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
