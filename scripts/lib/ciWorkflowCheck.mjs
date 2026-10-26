/**
 * PR-trigger guards for the PII hygiene gate.
 *
 * Runtime truth this pins: the CSV/`.dev.vars` gate only protects `main`
 * when `hygiene` actually runs on every pull request. `build` is a HEAVY job
 * gated by the CI-standard `changes` outputs; its only
 * allowed job-level `if:` references `needs.changes.outputs`, which `ci-ok`
 * (if: always()) turns into a pass. `scripts/check-ci-workflow.mjs` asserted
 * `on.pull_request: [main]` but never asserted the gate jobs lack
 * `paths`/`paths-ignore` skips, so a workflow edit could drop the gate on PRs
 * while the invariant check stayed green (CONVENTIONS.md fact 2: customer PII
 * must never be committed).
 *
 * Findings name jobs and keys only — never values, secrets, or file contents
 * (CONVENTIONS.md sections 4-5). Fixture workflows in tests carry no
 * credentials.
 */

/**
 * Jobs that must run unconditionally on every pull request.
 *
 * CI standard: only `hygiene` stays unconditional — it holds the
 * PII gate (CSV/`.dev.vars`) and the blocking secret scan (rule 6: cheap and
 * security always run). `build` is a HEAVY job gated by the `changes` outputs;
 * docs-only PRs skip it while `ci-ok` stays green. See `findPrTriggerSkips`
 * for the gating allowance.
 */
const GATE_JOBS = ["hygiene"];

/** Jobs allowed to carry CI-standard change gating (`needs.changes`). */
const GATED_JOBS = ["build"];

/** Job-level keys that let a workflow edit skip a job on pull requests. */
const JOB_LEVEL_SKIP_KEYS = ["if", "paths", "paths-ignore"];

/**
 * True when a job-level `if:` is exactly the CI-standard change gate
 * (`needs.changes.outputs.<area>`), which `ci-ok` tolerates via skipped
 * results. Any other `if:` (branch, event, actor, …) still drops the gate.
 *
 * @param {string} block
 * @returns {boolean}
 */
function isStandardChangesGate(block) {
  const match = String(block).match(/^    if: (.+)$/m);
  return !!match && match[1].includes("needs.changes.outputs.");
}

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
        `pull_request trigger must not narrow with '${key}:' — the PII gate must run on every pull request`
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
          `${job} job must not define '${key}:' — the PII gate must run on every pull request`
        );
      }
    }
    // Step keys sit at 8 spaces; `run: |` bodies indent deeper, so a match
    // here is a real step condition, not shell text.
    if (/^        if:/m.test(block)) {
      errors.push(
        `${job} job steps must not define 'if:' — a skipped step drops the PII gate on pull requests`
      );
    }
  }

  for (const job of GATED_JOBS) {
    const block = extractJobBlock(text, job);
    if (!block) {
      errors.push(`Missing ${job} job`);
      continue;
    }
    // `paths:`/`paths-ignore:` on a required check leaves the PR hanging on
    // "Expected — waiting" (CI standard rule 2); only job-level `if:` via
    // `needs.changes.outputs` is allowed, because `ci-ok` (if: always())
    // turns the skip into a pass.
    for (const key of ["paths", "paths-ignore"]) {
      if (new RegExp(`^    ${key}:`, "m").test(block)) {
        errors.push(
          `${job} job must not define '${key}:' — use job-level 'if: needs.changes.outputs.<area>' so ci-ok still reports`
        );
      }
    }
    if (/^    if:/m.test(block) && !isStandardChangesGate(block)) {
      errors.push(
        `${job} job 'if:' must reference 'needs.changes.outputs.<area>' — any other condition drops the gate on pull requests`
      );
    }
    // Step keys sit at 8 spaces; `run: |` bodies indent deeper, so a match
    // here is a real step condition, not shell text. The one exception is a
    // step gated `if: github.event_name == 'pull_request'`: it runs on every
    // pull request and skips only non-PR runs (push-to-main, schedule), so it
    // can never drop the gate on a PR. That is the coverage ratchet's PR-only
    // gate — a coverage gain must fail the PR author, never the main-branch
    // build that deploy needs. Any other step-level `if:` still drops a gate
    // on pull requests.
    const stepIfs = block.match(/^        if: (.+)$/gm) ?? [];
    if (stepIfs.some((line) => line.trim() !== "if: github.event_name == 'pull_request'")) {
      errors.push(
        `${job} job steps must not define 'if:' — a skipped step drops the PII gate on pull requests`
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
      `CI PR-trigger guards failed:\n${errors.map((e) => `- ${e}`).join("\n")}`
    );
  }
}

/**
 * First-party actions that must never float on a moving tag. A retagged
 * `v4` can silently change what CI runs; a SHA plus a `# vN` version comment
 * keeps the build reproducible while still telling Dependabot which track
 * to bump.
 */
const PINNED_FIRST_PARTY_ACTIONS = ["actions/checkout", "actions/setup-node"];

/**
 * Name every job in the workflow text. Job headers sit at 2-space indent
 * under `jobs:`; the slice starts at the `jobs:` line so the `on:` trigger
 * children (`  pull_request:`, …) are never mistaken for jobs.
 *
 * @param {unknown} workflowText
 * @returns {string[]}
 */
function listJobNames(workflowText) {
  const text = String(workflowText);
  const jobsAt = text.search(/^jobs:$/m);
  if (jobsAt < 0) {
    return [];
  }
  const jobsSection = text.slice(jobsAt);
  return [...jobsSection.matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map((match) => match[1]);
}

/**
 * Collect every real job (has its own `runs-on:`) missing a job-level
 * `timeout-minutes:`. Without a bound, a hung runner stalls the PR forever
 * instead of failing loudly. Pure: no I/O, no network, findings
 * name jobs only.
 *
 * @param {unknown} workflowText
 * @returns {string[]}
 */
export function findJobsMissingTimeouts(workflowText) {
  const text = String(workflowText);
  return listJobNames(text).filter((name) => {
    const block = extractJobBlock(text, name);
    if (!block || !/^    runs-on:/m.test(block)) {
      return false;
    }
    return !/^    timeout-minutes: \d+\s*$/m.test(block);
  });
}

/**
 * Throw when any job in the workflow lacks `timeout-minutes:`.
 *
 * @param {unknown} workflowText
 * @param {string} [label]
 * @returns {void}
 */
export function assertEveryJobHasTimeout(workflowText, label = "workflow") {
  const missing = findJobsMissingTimeouts(workflowText);
  if (missing.length > 0) {
    throw new Error(
      `CI timeout guards failed: ${label} jobs without 'timeout-minutes:': ${missing.join(", ")}`
    );
  }
}

/**
 * Collect every first-party `uses:` that floats on a tag or pins a SHA
 * without a version comment. Findings name the action and the offending
 * ref shape only — never file contents or credentials. Pure:
 * no I/O, no network.
 *
 * @param {unknown} workflowText
 * @returns {string[]}
 */
export function findUnpinnedFirstPartyActions(workflowText) {
  const errors = [];
  for (const rawLine of String(workflowText).split("\n")) {
    // Match `uses:` with or without the list dash so a
    // name-first step (`- name: …` / `uses: …`) cannot slip past the guard,
    // and tolerate an optional quote around the ref.
    const match = rawLine.match(/^\s*(?:- )?uses:\s*["']?(actions\/[A-Za-z0-9_-]+)@([^\s"']+)["']?\s*(#.*)?$/);
    if (!match || !PINNED_FIRST_PARTY_ACTIONS.includes(match[1])) {
      continue;
    }
    const [, action, ref, comment] = match;
    if (!/^[0-9a-f]{40}$/.test(ref)) {
      errors.push(
        `${action} must be pinned to a 40-char commit SHA, found '@${ref}'`
      );
      continue;
    }
    if (!comment || !/v\d+/.test(comment)) {
      errors.push(
        `${action} pin must carry a version comment (e.g. '# v4') so the track stays visible to Dependabot`
      );
    }
  }
  return errors;
}

/**
 * Throw when any first-party action floats on a moving tag or pins a SHA
 * without a version comment.
 *
 * @param {unknown} workflowText
 * @param {string} [label]
 * @returns {void}
 */
export function assertFirstPartyActionsPinned(workflowText, label = "workflow") {
  const errors = findUnpinnedFirstPartyActions(workflowText);
  if (errors.length > 0) {
    throw new Error(
      `CI action-pin guards failed in ${label}:\n${errors.map((e) => `- ${e}`).join("\n")}`
    );
  }
}

/**
 * Read the Node major pinned by `.nvmrc` (`24`, `v24`, `24.11.0` → `"24"`).
 * Returns null for aliases such as `lts/*`, which cannot anchor a drift
 * check.
 *
 * @param {unknown} nvmrcText
 * @returns {string|null}
 */
export function parseNvmrcMajor(nvmrcText) {
  const match = String(nvmrcText).trim().match(/^v?(\d+)(?:\.\d+){0,2}$/);
  return match ? match[1] : null;
}

/** A `node-version:` line; group 1 is the unquoted value. */
const NODE_VERSION_LINE = /^\s*node-version:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/;

/** `node-version-file: .nvmrc` reads the one source directly, so it cannot drift. */
const NODE_VERSION_FILE_NVMRC = /^\s*node-version-file:\s*["']?(?:\.\/)?\.nvmrc["']?\s*(?:#.*)?$/;

/** A `uses: actions/setup-node@…` line, with or without the list dash. */
const SETUP_NODE_USES = /^\s*(?:- )?uses:\s*["']?actions\/setup-node@/;

/**
 * Return the lines of the step that owns the `uses:` line at `usesIndex`:
 * from its `- ` list item down to the next line at or left of that dash.
 * A name-first step (`- name: …` then `uses: …`) starts at the nearest dash
 * left of the `uses:` indent, so list items inside `with:` are skipped.
 *
 * @param {string[]} lines
 * @param {number} usesIndex
 * @returns {string[]}
 */
function stepLines(lines, usesIndex) {
  const usesIndent = lines[usesIndex].search(/\S/);
  let start = usesIndex;
  if (!/^\s*- /.test(lines[start])) {
    do {
      start--;
    } while (start >= 0 && !(/^\s*- /.test(lines[start]) && lines[start].indexOf("-") < usesIndent));
    if (start < 0) {
      return [lines[usesIndex]];
    }
  }
  const dashColumn = lines[start].indexOf("-");
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].search(/\S/) > dashColumn)) {
    end++;
  }
  return lines.slice(start, end);
}

/**
 * Collect every `node-version:` that differs from the `.nvmrc` major, plus
 * every `actions/setup-node` step that pins neither that major nor
 * `node-version-file: .nvmrc` (without either it installs nothing and the
 * job runs on whatever Node the runner ships). `.nvmrc` is the one place the
 * version lives, so an end-of-life runtime cannot linger in one job after the
 * others move. Pure: no I/O, no network, findings name the line
 * and the version only.
 *
 * @param {unknown} workflowText
 * @param {string} expectedMajor
 * @returns {string[]}
 */
export function findNodeVersionDrift(workflowText, expectedMajor) {
  const lines = String(workflowText).split("\n");
  const errors = [];
  lines.forEach((line, index) => {
    const pin = line.match(NODE_VERSION_LINE);
    if (pin && pin[1] !== expectedMajor) {
      errors.push(
        `line ${index + 1}: node-version '${pin[1]}' must equal the .nvmrc major '${expectedMajor}'`
      );
    }
    if (
      SETUP_NODE_USES.test(line) &&
      !stepLines(lines, index).some((stepLine) => NODE_VERSION_LINE.test(stepLine) || NODE_VERSION_FILE_NVMRC.test(stepLine))
    ) {
      errors.push(
        `line ${index + 1}: actions/setup-node step must set node-version (or node-version-file: .nvmrc)`
      );
    }
  });
  return errors;
}

/**
 * Throw when the workflow's Node pins drift from `.nvmrc`, or when `.nvmrc`
 * holds no plain major to compare against.
 *
 * @param {unknown} workflowText
 * @param {unknown} nvmrcText
 * @param {string} [label]
 * @returns {void}
 */
export function assertNodeVersionsMatchNvmrc(workflowText, nvmrcText, label = "workflow") {
  const major = parseNvmrcMajor(nvmrcText);
  if (!major) {
    throw new Error("CI Node-pin guards failed: .nvmrc must hold a plain Node major such as 24");
  }
  const errors = findNodeVersionDrift(workflowText, major);
  if (errors.length > 0) {
    throw new Error(
      `CI Node-pin guards failed in ${label}:\n${errors.map((e) => `- ${e}`).join("\n")}`
    );
  }
}
