/** Pure transforms for export-curl-examples.mjs (no filesystem access). */
export function isJsonContentType(ct) {
  if (!ct || typeof ct !== "string") return true;
  const lower = ct.toLowerCase();
  return lower.includes("json") || lower.includes("+json");
}

export function slug(method, upstreamPath) {
  const tail = upstreamPath.replace(/^\/+/, "").replace(/\//g, "_");
  return `${method}_${tail}`;
}

export function queryToSearch(query) {
  if (!query || typeof query !== "object") return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else if (v != null) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function findHarvestRow(harvestLines, method, upstreamPath) {
  for (let i = harvestLines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(harvestLines[i]);
      if (row?.method === method && row.pathname === upstreamPath) return row;
    } catch {
      /* skip */
    }
  }
  return null;
}

export function exampleSearch(entry, harvestRow) {
  return harvestRow && Object.keys(harvestRow.query ?? {}).length > 0
    ? queryToSearch(harvestRow.query)
    : entry.exampleQuery ? `?${entry.exampleQuery}` : "";
}

function shellEscape(text) {
  return String(text).replace(/[\\"$`]/g, "\\$&").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export function curlExampleForEntry(entry, harvestRow, bodyText) {
  const contentType = harvestRow?.requestContentType ?? entry.exampleContentType ?? "application/json";
  const useJson = isJsonContentType(contentType);
  const bodyExt = useJson ? "json" : "body";
  const name = slug(entry.method, entry.upstreamPath);
  const bodyFile = typeof bodyText === "string" && entry.method !== "GET" && !harvestRow?.requestBodyTruncated
    ? { fileName: `${name}.${bodyExt}`, text: bodyText }
    : null;
  const lines = [`# ${shellEscape(entry.method)} ${shellEscape(entry.upstreamPath)} → ${shellEscape(entry.shadowPath)}`];

  if (entry.method === "GET") {
    const suffix = shellEscape(entry.shadowPath + exampleSearch(entry, harvestRow));
    lines.push(`curl -q -sS --fail --connect-timeout 5 --max-time 30 "$BASE${suffix}" -H "Accept: */*" -H "X-Requested-With: XMLHttpRequest"`);
  } else if (bodyFile) {
    const acceptHdr = useJson ? "application/json, text/javascript, */*; q=0.01" : "*/*";
    // Every non-GET line is inert, including all continuations. Retain escaped
    // material for inspection, never a flag that can activate a write.
    lines.push(
      "# Non-executable documentation only; no write replay is supported.",
      `# curl -sS -X ${shellEscape(entry.method)} "$BASE${shellEscape(entry.shadowPath)}" \\`,
      `#   -H "Content-Type: ${shellEscape(contentType)}" \\`,
      `#   -H "Accept: ${acceptHdr}" \\`,
      '#   -H "X-Requested-With: XMLHttpRequest" \\',
      `#   --data-binary "@$DIR/bodies/${shellEscape(bodyFile.fileName)}"`
    );
  } else {
    lines.push("# (no body: add exampleFile to route-map or re-record with updated recorder)");
  }
  lines.push("");
  return { lines, bodyFile };
}
