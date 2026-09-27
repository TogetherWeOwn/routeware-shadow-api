import { isLoginRedirect } from "./loginRedirect";
import { forwardToUpstream } from "./upstreamForward";
import { readSessionState, type SessionState } from "./sessionState";
import {
  isUpstreamTimeout,
  readUpstreamTimeoutMs,
  upstreamTimeoutProblem
} from "./upstreamTimeout";

type EstablishSession = (
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
  establishSession: EstablishSession
): Promise<Response> {
  // Bounded per-attempt budget (TOG-5835), honoring an optional
  // `UPSTREAM_TIMEOUT_MS` binding. Worst case is 2x this (one retry max).
  const timeoutMs = readUpstreamTimeoutMs(env);
  const forwardOpts = { timeoutMs };

  let session: SessionState = await readSessionState(sessionStub);

  // Proactive refresh: if the stored session is absent or about to expire
  // (SESSION_TTL_SECONDS), re-establish before spending the request on a
  // predictable login redirect.
  if (sessionNeedsRefresh(session)) {
    await establishSession(env, sessionStub, env.LOGIN_URL);
    session = await readSessionState(sessionStub);
  }

  // A hung upstream throws `UpstreamTimeoutError` from the first forward. It
  // is NEVER retried: the single-retry budget is reserved for the login
  // redirect (provably safe — a timeout retry could double-execute a
  // non-idempotent POST). Fail fast to 502 problem+json instead.
  let response: Response;
  try {
    response = await forwardToUpstream(
      incoming,
      upstreamUrl,
      session,
      bodyBuffer,
      forwardOpts
    );
  } catch (err) {
    if (isUpstreamTimeout(err)) {
      return upstreamTimeoutProblem(err.timeoutMs, new URL(incoming.url).pathname);
    }
    throw err;
  }

  if (response.status === 200 || !isLoginRedirect(response)) {
    return response;
  }

  // Reactive refresh: the session was rejected upstream despite the freshness
  // check (e.g. server-side invalidation). Re-establish and retry once.
  await establishSession(env, sessionStub, env.LOGIN_URL);

  session = await readSessionState(sessionStub);

  try {
    return await forwardToUpstream(incoming, upstreamUrl, session, bodyBuffer, forwardOpts);
  } catch (err) {
    if (isUpstreamTimeout(err)) {
      return upstreamTimeoutProblem(err.timeoutMs, new URL(incoming.url).pathname);
    }
    throw err;
  }
}
