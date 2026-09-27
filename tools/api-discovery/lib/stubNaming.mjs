/**
 * Pure naming mapping behind suggest-routes.mjs (no fs, no browser).
 *
 * Kept in its own module so Vitest can pin the upstreamPath → shadowPath
 * mapping and the emitted createRoute hint lines without running Playwright.
 * suggest-routes.mjs imports these; the logic must stay identical in both.
 */

/** Map an upstream `/WebRW/...` path to the suggested shadow API path. */
export function suggestShadowPath(upstreamPath) {
  const seg = String(upstreamPath).replace(/^\/WebRW\/?/i, "").replace(/\/+/g, "/");
  const kebab = seg
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\/+|\/+$/g, "");
  return `/api/v1/routeware/${kebab}`;
}

/** Comment block suggest-routes.mjs emits per missing route (3 lines + blank). */
export function stubBlock(gap) {
  const shadow = suggestShadowPath(gap.upstreamPath);
  return [
    `// ${gap.count}x  ${gap.method} ${gap.upstreamPath}`,
    `// → add route-map: shadowPath "${shadow}" (adjust naming)`,
    `// → createRoute method: "${String(gap.method).toLowerCase()}", path: "${shadow}"`,
    ""
  ];
}
