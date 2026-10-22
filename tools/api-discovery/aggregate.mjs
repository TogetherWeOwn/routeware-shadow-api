#!/usr/bin/env node
/** Stream, validate completely, then publish discovered-operations.json. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHarvestAggregator, EMPTY_HARVEST_NOTE, emptyHarvestDoc, MISSING_HARVEST_NOTE, SOURCE_FILE
} from "./lib/aggregateMerge.mjs";
import {
  harvestFailure, harvestOptions, harvestResult, printHarvestResult, readHarvestFile
} from "./lib/harvestCli.mjs";

const options = harvestOptions(process.argv.slice(2), true);
if (options.invalid) {
  printHarvestResult(harvestResult("HARVEST_UNKNOWN_FLAG"), options.json);
} else if (options.help) {
  console.log("Usage: node aggregate.mjs [--json] [--dry-run] [--help]\nValidate and aggregate a local harvest. --dry-run describes output without mutations.");
} else {
  let failureCode = "HARVEST_READ_FAILED";
  try {
    const outDir = join(dirname(fileURLToPath(import.meta.url)), "out");
    const outFile = join(outDir, "discovered-operations.json");
    const aggregator = createHarvestAggregator();
    const code = await readHarvestFile(join(outDir, "harvest.ndjson"), line => aggregator.addLine(line));
    const { lineCount, operations } = aggregator.finish();
    const now = new Date();
    const doc = code === "HARVEST_MISSING" ? emptyHarvestDoc(now, MISSING_HARVEST_NOTE) :
      code === "HARVEST_EMPTY" ? emptyHarvestDoc(now, EMPTY_HARVEST_NOTE) :
        { generatedAt: now.toISOString(), sourceFile: SOURCE_FILE, lineCount, operations };
    // No output I/O until every input line and the stream itself have passed.
    if (!options.dryRun) {
      failureCode = "HARVEST_WRITE_FAILED";
      await mkdir(outDir, { recursive: true });
      await writeFile(outFile, JSON.stringify(doc, null, 2), "utf8");
    }
    const message = options.dryRun ? "Dry run: would write out/discovered-operations.json." :
      code === "HARVEST_MISSING" ? `No harvest; wrote empty ${outFile}` :
        code === "HARVEST_EMPTY" ? `Empty harvest; wrote empty ${outFile}` :
          `Wrote ${outFile} with ${operations.length} operations from ${lineCount} lines.`;
    printHarvestResult(harvestResult(code, {
      dryRun: options.dryRun, output: "out/discovered-operations.json", lineCount, operationCount: operations.length
    }), options.json, message);
  } catch (error) {
    printHarvestResult(harvestFailure(error, failureCode), options.json);
  }
}
