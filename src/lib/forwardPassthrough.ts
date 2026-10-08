import { forwardWithSessionRetry, type EstablishSession } from "./forwardWithSessionRetry";
import { problemJsonResponse, problemType } from "./problem";
import type { ForwardOptions } from "./upstreamForward";

/** Client-facing boundary; internal save consumers keep the raw retry helper. */
export async function forwardPassthrough(
  env: Env,
  sessionStub: DurableObjectStub,
  incoming: Request,
  upstreamUrl: URL,
  bodyBuffer: ArrayBuffer | null,
  establishSession: EstablishSession,
  options: ForwardOptions = {}
): Promise<Response> {
  return forwardWithSessionRetry(
    env, sessionStub, incoming, upstreamUrl, bodyBuffer, establishSession, options,
    (response) => containUpstreamError(response, env)
  );
}

function containUpstreamError(response: Response, env: Env): Response {
  if (response.status < 400) {
    return response;
  }

  // Neither attempt's error body, headers nor status text is safe to relay.
  // Discard the stream without buffering it or waiting for upstream to finish.
  void response.body?.cancel().catch(() => {});
  const contained = problemJsonResponse({
    type: problemType("upstream-error", env),
    title: "Upstream request failed",
    status: response.status,
    detail: "Routeware returned an error. Its response body has been withheld."
  });
  contained.headers.set("cache-control", "no-store");
  return contained;
}
