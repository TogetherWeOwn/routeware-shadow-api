/**
 * Pure markdown renderer for generate-harvest-docs.mjs.
 */
export function renderHarvestApiDoc(discovered, routeMap) {
  const upstreamToShadow = new Map();
  for (const entry of routeMap) {
    upstreamToShadow.set(`${entry.method} ${entry.upstreamPath}`, entry.shadowPath);
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
    for (const sample of op.samples) {
      i += 1;
      lines.push(`#### Sample ${i} (${sample.ts})`);
      lines.push("");
      lines.push(`- **resourceType:** ${sample.resourceType ?? "—"}`);
      lines.push(`- **pathWithQuery:** \`${(sample.pathWithQuery ?? "").replace(/\|/g, "\\|")}\``);
      if (sample.frameUrl) {
        lines.push(`- **frameUrl:** \`${sample.frameUrl}\``);
      }
      lines.push(`- **query keys:** ${Object.keys(sample.query ?? {}).join(", ") || "—"}`);
      lines.push(`- **requestContentType:** ${sample.requestContentType ?? "—"}`);
      lines.push(`- **request header names:** ${(sample.requestHeaderNames ?? []).join(", ") || "—"}`);
      lines.push(`- **request JSON top-level keys:** ${(sample.requestBodyTopLevelKeys ?? []).join(", ") || "—"}`);
      lines.push(`- **responseStatus:** ${sample.responseStatus ?? "—"}`);
      lines.push(`- **responseContentType:** ${sample.responseContentType ?? "—"}`);
      lines.push(`- **response header names:** ${(sample.responseHeaderNames ?? []).join(", ") || "—"}`);
      lines.push(`- **response JSON top-level keys:** ${(sample.responseBodyTopLevelKeys ?? []).join(", ") || "—"}`);
      lines.push("");
      lines.push("<details><summary>Request body preview</summary>\n\n```json");
      lines.push((sample.requestBodyPreview ?? "(none)").slice(0, 24_000));
      lines.push("```\n</details>\n");
      lines.push("<details><summary>Response body preview</summary>\n\n```");
      lines.push((sample.responseBodyPreview ?? "(none)").slice(0, 24_000));
      lines.push("```\n</details>\n");
    }
    lines.push("");
  }

  return lines.join("\n");
}
