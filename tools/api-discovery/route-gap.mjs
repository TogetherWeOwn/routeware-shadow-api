#!/usr/bin/env node
/**
 * Compare harvest aggregate to route-map: missing shadow routes and stale map entries.
 *
 * Always writes out/route-gaps.json + out/route-gaps.txt, then gates:
 * - exit 0 when the report is clean, when no aggregate exists yet, or when the
 *   aggregate holds zero operations (nothing to compare — record first, then
 *   run npm run process);
 * - exit 1 when harvested operations lack shadow routes (always);
 * - exit 1 on map entries not seen in the harvest only with --strict (one
 *   session rarely exercises every mapped route, so stale entries are
 *   warnings by default — re-run with --strict after an exhaustive session).
 * A truncated discovered-operations.json is a hard error (exit 1), never a
 * silent pass.
 *
 * --check skips recomputation and gates on the existing out/route-gaps.json.
 * `npm run process` runs the report mid-chain (tolerated) so curl examples
 * and route stubs are always built, then gates last with --check.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const discoveredPath = join(__dirname, "out", "discovered-operations.json");
const mapPath = join(__dirname, "route-map.json");
const outJson = join(__dirname, "out", "route-gaps.json");
const outTxt = join(__dirname, "out", "route-gaps.txt");

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");

function failsGate(report) {
  return (
    (report.missingInShadowApi ?? []).length > 0 ||
    (strict && (report.mappedButNotInLastHarvest ?? []).length > 0)
  );
}

function printGaps(report) {
  for (const m of report.missingInShadowApi ?? []) {
    console.error(`missing shadow route: ${m.count}x  ${m.method} ${m.upstreamPath}`);
  }
  for (const m of report.mappedButNotInLastHarvest ?? []) {
    console.error(`stale map entry: ${m.method} ${m.upstreamPath} → ${m.shadowPath}`);
  }
}

async function writeReport(missingInShadow, inMapNotHarvested) {
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
  return report;
}

// Fresh checkout has no out/ dir yet — create it before any writeFile below.
await mkdir(join(__dirname, "out"), { recursive: true });

if (args.has("--check")) {
  let report;
  try {
    report = JSON.parse(await readFile(outJson, "utf8"));
  } catch (e) {
    console.error(`route-gap --check: cannot read ${outJson} — run npm run process first.`, e?.message ?? e);
    process.exit(1);
  }
  const missing = report.missingInShadowApi ?? [];
  const stale = report.mappedButNotInLastHarvest ?? [];
  console.log(
    `route-gap --check: ${missing.length} missing shadow routes, ${stale.length} stale map entries${strict ? " (strict)" : ""}`
  );
  printGaps(report);
  process.exit(failsGate(report) ? 1 : 0);
}

let discovered;
try {
  discovered = JSON.parse(await readFile(discoveredPath, "utf8"));
} catch (e) {
  if (e?.code === "ENOENT") {
    await writeReport([], []);
    console.log("route-gap: no aggregate yet");
    process.exit(0);
  }
  console.error(`route-gap: cannot parse ${discoveredPath}:`, e?.message ?? e);
  process.exit(1);
}

// An aggregate with zero operations means nothing was recorded (fresh
// checkout, `record --fresh` with an empty session): every map entry would
// look "stale", so there is nothing to compare — even under --strict.
if ((discovered.operations ?? []).length === 0) {
  await writeReport([], []);
  console.log("route-gap: empty aggregate (no harvested operations) — nothing to compare");
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

const report = await writeReport(missingInShadow, inMapNotHarvested);
printGaps(report);

if (failsGate(report)) {
  process.exit(1);
}
if (inMapNotHarvested.length > 0) {
  console.error("stale map entries are warnings by default; re-run with --strict to fail on them");
}
