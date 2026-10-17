#!/usr/bin/env node
/**
 * Markdown doc from discovered-operations.json + route-map.json.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHarvestApiDoc } from "./lib/harvestDocs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const discoveredPath = join(__dirname, "out", "discovered-operations.json");
const mapPath = join(__dirname, "route-map.json");
const outMd = join(__dirname, "out", "HARVEST_API.md");

// Fresh checkout has no out/ dir yet — create it before any writeFile below.
await mkdir(join(__dirname, "out"), { recursive: true });

let discovered;
try {
  discovered = JSON.parse(await readFile(discoveredPath, "utf8"));
} catch {
  await writeFile(
    outMd,
    "# Harvest API documentation\n\nRun `npm run record` then `npm run process` to generate `discovered-operations.json`.\n",
    "utf8"
  );
  console.log("No discovered-operations; wrote stub", outMd);
  process.exit(0);
}

let routeMap = [];
try {
  routeMap = JSON.parse(await readFile(mapPath, "utf8"));
} catch {
  /* optional */
}

await writeFile(outMd, renderHarvestApiDoc(discovered, routeMap), "utf8");
console.log("Wrote", outMd);
