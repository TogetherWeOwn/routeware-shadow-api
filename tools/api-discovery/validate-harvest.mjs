#!/usr/bin/env node
/** Read-only validation of out/harvest.ndjson against the shared pure contract. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarvestValidation } from "./lib/harvestContract.mjs";
import {
  harvestFailure, harvestOptions, harvestResult, printHarvestResult, readHarvestFile
} from "./lib/harvestCli.mjs";

const options = harvestOptions(process.argv.slice(2));
if (options.invalid) {
  printHarvestResult(harvestResult("HARVEST_UNKNOWN_FLAG"), options.json);
} else if (options.help) {
  console.log("Usage: node validate-harvest.mjs [--json] [--help]\nRead-only harvest validation. Missing input is a fresh-checkout skip.");
} else {
  try {
    const inFile = join(dirname(fileURLToPath(import.meta.url)), "out", "harvest.ndjson");
    const validation = createHarvestValidation();
    const code = await readHarvestFile(inFile, line => validation.addLine(line));
    const { lineCount, physicalLineCount } = validation.finish();
    const message = code === "HARVEST_MISSING" ? "validate-harvest: no harvest file — skip." :
      code === "HARVEST_EMPTY" ? "validate-harvest: empty file — skip." :
        `validate-harvest: OK, ${physicalLineCount} lines checked.`;
    printHarvestResult(harvestResult(code, { lineCount, physicalLineCount }), options.json, message);
  } catch (error) {
    printHarvestResult(harvestFailure(error), options.json);
  }
}
