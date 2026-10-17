#!/usr/bin/env node
/**
 * Merge harvest.ndjson into discovered-operations.json: method, path, counts,
 * resource types, and up to 3 diverse samples (query, headers, bodies, responses).
 *
 * Thin wrapper: the pure merge lives in lib/aggregateMerge.mjs (unit-tested);
 * this script only maps disk state to it and keeps the original log lines,
 * process.exit(0) empty paths, and streamed read of the harvest file.
 */
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHarvestAggregator,
  EMPTY_HARVEST_NOTE,
  emptyHarvestDoc,
  MISSING_HARVEST_NOTE,
  SOURCE_FILE
} from "./lib/aggregateMerge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const inFile = join(__dirname, "out", "harvest.ndjson");
const outFile = join(__dirname, "out", "discovered-operations.json");

// Fresh checkout has no out/ dir yet — create it before any writeFile below.
await mkdir(join(__dirname, "out"), { recursive: true });

let st;
try {
  st = await stat(inFile);
} catch {
  await writeFile(
    outFile,
    JSON.stringify(emptyHarvestDoc(new Date(), MISSING_HARVEST_NOTE), null, 2),
    "utf8"
  );
  console.log("No harvest; wrote empty", outFile);
  process.exit(0);
}

if (!st.size) {
  await writeFile(
    outFile,
    JSON.stringify(emptyHarvestDoc(new Date(), EMPTY_HARVEST_NOTE), null, 2),
    "utf8"
  );
  console.log("Empty harvest; wrote empty", outFile);
  process.exit(0);
}

const rl = createInterface({ input: createReadStream(inFile, { flags: "r" }) });

const aggregator = createHarvestAggregator();
for await (const line of rl) {
  aggregator.addLine(line);
}
const { lineCount, operations } = aggregator.finish();

const doc = {
  generatedAt: new Date().toISOString(),
  sourceFile: SOURCE_FILE,
  lineCount,
  operations
};

await writeFile(outFile, JSON.stringify(doc, null, 2), "utf8");
console.log("Wrote", outFile, "with", operations.length, "operations from", lineCount, "lines.");
