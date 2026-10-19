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

/** Catalogue table rows: `| `msg` | level | …` at line start. */
const DOC_ROW_RE = /^\|\s*`(.+?)`\s*\|/gm;

/**
 * Explicit computed `msg` expressions, mapped to their catalogue placeholders.
 * The TypeScript AST must find the exact expression at the stated call site
 * before its messages count as emitted; edits or deletion make rows stale.
 * Add a site here (and update this comment) when a computed `msg` is added.
 */
const COMPUTED_CALL_SITES: ReadonlyArray<{
  file: string;
  expression: string;
  messages: readonly string[];
}> = [
  {
    // Ternary in getCachedDataEntity (src/lib/entityDataCache.ts:78).
    file: "src/lib/entityDataCache.ts",
    expression: 'entry ? "Entity data cache hit" : "Entity data cache miss"',
    messages: ["Entity data cache hit", "Entity data cache miss"],
  },
  {
    // Template in readSnapshotExportPageSize (src/lib/snapshot/export.ts:101).
    file: "src/lib/snapshot/export.ts",
    expression:
      "`SNAPSHOT_EXPORT_PAGE_SIZE ignored (quote an integer from 1 to ${SNAPSHOT_EXPORT_MAX_PAGE_SIZE}); using ${SNAPSHOT_EXPORT_PAGE_SIZE}`",
    messages: [
      "SNAPSHOT_EXPORT_PAGE_SIZE ignored (quote an integer from 1 to ${SNAPSHOT_EXPORT_MAX_PAGE_SIZE}); using ${SNAPSHOT_EXPORT_PAGE_SIZE}",
    ],
  },
];

/** Log calls that the lexical scanner could not inspect as inline objects. */
type UntrackedMessage = { path: string; line: number; expression: string };

/** Counts source call tokens independently of the scanner's quote/comment state. */
function countLogEventCalls(text: string): number {
  return [
    ...text.matchAll(/\blogEvent\s*\(/g),
    ...text.matchAll(/\blogEvent\s*\/\*[\s\S]*?\*\/\s*\(/g),
  ].length;
}

function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  let at = start + 1;
  while (at < text.length) {
    if (text[at] === "\\") {
      at += 2;
    } else if (text[at] === quote) {
      return at + 1;
    } else {
      at++;
    }
  }
  return text.length;
}

function skipComment(text: string, start: number): number {
  if (text.startsWith("//", start)) {
    const newline = text.indexOf("\n", start + 2);
    return newline < 0 ? text.length : newline + 1;
  }
  if (text.startsWith("/*", start)) {
    const end = text.indexOf("*/", start + 2);
    return end < 0 ? text.length : end + 2;
  }
  return start;
}

function skipTrivia(text: string, start: number): number {
  let at = start;
  while (at < text.length) {
    if (/\s/.test(text[at])) {
      at++;
    } else {
      const next = skipComment(text, at);
      if (next === at) break;
      at = next;
    }
  }
  return at;
}

function findBalancedEnd(text: string, start: number): number {
  const openings: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack = [openings[text[start]]];
  let at = start + 1;
  while (at < text.length && stack.length > 0) {
    const char = text[at];
    if (char === "'" || char === '"' || char === "`") {
      at = skipQuoted(text, at);
    } else {
      const next = skipComment(text, at);
      if (next !== at) {
        at = next;
      } else if (openings[char]) {
        stack.push(openings[char]);
        at++;
      } else if (char === stack[stack.length - 1]) {
        stack.pop();
        at++;
      } else {
        at++;
      }
    }
  }
  return stack.length === 0 ? at - 1 : text.length;
}

function logEventObjectStart(text: string, callStart: number): number | undefined {
  const openParen = skipTrivia(text, callStart + "logEvent".length);
  if (text[openParen] !== "(") return undefined;
  const objectStart = skipTrivia(text, openParen + 1);
  return text[objectStart] === "{" ? objectStart : undefined;
}

function logEventObjectEnd(text: string, callStart: number): number | undefined {
  const objectStart = logEventObjectStart(text, callStart);
  if (objectStart === undefined) return undefined;
  const objectEnd = findBalancedEnd(text, objectStart);
  return objectEnd < text.length ? objectEnd : undefined;
}

function topLevelProperties(text: string, objectStart: number, objectEnd: number): string[] {
  const properties: string[] = [];
  let start = objectStart + 1;
  let at = start;
  const stack: string[] = [];
  const closing: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  while (at < objectEnd) {
    const char = text[at];
    if (char === "'" || char === '"' || char === "`") {
      at = skipQuoted(text, at);
    } else {
      const next = skipComment(text, at);
      if (next !== at) {
        at = next;
      } else if (closing[char]) {
        stack.push(closing[char]);
        at++;
      } else if (char === stack[stack.length - 1]) {
        stack.pop();
        at++;
      } else if (char === "," && stack.length === 0) {
        properties.push(text.slice(start, at));
        start = ++at;
      } else {
        at++;
      }
    }
  }
  properties.push(text.slice(start, objectEnd));
  return properties;
}

function parseLiteral(expression: string): string | undefined {
  const value = expression.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  if (value.startsWith("`") && value.endsWith("`") && !value.includes("${")) {
    return value.slice(1, -1).replace(/\\`/g, "`").replace(/\\\\/g, "\\");
  }
  return undefined;
}

function inspectLogEventMessages(
  files: Array<{ path: string; text: string }>,
): { messages: string[]; untracked: UntrackedMessage[] } {
  const found = new Set<string>();
  const untracked: UntrackedMessage[] = [];
  let callCount = 0;
  let inspectedCallCount = 0;
  const callsByFile = new Map<string, number>();
  const inspectedByFile = new Map<string, number>();
  for (const { path, text: sourceText } of files) {
    const text = String(sourceText);
    const normalizedPath = path.replace(/^\.\.\//, "");
    // logger.ts defines logEvent; it is not an emitted-event call site.
    if (normalizedPath === "src/lib/logger.ts" || normalizedPath.endsWith("/src/lib/logger.ts")) continue;
    // Keep an independent count pin so lexer blind spots (including regex
    // literals) cannot silently hide a new call.
    const fileCalls = countLogEventCalls(text);
    callCount += fileCalls;
    callsByFile.set(normalizedPath, fileCalls);
    if (/import\s*\{[^}]*\blogEvent\s+as\s+\w+/s.test(text)) {
      untracked.push({
        path: normalizedPath,
        line: text.slice(0, text.search(/import\s*\{[^}]*\blogEvent\s+as\s+\w+/s)).split("\n").length,
        expression: "<aliased logEvent import>",
      });
    }
    let at = 0;
    while (at < text.length) {
      const char = text[at];
      if (char === "'" || char === '"' || char === "`") {
        at = skipQuoted(text, at);
      } else {
        const next = skipComment(text, at);
        if (next !== at) {
          at = next;
        } else if (
          text.startsWith("logEvent", at) &&
          !/[\w$]/.test(text[at - 1] ?? "") &&
          !/[\w$]/.test(text[at + "logEvent".length] ?? "")
        ) {
          const openParen = skipTrivia(text, at + "logEvent".length);
          if (text[openParen] !== "(") {
            at += "logEvent".length;
            continue;
          }
          inspectedCallCount++;
          inspectedByFile.set(normalizedPath, (inspectedByFile.get(normalizedPath) ?? 0) + 1);
          const objectStart = logEventObjectStart(text, at);
          const objectEnd = logEventObjectEnd(text, at);
          if (objectStart !== undefined && objectEnd !== undefined) {
            const msgProperty = topLevelProperties(text, objectStart, objectEnd).find((property) =>
              /^\s*(?:msg|["']msg["'])\s*:/.test(property),
            );
            if (msgProperty) {
              const initializer = msgProperty.replace(/^\s*(?:msg|["']msg["'])\s*:/, "").trim();
              const literal = parseLiteral(initializer);
              if (literal !== undefined) {
                found.add(literal);
              } else {
                const site = COMPUTED_CALL_SITES.find(
                  (entry) =>
                    (normalizedPath === entry.file || normalizedPath.endsWith(`/${entry.file}`)) &&
                    initializer === entry.expression,
                );
                if (site) {
                  site.messages.forEach((message) => found.add(message));
                } else {
                  untracked.push({
                    path: normalizedPath,
                    line: text.slice(0, objectStart).split("\n").length,
                    expression: initializer,
                  });
                }
              }
            } else {
              untracked.push({
                path: normalizedPath,
                line: text.slice(0, objectStart).split("\n").length,
                expression: "<missing msg property>",
              });
            }
            at = objectEnd + 1;
          } else {
            const openParen = skipTrivia(text, at + "logEvent".length);
            const end = text[openParen] === "("
              ? findBalancedEnd(text, openParen)
              : openParen;
            untracked.push({
              path: normalizedPath,
              line: text.slice(0, at).split("\n").length,
              expression: text[openParen] === "("
                ? text.slice(openParen + 1, end).trim() || "<empty argument>"
                : "<missing call argument>",
            });
            at = end < text.length ? end + 1 : at + "logEvent".length;
          }
        } else {
          at++;
        }
      }
    }
  }
  if (callCount !== inspectedCallCount) {
    const offenders: string[] = [];
    for (const [filePath, calls] of callsByFile) {
      const inspected = inspectedByFile.get(filePath) ?? 0;
      if (calls !== inspected) {
        offenders.push(`${filePath} (${calls} calls, ${inspected} inspected)`);
      }
    }
    const offenderSuffix = offenders.length > 0 ? `; offending files: ${offenders.join(", ")}` : "";
    untracked.push({
      path: "src/",
      line: 1,
      expression: `<logEvent call count mismatch: ${callCount} calls, scanner inspected ${inspectedCallCount}${offenderSuffix}>`,
    });
  }
  return { messages: [...found].sort(), untracked };
}

function extractCodeMessages(files: Array<{ path: string; text: string }>): string[] {
  return inspectLogEventMessages(files).messages;
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
  const inspected = inspectLogEventMessages(files);
  const code = inspected.messages;
  const doc = extractDocMessages(markdownText);
  expect(code.length).toBeGreaterThan(0);
  const codeSet = new Set(code);
  const docSet = new Set(doc);
  return {
    missing: code.filter((m) => !docSet.has(m)),
    stale: doc.filter((m) => !codeSet.has(m)),
    untracked: inspected.untracked,
  };
}

describe("logging catalogue coverage: extraction", () => {
  it("extracts string literals in any quote style and identifies computed values", () => {
    const files = [
      { path: "src/a.ts", text: 'logEvent /* whitespace */ ( { level: "info", msg: "Double quoted", route: "x" })' },
      { path: "src/b.ts", text: "logEvent({ level: 'info', msg: 'Single quoted', route: 'x' })" },
      { path: "src/c.ts", text: "logEvent({ level: 'info', msg: `No interpolation`, route: 'x' })" },
      { path: "src/d.ts", text: "logEvent({ level: 'warn', msg: `Template ${n}`, route: 'x' })" },
      { path: "src/e.ts", text: 'const message = "Const value"; logEvent({ level: "info", msg: message, route: "x" })' },
      { path: "src/f.ts", text: 'logEvent({ level: "info", route: "x" })' },
    ];
    expect(extractCodeMessages(files)).toEqual([
      "Double quoted",
      "No interpolation",
      "Single quoted",
    ]);
    expect(inspectLogEventMessages(files).untracked).toEqual([
      { path: "src/d.ts", line: 1, expression: "`Template ${n}`" },
      { path: "src/e.ts", line: 1, expression: "message" },
      { path: "src/f.ts", line: 1, expression: "<missing msg property>" },
    ]);
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
    expect(inspectLogEventMessages([
      {
        path: "src/lib/entityDataCache.ts",
        text: 'logEvent({ level: "info", msg: entry ? "Entity hit RENAMED" : "Entity miss RENAMED", route: "x" })',
      },
    ]).untracked).toEqual([
      {
        path: "src/lib/entityDataCache.ts",
        line: 1,
        expression: 'entry ? "Entity hit RENAMED" : "Entity miss RENAMED"',
      },
    ]);
  });

  it("fails closed on non-object calls, aliased imports, and regex literals", () => {
    const nonObject = inspectLogEventMessages([
      { path: "src/a.ts", text: "logEvent(payload)" },
    ]);
    expect(nonObject.untracked).toContainEqual({
      path: "src/a.ts",
      line: 1,
      expression: "payload",
    });

    const aliased = inspectLogEventMessages([
      {
        path: "src/a.ts",
        text: 'import { logEvent as emit } from "./logger"; emit({ msg: "Alias event" })',
      },
    ]);
    expect(aliased.untracked).toContainEqual({
      path: "src/a.ts",
      line: 1,
      expression: "<aliased logEvent import>",
    });

    const regexBeforeCall = inspectLogEventMessages([
      {
        path: "src/a.ts",
        text: 'const re = /"/; logEvent({ msg: "After regex" })',
      },
    ]);
    expect(regexBeforeCall.untracked).toContainEqual(
      expect.objectContaining({ path: "src/", expression: expect.stringContaining("call count mismatch") }),
    );
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

  it("every logEvent msg is a literal or a verified computed expression", () => {
    const files = realFiles();
    expect(files.length).toBeGreaterThan(0);
    // Each scanned inline object's msg is checked, and the independent call
    // count pin catches calls hidden by unsupported syntax or lexer state.
    expect(inspectLogEventMessages(files).untracked).toEqual([]);
  });
});
