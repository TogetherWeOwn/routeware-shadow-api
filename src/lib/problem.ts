const PROBLEM_JSON = "application/problem+json";

/**
 * Base for problem `type` URIs. Slugs resolve to anchors in docs/PROBLEMS.md,
 * e.g. `problemType("not-found")` → `.../PROBLEMS.md#not-found`.
 */
export const PROBLEM_TYPE_BASE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";

/** Build a dereferenceable problem `type` URI from a kebab-case slug. */
export function problemType(slug: string): string {
  return `${PROBLEM_TYPE_BASE}${slug}`;
}

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
};

export function problemJsonResponse(body: ProblemBody): Response {
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: {
      "content-type": PROBLEM_JSON
    }
  });
}

export function notFoundProblem(path: string): Response {
  return problemJsonResponse({
    type: problemType("not-found"),
    title: "Not Found",
    status: 404,
    detail: `No operation registered for ${path}. See docs/PROBLEMS.md#not-found.`,
    instance: path
  });
}
