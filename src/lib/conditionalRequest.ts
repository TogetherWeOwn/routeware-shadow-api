// RFC entity-tags allow commas inside the quoted opaque value; splitting on
// commas before parsing can turn part of one unrelated tag into a false match.
const ENTITY_TAG = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
const ENTITY_TAG_LIST = new RegExp(`^[ \\t]*${ENTITY_TAG}(?:[ \\t]*,[ \\t]*${ENTITY_TAG})*[ \\t]*$`);
const ENTITY_TAG_TOKENS = new RegExp(ENTITY_TAG, "g");

function normalizeEtagToken(token: string): string {
  return token.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
}

/**
 * Weak comparison for GET If-None-Match: exact opaque tokens, never substrings.
 * New callers require quoted tags (or standalone `*`); malformed lists miss.
 * Legacy mode preserves the pre-existing hydrated/CSV read normalization,
 * including unquoted tokens and case-insensitive weak prefixes.
 */
export function matchesIfNoneMatch(
  header: string | null | undefined,
  etag: string,
  syntax: "quoted" | "legacy" = "quoted"
): boolean {
  if (!header) return false;
  const want = normalizeEtagToken(etag);
  if (syntax === "legacy") {
    return header.split(",").map(normalizeEtagToken)
      .some((token) => token === "*" || token === want);
  }
  if (/^[ \t]*\*[ \t]*$/.test(header)) return true;
  if (!ENTITY_TAG_LIST.test(header)) return false;
  // The full-list check guarantees at least one complete quoted token.
  return header.match(ENTITY_TAG_TOKENS)!
    .some((token) => normalizeEtagToken(token) === want);
}
