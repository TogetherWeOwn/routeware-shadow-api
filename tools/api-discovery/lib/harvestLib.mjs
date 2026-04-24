/**
 * Shared helpers for harvest NDJSON tooling (aggregate, docs, validation).
 */

export function truncate(str, maxLen) {
  if (str == null) {
    return undefined;
  }
  const s = String(str);
  if (s.length <= maxLen) {
    return s;
  }
  return `${s.slice(0, maxLen)}\n… [truncated for aggregate output; see harvest.ndjson for full preview up to cap]`;
}

export function tryParseJsonPreview(text) {
  if (!text || typeof text !== "string") {
    return { ok: false };
  }
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

/** Top-level keys only, for markdown (keeps aggregate small). */
export function jsonTopLevelKeys(text) {
  const r = tryParseJsonPreview(text);
  if (!r.ok || r.value == null || typeof r.value !== "object") {
    return [];
  }
  if (Array.isArray(r.value)) {
    return [`[array length ${r.value.length}]`];
  }
  return Object.keys(r.value).sort();
}
