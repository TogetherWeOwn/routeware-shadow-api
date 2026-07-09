#!/usr/bin/env node
/**
 * Merge harvest.ndjson into discovered-operations.json: method, path, counts,
 * resource types, and up to 3 diverse samples (query, headers, bodies, responses).
 */
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonTopLevelKeys, truncate } from "./lib/harvestLib.mjs";
import { normalizePath } from "./lib/normalizePath.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PREVIEW_IN_AGGREGATE = 12_000;

function sampleSignature(row) {
  return JSON.stringify({
    q: row.query ?? {},
    st: row.responseStatus,
    rct: row.requestContentType,
    rb0: (row.requestBodyPreview ?? "").slice(0, 240)
  });
}

function buildSample(row) {
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

const inFile = join(__dirname, "out", "harvest.ndjson");
const outFile = join(__dirname, "out", "discovered-operations.json");

let st;
try {
  st = await stat(inFile);
} catch {
  await writeFile(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceFile: "out/harvest.ndjson",
        lineCount: 0,
        operations: [],
        note: "No harvest file yet. Run npm run record, then npm run process."
      },
      null,
      2
    ),
    "utf8"
  );
  console.log("No harvest; wrote empty", outFile);
  process.exit(0);
}

if (!st.size) {
  await writeFile(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceFile: "out/harvest.ndjson",
        lineCount: 0,
        operations: [],
        note: "harvest.ndjson is empty."
      },
      null,
      2
    ),
    "utf8"
  );
  console.log("Empty harvest; wrote empty", outFile);
  process.exit(0);
}

const byKey = new Map();
let lineCount = 0;

const rl = createInterface({ input: createReadStream(inFile, { flags: "r" }) });

for await (const line of rl) {
  if (!line.trim()) {
    continue;
  }
  lineCount += 1;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  const method = row.method ?? "?";
  const path = normalizePath(row.pathname ?? "");
  const key = `${method} ${path}`;
  const cur =
    byKey.get(key) ??
    ({
      count: 0,
      resourceTypes: new Set(),
      samples: [],
      sampleSigs: new Set()
    });

  cur.count += 1;
  if (row.resourceType) {
    cur.resourceTypes.add(row.resourceType);
  }

  const sig = sampleSignature(row);
  if (!cur.sampleSigs.has(sig) && cur.samples.length < 3) {
    cur.sampleSigs.add(sig);
    cur.samples.push(buildSample(row));
  }

  byKey.set(key, cur);
}

const operations = [...byKey.entries()]
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

const doc = {
  generatedAt: new Date().toISOString(),
  sourceFile: "out/harvest.ndjson",
  lineCount,
  operations
};

await writeFile(outFile, JSON.stringify(doc, null, 2), "utf8");
console.log("Wrote", outFile, "with", operations.length, "operations from", lineCount, "lines.");
