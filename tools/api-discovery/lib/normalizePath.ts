/**
 * Collapse obvious dynamic segments so repeated calls group in aggregates.
 * Tune patterns as you learn Routeware URL shapes.
 */
export function normalizePath(pathname: string): string {
  let path = pathname;
  path = path.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
    "/{uuid}"
  );
  path = path.replace(/\/\d+(?=\/|$)/g, "/{id}");
  return path;
}
