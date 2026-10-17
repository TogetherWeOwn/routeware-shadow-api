/**
 * Pure helpers for the docs link + anchor check (TOG-18936).
 *
 * Rule (docs/CONVENTIONS.md §7): every relative `](path)` / `](path#anchor)`
 * link in tracked `*.md` files must resolve — the target must be a tracked
 * file (or a directory containing tracked files), and any `#anchor` must
 * match a heading slug (GitHub rules) or an `<a name>` anchor in the target.
 * External `scheme:` URLs, `mailto:`, Paperclip-internal `/TOG/…` paths and
 * links into gitignored paths are skipped.
 *
 * Everything here is pure (paths and text in, verdicts out) so it is
 * unit-testable without filesystem access — the suite runs inside the
 * workers pool with no `node:fs`. The impure wrapper lives in
 * `scripts/check-docs-links.mjs`, which feeds `{ path, text }` entries plus
 * the `git ls-files` set in.
 */

import { decodeHTMLStrict } from "entities";
import { Marked, parseInline } from "marked";

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

export const CHECK_NAME = "docs-links";

/** Any `scheme:` prefix (http:, https:, mailto:, …) — never a repo file. */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** Paperclip-internal board paths (e.g. `/TOG/issues/TOG-18899`). */
const PAPERCLIP_INTERNAL_PREFIX = "/TOG/";
/** GitHub custom-anchor syntax inside any HTML token (block or inline). */
const NAMED_ANCHOR_RE = /<a\s+[^>]*?\bname\s*=\s*(["'])([A-Za-z0-9_-]+)\1[^>]*>/gi;

/**
 * @typedef {{ path: string, text: string }} MarkdownFile
 * @typedef {{ text: string, target: string }} DocLink
 * @typedef {{ dirPrefixes: string[], suffixes: string[], exact: string[] }} IgnoreRules
 * @typedef {{ file: string, text: string, target: string, reason: string, resolved: string }} DocFinding
 */

/** Repo-relative posix normalization (no `node:path`: workers-pool safe). */
export function normalizeRepoPath(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

function posixDirname(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/**
 * Decode HTML entities back to plain text (full HTML5 set via the
 * `entities` package). `parseInline` returns escaped HTML, so without this
 * `'` / `&` / `"` / `<` / `>` leak into slugs as `39` / `amp` / `quot` /
 * `lt` / `gt`, and longer names (`mdash`, `nbsp`, `copy`, …) leak as their
 * bare names (GitHub slugs the plain text). Single-pass, like an HTML
 * tokenizer: `&amp;lt;` decodes to `&lt;`. Unknown entities are left alone.
 * Strict mode (trailing semicolon required, like GitHub): the legacy
 * decoder would turn the `&reg` prefix of an unknown `&region;` into `®`,
 * but GitHub renders the whole `&region;` as literal text.
 *
 * Must run AFTER {@link stripHtmlTags}: a decoded `&lt;id&gt;` looks like a
 * tag, so decoding first would let the tag-strip eat it and its text.
 *
 * @param {string} htmlText inline-rendered HTML with tags already stripped
 * @returns {string} plain text with entities decoded
 */
export function decodeHtmlEntities(htmlText) {
  return decodeHTMLStrict(String(htmlText));
}

/**
 * Strip real HTML tags from `parseInline` output, keeping the inner text.
 * Runs BEFORE entity decoding: at this point a literal `<id>` is still
 * escaped as `&lt;id&gt;` (untouched), while real markup (`<code>`, `<a>`,
 * `<b>`) is bare and removed. Escaped angle brackets decoded later are
 * punctuation, never tags.
 *
 * This is a scanner, not a regex replace: a single-pass multi-character
 * replace can leave a reassembled `<script` behind (CodeQL
 * js/incomplete-multi-character-sanitization). It is still not a general
 * HTML sanitizer — its only caller feeds the result to
 * {@link slugifyHeading}, which keeps only letters, numbers, marks,
 * connector punctuation, hyphens and spaces, so no markup can reach any
 * output. A `<` only starts a tag when followed by `!`, `/` or a letter,
 * and the tag ends at the first `>` before a line terminator.
 *
 * @param {string} inlineHtml `parseInline` output
 * @returns {string} HTML with tags removed, entities untouched
 */
function stripHtmlTags(inlineHtml) {
  const s = String(inlineHtml);
  let out = "";
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    const next = s[lt + 1];
    if (next === undefined || !/[!/a-z]/i.test(next)) {
      out += "<";
      i = lt + 1;
      continue;
    }
    let end = lt + 1;
    while (
      end < s.length &&
      s[end] !== ">" &&
      s[end] !== "\n" &&
      s[end] !== "\r" &&
      s[end] !== "\u2028" &&
      s[end] !== "\u2029"
    ) {
      end += 1;
    }
    if (end < s.length && s[end] === ">") {
      i = end + 1;
    } else {
      out += "<";
      i = lt + 1;
    }
  }
  return out;
}

/**
 * GitHub heading slug: lowercase, drop every character that is not a
 * letter, decimal/digit/letter number, mark, connector punctuation, hyphen
 * or space, then one hyphen per space (so a removed em-dash between spaces
 * leaves a double hyphen). Mirrors github-slugger: only `\p{Nd}` + `\p{Nl}`
 * numbers survive (other numbers like ² ½ ₂ are dropped) and `\p{Pc}`
 * (which includes `_`) is kept.
 * Angle brackets are punctuation here, so `<id>` slugs with its text kept
 * (`/v1/<id>` → `v1id`); tags must already be gone via {@link stripHtmlTags}.
 *
 * @param {string} plainText heading plain text AFTER tag stripping AND
 * entity decoding (see {@link stripHtmlTags} and {@link decodeHtmlEntities}:
 * markdown syntax, HTML tags and entities must already be gone)
 * @returns {string} the anchor slug
 */
export function slugifyHeading(plainText) {
  return String(plainText)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{Nd}\p{Nl}\p{M}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Visit a token and every nested token: block children (`.tokens`),
 * list items (`.items`) and table cells. `walkTokens` alone is not enough —
 * list-item bodies live under `.items`, so links inside bullets would be
 * missed.
 */
function eachToken(token, visit) {
  visit(token);
  if (Array.isArray(token.tokens)) {
    for (const child of token.tokens) eachToken(child, visit);
  }
  if (Array.isArray(token.items)) {
    for (const item of token.items) eachToken(item, visit);
  }
  if (token.type === "table") {
    const cells = [...(token.header ?? []), ...((token.rows ?? []).flat())];
    for (const cell of cells) eachToken(cell, visit);
  }
}

/**
 * Every `](target)` link (and image) target in a markdown document, in
 * document order. Fenced code, indented code and inline code spans never
 * produce link tokens, so code examples are ignored by construction.
 *
 * @param {string} markdownText full markdown source
 * @returns {DocLink[]} `{ text, target }` pairs (text is raw link text)
 */
export function extractLinks(markdownText) {
  const links = [];
  for (const token of markdown.lexer(String(markdownText))) {
    eachToken(token, (t) => {
      if (t.type === "link" || t.type === "image") {
        if (typeof t.href === "string" && t.href !== "") {
          links.push({ text: String(t.text ?? ""), target: t.href });
        }
        // Image alt text is literal prose, never link markup.
        if (t.type === "image") t.tokens = [];
      }
    });
  }
  return links;
}

/**
 * Every linkable anchor in a document: heading slugs in document order
 * (repeats numbered `-1`, `-2`, exactly like GitHub) plus `<a name>`
 * anchors. Anchors inside code fences are not HTML tokens, so examples
 * never contribute.
 *
 * @param {string} markdownText full markdown source
 * @returns {string[]} anchor slugs in document order
 */
export function extractAnchors(markdownText) {
  const occurrences = Object.create(null);
  const dedupe = (base) => {
    let result = base;
    while (Object.hasOwn(occurrences, result)) {
      occurrences[base] += 1;
      result = `${base}-${occurrences[base]}`;
    }
    occurrences[result] = 0;
    return result;
  };
  const anchors = [];
  for (const token of markdown.lexer(String(markdownText))) {
    eachToken(token, (t) => {
      if (t.type === "heading") {
        anchors.push(
          dedupe(slugifyHeading(decodeHtmlEntities(stripHtmlTags(parseInline(t.text))))),
        );
      } else if (t.type === "html") {
        NAMED_ANCHOR_RE.lastIndex = 0;
        for (const m of String(t.text).matchAll(NAMED_ANCHOR_RE)) {
          anchors.push(m[2]);
        }
        // Image alt text is not rendered HTML; handled under extractLinks.
      }
    });
  }
  return anchors;
}

/**
 * Parse `.gitignore` text into matchable rules. Supports the shapes this
 * repo uses: `dir/` prefixes, `*.ext` suffix globs and exact paths. `!`
 * negations and other globs are ignored (documented limitation — the
 * check fails closed on everything else, never silently green).
 *
 * @param {string} gitignoreText raw `.gitignore` text
 * @returns {IgnoreRules} dir prefixes (trailing slash), suffixes (leading dot), exact paths
 */
export function parseGitignore(gitignoreText) {
  const rules = { dirPrefixes: [], suffixes: [], exact: [] };
  for (let line of String(gitignoreText).split("\n")) {
    line = line.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    if (line.startsWith("/")) line = line.slice(1);
    if (line.endsWith("/")) rules.dirPrefixes.push(line);
    else if (line.startsWith("*.")) rules.suffixes.push(line.slice(1));
    else if (!line.includes("*")) rules.exact.push(line);
  }
  return rules;
}

/**
 * Whether a repo-relative path falls under the parsed gitignore rules.
 * Slash-less exact patterns match basenames at any depth (git semantics).
 *
 * @param {string} repoPath repo-relative posix path
 * @param {IgnoreRules} rules from {@link parseGitignore}
 * @returns {boolean}
 */
export function isIgnoredPath(repoPath, rules) {
  const p = normalizeRepoPath(repoPath);
  for (const prefix of rules.dirPrefixes ?? []) {
    const dir = normalizeRepoPath(prefix);
    if (p === dir || p.startsWith(`${dir}/`)) return true;
  }
  for (const suffix of rules.suffixes ?? []) {
    if (p.endsWith(suffix)) return true;
  }
  for (const pattern of rules.exact ?? []) {
    const exact = normalizeRepoPath(pattern);
    if (p === exact) return true;
    if (!exact.includes("/") && p.endsWith(`/${exact}`)) return true;
  }
  return false;
}

function isTrackedDir(resolved, tracked) {
  if (resolved === "") return true;
  const prefix = `${resolved}/`;
  for (const p of tracked) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Check every relative link in the given markdown files.
 *
 * @param {MarkdownFile[]} files repo-relative paths with full text
 * @param {{ trackedPaths?: string[], ignoreRules?: IgnoreRules }} options
 * all tracked repo-relative paths (existence = tracked, matching GitHub),
 * plus parsed gitignore rules for skip decisions
 * @returns {DocFinding[]} findings in scan order (`reason` is
 * `missing file` or `missing anchor`; `resolved` is the repo-relative
 * target for files, the scanning file for same-file anchors)
 */
export function checkDocsLinks(files, options = {}) {
  const { trackedPaths = [], ignoreRules = { dirPrefixes: [], suffixes: [], exact: [] } } = options;
  const tracked = new Set(trackedPaths.map(normalizeRepoPath));
  const byPath = new Map(files.map((f) => [normalizeRepoPath(f.path), String(f.text)]));
  const anchorCache = new Map();
  const anchorsFor = (resolved) => {
    let anchors = anchorCache.get(resolved);
    if (anchors === undefined) {
      anchors = extractAnchors(byPath.get(resolved) ?? "");
      anchorCache.set(resolved, anchors);
    }
    return anchors;
  };
  const findings = [];
  for (const { path, text } of files) {
    const file = normalizeRepoPath(path);
    for (const { text: linkText, target } of extractLinks(String(text))) {
      // Protocol-relative URLs (//host/path) are external links, not
      // repo-absolute paths; SCHEME_RE does not match them.
      if (SCHEME_RE.test(target) || target.startsWith("//")) continue;
      const hashIdx = target.indexOf("#");
      const rawPath = hashIdx === -1 ? target : target.slice(0, hashIdx);
      const anchor = hashIdx === -1 ? null : target.slice(hashIdx + 1);
      let resolved;
      if (rawPath === "") {
        resolved = file;
      } else if (rawPath.startsWith("/")) {
        if (rawPath.startsWith(PAPERCLIP_INTERNAL_PREFIX)) continue;
        resolved = normalizeRepoPath(rawPath.slice(1));
      } else {
        resolved = normalizeRepoPath(
          posixDirname(file) === "" ? rawPath : `${posixDirname(file)}/${rawPath}`,
        );
      }
      if (isIgnoredPath(resolved, ignoreRules)) continue;
      if (!tracked.has(resolved)) {
        if (isTrackedDir(resolved, tracked)) continue;
        findings.push({ file, text: linkText, target, reason: "missing file", resolved });
        continue;
      }
      if (anchor !== null && anchor !== "") {
        // Anchors are only verifiable in markdown sources with text at hand.
        // A tracked non-markdown target (or an unscanned file) cannot prove
        // an anchor either way, so it is skipped, not failed.
        if (!resolved.endsWith(".md") || !byPath.has(resolved)) continue;
        if (!anchorsFor(resolved).includes(anchor)) {
          findings.push({ file, text: linkText, target, reason: "missing anchor", resolved });
        }
      }
    }
  }
  return findings;
}

/** Cap link text so a finding line stays readable (never file contents). */
function shortText(text) {
  const s = String(text).replace(/\s+/g, " ");
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/**
 * Human report: `file: [text](target) (reason)` per finding, headed by a
 * FAIL line; empty when clean. Prints link text only, never file contents.
 *
 * @param {DocFinding[]} findings from {@link checkDocsLinks}
 * @returns {string[]} report lines
 */
export function formatReport(findings) {
  if (findings.length === 0) return [];
  const lines = [`${CHECK_NAME}: FAIL`];
  for (const f of findings) {
    const detail = f.reason === "missing file" ? f.resolved : f.target.slice(f.target.indexOf("#"));
    lines.push(`${f.file}: [${shortText(f.text)}](${f.target}) (${f.reason}: ${detail})`);
  }
  return lines;
}
