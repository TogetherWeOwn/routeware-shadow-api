/**
 * Exact-hostname check for the house fetch-stub pattern
 * (docs/TEST-INVARIANTS.md § "No test may reach the network").
 *
 * Test fetch stubs must detect upstream URLs without substring matching on
 * the full URL string: `url.includes(host)` both false-trips on crafted
 * URLs that merely mention the host (a query string, or a lookalike domain
 * such as `<host>.evil.example`) and can be evaded by case variants
 * (`KILLEEN.ROUTEWARE.COM`), since `includes` is case-sensitive while DNS
 * is not. Comparing the parsed hostname is exact: the URL parser isolates
 * the host component and lowercases it (CodeQL
 * `js/incomplete-url-substring-sanitization`).
 *
 * A trailing dot is the same DNS name (FQDN root label), and the parser
 * keeps it — including for the %2e-encoded form — so both sides are
 * canonicalized before comparing; otherwise the tripwire would miss the
 * fetch and stubs that fall through to `originalFetch` would hit the
 * live tenant.
 *
 * Returns false when `url` does not parse, so unparseable input falls
 * through to the stub's loud `Unexpected upstream fetch` failure instead
 * of throwing a bare TypeError.
 */
export const UPSTREAM_HOST = "killeen.routeware.com";

export function isUpstreamUrl(url: string, host: string = UPSTREAM_HOST): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  const canon = (h: string): string => h.toLowerCase().replace(/\.$/, "");
  return canon(hostname) === canon(host);
}
