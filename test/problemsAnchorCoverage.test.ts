/**
 * Vite client types for `import.meta.glob` and the generic `*?raw`
 * text-import declaration (covers `docs/PROBLEMS.md?raw` below). The suite
 * runs inside the workers pool with no `node:fs`, so repo text is read
 * through bundled `?raw` imports instead of filesystem reads.
 */
/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  compareAnchors,
  extractCodeSlugs,
  extractDocAnchors,
  extractDocSlugs,
  formatAnchorReport,
} from "../scripts/lib/problemsAnchorCheck.mjs";
import problemsMd from "../docs/PROBLEMS.md?raw";

// Every src module as text. The suite runs inside the workers pool (workerd:
// no `node:fs`), so the tree is read through Vite `?raw` imports bundled at
// transform time instead of filesystem reads.
const srcModules = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

const DOC_FIXTURE = [
  "| Slug (`type` anchor) | HTTP status | Meaning |",
  "|----------------------|-------------|---------|",
  '| `bad-request` | 400 | <a name="bad-request"></a>Malformed. |',
  "| `not-found` | 404 | <a name='not-found'></a>Missing. |",
  "",
  "## Authentication (`unauthorized`)",
  "",
  "See `not-found` for details.",
  "",
].join("\n");

function checkTree(markdownText: string) {
  const files = Object.entries(srcModules).map(([key, text]) => ({
    path: key.replace(/^\.\.\//, ""),
    text,
  }));
  // Fail closed if the glob ever matches nothing: empty sets would compare
  // vacuously green.
  expect(files.length).toBeGreaterThan(0);
  const { slugs: codeSlugs, dynamic } = extractCodeSlugs(files);
  const docSlugs = extractDocSlugs(markdownText);
  expect(codeSlugs.length).toBeGreaterThan(0);
  expect(docSlugs.length).toBeGreaterThan(0);
  return compareAnchors({
    codeSlugs,
    docSlugs,
    anchorSlugs: extractDocAnchors(markdownText),
    dynamicUsages: dynamic,
  });
}

describe("problems anchor check: code extraction", () => {
  it("extracts double- and single-quoted slugs with the files using them", () => {
    const result = extractCodeSlugs([
      { path: "src/a.ts", text: 'type: problemType("bad-request"),' },
      { path: "src/b.ts", text: "type: problemType('not-found'), // x\ntype: problemType(\"bad-request\")," },
    ]);
    expect(result.slugs).toEqual(["bad-request", "not-found"]);
    expect(result.bySlug["bad-request"]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.dynamic).toEqual([]);
  });

  it("extracts literal slugs with an environment override argument", () => {
    const result = extractCodeSlugs([
      { path: "src/helper.ts", text: 'problemType("bad-gateway", env)\nproblemType(\'payload-too-large\', c.env)' },
    ]);
    expect(result.slugs).toEqual(["bad-gateway", "payload-too-large"]);
    expect(result.dynamic).toEqual([]);
  });

  it("flags non-literal problemType( usages with file and line", () => {
    const result = extractCodeSlugs([
      { path: "src/a.ts", text: 'problemType("ok-slug")\nproblemType(slug, env)\nproblemType(`tpl`, env)' },
    ]);
    expect(result.slugs).toEqual(["ok-slug"]);
    expect(result.dynamic).toEqual([
      { path: "src/a.ts", line: 2 },
      { path: "src/a.ts", line: 3 },
    ]);
  });

  it("skips the helper's own function declaration", () => {
    const result = extractCodeSlugs([
      { path: "src/lib/problem.ts", text: "export function problemType(slug: string): string {" },
    ]);
    expect(result.slugs).toEqual([]);
    expect(result.dynamic).toEqual([]);
  });
});

describe("problems anchor check: doc extraction", () => {
  it("reads slugs from table rows only, ignoring headings and prose", () => {
    expect(extractDocSlugs(DOC_FIXTURE)).toEqual(["bad-request", "not-found"]);
  });

  it("reads explicit named anchors, not table cells or heading mentions", () => {
    expect(extractDocAnchors(DOC_FIXTURE)).toEqual(["bad-request", "not-found"]);
    expect(extractDocAnchors('| `payload-too-large` | 413 | Too big. |\n## Oversized (`payload-too-large`)')).toEqual([]);
  });

  it("ignores anchors quoted in code examples or HTML comments", () => {
    const examples = [
      '<!-- <a name="commented"></a> -->',
      '`<a name="inline"></a>`',
      '`multiline\n<a name="multiline-inline"></a>\nexample`',
      '    <a name="indented"></a>',
      '\t<a name="tab-indented"></a>',
      "```html",
      '<a name="backtick-fence"></a>',
      "```",
      "~~~html",
      '<a name="tilde-fence"></a>',
      "~~~",
      '<a name="real"></a>',
    ].join("\n");
    expect(extractDocAnchors(examples)).toEqual(["real"]);
  });
});

describe("problems anchor check: comparison", () => {
  it("passes when code, doc slugs and named anchors match exactly", () => {
    const result = compareAnchors({
      codeSlugs: ["bad-request", "not-found"],
      docSlugs: ["not-found", "bad-request"],
      anchorSlugs: ["bad-request", "not-found"],
    });
    expect(result.ok).toBe(true);
    expect(formatAnchorReport(result)).toEqual([]);
  });

  it("fails on a bogus code slug with no doc row (the reviewer acceptance probe)", () => {
    const result = compareAnchors({
      codeSlugs: ["bad-request", "bogus-slug"],
      docSlugs: ["bad-request", "not-found"],
      anchorSlugs: ["bad-request", "not-found"],
    });
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(["bogus-slug"]);
    expect(result.unreferenced).toEqual(["not-found"]);
    const report = formatAnchorReport(result).join("\n");
    expect(report).toContain(`${CHECK_NAME}: FAIL`);
    expect(report).toContain("bogus-slug");
  });

  it("fails on a doc row no code references", () => {
    const result = compareAnchors({
      codeSlugs: ["bad-request"],
      docSlugs: ["bad-request", "stale-row"],
      anchorSlugs: ["bad-request", "stale-row"],
    });
    expect(result.ok).toBe(false);
    expect(result.unreferenced).toEqual(["stale-row"]);
  });

  it("reports missing explicit anchors in sorted order despite matching rows", () => {
    const result = compareAnchors({
      codeSlugs: ["payload-too-large", "bad-request"],
      docSlugs: ["payload-too-large", "bad-request"],
      anchorSlugs: [],
    });
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual([]);
    expect(result.unreferenced).toEqual([]);
    expect(result.missingAnchors).toEqual(["bad-request", "payload-too-large"]);
    expect(formatAnchorReport(result)).toContain("slug with no PROBLEMS.md named anchor: payload-too-large");
  });

  it("fails on non-literal usages even when every literal slug matches", () => {
    const dynamicUsages = [{ path: "src/a.ts", line: 7 }];
    const result = compareAnchors({
      codeSlugs: ["bad-request"],
      docSlugs: ["bad-request"],
      anchorSlugs: ["bad-request"],
      dynamicUsages,
    });
    expect(result.ok).toBe(false);
    expect(formatAnchorReport(result).join("\n")).toContain("src/a.ts:7");
  });
});

describe("problems anchor check: real tree", () => {
  it("every problemType() slug resolves to a PROBLEMS.md row and named target", () => {
    const result = checkTree(problemsMd);
    expect({
      unknown: result.unknown,
      unreferenced: result.unreferenced,
      missingAnchors: result.missingAnchors,
      dynamic: result.dynamicUsages,
    }).toEqual({ unknown: [], unreferenced: [], missingAnchors: [], dynamic: [] });
    expect(result.ok).toBe(true);
  });

  it("fails if the payload-too-large target disappears but its table row remains", () => {
    const broken = problemsMd.replace('<a name="payload-too-large"></a>', "");
    expect(broken).not.toBe(problemsMd);
    const result = checkTree(broken);
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual([]);
    expect(result.unreferenced).toEqual([]);
    expect(result.missingAnchors).toEqual(["payload-too-large"]);
  });
});
