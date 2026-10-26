/**
 * Pure helpers for the CHANGELOG gate (PR #171).
 *
 * Gap: `[Unreleased]` sits empty with no enforcement, so consumer-visible
 * contract changes land without a changelog entry and the release notes lag
 * the code they describe.
 *
 * Rule: a change is contract-visible when it touches a consumer-facing
 * surface — `src/routes/**`, `src/app.ts`, `src/worker.ts`, `src/lib/*.ts`
 * response shapes, `wrangler.toml` routes/vars, or `migrations/d1/**`
 * (schema consumers read through). A contract-visible change must add at
 * least one bullet under `## [Unreleased]` naming its reference: a GitHub
 * issue (`#123`, bullet-leading or parenthesised) or a legacy card id
 * (`TOG-1234`, kept for historical entries).
 * Docs-only, test-only, script-only, and CI-only changes carry no consumer
 * surface and skip the gate.
 *
 * Everything here is pure (text in, verdicts out) so it is unit-testable
 * without filesystem access — the suite runs inside the workers pool with no
 * `node:fs`. The impure wrapper lives in `scripts/check-changelog.mjs`.
 * Findings name paths only, never values (CONVENTIONS.md sections 4-5).
 */

export const CHECK_NAME = "changelog";

/**
 * Paths whose change is consumer-visible and must carry a changelog entry.
 * `src/lib/**` is deliberately narrow: only top-level lib files shape
 * response bodies directly; `src/lib/snapshot/**` internals surface through
 * the routes and migrations that already match.
 */
const CONTRACT_PATTERNS = [
  /^src\/routes\//,
  /^src\/app\.ts$/,
  /^src\/worker\.ts$/,
  /^src\/lib\/[^/]+\.ts$/,
  /^wrangler\.toml$/,
  /^migrations\/d1\//,
];

/** CHANGELOG.md itself never triggers its own gate. */
const SELF_PATH = "CHANGELOG.md";

/**
 * Decide whether a changed path is consumer-visible.
 *
 * @param {unknown} filePath repo-relative path
 * @returns {boolean} true when the path needs a changelog entry
 */
export function isContractVisiblePath(filePath) {
  const path = String(filePath ?? "");
  if (path === SELF_PATH) return false;
  return CONTRACT_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Extract the `## [Unreleased]` section body from CHANGELOG.md text.
 *
 * @param {unknown} text full CHANGELOG.md text
 * @returns {string|null} section body, or null when no Unreleased heading
 */
export function unreleasedSection(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((line) => /^## \[Unreleased\]\s*$/.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \s*\[?/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/**
 * Collect references named by bullets in a changelog section: GitHub issue
 * refs (`#123` at a bullet start or parenthesised, e.g. `(#123)`) and
 * legacy card ids (`TOG-1234`).
 *
 * @param {unknown} section section body text
 * @returns {string[]} sorted unique references
 */
export function unreleasedCardIds(section) {
  const found = new Set();
  const text = String(section ?? "");
  for (const match of text.matchAll(/\bTOG-(\d+)\b/g)) {
    found.add(`TOG-${match[1]}`);
  }
  // `#N` refs count only inside a bullet: at its start (`- #123:`) or
  // parenthesised anywhere in the bullet, including wrapped continuation
  // lines. Prose and heading lines never satisfy the gate.
  let inBullet = false;
  for (const line of text.split("\n")) {
    if (/^\s*[-*]\s+/.test(line)) {
      inBullet = true;
      const start = line.match(/^\s*[-*]\s+#(\d+)\b/);
      if (start) found.add(`#${start[1]}`);
    } else if (!/^\s+\S/.test(line)) {
      inBullet = false;
    }
    if (inBullet) {
      for (const match of line.matchAll(/\(#(\d+)\)/g)) {
        found.add(`#${match[1]}`);
      }
    }
  }
  return [...found].sort();
}

/**
 * Evaluate the gate over a set of changed paths and the changelog text.
 *
 * @param {string[]} [changedPaths] repo-relative changed paths
 * @param {unknown} [changelogText] full CHANGELOG.md text
 * @param {string[]} [cardIds] references claimed for this change (e.g. `#123`)
 * @returns {{ ok: boolean, contractPaths: string[], cards: string[], skipped: boolean }}
 */
export function evaluateChangelogGate(changedPaths, changelogText, cardIds) {
  const contractPaths = [...new Set(changedPaths ?? [])]
    .filter(isContractVisiblePath)
    .sort();
  if (contractPaths.length === 0) {
    return { ok: true, contractPaths: [], cards: [], skipped: true };
  }
  const section = unreleasedSection(changelogText ?? "");
  if (section === null) {
    return { ok: false, contractPaths, cards: [], skipped: false };
  }
  const cards = unreleasedCardIds(section);
  const claimed = new Set(cardIds ?? []);
  const ok = cards.length > 0 && (claimed.size === 0 || cards.some((id) => claimed.has(id)));
  return { ok, contractPaths, cards, skipped: false };
}

export function formatPassLog(contractPaths, cards) {
  if (contractPaths.length === 0) {
    return `${CHECK_NAME}: PASS — no consumer-visible paths changed (docs/test/scripts/CI only), no entry required`;
  }
  return (
    `${CHECK_NAME}: PASS — ${contractPaths.length} consumer-visible path(s) ` +
    `covered by ${cards.length} Unreleased referencing bullet(s): ${cards.join(", ")}`
  );
}

export function formatFailureLog({ contractPaths, cards }) {
  const lines = [
    `${CHECK_NAME}: FAIL — consumer-visible change without a CHANGELOG entry:`,
  ];
  for (const path of contractPaths) {
    lines.push(`  contract path changed: ${path}`);
  }
  if (cards.length === 0) {
    lines.push("  no referencing bullet under ## [Unreleased] (add one, e.g. `- #123: …`)");
  } else {
    lines.push(
      `  Unreleased names ${cards.join(", ")} but not this change's reference — add a bullet for it`
    );
  }
  lines.push("Docs/test/scripts/CI-only changes skip the gate; contract changes do not.");
  return lines.join("\n");
}
