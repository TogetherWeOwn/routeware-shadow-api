/**
 * PR-trigger guards for the PII hygiene gate (TOG-6539).
 *
 * Runtime truth this pins: the CSV/`.dev.vars` gate only protects `main`
 * when the `build` and `hygiene` jobs actually run on every pull request.
 * `scripts/check-ci-workflow.mjs` asserted `on.pull_request: [main]` but
 * never asserted the two gate jobs lack `if:`/`paths`/`paths-ignore` skips,
 * so a workflow edit could drop the gate on PRs while the invariant check
 * stayed green (CONVENTIONS.md fact 2: customer PII must never be committed).
 *
 * Findings name jobs and keys only — never values, secrets, or file contents
 * (CONVENTIONS.md sections 4-5). Fixture workflows in tests carry no
 * credentials.
 */

/** Jobs that must run unconditionally on every pull request. */
const GATE_JOBS = ["build", "hygiene"];

/** Job-level keys that let a workflow edit skip a job on pull requests. */
const JOB_LEVEL_SKIP_KEYS = ["if", "paths", "paths-ignore"];

/** `pull_request` trigger keys that narrow which PRs run the gate. */
const TRIGGER_NARROW_KEYS = ["paths", "paths-ignore", "types"];

/**
 * Extract the raw text of one `jobs.<name>` block (2-space job indent).
 * Same shape as the `jobBlock` helper in `scripts/check-ci-workflow.mjs`.
 *
 * @param {unknown} workflowText
 * @param {string} name
 * @returns {string|null}
 */
function extractJobBlock(workflowText, name) {
  const match = String(workflowText).match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`, "m")
  );
  return match ? match[0] : null;
}

/**
 * Extract the raw text of the top-level `on:` trigger block (ends at the
 * next column-0 key such as `permissions:` or `jobs:`).
 *
 * @param {unknown} workflowText
 * @returns {string}
 */
function extractOnBlock(workflowText) {
  const lines = String(workflowText).split("\n");
  const start = lines.findIndex((line) => line === "on:");
  if (start < 0) {
    return "";
  }
  const end = lines.findIndex((line, index) => index > start && /^[A-Za-z]/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/**
 * Extract one trigger section (e.g. `  pull_request:` plus its indented
 * keys) from the `on:` block. Narrowing `push:` does not affect the PR gate,
 * so callers scope to the trigger they guard.
 *
 * @param {string} onBlock
 * @param {string} trigger
 * @returns {string}
 */
function extractTriggerSection(onBlock, trigger) {
  const lines = onBlock.split("\n");
  const start = lines.findIndex((line) => line === `  ${trigger}:`);
  if (start < 0) {
    return "";
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Collect every pull-request skip on the PII gate path. Pure: no I/O, no
 * network, findings name jobs/keys only.
 *
 * @param {unknown} workflowText
 * @returns {string[]}
 */
export function findPrTriggerSkips(workflowText) {
  const text = String(workflowText);
  const errors = [];

  if (!/^  pull_request:\n    branches: \[main\]$/m.test(text)) {
    errors.push(
      "CI must run for pull requests targeting main (on.pull_request branches [main] missing)"
    );
  }
  const pullRequest = extractTriggerSection(extractOnBlock(text), "pull_request");
  for (const key of TRIGGER_NARROW_KEYS) {
    if (new RegExp(`^    ${key}:`, "m").test(pullRequest)) {
      errors.push(
        `pull_request trigger must not narrow with '${key}:' — the PII gate must run on every pull request (TOG-6539)`
      );
    }
  }

  for (const job of GATE_JOBS) {
    const block = extractJobBlock(text, job);
    if (!block) {
      errors.push(`Missing ${job} job`);
      continue;
    }
    for (const key of JOB_LEVEL_SKIP_KEYS) {
      if (new RegExp(`^    ${key}:`, "m").test(block)) {
        errors.push(
          `${job} job must not define '${key}:' — the PII gate must run on every pull request (TOG-6539)`
        );
      }
    }
    // Step keys sit at 8 spaces; `run: |` bodies indent deeper, so a match
    // here is a real step condition, not shell text.
    if (/^        if:/m.test(block)) {
      errors.push(
        `${job} job steps must not define 'if:' — a skipped step drops the PII gate on pull requests (TOG-6539)`
      );
    }
  }

  return errors;
}

/**
 * Throw when the workflow lets a pull request skip the PII gate.
 *
 * @param {unknown} workflowText
 * @returns {void}
 */
export function assertNoPrTriggerSkips(workflowText) {
  const errors = findPrTriggerSkips(workflowText);
  if (errors.length > 0) {
    throw new Error(
      `CI PR-trigger guards failed (TOG-6539):\n${errors.map((e) => `- ${e}`).join("\n")}`
    );
  }
}
