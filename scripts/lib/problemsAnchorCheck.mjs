/**
 * Pure helpers for the PROBLEMS.md anchor coverage check.
 *
 * Every problem+json `type` is `PROBLEM_TYPE_BASE + slug`
 * (`src/lib/problem.ts`), and every slug must resolve to a named anchor and
 * row in `docs/PROBLEMS.md` — and every doc row must be referenced by code — so a
 * renamed or invented slug fails the suite instead of shipping a dead link.
 *
 * Every function here is pure (strings/objects in, data out) so the whole
 * rule is unit-testable without Cloudflare credentials or network access.
 * See `test/problemsAnchorCoverage.test.ts` for the unit pins plus the one
 * integration test that scans the real tree (via Vite `?raw` imports, since
 * the suite runs inside the workers pool with no `node:fs`).
 */

import { Marked } from "marked";

// Marked 18.1.0 accepts mixed-character closing fences. Override only that
// tokenizer so code examples stay opaque, including inside lists/blockquotes.
// https://github.github.com/gfm/#fenced-code-blocks
// https://marked.js.org/using_pro#tokenizer
const markdown = new Marked({
  gfm: true,
  tokenizer: {
    fences(src) {
      const opening = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)/.exec(src);
      if (!opening) return;
      const fence = opening[1];
      const content = src.slice(opening[0].length);
      // Match normalized LF boundaries, not JS multiline ^/$ (also U+2028/2029).
      // https://github.github.com/gfm/#characters-and-lines
      const closing = new RegExp(`(?:^|\\n) {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n|(?![\\s\\S]))`).exec(content);
      const end = closing ? opening[0].length + closing.index + closing[0].length : src.length;
      return {
        type: "code",
        raw: src.slice(0, end),
        lang: opening[2].trim(),
        text: closing ? content.slice(0, closing.index) : content,
      };
    },
  },
});

export const CHECK_NAME = "problems-anchor-coverage";

/**
 * @typedef {{ path: string, text: string }} SourceFile
 * @typedef {{ path: string, line: number }} DynamicUsage
 * @typedef {{ slugs: string[], bySlug: Record<string, string[]>, dynamic: DynamicUsage[] }} CodeSlugs
 * @typedef {{ codeSlugs: string[], docSlugs: string[], anchorSlugs: string[], dynamicUsages?: DynamicUsage[] }} AnchorInputs
 * @typedef {{ ok: boolean, unknown: string[], unreferenced: string[], missingAnchors: string[], dynamicUsages: DynamicUsage[] }} AnchorResult
 */

/**
 * `problemType("bad-request")` — double- or single-quoted string literal,
 * with an optional second arg (threads the `PROBLEM_TYPE_BASE`
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
/** GitHub's custom-anchor syntax (not an automatically slugged heading).
 * Use HTML ASCII whitespace here; JS `\s` also matches Unicode separators
 * that GitHub does not treat as tag/attribute whitespace.
 * https://html.spec.whatwg.org/multipage/syntax.html#start-tags
 * https://github.github.com/gfm/#whitespace-character
 * https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#custom-anchors
 */
const DOC_ANCHOR_RE = /^<a[ \t\n\f\r]+name=(["'])([a-z0-9-]+)\1[ \t\n\f\r]*>/;

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
 * Read explicit custom anchors; a table row or heading mentioning a slug
 * is not itself a target for `#<slug>`.
 *
 * @param {string} markdownText full PROBLEMS.md text
 * @returns {string[]} sorted unique named anchors
 */
export function extractDocAnchors(markdownText) {
  const anchors = [];
  // Walk parsed GFM tokens, including table cells, not raw markup in examples.
  // https://marked.js.org/using_pro#lexer
  markdown.walkTokens(markdown.lexer(String(markdownText)), (token) => {
    // Image alt text is not rendered HTML; do not visit its inline tokens.
    if (token.type === "image") {
      token.tokens = [];
      return;
    }
    if (token.type !== "html") return;
    const match = DOC_ANCHOR_RE.exec(token.text);
    if (match) anchors.push(match[2]);
  });
  return sortedUnique(anchors);
}

/**
 * Compare code slugs, doc rows and named targets, plus non-literal calls.
 * `ok` is true only when all offender lists are empty.
 *
 * @param {AnchorInputs} inputs extracted slugs, anchors and non-literal calls
 * @returns {AnchorResult} comparison with sorted offender lists
 */
export function compareAnchors({ codeSlugs, docSlugs, anchorSlugs = [], dynamicUsages = [] }) {
  const code = new Set(codeSlugs);
  const doc = new Set(docSlugs);
  const anchors = new Set(anchorSlugs);
  const unknown = sortedUnique([...code].filter((s) => !doc.has(s)));
  const unreferenced = sortedUnique([...doc].filter((s) => !code.has(s)));
  const missingAnchors = sortedUnique([...new Set([...code, ...doc])].filter((s) => !anchors.has(s)));
  return {
    ok:
      dynamicUsages.length === 0 &&
      unknown.length === 0 &&
      unreferenced.length === 0 &&
      missingAnchors.length === 0,
    unknown,
    unreferenced,
    missingAnchors,
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
  for (const s of result.missingAnchors) {
    lines.push(`slug with no PROBLEMS.md named anchor: ${s}`);
  }
  for (const d of result.dynamicUsages) {
    lines.push(`non-literal problemType( usage: ${d.path}:${d.line}`);
  }
  return lines;
}
