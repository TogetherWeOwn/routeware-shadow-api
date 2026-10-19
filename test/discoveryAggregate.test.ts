/**
 * Acceptance tests for the discovery aggregate merge transform
 * (`tools/api-discovery/aggregate.mjs`): the merge that folds
 * `out/harvest.ndjson` into `out/discovered-operations.json`.
 *
 * They pin the script's CURRENT semantics (aggregate.mjs at f6aabea) with
 * synthetic rows only — no live Routeware, no browser, no network, no real
 * PII. Behavior changes are separate cards; do not "fix" a pinned quirk
 * here (each quirk pin names the line it comes from).
 *
 * WHY THIS FILE IS RED ON MAIN TODAY
 * ----------------------------------
 * `aggregate.mjs` runs the whole merge at module import against hardcoded
 * `out/` paths and exports nothing, and this suite runs inside the workers
 * pool (no `node:fs`, no child processes). The build card makes
 * the suite pass WITHOUT editing this file, by extracting the pure merge
 * into `tools/api-discovery/lib/` per the contract below — the same
 * extraction `lib/normalizePath.mjs` and `lib/stubNaming.mjs` already
 * received — and reducing `aggregate.mjs` to a thin wrapper that feeds the
 * extracted functions from disk with NO behavior change.
 *
 * BUILD CONTRACT (exact — implement to these names/shapes)
 * ---------------------------------------------------------
 * Create `tools/api-discovery/lib/aggregateMerge.mjs` (plain ESM JS, no
 * `node:*` imports — it must load inside workerd) exporting:
 *
 * - `buildHarvestDoc(content, now = new Date())`
 *     `content` is EXACTLY ONE of:
 *       `null`     — the harvest file is missing (stat failed)
 *       `""`       — the harvest file exists but is zero bytes
 *       a string   — non-empty harvest.ndjson text
 *     and it returns the full `discovered-operations.json` document:
 *       `{ generatedAt, sourceFile, lineCount, operations }` for a
 *       non-empty string, plus a `note` key (and `lineCount: 0`,
 *       `operations: []`) for `null` and `""` — see tests for exact notes.
 *     `generatedAt` is `now.toISOString()`. `sourceFile` is the literal
 *     `"out/harvest.ndjson"`.
 *     The wrapper maps disk state to `content` exactly as today:
 *     `stat` throws -> `null`; `st.size === 0` -> `""`; otherwise the
 *     file read as utf8 text. Line iteration therefore splits on `"\n"`;
 *     a trailing `"\r"` stays part of a line (JSON.parse tolerates it,
 *     `line.trim()` skips a bare-CR line) — same outcomes as today's
 *     readline stream.
 *
 * - `aggregateHarvestLines(lines)` — the merge core. `lines` is the lines
 *     iterable the wrapper streams today (tests pass `string[]`); returns
 *     `{ lineCount, operations }` with the exact semantics pinned below.
 *     `buildHarvestDoc(string, now)` must equal
 *     `{ generatedAt, sourceFile, ...aggregateHarvestLines(string.split("\n")) }`.
 *
 * - `emptyHarvestDoc(now, note)` — the missing/empty document builder:
 *     `{ generatedAt: now.toISOString(), sourceFile: "out/harvest.ndjson",
 *        lineCount: 0, operations: [], note }`.
 *
 * - `buildSample(row)` and `sampleSignature(row)` — moved verbatim from
 *     aggregate.mjs.
 *
 * - constants `SOURCE_FILE = "out/harvest.ndjson"`,
 *   `MISSING_HARVEST_NOTE = "No harvest file yet. Run npm run record, then npm run process."`,
 *   `EMPTY_HARVEST_NOTE = "harvest.ndjson is empty."`,
 *   `MAX_SAMPLES_PER_OPERATION = 3`,
 *   `PREVIEW_IN_AGGREGATE = 12000`.
 *
 * Reuse, do not re-implement: `normalizePath` from `./normalizePath.mjs`,
 * `truncate` + `jsonTopLevelKeys` from `./harvestLib.mjs`.
 *
 * Wrapper keeps today's log lines and `process.exit(0)` on the
 * missing/empty paths and writes `JSON.stringify(doc, null, 2)` to
 * `out/discovered-operations.json`; the streamed path keeps iterating the
 * read stream through `aggregateHarvestLines` rather than slurping.
 *
 * HOUSE RULE: this file is FROZEN for the builder. If an assertion looks
 * wrong, say so on the card instead of editing the test.
 *
 * Reviewer mutation check: every fixture mutation named in a test title
 * flips exactly that one test — change the value, watch only it go red.
 */

import { describe, expect, it } from "vitest";
import {
  aggregateHarvestLines,
  buildHarvestDoc,
  buildSample,
  EMPTY_HARVEST_NOTE,
  emptyHarvestDoc,
  MAX_SAMPLES_PER_OPERATION,
  MISSING_HARVEST_NOTE,
  PREVIEW_IN_AGGREGATE,
  sampleSignature,
  SOURCE_FILE
} from "../tools/api-discovery/lib/aggregateMerge.mjs";

type HarvestRow = Record<string, unknown>;

/** One synthetic harvest row; override a single field per fixture. */
function row(overrides: HarvestRow = {}): HarvestRow {
  return {
    ts: "2026-10-15T00:00:00.000Z",
    method: "GET",
    pathname: "/WebRW/api/customers",
    ...overrides
  };
}

function line(overrides: HarvestRow = {}): string {
  return JSON.stringify(row(overrides));
}

const NOW = new Date("2026-10-15T12:00:00.000Z");

describe("aggregateHarvestLines: operation grouping and counts", () => {
  it("groups rows by method + pathname and counts each group", () => {
    const { lineCount, operations } = aggregateHarvestLines([
      line(),
      line(),
      line({ method: "POST" })
    ]);
    expect(lineCount).toBe(3);
    expect(operations).toHaveLength(2);
    const byKey = new Map(operations.map((op: { key: string }) => [op.key, op]));
    expect(byKey.get("GET /WebRW/api/customers")).toMatchObject({
      method: "GET",
      pathname: "/WebRW/api/customers",
      normalizedPath: "/WebRW/api/customers",
      count: 2
    });
    expect(byKey.get("POST /WebRW/api/customers")).toMatchObject({ count: 1 });
  });

  it("sorts operations by count descending; ties keep first-seen order", () => {
    const { operations } = aggregateHarvestLines([
      line({ pathname: "/WebRW/api/alpha" }),
      line({ pathname: "/WebRW/api/bravo" }),
      line({ pathname: "/WebRW/api/bravo" }),
      line({ pathname: "/WebRW/api/charlie" })
    ]);
    expect(operations.map((op: { pathname: string }) => op.pathname)).toEqual([
      "/WebRW/api/bravo",
      "/WebRW/api/alpha",
      "/WebRW/api/charlie"
    ]);
  });

  it("collapses numeric and uuid path segments via normalizePath", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const { operations } = aggregateHarvestLines([
      line({ pathname: "/WebRW/api/customers/42" }),
      line({ pathname: "/WebRW/api/customers/7" }),
      line({ pathname: `/WebRW/api/docs/${uuid}` })
    ]);
    expect(
      operations.map((op: { pathname: string }) => op.pathname).sort()
    ).toEqual(["/WebRW/api/customers/{id}", "/WebRW/api/docs/{uuid}"]);
  });

  it('keys a row with no method under "?"', () => {
    const noMethod = row();
    delete noMethod.method;
    const { operations } = aggregateHarvestLines([JSON.stringify(noMethod)]);
    expect(operations[0]).toMatchObject({
      key: "? /WebRW/api/customers",
      method: "?"
    });
  });

  it('keys a row with no pathname under "" (key keeps its trailing space)', () => {
    const noPath = row();
    delete noPath.pathname;
    const { operations } = aggregateHarvestLines([JSON.stringify(noPath)]);
    expect(operations[0]).toMatchObject({ key: "GET ", pathname: "", method: "GET" });
  });

  it("merges a row carrying only ts and method without throwing", () => {
    const { operations } = aggregateHarvestLines([
      JSON.stringify({ ts: "2026-10-15T00:00:00.000Z", method: "GET" })
    ]);
    expect(operations[0].samples[0]).toMatchObject({
      ts: "2026-10-15T00:00:00.000Z",
      resourceType: null,
      pathWithQuery: "",
      frameUrl: null,
      query: {},
      queryString: "",
      requestContentType: null,
      requestHeaderNames: [],
      requestBodyTruncated: false,
      requestBodyTopLevelKeys: [],
      responseStatus: null,
      responseContentType: null,
      responseHeaderNames: [],
      responseBodyTruncated: false,
      responseBodyTopLevelKeys: []
    });
  });
});

describe("aggregateHarvestLines: resource types", () => {
  it("unions resource types across rows, deduplicated and sorted", () => {
    const { operations } = aggregateHarvestLines([
      line({ resourceType: "xhr" }),
      line({ resourceType: "fetch" }),
      line({ resourceType: "fetch" })
    ]);
    expect(operations[0].resourceTypes).toEqual(["fetch", "xhr"]);
  });

  it("omits falsy resource types (missing and empty string)", () => {
    const { operations } = aggregateHarvestLines([line(), line({ resourceType: "" })]);
    expect(operations[0].resourceTypes).toEqual([]);
  });
});

describe("aggregateHarvestLines: sample diversity and cap", () => {
  it("keeps only one sample when rows share a signature", () => {
    const { operations } = aggregateHarvestLines([line(), line(), line()]);
    expect(operations[0].samples).toHaveLength(1);
  });

  it("adds a sample when the query changes", () => {
    const { operations } = aggregateHarvestLines([
      line(),
      line({ query: { page: "2" } })
    ]);
    expect(operations[0].samples).toHaveLength(2);
    expect(operations[0].samples[1].query).toEqual({ page: "2" });
  });

  it("adds a sample when the response status changes", () => {
    const { operations } = aggregateHarvestLines([
      line({ responseStatus: 200 }),
      line({ responseStatus: 500 })
    ]);
    expect(operations[0].samples).toHaveLength(2);
    expect(operations[0].samples[1].responseStatus).toBe(500);
  });

  it("caps samples at 3: a fourth distinct signature is counted, not sampled", () => {
    const { operations } = aggregateHarvestLines([
      line({ query: { page: "1" } }),
      line({ query: { page: "2" } }),
      line({ query: { page: "3" } }),
      line({ query: { page: "4" } })
    ]);
    expect(operations[0].count).toBe(4);
    expect(operations[0].samples).toHaveLength(MAX_SAMPLES_PER_OPERATION);
    expect(
      operations[0].samples.map((s: { query: unknown }) => s.query)
    ).toEqual([{ page: "1" }, { page: "2" }, { page: "3" }]);
  });

  it("treats bodies differing only past char 240 as the same signature", () => {
    const prefix = "x".repeat(240);
    const { operations } = aggregateHarvestLines([
      line({ requestBodyPreview: `${prefix}AAAA` }),
      line({ requestBodyPreview: `${prefix}BBBB` })
    ]);
    expect(operations[0].samples).toHaveLength(1);
  });

  it("treats bodies differing before char 240 as different signatures", () => {
    const prefix = "x".repeat(100);
    const { operations } = aggregateHarvestLines([
      line({ requestBodyPreview: `${prefix}AAAA` }),
      line({ requestBodyPreview: `${prefix}BBBB` })
    ]);
    expect(operations[0].samples).toHaveLength(2);
  });

  it("treats query objects with different key order as different signatures", () => {
    const { operations } = aggregateHarvestLines([
      line({ query: { a: "1", b: "2" } }),
      line({ query: { b: "2", a: "1" } })
    ]);
    expect(operations[0].samples).toHaveLength(2);
  });

  it("does not add a sample when only the response body changes", () => {
    const { operations } = aggregateHarvestLines([
      line({ responseBodyPreview: "first" }),
      line({ responseBodyPreview: "second" })
    ]);
    expect(operations[0].samples).toHaveLength(1);
    expect(operations[0].samples[0].responseBodyPreview).toBe("first");
  });
});

describe("aggregateHarvestLines: stale and malformed lines", () => {
  it("counts a malformed JSON line in lineCount but merges no operation", () => {
    const { lineCount, operations } = aggregateHarvestLines([
      line(),
      "{not valid json",
      line()
    ]);
    expect(lineCount).toBe(3);
    expect(operations).toHaveLength(1);
  });

  it("skips blank and whitespace-only lines without counting them", () => {
    const { lineCount, operations } = aggregateHarvestLines([
      "",
      "   ",
      line(),
      ""
    ]);
    expect(lineCount).toBe(1);
    expect(operations).toHaveLength(1);
  });

  // Deliberately unpinned: a non-object JSON line ("null", "42") makes
  // today's script throw (row.method on null). record.ts never writes one,
  // so pinning either the crash or a guard belongs to a behavior card.

  it("reprocesses from scratch: an operation absent from this run is dropped", () => {
    const previousRun = aggregateHarvestLines([
      line({ pathname: "/WebRW/api/retired" })
    ]);
    const thisRun = aggregateHarvestLines([line()]);
    expect(previousRun.operations).toHaveLength(1);
    expect(thisRun.operations.map((op: { pathname: string }) => op.pathname)).toEqual([
      "/WebRW/api/customers"
    ]);
  });

  it("builds a sample from a legacy row with no pathWithQuery, from pathname + queryString", () => {
    const { operations } = aggregateHarvestLines([line({ queryString: "page=2" })]);
    expect(operations[0].samples[0].pathWithQuery).toBe("/WebRW/api/customers?page=2");
  });

  it("builds a sample from a legacy row with no pathWithQuery and no queryString", () => {
    const { operations } = aggregateHarvestLines([line()]);
    expect(operations[0].samples[0].pathWithQuery).toBe("/WebRW/api/customers");
  });
});

describe("buildSample and sampleSignature units", () => {
  it("passes pathWithQuery through when present", () => {
    expect(buildSample(row({ pathWithQuery: "/WebRW/x?y=1" })).pathWithQuery).toBe(
      "/WebRW/x?y=1"
    );
  });

  it("lists request and response header NAMES sorted, never values", () => {
    const sample = buildSample(
      row({
        requestHeaders: { "x-zeta": "1", accept: "application/json" },
        responseHeaders: {
          "x-zeta": "aaa-first-by-value",
          "content-type": "application/json",
          accept: "zzz-last-by-value"
        }
      })
    );
    expect(sample.requestHeaderNames).toEqual(["accept", "x-zeta"]);
    expect(sample.responseHeaderNames).toEqual(["accept", "content-type", "x-zeta"]);
  });

  it("truncates a body preview longer than PREVIEW_IN_AGGREGATE with the marker", () => {
    const long = "y".repeat(PREVIEW_IN_AGGREGATE + 1);
    const marker =
      "[truncated for aggregate output; see harvest.ndjson for full preview up to cap]";
    const responsePreview =
      buildSample(row({ responseBodyPreview: long })).responseBodyPreview ?? "";
    const requestPreview =
      buildSample(row({ requestBodyPreview: long })).requestBodyPreview ?? "";

    for (const preview of [responsePreview, requestPreview]) {
      expect(preview.startsWith("y".repeat(PREVIEW_IN_AGGREGATE))).toBe(true);
      expect(preview).toContain(marker);
      expect(preview.length).toBeLessThan(long.length + 100);
    }
  });

  it("extracts sorted top-level keys from JSON previews", () => {
    const sample = buildSample(
      row({
        requestBodyPreview: '{"b":1,"a":2}',
        responseBodyPreview: '{"z":1}'
      })
    );
    expect(sample.requestBodyTopLevelKeys).toEqual(["a", "b"]);
    expect(sample.responseBodyTopLevelKeys).toEqual(["z"]);
  });

  it("leaves truncated flags false and previews undefined for a bare row", () => {
    const sample = buildSample(row());
    expect(sample.requestBodyTruncated).toBe(false);
    expect(sample.responseBodyTruncated).toBe(false);
    expect(sample.requestBodyPreview).toBeUndefined();
    expect(sample.responseBodyPreview).toBeUndefined();
  });

  it("passes truncated flags through from the row", () => {
    // Asymmetric on purpose: identical values would still pass if the two
    // fields were ever cross-wired in buildSample.
    const requestOnly = buildSample(
      row({ requestBodyTruncated: true, responseBodyTruncated: false })
    );
    expect(requestOnly.requestBodyTruncated).toBe(true);
    expect(requestOnly.responseBodyTruncated).toBe(false);

    const responseOnly = buildSample(
      row({ requestBodyTruncated: false, responseBodyTruncated: true })
    );
    expect(responseOnly.requestBodyTruncated).toBe(false);
    expect(responseOnly.responseBodyTruncated).toBe(true);
  });

  it("signature ignores response-only differences and body chars past 240", () => {
    const a = sampleSignature(row({ responseBodyPreview: "one" }));
    const b = sampleSignature(row({ responseBodyPreview: "two" }));
    expect(a).toBe(b);

    const prefix = "x".repeat(240);
    expect(sampleSignature(row({ requestBodyPreview: `${prefix}A` }))).toBe(
      sampleSignature(row({ requestBodyPreview: `${prefix}B` }))
    );

    const lowerBoundaryPrefix = "x".repeat(239);
    expect(
      sampleSignature(row({ requestBodyPreview: `${lowerBoundaryPrefix}A` }))
    ).not.toBe(
      sampleSignature(row({ requestBodyPreview: `${lowerBoundaryPrefix}B` }))
    );

    expect(
      sampleSignature(row({ requestContentType: "application/json" }))
    ).not.toBe(sampleSignature(row({ requestContentType: "text/plain" })));
  });
});

describe("buildHarvestDoc: missing and empty harvest files", () => {
  it("missing file (null) writes the empty doc with the record-then-process note", () => {
    expect(buildHarvestDoc(null, NOW)).toEqual({
      generatedAt: "2026-10-15T12:00:00.000Z",
      sourceFile: SOURCE_FILE,
      lineCount: 0,
      operations: [],
      note: MISSING_HARVEST_NOTE
    });
    expect(SOURCE_FILE).toBe("out/harvest.ndjson");
    expect(MISSING_HARVEST_NOTE).toBe(
      "No harvest file yet. Run npm run record, then npm run process."
    );
  });

  it("zero-byte file (\"\") writes the empty doc with the empty-harvest note", () => {
    expect(buildHarvestDoc("", NOW)).toEqual({
      generatedAt: "2026-10-15T12:00:00.000Z",
      sourceFile: "out/harvest.ndjson",
      lineCount: 0,
      operations: [],
      note: EMPTY_HARVEST_NOTE
    });
    expect(EMPTY_HARVEST_NOTE).toBe("harvest.ndjson is empty.");
  });

  it("whitespace-only content is NOT the empty path: no note, lineCount 0", () => {
    const doc = buildHarvestDoc("\n  \n", NOW);
    expect(doc).not.toHaveProperty("note");
    expect(doc.lineCount).toBe(0);
    expect(doc.operations).toEqual([]);
  });

  it("emptyHarvestDoc is the shared builder behind both notes", () => {
    expect(emptyHarvestDoc(NOW, MISSING_HARVEST_NOTE)).toEqual(
      buildHarvestDoc(null, NOW)
    );
    expect(emptyHarvestDoc(NOW, EMPTY_HARVEST_NOTE)).toEqual(
      buildHarvestDoc("", NOW)
    );
  });
});

describe("buildHarvestDoc: full document from ndjson text", () => {
  it("wraps the merge with generatedAt and sourceFile, with no note", () => {
    const doc = buildHarvestDoc([line(), line(), line({ method: "POST" })].join("\n"), NOW);
    expect(doc.generatedAt).toBe("2026-10-15T12:00:00.000Z");
    expect(doc.sourceFile).toBe("out/harvest.ndjson");
    expect(doc.lineCount).toBe(3);
    expect(doc.operations).toHaveLength(2);
    expect(doc).not.toHaveProperty("note");
  });

  it("a trailing newline adds no phantom line", () => {
    expect(buildHarvestDoc(`${line()}\n`, NOW).lineCount).toBe(1);
  });

  it("CRLF line endings merge identically to LF", () => {
    const crlf = buildHarvestDoc([line(), line()].join("\r\n"), NOW);
    expect(crlf.lineCount).toBe(2);
    expect(crlf.operations).toHaveLength(1);
    expect(crlf.operations[0].samples).toHaveLength(1);
  });
});

describe("contract constants", () => {
  it("pins the sample cap and preview size the script ships today", () => {
    expect(MAX_SAMPLES_PER_OPERATION).toBe(3);
    expect(PREVIEW_IN_AGGREGATE).toBe(12_000);
  });
});
