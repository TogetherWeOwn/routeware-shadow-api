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
