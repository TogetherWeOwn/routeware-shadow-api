import { isLoginRedirect } from "./loginRedirect";
import { forwardToUpstream, type ForwardOptions } from "./upstreamForward";
import { readSessionState, type SessionState } from "./sessionState";

export type EstablishSession = (
  env: Env,
  stub: DurableObjectStub,
  bootstrapUrl: string
) => Promise<void>;

/** Refresh this far before the stored session's recorded expiry. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * True when a session we *have* is at/near its recorded TTL expiry.
 *
 * A missing session returns false on purpose: it is handled reactively (the
 * first forward gets a login redirect, then re-establishes), which avoids
 * launching the browser for a request a cookieless upstream would serve anyway.
 * The proactive path exists specifically to skip a predictable redirect when the
 * stored session is known to be expiring (making SESSION_TTL_SECONDS effective).
 */
export function sessionNeedsRefresh(session: SessionState, nowMs = Date.now()): boolean {
  if (!session.cookieHeader) {
    return false;
  }
  if (session.expiresAtMs !== null && nowMs >= session.expiresAtMs - EXPIRY_SKEW_MS) {
    return true;
  }
  return false;
}

export async function forwardWithSessionRetry(
  env: Env,
  sessionStub: DurableObjectStub,
  incoming: Request,
  upstreamUrl: URL,
  bodyBuffer: ArrayBuffer | null,
  establishSession: EstablishSession,
  options: ForwardOptions = {}
): Promise<Response> {
  let session: SessionState = await readSessionState(sessionStub);

  // Proactive refresh: if the stored session is absent or about to expire
  // (SESSION_TTL_SECONDS), re-establish before spending the request on a
  // predictable login redirect.
  if (sessionNeedsRefresh(session)) {
    await establishSession(env, sessionStub, env.LOGIN_URL);
    session = await readSessionState(sessionStub);
  }

  let response = await forwardToUpstream(
    incoming,
    upstreamUrl,
    session,
    bodyBuffer,
    options
  );

  if (response.status === 200 || !isLoginRedirect(response)) {
    return response;
  }

  // Reactive refresh: the session was rejected upstream despite the freshness
  // check (e.g. server-side invalidation). Re-establish and retry once.
  await establishSession(env, sessionStub, env.LOGIN_URL);

  session = await readSessionState(sessionStub);

  return forwardToUpstream(incoming, upstreamUrl, session, bodyBuffer, options);
}
