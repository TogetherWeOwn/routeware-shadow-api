#!/usr/bin/env node
/**
 * Compare harvest aggregate to route-map: missing shadow routes and stale map entries.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const discoveredPath = join(__dirname, "out", "discovered-operations.json");
const mapPath = join(__dirname, "route-map.json");
const outJson = join(__dirname, "out", "route-gaps.json");
const outTxt = join(__dirname, "out", "route-gaps.txt");

// Fresh checkout has no out/ dir yet — create it before any writeFile below.
await mkdir(join(__dirname, "out"), { recursive: true });

let discovered;
try {
  discovered = JSON.parse(await readFile(discoveredPath, "utf8"));
} catch {
  await writeFile(outTxt, "No discovered-operations.json — run npm run process after recording.\n", "utf8");
  console.log("route-gap: no aggregate yet");
  process.exit(0);
}

const routeMap = JSON.parse(await readFile(mapPath, "utf8"));
const mapped = new Set(routeMap.map((e) => `${e.method} ${e.upstreamPath}`));

const harvestKeys = new Set(
  (discovered.operations ?? []).map((o) => `${o.method} ${o.pathname}`)
);

const missingInShadow = [];
for (const op of discovered.operations ?? []) {
  const k = `${op.method} ${op.pathname}`;
  if (!mapped.has(k)) {
    missingInShadow.push({
      method: op.method,
      upstreamPath: op.pathname,
      count: op.count,
      resourceTypes: op.resourceTypes ?? []
    });
  }
}

const inMapNotHarvested = [];
for (const e of routeMap) {
  const k = `${e.method} ${e.upstreamPath}`;
  if (!harvestKeys.has(k)) {
    inMapNotHarvested.push({
      method: e.method,
      upstreamPath: e.upstreamPath,
      shadowPath: e.shadowPath
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  missingInShadowApi: missingInShadow.sort((a, b) => b.count - a.count),
  mappedButNotInLastHarvest: inMapNotHarvested
};

await writeFile(outJson, JSON.stringify(report, null, 2), "utf8");

const txt = [
  "Harvest vs route-map",
  "====================",
  "",
  `Missing shadow routes (${missingInShadow.length}) — add to route-map + src/app.ts:`,
  ...missingInShadow.map((m) => `  ${m.count}x  ${m.method} ${m.upstreamPath}`),
  "",
  `Mapped but not seen in this harvest (${inMapNotHarvested.length}):`,
  ...inMapNotHarvested.map((m) => `  ${m.method} ${m.upstreamPath} → ${m.shadowPath}`),
  ""
].join("\n");

await writeFile(outTxt, txt, "utf8");
console.log("Wrote", outJson, "and", outTxt);
console.log(
  "Gaps:",
  missingInShadow.length,
  "harvested ops without route-map entry;",
  inMapNotHarvested.length,
  "map entries not in harvest."
);
