import { OpenAPIHono, z } from "@hono/zod-openapi";
import { bearerMatches } from "../lib/auth";
import { problemJsonResponse, problemType } from "../lib/problem";
import type { AppEnv } from "./types";

/**
 * Default zod-validation hook for every route module (TOG-5836).
 *
 * Without this, `@hono/zod-openapi` answers schema rejections (bad query,
 * path or body shapes) with its raw `{success:false, error}` 400 as
 * `application/json` — the one error shape in the API that did not anchor
 * into `docs/PROBLEMS.md`. Every rejection now returns an anchored 400
 * `bad-request` problem+json, and the handler never runs.
 *
 * `detail` names the rejected target and fields, never values: query strings
 * here can carry customer PII (company-name/company substrings), so the zod
 * messages (which echo received values) are deliberately not forwarded.
 */
export function validationFailureHook(result: {
  success: boolean;
  target: string;
  error?: { issues: Array<{ path: PropertyKey[] }> };
}): Response | undefined {
  if (result.success || !result.error) {
    return undefined;
  }
  const fields = result.error.issues.map((issue) =>
    issue.path.length > 0 ? issue.path.map((p) => String(p)).join(".") : result.target
  );
  const unique = [...new Set(fields)];
  return problemJsonResponse({
    type: problemType("bad-request"),
    title: "Bad Request",
    status: 400,
    detail: `Invalid request ${result.target} (${unique.join(", ")}). See docs/PROBLEMS.md#bad-request.`
  });
}

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
 *
 * The `defaultHook` is what keeps schema rejections anchored: the validators
 * are built when each module registers its routes, so the hook must live on
 * the module itself — setting it only on the root app would leave every
 * module returning raw `{success:false}` 400s.
 */
export function createRouteModule(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({ defaultHook: validationFailureHook });
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
