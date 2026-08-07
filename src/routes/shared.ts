import { OpenAPIHono, z } from "@hono/zod-openapi";
import { bearerMatches } from "../lib/auth";
import type { AppEnv } from "./types";

/**
 * Build an empty route module.
 *
 * It must be an `OpenAPIHono`, never a plain `Hono`: `OpenAPIHono.route()`
 * copies a sub-app's `openAPIRegistry` into the parent only when the sub-app is
 * `instanceof OpenAPIHono`. Mounting a plain `Hono` would still serve traffic
 * while silently dropping every one of its routes from `/openapi.json`.
 *
 * Modules are mounted on the root app at `"/"` so the full `/api/v1/...` path
 * written in each `createRoute` is used verbatim, with no prefix merging.
 */
export function createRouteModule(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>();
}

/**
 * Snapshot and data-entity routes gate on `CUSTOMER_SNAPSHOT_SYNC_SECRET`
 * specifically. This is a second, narrower check that runs inside the handler,
 * on top of the app-wide `/api/v1/*` bearer gate in `app.ts`.
 */
export function snapshotSyncAuthorized(c: {
  env: Env;
  req: { header: (name: string) => string | undefined };
}): boolean {
  return bearerMatches(c.req, c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET);
}

/** Response shape for routes that stream an upstream Routeware body through. */
export const upstreamPassthrough200 = {
  200: {
    description:
      "Upstream Routeware response (JSON, form-encoded, HTML, or other)",
    content: {
      "application/json": { schema: z.unknown() },
      "text/plain": { schema: z.string() },
      "text/html": { schema: z.string() }
    }
  }
} as const;

/**
 * Shared by the customer, address and container snapshot list routes. Keep this
 * a single instance — the `.openapi()` name registers one reusable component,
 * and three separate instances would register it three times.
 */
export const snapshotListResponse = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number().int()
  })
  .openapi("CustomerSnapshotList");
