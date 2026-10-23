#!/usr/bin/env node
/**
 * From route-gaps.json, emit a commented TypeScript checklist for src/app.ts.
 * Run after: npm run process
 *
 * When route-map.json is present it is validated with the shared library
 * before anything is produced; an invalid map exits 1 and writes nothing.
 * (The map is not this script's input, so a missing map skips validation
 * instead of failing.) --dry-run validates, reads the gaps, and renders the
 * checklist before printing the verdict, without writing anything.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRouteMap } from "./lib/routeMapValidation.mjs";
import { renderSuggestedRoutesStub } from "./lib/stubNaming.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gapsPath = join(__dirname, "out", "route-gaps.json");
const mapPath = join(__dirname, "route-map.json");
const outTs = join(__dirname, "out", "suggested-routes.stub.ts");

const dryRun = new Set(process.argv.slice(2)).has("--dry-run");

let mapEntries = null;
try {
  const map = JSON.parse(await readFile(mapPath, "utf8"));
  const mapValidation = validateRouteMap(map);
  if (!mapValidation.ok) {
    for (const finding of mapValidation.findings) {
      console.error(
        `${finding.code} [${finding.checkId}] entries ${finding.entryIndexes.join(",") || "—"}: ${finding.nextAction}`
      );
    }
    console.error(
      `suggest-routes: route map invalid (${mapValidation.findings.length} findings) — refusing to generate.`
    );
    process.exit(1);
  }
  mapEntries = map.length;
} catch (e) {
  if (e?.code !== "ENOENT") {
    if (e instanceof SyntaxError) {
      console.error(`suggest-routes: ${mapPath} is not valid JSON — refusing to generate.`);
    } else {
      console.error(`suggest-routes: cannot read ${mapPath}:`, e?.message ?? e);
    }
    process.exit(1);
  }
  // No route map beside the gaps input: nothing to guard, proceed.
}
let gaps;
try {
  gaps = JSON.parse(await readFile(gapsPath, "utf8"));
} catch {
  console.error("Missing", gapsPath, "— run npm run process first.");
  process.exit(1);
}

const missing = gaps.missingInShadowApi ?? [];
const output = renderSuggestedRoutesStub(missing);

if (dryRun) {
  console.log(
    mapEntries === null
      ? `dry-run: no route-map.json present, map validation skipped; would write ${outTs} — no files written.`
      : `dry-run: route map valid (${mapEntries} entries, no mapping findings); would write ${outTs} — no files written.`
  );
  process.exit(0);
}

// Fresh checkout has no out/ dir yet — create it before the write below.
await mkdir(join(__dirname, "out"), { recursive: true });
await writeFile(outTs, output, "utf8");
console.log("Wrote", outTs, `(${missing.length} gaps, first 40 listed).`);
