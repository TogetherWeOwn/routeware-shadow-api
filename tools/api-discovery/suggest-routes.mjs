#!/usr/bin/env node
/**
 * From route-gaps.json, emit a commented TypeScript checklist for src/app.ts.
 * Run after: npm run process
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSuggestedRoutesStub } from "./lib/stubNaming.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gapsPath = join(__dirname, "out", "route-gaps.json");
const outTs = join(__dirname, "out", "suggested-routes.stub.ts");

let gaps;
try {
  gaps = JSON.parse(await readFile(gapsPath, "utf8"));
} catch {
  console.error("Missing", gapsPath, "— run npm run process first.");
  process.exit(1);
}

const missing = gaps.missingInShadowApi ?? [];
const output = renderSuggestedRoutesStub(missing);

// Fresh checkout has no out/ dir yet — create it before the write below.
await mkdir(join(__dirname, "out"), { recursive: true });
await writeFile(outTs, output, "utf8");
console.log("Wrote", outTs, `(${missing.length} gaps, first 40 listed).`);
