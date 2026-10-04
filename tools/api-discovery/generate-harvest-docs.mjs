#!/usr/bin/env node
/**
 * Markdown doc from discovered-operations.json + route-map.json.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const upstreamToShadow = new Map();
for (const e of routeMap) {
  upstreamToShadow.set(`${e.method} ${e.upstreamPath}`, e.shadowPath);
}

const lines = [];
lines.push("# Routeware WebRW — harvested traffic");
lines.push("");
lines.push(`Generated **${discovered.generatedAt ?? new Date().toISOString()}** from \`${discovered.sourceFile ?? "harvest.ndjson"}\` (${discovered.lineCount ?? "?"} lines).`);
lines.push("");
lines.push("Sensitive headers are redacted in the recorder. Bodies in this file are truncated for size; full previews (up to env caps) live in `harvest.ndjson`.");
lines.push("");
lines.push("## Operations (by frequency)");
lines.push("");
lines.push("| Count | Method | Upstream path | Shadow API |");
lines.push("|------:|--------|---------------|------------|");

for (const op of discovered.operations ?? []) {
  const shadow = upstreamToShadow.get(`${op.method} ${op.pathname}`) ?? "— *add route* —";
  lines.push(`| ${op.count} | ${op.method} | \`${op.pathname}\` | \`${shadow}\` |`);
}

lines.push("");
lines.push("## Samples (first operation examples)");
lines.push("");

for (const op of discovered.operations ?? []) {
  if (!op.samples?.length) {
    continue;
  }
  lines.push(`### ${op.method} \`${op.pathname}\` (${op.count} calls)`);
  lines.push("");
  lines.push(`Resource types: **${(op.resourceTypes ?? []).join(", ") || "—"}**`);
  lines.push("");
  let i = 0;
  for (const s of op.samples) {
    i += 1;
    lines.push(`#### Sample ${i} (${s.ts})`);
    lines.push("");
    lines.push(`- **resourceType:** ${s.resourceType ?? "—"}`);
    lines.push(`- **pathWithQuery:** \`${(s.pathWithQuery ?? "").replace(/\|/g, "\\|")}\``);
    if (s.frameUrl) {
      lines.push(`- **frameUrl:** \`${s.frameUrl}\``);
    }
    lines.push(`- **query keys:** ${Object.keys(s.query ?? {}).join(", ") || "—"}`);
    lines.push(`- **requestContentType:** ${s.requestContentType ?? "—"}`);
    lines.push(`- **request header names:** ${(s.requestHeaderNames ?? []).join(", ") || "—"}`);
    lines.push(`- **request JSON top-level keys:** ${(s.requestBodyTopLevelKeys ?? []).join(", ") || "—"}`);
    lines.push(`- **responseStatus:** ${s.responseStatus ?? "—"}`);
    lines.push(`- **responseContentType:** ${s.responseContentType ?? "—"}`);
    lines.push(`- **response header names:** ${(s.responseHeaderNames ?? []).join(", ") || "—"}`);
    lines.push(`- **response JSON top-level keys:** ${(s.responseBodyTopLevelKeys ?? []).join(", ") || "—"}`);
    lines.push("");
    lines.push("<details><summary>Request body preview</summary>\n\n```json");
    lines.push((s.requestBodyPreview ?? "(none)").slice(0, 24_000));
    lines.push("```\n</details>\n");
    lines.push("<details><summary>Response body preview</summary>\n\n```");
    lines.push((s.responseBodyPreview ?? "(none)").slice(0, 24_000));
    lines.push("```\n</details>\n");
  }
  lines.push("");
}

await writeFile(outMd, lines.join("\n"), "utf8");
console.log("Wrote", outMd);
