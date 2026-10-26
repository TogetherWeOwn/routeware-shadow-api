import { z } from "@hono/zod-openapi";

const PROBLEM_JSON = "application/problem+json";

/**
 * Fallback base for problem `type` URIs. Slugs resolve to anchors in docs/PROBLEMS.md,
 * e.g. `problemType("not-found")` → `.../PROBLEMS.md#not-found`.
 *
 * This is the committed default only — the effective base resolves from the
 * `PROBLEM_TYPE_BASE` wrangler var via `resolveProblemTypeBase()` (
 * HANDOVER.md open-task #1). The grep acceptance for this card ("no hardcoded
 * github.com URL in src/ except the fallback constant") points here.
 */
export const DEFAULT_PROBLEM_TYPE_BASE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";

/**
 * Historical export: the default base. Kept so existing importers and tests
 * keep working unchanged; new code should use the two-arg `problemType` form
 * (slug plus env) and let the env override apply.
 */
export const PROBLEM_TYPE_BASE = DEFAULT_PROBLEM_TYPE_BASE;

/**
 * Resolve the effective problem `type` URI base.
 *
 * A non-empty `PROBLEM_TYPE_BASE` binding wins (set it in wrangler.toml
 * `[vars]` / `.dev.vars` / `wrangler secret` at transfer time — the value is
 * used verbatim, trailing `#` included, so slugs append directly). Anything
 * else (absent, empty, non-string — including the committed `""` default and
 * test envs that never set it) falls back to `DEFAULT_PROBLEM_TYPE_BASE`,
 * so every existing response body is byte-identical unless the operator opts in.
 */
export function resolveProblemTypeBase(env?: Env): string {
  const override = (
    env as unknown as { PROBLEM_TYPE_BASE?: unknown } | undefined
  )?.PROBLEM_TYPE_BASE;
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  return DEFAULT_PROBLEM_TYPE_BASE;
}

/** Build a dereferenceable problem `type` URI from a kebab-case slug. */
export function problemType(slug: string, env?: Env): string {
  return `${resolveProblemTypeBase(env)}${slug}`;
}

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
};

/**
 * Mounted OpenAPI shape for the EXISTING `ProblemBody` wire bodies served by
 * the six ordinary flat snapshot GETs (three lists plus three by-ID reads).
 * Declaration-only: it types `/openapi.json`, never runtime validation —
 * handlers keep serving the same `problemJsonResponse` bytes.
 *
 * The single shared component every scoped 400/404 references: `type`,
 * `title` and `status` are always present; `detail`, `instance` and
 * `requestId` travel only where the runtime sets them. Query-validator 400s
 * omit `instance`; flat snapshot 400/404 bodies omit `requestId` and
 * propagate correlation via the `x-request-id` response header instead (only
 * the existing 401 body echoes it). The `type` URI slug after `#` is the
 * stable error identity; its base is deployment-configurable, so the schema
 * deliberately carries no enum, const, pattern or format facet.
 */
export const problemBodySchema = z.object({
  type: z.string().openapi({
    description: "Stable problem-type URI; the slug after `#` is the error identity (e.g. `bad-request`). The base follows the deployment `PROBLEM_TYPE_BASE`, never a closed enum."
  }),
  title: z.string().openapi({ description: "Fixed HTTP reason title for the status." }),
  status: z.number().int().openapi({ description: "HTTP status code, equal to the response status." }),
  detail: z.string().optional().openapi({
    description: "Fixed value-free guidance naming the rejected field or missing key, never submitted values."
  }),
  instance: z.string().optional().openapi({
    description: "Request path (plus handler fragment) on ID and missing-row failures; omitted on query-validator failures."
  }),
  requestId: z.string().optional().openapi({
    description: "Echoed only on the existing 401 body; flat snapshot 400/404 bodies omit it (see the `x-request-id` response header)."
  })
}).openapi("ProblemBody");

const PROBLEM_EXAMPLE_BASE = "https://example.invalid/problems#";

/**
 * Synthetic value-free media payloads for the scoped 400/404 contracts.
 * Fixed correction guidance only — no live identifiers, phone data, tokens
 * or tracker references. Shared by all nine error responses so machine
 * clients see one shape per status.
 */
export const snapshotProblem400Media = {
  schema: problemBodySchema,
  example: {
    type: `${PROBLEM_EXAMPLE_BASE}bad-request`,
    title: "Bad Request",
    status: 400,
    detail: "Invalid request query (limit). See docs/PROBLEMS.md#bad-request."
  }
};

export const snapshotProblem404Media = {
  schema: problemBodySchema,
  example: {
    type: `${PROBLEM_EXAMPLE_BASE}not-found`,
    title: "Not Found",
    status: 404,
    detail: "No snapshot row for the requested id. See docs/PROBLEMS.md#not-found."
  }
};

export function problemJsonResponse(body: ProblemBody): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: {
      "content-type": PROBLEM_JSON
    }
  });
}

export function notFoundProblem(
  path: string,
  env?: Env,
  requestId?: string
): Response {
  return problemJsonResponse({
    type: problemType("not-found", env),
    title: "Not Found",
    status: 404,
    detail: `No operation registered for ${path}. See docs/PROBLEMS.md#not-found.`,
    instance: path,
    ...(requestId === undefined ? {} : { requestId })
  });
}
