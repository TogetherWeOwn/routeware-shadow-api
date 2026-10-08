/**
 * Pure helpers for the PROBLEMS.md anchor coverage check (TOG-6281).
 *
 * Every problem+json `type` is `PROBLEM_TYPE_BASE + slug`
 * (`src/lib/problem.ts`), and every slug must resolve to a row in
 * `docs/PROBLEMS.md` — and every doc row must be referenced by code — so a
 * renamed or invented slug fails the suite instead of shipping a dead link.
 *
 * Every function here is pure (strings/objects in, data out) so the whole
 * rule is unit-testable without Cloudflare credentials or network access.
 * See `test/problemsAnchorCoverage.test.ts` for the unit pins plus the one
 * integration test that scans the real tree (via Vite `?raw` imports, since
 * the suite runs inside the workers pool with no `node:fs`).
 */

export const CHECK_NAME = "problems-anchor-coverage";

/**
 * @typedef {{ path: string, text: string }} SourceFile
 * @typedef {{ path: string, line: number }} DynamicUsage
 * @typedef {{ slugs: string[], bySlug: Record<string, string[]>, dynamic: DynamicUsage[] }} CodeSlugs
 * @typedef {{ codeSlugs: string[], docSlugs: string[], dynamicUsages?: DynamicUsage[] }} AnchorInputs
 * @typedef {{ ok: boolean, unknown: string[], unreferenced: string[], dynamicUsages: DynamicUsage[] }} AnchorResult
 */

/**
 * `problemType("bad-request")` — double- or single-quoted string literal,
 * with an optional second arg (TOG-8357 threads the `PROBLEM_TYPE_BASE`
 * override as `problemType("bad-request", env)`). The slug stays the first
 * arg, so the coverage rule is unchanged: literal first arg extracts,
 * anything else (`problemType(slug)`, ``problemType(`tpl`)``) still flags
 * dynamic.
 */
const CODE_SLUG_RE = /problemType\(\s*["']([A-Za-z0-9_-]+)["']\s*(?:,[^)]*)?\)/g;
/** Any `problemType(` call site, literal or not. */
const CODE_CALL_RE = /problemType\(/g;
/** Line prefix ending in the `function` keyword: the declaration, not a call. */
const DEFINITION_PREFIX_RE = /\bfunction\s*$/;
/** Doc table rows: `| `slug` | status | ...` at line start. */
const DOC_ROW_RE = /^\|\s*`([a-z0-9-]+)`\s*\|/gm;

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** The source line prefix before a match index (no trailing newline). */
function linePrefixOf(text, index) {
  const s = String(text);
  return s.slice(s.lastIndexOf("\n", index - 1) + 1, index);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/**
 * Scan source texts for `problemType("<slug>"[, env])` literals.
 *
 * Those would otherwise slip past the literal scan silently, so they fail
 * the check instead.
 *
 * @param {SourceFile[]} files repo-relative paths (e.g. `src/app.ts`)
 * @returns {CodeSlugs} the sorted unique slugs, the sorted file list per
 * slug, and every non-literal call site (`problemType(x)`,
 * ``problemType(`...`)``) as `{ path, line }`
 */
export function extractCodeSlugs(files) {
  const bySlug = {};
  const dynamic = [];
  for (const { path, text } of files) {
    const literalAt = new Set();
    for (const m of String(text).matchAll(CODE_SLUG_RE)) {
      literalAt.add(m.index);
      (bySlug[m[1]] ??= []).push(path);
    }
    for (const c of String(text).matchAll(CODE_CALL_RE)) {
      if (literalAt.has(c.index)) continue;
      // Skip the helper's own declaration (`export function problemType(`)
      // in src/lib/problem.ts: it defines the helper, not a problem slug.
      if (DEFINITION_PREFIX_RE.test(linePrefixOf(text, c.index))) continue;
      dynamic.push({ path, line: lineOf(String(text), c.index) });
    }
  }
  for (const slug of Object.keys(bySlug)) {
    bySlug[slug] = sortedUnique(bySlug[slug]);
  }
  return { slugs: sortedUnique(Object.keys(bySlug)), bySlug, dynamic };
}

/**
 * Read doc slugs from the PROBLEMS.md slug table (`| `slug` | status | …`
 * rows). Headings and prose backticks never match: only line-start table
 * rows with a second column do.
 *
 * @param {string} markdownText full PROBLEMS.md text
 * @returns {string[]} sorted unique doc slugs
 */
export function extractDocSlugs(markdownText) {
  return sortedUnique(
    [...String(markdownText).matchAll(DOC_ROW_RE)].map((m) => m[1])
  );
}

/**
 * Compare the two directions: code slugs with no doc row, doc rows no code
 * references, and non-literal call sites. `ok` is true only when all three
 * are empty.
 *
 * @param {AnchorInputs} inputs extracted slugs plus non-literal call sites
 * @returns {AnchorResult} comparison with sorted offender lists
 */
export function compareAnchors({ codeSlugs, docSlugs, dynamicUsages = [] }) {
  const code = new Set(codeSlugs);
  const doc = new Set(docSlugs);
  return {
    ok:
      dynamicUsages.length === 0 &&
      [...code].every((s) => doc.has(s)) &&
      [...doc].every((s) => code.has(s)),
    unknown: sortedUnique([...code].filter((s) => !doc.has(s))),
    unreferenced: sortedUnique([...doc].filter((s) => !code.has(s))),
    dynamicUsages,
  };
}

/**
 * Human report naming every offending slug; empty when the result is ok.
 *
 * @param {AnchorResult} result comparison from {@link compareAnchors}
 * @returns {string[]} report lines
 */
export function formatAnchorReport(result) {
  if (result.ok) return [];
  const lines = [`${CHECK_NAME}: FAIL`];
  for (const s of result.unknown) {
    lines.push(`code slug with no PROBLEMS.md row: ${s}`);
  }
  for (const s of result.unreferenced) {
    lines.push(`PROBLEMS.md row no code references: ${s}`);
  }
  for (const d of result.dynamicUsages) {
    lines.push(`non-literal problemType( usage: ${d.path}:${d.line}`);
  }
  return lines;
}
