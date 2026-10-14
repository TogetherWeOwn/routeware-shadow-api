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
 * Computed call sites, in exact placeholder form as they appear in the
 * catalogue table's `msg` column. Explicit by design: the literal scan
 * above cannot see these call sites, so each one is pinned here. A site's
 * messages count as emitted only when every `evidence` string is still
 * present verbatim in its source file — a reworded or deleted computed
 * call therefore stops crediting its catalogue rows and the stale-row
 * test fails. Add a site here (with this comment updated) when a new
 * computed `msg` lands under `src/`; the call-site count test below
 * fails until you do.
 */
const COMPUTED_CALL_SITES: ReadonlyArray<{
  file: string;
  messages: readonly string[];
  evidence: readonly string[];
}> = [
  {
    // Ternary in getCachedDataEntity (src/lib/entityDataCache.ts:76).
    file: "src/lib/entityDataCache.ts",
    messages: ["Entity data cache hit", "Entity data cache miss"],
    evidence: ['"Entity data cache hit"', '"Entity data cache miss"'],
  },
  {
    // Template in readSnapshotExportPageSize (src/lib/snapshot/export.ts:101);
    // the ${...} names are the placeholder — the live line carries numbers.
    file: "src/lib/snapshot/export.ts",
    messages: [
      "SNAPSHOT_EXPORT_PAGE_SIZE ignored (quote an integer from 1 to ${SNAPSHOT_EXPORT_MAX_PAGE_SIZE}); using ${SNAPSHOT_EXPORT_PAGE_SIZE}",
    ],
    evidence: [
      "`SNAPSHOT_EXPORT_PAGE_SIZE ignored (quote an integer from 1 to ${SNAPSHOT_EXPORT_MAX_PAGE_SIZE}); using ${SNAPSHOT_EXPORT_PAGE_SIZE}`",
    ],
  },
];

const COMPUTED_MESSAGES = COMPUTED_CALL_SITES.flatMap((site) => site.messages);

/** `logEvent(` call sites (the definition in src/lib/logger.ts excluded). */
const LOG_EVENT_CALL_RE = /\blogEvent\s*\(/g;

function verifiedComputedMessages(files: Array<{ path: string; text: string }>): string[] {
  const verified: string[] = [];
  for (const site of COMPUTED_CALL_SITES) {
    const file = files.find((f) => f.path === site.file || f.path.endsWith(`/${site.file}`));
    if (file && site.evidence.every((snippet) => String(file.text).includes(snippet))) {
      verified.push(...site.messages);
    }
  }
  return verified;
}

function countMatches(re: RegExp, files: Array<{ path: string; text: string }>): number {
  let total = 0;
  for (const { text } of files) {
    total += [...String(text).matchAll(re)].length;
  }
  return total;
}

function countLogEventCallSites(files: Array<{ path: string; text: string }>): number {
  return countMatches(
    LOG_EVENT_CALL_RE,
    files.filter((f) => !f.path.endsWith("src/lib/logger.ts")),
  );
}

function extractCodeMessages(files: Array<{ path: string; text: string }>): string[] {
  const found = new Set<string>();
  for (const { text } of files) {
    for (const m of String(text).matchAll(CODE_MSG_RE)) {
      found.add(m[1]);
    }
  }
  for (const msg of verifiedComputedMessages(files)) {
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

function realFiles(): Array<{ path: string; text: string }> {
  return Object.entries(srcModules).map(([key, text]) => ({
    path: (key as string).replace(/^\.\.\//, ""),
    text: text as string,
  }));
}

function checkTree(markdownText: string) {
  const files = realFiles();
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

  it("credits computed messages only when their source evidence is present", () => {
    const present = extractCodeMessages([
      {
        path: "src/lib/entityDataCache.ts",
        text: 'logEvent({ level: "info", msg: entry ? "Entity data cache hit" : "Entity data cache miss", route: "x" })',
      },
    ]);
    expect(present).toContain("Entity data cache hit");
    expect(present).toContain("Entity data cache miss");

    const reworded = extractCodeMessages([
      {
        path: "src/lib/entityDataCache.ts",
        text: 'logEvent({ level: "info", msg: entry ? "Entity hit RENAMED" : "Entity miss RENAMED", route: "x" })',
      },
    ]);
    expect(reworded).not.toContain("Entity data cache hit");
    expect(reworded).not.toContain("Entity data cache miss");
    expect(COMPUTED_MESSAGES).toContain("Entity data cache hit");
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

  it("every logEvent call site is a literal msg or a known computed call site", () => {
    const files = realFiles();
    expect(files.length).toBeGreaterThan(0);
    // A msg in any other form (single quotes, backticks, a const, a new
    // ternary) is invisible to the literal scan, so it must fail here and
    // be added to COMPUTED_CALL_SITES on purpose instead of slipping by.
    expect(countLogEventCallSites(files)).toBe(
      countMatches(CODE_MSG_RE, files) + COMPUTED_CALL_SITES.length,
    );
  });
});
