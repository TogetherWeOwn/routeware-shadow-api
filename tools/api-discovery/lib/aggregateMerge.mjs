/**
 * Pure harvest merge behind aggregate.mjs (no fs, no node:* imports).
 *
 * Kept in its own module so Vitest can pin the harvest.ndjson ->
 * discovered-operations.json transform without disk or a browser.
 * aggregate.mjs imports these; the logic must stay identical in both.
 */
import { jsonTopLevelKeys, truncate } from "./harvestLib.mjs";
import { normalizePath } from "./normalizePath.mjs";
import { createHarvestValidation } from "./harvestContract.mjs";

export const SOURCE_FILE = "out/harvest.ndjson";
export const MISSING_HARVEST_NOTE =
  "No harvest file yet. Run npm run record, then npm run process.";
export const EMPTY_HARVEST_NOTE = "harvest.ndjson is empty.";
export const MAX_SAMPLES_PER_OPERATION = 3;
export const PREVIEW_IN_AGGREGATE = 12_000;

export function sampleSignature(row) {
  return JSON.stringify({
    q: row.query ?? {},
    st: row.responseStatus,
    rct: row.requestContentType,
    rb0: (row.requestBodyPreview ?? "").slice(0, 240)
  });
}

export function buildSample(row) {
  return {
    ts: row.ts,
    resourceType: row.resourceType ?? null,
    pathWithQuery: row.pathWithQuery ?? `${row.pathname ?? ""}${row.queryString ? `?${row.queryString}` : ""}`,
    frameUrl: row.frameUrl ?? null,
    query: row.query ?? {},
    queryString: row.queryString ?? "",
    requestContentType: row.requestContentType ?? null,
    requestHeaderNames: row.requestHeaders ? Object.keys(row.requestHeaders).sort() : [],
    requestBodyPreview: truncate(row.requestBodyPreview, PREVIEW_IN_AGGREGATE),
    requestBodyTruncated: !!row.requestBodyTruncated,
    requestBodyTopLevelKeys: jsonTopLevelKeys(row.requestBodyPreview),
    responseStatus: row.responseStatus ?? null,
    responseContentType: row.responseContentType ?? null,
    responseHeaderNames: row.responseHeaders ? Object.keys(row.responseHeaders).sort() : [],
    responseBodyPreview: truncate(row.responseBodyPreview, PREVIEW_IN_AGGREGATE),
    responseBodyTruncated: !!row.responseBodyTruncated,
    responseBodyTopLevelKeys: jsonTopLevelKeys(row.responseBodyPreview)
  };
}

function createMergeState() {
  return { byKey: new Map(), validation: createHarvestValidation() };
}

function mergeLine(state, line) {
  const row = state.validation.addLine(line);
  if (row === null) return;
  const method = row.method;
  const path = normalizePath(row.pathname);
  const key = `${method} ${path}`;
  const cur =
    state.byKey.get(key) ??
    {
      count: 0,
      resourceTypes: new Set(),
      samples: [],
      sampleSigs: new Set()
    };

  cur.count += 1;
  if (row.resourceType) {
    cur.resourceTypes.add(row.resourceType);
  }

  const sig = sampleSignature(row);
  if (!cur.sampleSigs.has(sig) && cur.samples.length < MAX_SAMPLES_PER_OPERATION) {
    cur.sampleSigs.add(sig);
    cur.samples.push(buildSample(row));
  }

  state.byKey.set(key, cur);
}

function finishMerge(state) {
  const { lineCount } = state.validation.finish();
  const operations = [...state.byKey.entries()]
    .map(([key, v]) => ({
      key,
      method: key.split(" ")[0],
      pathname: key.slice(key.indexOf(" ") + 1),
      normalizedPath: key.slice(key.indexOf(" ") + 1),
      count: v.count,
      resourceTypes: [...v.resourceTypes].sort(),
      samples: v.samples
    }))
    .sort((a, b) => b.count - a.count);
  return { lineCount, operations };
}

/** Merge harvest lines from a sync iterable into { lineCount, operations }. */
export function aggregateHarvestLines(lines) {
  const state = createMergeState();
  for (const line of lines) {
    mergeLine(state, line);
  }
  return finishMerge(state);
}

/**
 * Incremental form of aggregateHarvestLines for async line sources: the
 * wrapper feeds its readline stream line-by-line (addLine) instead of
 * slurping the harvest into memory, then reads the same finish result.
 */
export function createHarvestAggregator() {
  const state = createMergeState();
  return {
    addLine(line) {
      mergeLine(state, line);
    },
    finish() {
      return finishMerge(state);
    }
  };
}

export function emptyHarvestDoc(now, note) {
  return {
    generatedAt: now.toISOString(),
    sourceFile: SOURCE_FILE,
    lineCount: 0,
    operations: [],
    note
  };
}

/**
 * Build the discovered-operations document from harvest state:
 * null = missing file, "" = zero-byte file, otherwise ndjson text.
 */
export function buildHarvestDoc(content, now = new Date()) {
  if (content === null) {
    return emptyHarvestDoc(now, MISSING_HARVEST_NOTE);
  }
  if (content === "") {
    return emptyHarvestDoc(now, EMPTY_HARVEST_NOTE);
  }
  const { lineCount, operations } = aggregateHarvestLines(content.split("\n"));
  return {
    generatedAt: now.toISOString(),
    sourceFile: SOURCE_FILE,
    lineCount,
    operations
  };
}
