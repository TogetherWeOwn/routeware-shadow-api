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
