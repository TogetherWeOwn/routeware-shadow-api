export type SkipTakeTranslation = {
  /** Body to forward upstream (re-serialized only when translated). */
  text: string;
  /** True when a translation was applied. */
  translated: boolean;
};

function isValidOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * TOG-5936: translate OData-style `skip`/`take` pagination keys onto the
 * Ext.NET `start`/`limit` spelling the harvested SPA traffic uses
 * (`tools/api-discovery/examples/customers-read.post.example.json`).
 *
 * Whether upstream Routeware honors `skip`/`take` was never established, so a
 * client sending them risked silently receiving an unpaged/default-window
 * result. Mapping server-side is correct under either upstream behavior: if
 * upstream ignores `skip`/`take` the translation fixes silent mispaging, and
 * if it honors them the proven SPA spelling still pages the same window.
 *
 * Rules (all other bodies pass through untouched):
 * - JSON objects only; non-JSON, arrays and primitives are returned as-is.
 * - `skip` maps to `start`, `take` maps to `limit`, but only when that target
 *   key is absent — an explicit `start`/`limit` always wins.
 * - Translated `skip`/`take` keys are dropped so upstream never sees two
 *   spellings of one window. When `start`/`limit` are already explicit, a
 *   redundant `skip`/`take` is still dropped as conflicting.
 * - A present-but-invalid `skip`/`take` (non-number, fractional, negative)
 *   translates nothing: the body is forwarded unchanged rather than
 *   half-mapped. `take: 0` maps faithfully to `limit: 0`.
 * - `page`, `filter`, `sort` and `group` are never synthesized or touched.
 */
export function translateSkipTakeToStartLimit(bodyText: string): SkipTakeTranslation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { text: bodyText, translated: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { text: bodyText, translated: false };
  }
  const body = parsed as Record<string, unknown>;
  const hasSkip = Object.hasOwn(body, "skip");
  const hasTake = Object.hasOwn(body, "take");
  if (!hasSkip && !hasTake) {
    return { text: bodyText, translated: false };
  }
  const { skip, take } = body;
  if ((hasSkip && !isValidOffset(skip)) || (hasTake && !isValidOffset(take))) {
    return { text: bodyText, translated: false };
  }
  const out: Record<string, unknown> = { ...body };
  if (hasSkip && !Object.hasOwn(out, "start")) {
    out.start = skip;
  }
  if (hasTake && !Object.hasOwn(out, "limit")) {
    out.limit = take;
  }
  delete out.skip;
  delete out.take;
  return { text: JSON.stringify(out), translated: true };
}
