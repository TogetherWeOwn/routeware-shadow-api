/**
 * Unit tests for the docs link + anchor check (TOG-18936).
 *
 * Rule (docs/CONVENTIONS.md §7): every relative `](path)` / `](path#anchor)`
 * link in tracked `*.md` files must resolve — file exists (or is a tracked
 * directory), and any `#anchor` must match a heading slug (GitHub rules) or
 * an `<a name>` anchor in the target file. External URLs, mailto:, Paperclip
 * `/TOG/…` paths and links into gitignored paths are skipped.
 *
 * Pure logic lives in `scripts/lib/docsLinks.mjs` (no `node:fs`, so these
 * fixtures run inside the workers pool); the thin `node:fs` wrapper is
 * `scripts/check-docs-links.mjs`, exercised via `npm run check:docs-links`.
 *
 * NOTE: no real-tree glob integration test here (unlike
 * problemsAnchorCoverage.test.ts): cross-file targets such as `../src/app.ts`
 * are not markdown and cannot be bundled via `?raw`, so the tree is pinned by
 * the script's own run (exit 0) and the `check:ci-workflow` gate instead.
 */
import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  checkDocsLinks,
  decodeHtmlEntities,
  extractAnchors,
  extractLinks,
  formatReport,
  isIgnoredPath,
  parseGitignore,
  slugifyHeading,
} from "../scripts/lib/docsLinks.mjs";

const TRACKED = [
  "README.md",
  "docs/A.md",
  "docs/B.md",
  "src/app.ts",
  "LICENSE",
];

function files(
  entries: Array<[string, string]>,
): Array<{ path: string; text: string }> {
  return entries.map(([path, text]) => ({ path, text }));
}

describe("slugifyHeading (GitHub slug rules, TOG-18936)", () => {
  it("lowercases, strips punctuation, turns spaces into hyphens", () => {
    expect(slugifyHeading("Smoke Ladder: Five Commands (Fresh Clone)")).toBe(
      "smoke-ladder-five-commands-fresh-clone",
    );
  });

  it("collapses a removed em-dash between spaces into a double hyphen", () => {
    expect(slugifyHeading("0. Do this first — verify PR CI")).toBe(
      "0-do-this-first--verify-pr-ci",
    );
  });

  it("keeps underscores and hyphens (github-slugger parity)", () => {
    expect(slugifyHeading("gateway_failure readyz")).toBe("gateway_failure-readyz");
  });

  it("slugs rendered heading text, not raw markdown", () => {
    // Backticks and link destinations never reach a GitHub anchor.
    expect(slugifyHeading("See `npm run foo` and link text")).toBe(
      "see-npm-run-foo-and-link-text",
    );
  });
});

describe("decodeHtmlEntities + heading slugs (TOG-18936, review #261)", () => {
  it("decodes named and numeric entities in a single pass", () => {
    expect(
      decodeHtmlEntities("Don&#39;t &amp; Q &#x51;&amp;&#x41; &quot;hi&quot; &lt;x&gt;"),
    ).toBe("Don't & Q Q&A \"hi\" <x>");
    // Single-pass, like an HTML tokenizer: the outer entity decodes once.
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
    // Unknown entities are left alone, never silently dropped.
    expect(decodeHtmlEntities("&bogus;")).toBe("&bogus;");
  });

  it("slugs headings with ' & \" < > like GitHub", () => {
    expect(extractAnchors("## Don't panic\n")).toEqual(["dont-panic"]);
    expect(extractAnchors("## Q&A\n")).toEqual(["qa"]);
    expect(extractAnchors("## Say \"hi\"\n")).toEqual(["say-hi"]);
    expect(extractAnchors("## 1 < 2\n")).toEqual(["1--2"]);
  });

  it("resolves cross-file links to entity-bearing headings", () => {
    const findings = checkDocsLinks(
      files([
        ["docs/A.md", "See [p](B.md#dont-panic).\n"],
        ["docs/B.md", "## Don't panic\n"],
      ]),
      { trackedPaths: TRACKED, ignoreRules: { dirPrefixes: [], suffixes: [], exact: [] } },
    );
    expect(findings).toEqual([]);
  });
});

describe("extractLinks (TOG-18936)", () => {
  it("finds relative links with and without anchors", () => {
    const links = extractLinks(
      "See [B](B.md) and [sec](B.md#sec) here.\n",
    );
    expect(links).toEqual([
      { text: "B", target: "B.md" },
      { text: "sec", target: "B.md#sec" },
    ]);
  });

  it("ignores links inside fenced code blocks", () => {
    const links = extractLinks(
      "```md\n[broken](nope.md)\n```\n\nReal [ok](B.md).\n",
    );
    expect(links).toEqual([{ text: "ok", target: "B.md" }]);
  });

  it("ignores links inside inline code spans", () => {
    const links = extractLinks("Use `[x](y.md)` literally, plus [ok](B.md).\n");
    expect(links).toEqual([{ text: "ok", target: "B.md" }]);
  });

  it("keeps code opaque across mixed-character closers", () => {
    // Stock marked 18.1.0 ends the block at the ```~~ line and lints [z]
    // as a real link; the fences override holds the block open until the
    // matching closer, so only [ok] is extracted.
    const links = extractLinks(
      "```md\n[y](y.md)\n```~~\n[z](z.md)\n```\n\n[ok](ok.md)\n",
    );
    expect(links).toEqual([{ text: "ok", target: "ok.md" }]);
  });
});

describe("extractAnchors (TOG-18936)", () => {
  it("slugs headings and numbers duplicates like GitHub (-1, -2)", () => {
    const anchors = extractAnchors("## Dup\n\n## Dup\n\n## Dup\n");
    expect(anchors).toEqual(["dup", "dup-1", "dup-2"]);
  });

  it("collects <a name> anchors alongside heading slugs", () => {
    const anchors = extractAnchors(
      '# Title\n\n<a name="custom-anchor"></a>row\n',
    );
    expect(anchors).toContain("title");
    expect(anchors).toContain("custom-anchor");
  });

  it("ignores anchors inside fenced code blocks", () => {
    const anchors = extractAnchors(
      "# Real\n\n```md\n<a name=\"fake\"></a>\n```\n",
    );
    expect(anchors).toEqual(["real"]);
  });
});

describe("checkDocsLinks (TOG-18936)", () => {
  it("reports a missing file (the docs/docs/… rot class)", () => {
    const findings = checkDocsLinks(
      files([["docs/A.md", "Prior: [drill](docs/B.md).\n"]]),
      { trackedPaths: TRACKED, ignoreRules: { dirPrefixes: [], suffixes: [], exact: [] } },
    );
    expect(findings).toEqual([
      {
        file: "docs/A.md",
        text: "drill",
        target: "docs/B.md",
        reason: "missing file",
        resolved: "docs/docs/B.md",
      },
    ]);
  });

  it("reports a missing anchor in the same file", () => {
    const findings = checkDocsLinks(
      files([["docs/A.md", "# Real\n\nSee [x](#nope).\n"]]),
      { trackedPaths: TRACKED, ignoreRules: { dirPrefixes: [], suffixes: [], exact: [] } },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe("missing anchor");
  });

  it("resolves an anchor in another file", () => {
    const findings = checkDocsLinks(
      files([
        ["docs/A.md", "See [s](B.md#sec-one).\n"],
        ["docs/B.md", "# Sec One\n"],
      ]),
      { trackedPaths: TRACKED, ignoreRules: { dirPrefixes: [], suffixes: [], exact: [] } },
    );
    expect(findings).toEqual([]);
  });

  it("resolves a duplicate-heading -1 slug", () => {
    const findings = checkDocsLinks(
      files([["docs/A.md", "## Dup\n\n## Dup\n\nSee [d](#dup-1).\n"]]),
      { trackedPaths: TRACKED, ignoreRules: { dirPrefixes: [], suffixes: [], exact: [] } },
    );
    expect(findings).toEqual([]);
  });

  it("skips external URLs, mailto: and Paperclip-internal paths", () => {
    const findings = checkDocsLinks(
      files([
        [
          "docs/A.md",
          "See [w](https://example.com/x#y), [m](mailto:a@b.c) and [t](/TOG/issues/TOG-1).\n",
        ],
      ]),
      { trackedPaths: TRACKED, ignoreRules: { dirPrefixes: [], suffixes: [], exact: [] } },
    );
    expect(findings).toEqual([]);
  });

  it("skips links into gitignored paths", () => {
    const findings = checkDocsLinks(
      files([["CUSTOMER_SNAPSHOT.md", "See [r](tools/api-discovery/out/R.md).\n"]]),
      {
        trackedPaths: TRACKED,
        ignoreRules: { dirPrefixes: ["tools/api-discovery/out/"], suffixes: [], exact: [] },
      },
    );
    expect(findings).toEqual([]);
  });

  it("reports broken links inside bullets and table cells", () => {
    // Pins the `.items` walk (bullets) and the table-cell branch: removing
    // either must turn this red instead of failing the gate open.
    const findings = checkDocsLinks(
      files([
        ["docs/A.md", "- see [gone](nope.md)\n\n| h |\n|---|\n| [gone2](nope2.md) |\n"],
      ]),
      { trackedPaths: TRACKED, ignoreRules: { dirPrefixes: [], suffixes: [], exact: [] } },
    );
    expect(findings.map((f) => f.target).sort()).toEqual(["nope.md", "nope2.md"]);
  });

  it("links to headings inside blockquotes", () => {
    const findings = checkDocsLinks(
      files([["docs/A.md", "> ## Quoted\n\nSee [q](#quoted).\n"]]),
      { trackedPaths: TRACKED, ignoreRules: { dirPrefixes: [], suffixes: [], exact: [] } },
    );
    expect(findings).toEqual([]);
  });

  it("accepts links to tracked directories and non-markdown files", () => {
    const findings = checkDocsLinks(
      files([["docs/A.md", "See [lib](../src/) and [lic](../LICENSE).\n"]]),
      { trackedPaths: [...TRACKED, "src/other.ts"], ignoreRules: { dirPrefixes: [], suffixes: [], exact: [] } },
    );
    expect(findings).toEqual([]);
  });
});

describe("gitignore matching (TOG-18936)", () => {
  it("parses directory prefixes, suffix globs and exact files", () => {
    const rules = parseGitignore(
      "# comment\n\ntools/api-discovery/out/\n*.csv\nworker-configuration.d.ts\n",
    );
    expect(rules).toEqual({
      dirPrefixes: ["tools/api-discovery/out/"],
      suffixes: [".csv"],
      exact: ["worker-configuration.d.ts"],
    });
  });

  it("matches paths under an ignored directory and ignored suffixes", () => {
    const rules = parseGitignore("tools/api-discovery/out/\n*.csv\n");
    expect(isIgnoredPath("tools/api-discovery/out/R.md", rules)).toBe(true);
    expect(isIgnoredPath("exports/dump.csv", rules)).toBe(true);
    expect(isIgnoredPath("docs/A.md", rules)).toBe(false);
  });
});

describe("formatReport (TOG-18936)", () => {
  it("lists file: link (reason) lines, never file contents", () => {
    const lines = formatReport([
      { file: "docs/A.md", text: "drill", target: "docs/B.md", reason: "missing file", resolved: "docs/docs/B.md" },
      { file: "docs/A.md", text: "x", target: "#nope", reason: "missing anchor", resolved: "docs/A.md" },
    ]);
    expect(lines).toEqual([
      "docs-links: FAIL",
      "docs/A.md: [drill](docs/B.md) (missing file: docs/docs/B.md)",
      "docs/A.md: [x](#nope) (missing anchor: #nope)",
    ]);
  });

  it("is empty when there are no findings", () => {
    expect(formatReport([])).toEqual([]);
  });
});

describe("check name (TOG-18936)", () => {
  it("exposes the hygiene check name", () => {
    expect(CHECK_NAME).toBe("docs-links");
  });
});
