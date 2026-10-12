/**
 * Vite client types for `import.meta.glob` and the generic `*?raw`
 * text-import declaration (covers `docs/LOGGING.md?raw` below). The suite
 * runs inside the workers pool with no `node:fs`, so repo text is read
 * through bundled `?raw` imports instead of filesystem reads.
 */
/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import loggingMd from "../docs/LOGGING.md?raw";

// Every src module as text. The suite runs inside the workers pool (workerd:
// no `node:fs`), so the tree is read through Vite `?raw` imports bundled at
// transform time instead of filesystem reads.
const srcModules = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * String-literal `msg` values: `msg: "literal"` directly after the colon.
 * Ternary and template forms never match on purpose — they are pinned in
 * COMPUTED_MESSAGES below instead of being silently half-covered:
 * - `src/lib/entityDataCache.ts:76` emits `entry ? "Entity data cache hit"`
 *   `: "Entity data cache miss"` (a ternary, not a `msg: "..."` literal).
 * - `src/lib/snapshot/export.ts:101` emits a template literal with
 *   `${SNAPSHOT_EXPORT_MAX_PAGE_SIZE}` / `${SNAPSHOT_EXPORT_PAGE_SIZE}`
 *   interpolations (backticks, not double quotes).
 */
const CODE_MSG_RE = /msg:\s*"([^"]+)"/g;

/** Catalogue table rows: `| `msg` | level | …` at line start. */
const DOC_ROW_RE = /^\|\s*`(.+?)`\s*\|/gm;

/**
 * Computed messages, in exact placeholder form as they appear in the
 * catalogue table's `msg` column. Explicit by design: the literal scan
 * above cannot see these call sites, so each one is pinned here and the
 * comparison treats them as emitted. Add a row here (with this comment
 * updated) when a new computed `msg` lands under `src/`.
 */
const COMPUTED_MESSAGES = [
  // Ternary in getCachedDataEntity (src/lib/entityDataCache.ts:76).
  "Entity data cache hit",
  "Entity data cache miss",
  // Template in readSnapshotExportPageSize (src/lib/snapshot/export.ts:101);
  // the ${...} names are the placeholder — the live line carries numbers.
  "SNAPSHOT_EXPORT_PAGE_SIZE ignored (quote an integer from 1 to ${SNAPSHOT_EXPORT_MAX_PAGE_SIZE}); using ${SNAPSHOT_EXPORT_PAGE_SIZE}",
];

function extractCodeMessages(files: Array<{ path: string; text: string }>): string[] {
  const found = new Set<string>();
  for (const { text } of files) {
    for (const m of String(text).matchAll(CODE_MSG_RE)) {
      found.add(m[1]);
    }
  }
  for (const msg of COMPUTED_MESSAGES) {
    found.add(msg);
  }
  return [...found].sort();
}

function extractDocMessages(markdownText: string): string[] {
  const marker = "## Event catalogue";
  const at = String(markdownText).indexOf(marker);
  // No catalogue section yet (or removed): every emitted message reads as
  // missing, so the real-tree tests fail naming the messages themselves
  // instead of passing vacuously green on an empty set.
  if (at < 0) return [];
  const catalogue = String(markdownText).slice(at);
  return [...new Set([...catalogue.matchAll(DOC_ROW_RE)].map((m) => m[1]))].sort();
}

function checkTree(markdownText: string) {
  const files = Object.entries(srcModules).map(([key, text]) => ({
    path: (key as string).replace(/^\.\.\//, ""),
    text: text as string,
  }));
  // Fail closed if the glob ever matches nothing: empty sets would compare
  // vacuously green.
  expect(files.length).toBeGreaterThan(0);
  const code = extractCodeMessages(files);
  const doc = extractDocMessages(markdownText);
  expect(code.length).toBeGreaterThan(0);
  const codeSet = new Set(code);
  const docSet = new Set(doc);
  return {
    missing: code.filter((m) => !docSet.has(m)),
    stale: doc.filter((m) => !codeSet.has(m)),
  };
}

describe("logging catalogue coverage: extraction", () => {
  it("extracts only direct string-literal msg values", () => {
    expect(
      extractCodeMessages([
        { path: "src/a.ts", text: 'logEvent({ level: "info", msg: "Plain event", route: "x" })' },
        { path: "src/b.ts", text: 'logEvent({ level: "info", msg: entry ? "Hit" : "Miss", route: "x" })' },
        { path: "src/c.ts", text: "logEvent({ level: \"warn\", msg: `Template ${n}`, route: \"x\" })" },
      ]).filter((m) => ["Plain event", "Hit", "Miss", "Template"].some((k) => m.includes(k))),
    ).toEqual(["Plain event"]);
  });

  it("reads catalogue rows only, ignoring headings and prose", () => {
    const md = [
      "## Event catalogue",
      "",
      "| msg | level |",
      "|-----|-------|",
      "| `Plain event` | info |",
      "See `Plain event` for details.",
      "",
    ].join("\n");
    expect(extractDocMessages(md)).toEqual(["Plain event"]);
  });
});

describe("logging catalogue coverage: real tree", () => {
  it("every emitted msg is catalogued in docs/LOGGING.md", () => {
    expect(checkTree(loggingMd).missing).toEqual([]);
  });

  it("the catalogue lists no message src/ no longer emits", () => {
    expect(checkTree(loggingMd).stale).toEqual([]);
  });
});
