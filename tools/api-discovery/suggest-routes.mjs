#!/usr/bin/env node
/**
 * From route-gaps.json, emit a commented TypeScript checklist for src/app.ts.
 * Run after: npm run process
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const lines = [
  "/**",
  " * AUTO-GENERATED — do not import. Copy pieces into src/app.ts + route-map.json.",
  " * Upstream paths are under TARGET_BASE_PATH (default /WebRW).",
  " */",
  "",
  "/* eslint-disable */",
  ""
];

for (const m of missing.slice(0, 40)) {
  const seg = m.upstreamPath.replace(/^\/WebRW\/?/i, "").replace(/\/+/g, "/");
  const kebab = seg
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\/+|\/+$/g, "");
  const shadow = `/api/v1/routeware/${kebab}`;
  lines.push(`// ${m.count}x  ${m.method} ${m.upstreamPath}`);
  lines.push(`// → add route-map: shadowPath "${shadow}" (adjust naming)`);
  lines.push(`// → createRoute method: "${m.method.toLowerCase()}", path: "${shadow}"`);
  lines.push("");
}

if (missing.length > 40) {
  lines.push(`// … and ${missing.length - 40} more (see route-gaps.json)`);
}

await writeFile(outTs, lines.join("\n"), "utf8");
console.log("Wrote", outTs, `(${missing.length} gaps, first 40 listed).`);
