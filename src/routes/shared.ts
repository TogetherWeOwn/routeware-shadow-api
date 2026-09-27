import { OpenAPIHono, z } from "@hono/zod-openapi";
import { bearerMatches } from "../lib/auth";
import { problemJsonResponse, problemType } from "../lib/problem";
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
export function snapshotSyncAuthorized(c: SnapshotAuthContext): boolean {
  return bearerMatches(c.req, c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET);
}

type SnapshotAuthContext = {
  env: Env;
  req: { header: (name: string) => string | undefined };
};

/**
 * Guard for the snapshot-secret routes: returns a 401 problem+json response to
 * return as-is, or `null` when the caller is authorized.
 *
 * `detail` is per-call-site rather than fixed here because the existing wording
 * differs between routes (several omit it entirely). That inconsistency is
 * pre-existing and pinned by `test/snapshotAuth.test.ts`; unifying it would
 * change what clients see, so it belongs in its own change.
 */
export function requireSnapshotAuth(
  c: SnapshotAuthContext,
  detail?: string
): Response | null {
  if (snapshotSyncAuthorized(c)) {
    return null;
  }
  return problemJsonResponse({
    type: problemType("unauthorized"),
    title: "Unauthorized",
    status: 401,
    detail
  });
}

/**
 * Guard for routes that need `CUSTOMER_SNAPSHOT_SYNC_SECRET` to be configured
 * at all: returns a 503 problem+json response, or `null` when it is set.
 */
export function requireSnapshotSecret(env: Env, detail?: string): Response | null {
  if (env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim()) {
    return null;
  }
  return problemJsonResponse({
    type: problemType("misconfigured"),
    title: "Not configured",
    status: 503,
    detail
  });
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
 * Keyset cursor query param shared by the customer, address and container
 * snapshot list routes. The value is the last-seen primary key; the handler
 * adds `<pk> > ?` so D1 seeks the PK index instead of scanning past a deep
 * OFFSET. Prefer this over `offset` for large scans; leave `offset` at 0 when
 * paging by cursor (the two compose, but a nonzero offset still scans).
 */
export const snapshotCursorParam = z.coerce
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "Keyset cursor: return rows with a primary key greater than this value. Prefer over deep `offset` for large scans."
  );

/**
 * Next-page token for a keyset list response. Returns the primary key of the
 * last row when a full page was returned (more rows may exist — pass it as
 * `cursor`), or `null` when fewer than `limit` rows came back (end of
 * results). A `null` for a full page whose last row lacks a numeric pk keeps
 * the response shape stable instead of emitting a bogus cursor.
 */
export function keysetNextCursor(
  rows: Array<Record<string, unknown>>,
  pkField: string,
  limit: number
): number | null {
  if (rows.length === 0 || rows.length < limit) {
    return null;
  }
  const last = rows[rows.length - 1]?.[pkField];
  return typeof last === "number" && Number.isInteger(last) ? last : null;
}

/**
 * Shared by the customer, address and container snapshot list routes. Keep this
 * a single instance — the `.openapi()` name registers one reusable component,
 * and three separate instances would register it three times.
 */
export const snapshotListResponse = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number().int(),
    nextCursor: z
      .number()
      .int()
      .nullable()
      .describe(
        "Primary key of the last row when a full page was returned; pass as `cursor` for the next page. Null at the end of results."
      )
  })
  .openapi("CustomerSnapshotList");
