/**
 * Vite client types for `import.meta.glob` and the generic `*?raw`
 * text-import declaration (covers `docs/PROBLEMS.md?raw` below). Declared
 * here — not in `test/env.d.ts` — so this slice stays two new files with
 * zero modifications to shared files. The suite runs inside the workers
 * pool with no `node:fs`, so repo text is read through bundled `?raw`
 * imports instead of filesystem reads.
 */
/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  compareAnchors,
  extractCodeSlugs,
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
  "| `bad-request` | 400 | Malformed. |",
  "| `not-found` | 404 | Missing. |",
  "",
  "## Authentication (`unauthorized`)",
  "",
  "See `not-found` for details.",
  "",
].join("\n");

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

  it("flags non-literal problemType( usages with file and line", () => {
    const result = extractCodeSlugs([
      { path: "src/a.ts", text: 'problemType("ok-slug")\nproblemType(slug)\nproblemType(`tpl`)' },
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
});

describe("problems anchor check: comparison", () => {
  it("passes when code and doc slugs match exactly", () => {
    const result = compareAnchors({
      codeSlugs: ["bad-request", "not-found"],
      docSlugs: ["not-found", "bad-request"],
    });
    expect(result.ok).toBe(true);
    expect(formatAnchorReport(result)).toEqual([]);
  });

  it("fails on a bogus code slug with no doc row (the reviewer acceptance probe)", () => {
    const result = compareAnchors({
      codeSlugs: ["bad-request", "bogus-slug"],
      docSlugs: ["bad-request", "not-found"],
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
    });
    expect(result.ok).toBe(false);
    expect(result.unreferenced).toEqual(["stale-row"]);
  });

  it("fails on non-literal usages even when every literal slug matches", () => {
    const dynamicUsages = [{ path: "src/a.ts", line: 7 }];
    const result = compareAnchors({
      codeSlugs: ["bad-request"],
      docSlugs: ["bad-request"],
      dynamicUsages,
    });
    expect(result.ok).toBe(false);
    expect(formatAnchorReport(result).join("\n")).toContain("src/a.ts:7");
  });
});

describe("problems anchor check: real tree", () => {
  it("every problemType() slug resolves to a PROBLEMS.md row and back", () => {
    // Arrange — fail closed if the glob ever matches nothing: empty sets
    // would compare vacuously green.
    const files = Object.entries(srcModules).map(([key, text]) => ({
      path: key.replace(/^\.\.\//, ""),
      text,
    }));
    expect(files.length).toBeGreaterThan(0);

    // Act
    const { slugs: codeSlugs, dynamic } = extractCodeSlugs(files);
    const docSlugs = extractDocSlugs(problemsMd);
    expect(codeSlugs.length).toBeGreaterThan(0);
    expect(docSlugs.length).toBeGreaterThan(0);
    const result = compareAnchors({ codeSlugs, docSlugs, dynamicUsages: dynamic });

    // Assert — the diff names the offending slug(s) on failure.
    expect({
      unknown: result.unknown,
      unreferenced: result.unreferenced,
      dynamic: result.dynamicUsages,
    }).toEqual({ unknown: [], unreferenced: [], dynamic: [] });
  });
});
