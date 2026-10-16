/**
 * Pure transforms for export-curl-examples.mjs (no filesystem access).
 */
export function isJsonContentType(ct) {
  if (!ct || typeof ct !== "string") {
    return true;
  }
  const lower = ct.toLowerCase();
  return lower.includes("json") || lower.includes("+json");
}

export function slug(method, upstreamPath) {
  const tail = upstreamPath.replace(/^\/+/, "").replace(/\//g, "_");
  return `${method}_${tail}`;
}

export function queryToSearch(query) {
  if (!query || typeof query !== "object") {
    return "";
  }
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) {
      v.forEach((x) => p.append(k, String(x)));
    } else if (v != null) {
      p.set(k, String(v));
    }
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function findHarvestRow(harvestLines, method, upstreamPath) {
  for (let i = harvestLines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(harvestLines[i]);
      if (row.method === method && row.pathname === upstreamPath) {
        return row;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

export function curlExampleForEntry(entry, harvestRow, bodyText) {
  const contentType =
    harvestRow?.requestContentType ?? entry.exampleContentType ?? "application/json";
  const useJson = isJsonContentType(contentType);
  const bodyExt = useJson ? "json" : "body";
  const name = slug(entry.method, entry.upstreamPath);
  const bodyFile = bodyText && entry.method !== "GET"
    ? { fileName: `${name}.${bodyExt}`, text: bodyText }
    : null;
  const lines = [`# ${entry.method} ${entry.upstreamPath} → ${entry.shadowPath}`];

  if (entry.method === "GET") {
    const qs =
      harvestRow && Object.keys(harvestRow.query ?? {}).length > 0
        ? queryToSearch(harvestRow.query)
        : entry.exampleQuery
          ? `?${entry.exampleQuery}`
          : "";
    lines.push(
      `curl -sS "$BASE${entry.shadowPath}${qs}" -H "Accept: */*" -H "X-Requested-With: XMLHttpRequest"`
    );
  } else if (bodyFile) {
    const acceptHdr = useJson
      ? "application/json, text/javascript, */*; q=0.01"
      : "*/*";
    lines.push(
      `curl -sS -X ${entry.method} "$BASE${entry.shadowPath}" \\`,
      `  -H "Content-Type: ${contentType.replace(/"/g, '\\"')}" \\`,
      `  -H "Accept: ${acceptHdr}" \\`,
      `  -H "X-Requested-With: XMLHttpRequest" \\`,
      `  --data-binary "@$DIR/bodies/${bodyFile.fileName}"`
    );
  } else {
    lines.push("# (no body: add exampleFile to route-map or re-record with updated recorder)");
  }
  lines.push("");

  return { lines, bodyFile };
}
