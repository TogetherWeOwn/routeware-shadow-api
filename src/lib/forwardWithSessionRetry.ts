import { isLoginRedirect } from "./loginRedirect";
import { forwardToUpstream } from "./upstreamForward";
import { readSessionState, type SessionState } from "./sessionState";

type EstablishSession = (
  env: Env,
  stub: DurableObjectStub,
  bootstrapUrl: string
) => Promise<void>;

export async function forwardWithSessionRetry(
  env: Env,
  sessionStub: DurableObjectStub,
  incoming: Request,
  upstreamUrl: URL,
  bodyBuffer: ArrayBuffer | null,
  establishSession: EstablishSession
): Promise<Response> {
  let session: SessionState = await readSessionState(sessionStub);

  let response = await forwardToUpstream(
    incoming,
    upstreamUrl,
    session,
    bodyBuffer
  );

  if (response.status === 200 || !isLoginRedirect(response)) {
    return response;
  }

  await establishSession(env, sessionStub, env.LOGIN_URL);

  session = await readSessionState(sessionStub);

  return forwardToUpstream(incoming, upstreamUrl, session, bodyBuffer);
}
