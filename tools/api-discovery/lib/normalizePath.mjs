/**
 * Collapse obvious dynamic segments so repeated calls group in aggregates.
 * Single source of truth: imported by both `aggregate.mjs` (the pipeline) and
 * the unit test, so the tested code is the code that runs.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function normalizePath(pathname) {
  let path = pathname;
  path = path.replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
    "/{uuid}"
  );
  path = path.replace(/\/\d+(?=\/|$)/g, "/{id}");
  return path;
}
