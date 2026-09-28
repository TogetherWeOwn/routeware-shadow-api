import { OpenAPIHono, z } from "@hono/zod-openapi";
import { bearerMatches } from "../lib/auth";
import { problemJsonResponse, problemType } from "../lib/problem";
import { findForeignKeyError } from "../lib/snapshot/upsert";
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
  req: { header: (name: string) => string | undefined; url: string };
};

/**
 * Guard for the snapshot-secret routes: returns a 401 problem+json response to
 * return as-is, or `null` when the caller is authorized.
 *
 * The detail is fixed here (TOG-7030): every privileged route names the sync
 * secret and the remedy doc, so clients see one canonical 401 body.
 */
export function requireSnapshotAuth(c: SnapshotAuthContext): Response | null {
  if (snapshotSyncAuthorized(c)) {
    return null;
  }
  return problemJsonResponse({
    type: problemType("unauthorized"),
    title: "Unauthorized",
    status: 401,
    detail:
      "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.",
    instance: new URL(c.req.url).pathname
  });
}

/**
 * Guard for routes that need `CUSTOMER_SNAPSHOT_SYNC_SECRET` to be configured
 * at all: returns a 503 problem+json response, or `null` when it is set.
 */
export function requireSnapshotSecret(c: SnapshotAuthContext): Response | null {
  if (c.env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim()) {
    return null;
  }
  return problemJsonResponse({
    type: problemType("misconfigured"),
    title: "Service Unavailable",
    status: 503,
    detail:
      "Set CUSTOMER_SNAPSHOT_SYNC_SECRET in vars or secrets. See docs/PROBLEMS.md#misconfigured.",
    instance: new URL(c.req.url).pathname
  });
}

/**
 * Map a dangling-FK snapshot failure to 400 `bad-request` problem+json, or
 * `null` when the error is not an FK violation. Lists up to 20 missing integer
 * keys, then `+N more` — integer keys only, no PII, no secrets.
 *
 * Shared by the address/container import and sync handlers: a `sync` that
 * pulls an upstream export with dangling references is the same client-actionable
 * 400 as an `import` with dangling rows, not a 500.
 */
export function foreignKeyProblem(err: unknown): Response | null {
  const fk = findForeignKeyError(err);
  if (!fk) {
    return null;
  }
  const shown = fk.missingKeys.slice(0, 20);
  const extra = fk.missingKeys.length - shown.length;
  const keys = extra > 0 ? `${shown.join(", ")} +${extra} more` : shown.join(", ");
  const parents =
    fk.parentTable === "customer_snapshot" ? "customers" : "addresses";
  return problemJsonResponse({
    type: problemType("bad-request"),
    title: "Bad Request",
    status: 400,
    detail:
      `Dangling reference: ${fk.table}.${fk.column}=${keys} has no row in ` +
      `${fk.parentTable}.${fk.column} (batch at row offset ${fk.rowOffset}). ` +
      `Import ${parents} first. See docs/PROBLEMS.md#bad-request.`
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
