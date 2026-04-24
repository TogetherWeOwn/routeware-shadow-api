const PROBLEM_JSON = "application/problem+json";

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
    type: "https://example.com/probs/not-found",
    title: "Not Found",
    status: 404,
    detail: `No operation registered for ${path}`,
    instance: path
  });
}
