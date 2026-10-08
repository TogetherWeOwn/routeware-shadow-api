export function routewareWebRwUrl(
  targetOrigin: string,
  basePath: string,
  resourcePath: string
): URL {
  const normalizedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const suffix = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  return new URL(`${normalizedBase}${suffix}`, targetOrigin);
}

/** Fixed WebRW path with the shadow API request’s query string (for GET parity with the SPA). */
export function routewareWebRwUrlWithIncomingSearch(
  targetOrigin: string,
  basePath: string,
  resourcePath: string,
  incoming: Request
): URL {
  const url = routewareWebRwUrl(targetOrigin, basePath, resourcePath);
  url.search = new URL(incoming.url).search;
  return url;
}

/**
 * Fixed WebRW path with only the allowlisted query params copied from the
 * shadow API request. Anything else the client sends is dropped (never
 * forwarded, never an error) so arbitrary client input cannot reach upstream
 * as new query surface. Matching is case-sensitive; repeated allowlisted
 * params keep every value, in allowlist order.
 */
export function routewareWebRwUrlWithQueryAllowlist(
  targetOrigin: string,
  basePath: string,
  resourcePath: string,
  incoming: Request,
  allowedParams: readonly string[]
): URL {
  const url = routewareWebRwUrl(targetOrigin, basePath, resourcePath);
  const incomingParams = new URL(incoming.url).searchParams;
  for (const name of allowedParams) {
    for (const value of incomingParams.getAll(name)) {
      url.searchParams.append(name, value);
    }
  }
  return url;
}
