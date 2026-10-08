import { isLoginPageResponse, isLoginRedirect } from "./loginRedirect";
import { forwardToUpstream, type ForwardOptions } from "./upstreamForward";
import {
  concurrentRefreshTimeoutProblem,
  isConcurrentRefreshTimeout
} from "./sessionRefreshLock";
import { readSessionState, readSessionTtlMs, type SessionState } from "./sessionState";
import {
  isUpstreamTimeout,
  readUpstreamTimeoutMs,
  upstreamTimeoutProblem
} from "./upstreamTimeout";

export type EstablishSession = (
  env: Env,
  stub: DurableObjectStub,
  bootstrapUrl: string
) => Promise<void>;

/**
 * TOG-6462 retry context for the anti-forgery modal GET. When BOTH fields are
 * present the modal fetch runs through `forwardWithSessionRetry` (single
 * re-establish + retry, `internalMarker` preserved) instead of bare
 * `forwardToUpstream`, so an expired stored session (modal answers 302 →
 * login, or HTTP-200 login page) heals instead of surfacing a 502 the next
 * save would hit again. Absent keeps the direct forward.
 */
export type ModalRetryContext = {
  /** AuthSession DO stub the retry reads and refreshes. */
  sessionStub?: DurableObjectStub;
  /** Real `establishSession` — the single re-login budget. */
  establishSession?: EstablishSession;
};

/** Refresh this far before the stored session's recorded expiry. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * True when a session we *have* is at/near its recorded TTL expiry, or when
 * the stored expiry outlives the *current* `SESSION_TTL_SECONDS` (TOG-6528).
 *
 * A missing session returns false on purpose: it is handled reactively (the
 * first forward gets a login redirect, then re-establishes), which avoids
 * launching the browser for a request a cookieless upstream would serve anyway.
 * The proactive path exists specifically to skip a predictable redirect when the
 * stored session is known to be expiring (making SESSION_TTL_SECONDS effective).
 *
 * The second clause is the TTL-lowering containment: `expiresAtMs` is written
 * once at login, so lowering the TTL after the fact never moves it — without
 * this check the far-future expiry keeps a possibly-leaked cookie in use. When
 * the remaining lifetime exceeds the current TTL, the TTL was lowered since
 * login (or the stored value is otherwise bogus), so the session is treated as
 * expired and re-established. A literal `min(stored, now + TTL)` clamp would
 * NOT work here: `now + TTL` is always a full TTL away, so the check would
 * slide forward forever and never fire.
 *
 * When `env` is omitted or the TTL is unparseable, only the stored expiry is
 * consulted (the pre-TOG-6528 behavior); the next login still fails loudly via
 * `sessionExpiryMs`, so a bad value cannot silently wedge traffic.
 */
export function sessionNeedsRefresh(
  session: SessionState,
  nowMs = Date.now(),
  env?: Pick<Env, "SESSION_TTL_SECONDS">
): boolean {
  if (!session.cookieHeader) {
    return false;
  }
  if (session.expiresAtMs !== null && nowMs >= session.expiresAtMs - EXPIRY_SKEW_MS) {
    return true;
  }
  if (session.expiresAtMs !== null && env) {
    const ttlMs = readSessionTtlMs(env);
    if (ttlMs !== null && session.expiresAtMs - nowMs > ttlMs) {
      return true;
    }
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
  // Bounded per-attempt budget (TOG-5835), honoring an optional
  // `UPSTREAM_TIMEOUT_MS` binding. Worst case is 2x this (one retry max).
  // TOG-6462: the anti-forgery modal fetch passes `internalMarker` through
  // so the retry forward keeps the trusted-server-side header (`upstreamForward`
  // sets it from `options` only — client requests can never spoof it).
  const timeoutMs = readUpstreamTimeoutMs(env);
  const forwardOpts: ForwardOptions = {
    timeoutMs,
    ...(options.internalMarker !== undefined
      ? { internalMarker: options.internalMarker }
      : {})
  };

  let session: SessionState = await readSessionState(sessionStub);

  // Proactive refresh: if the stored session is absent or about to expire
  // (SESSION_TTL_SECONDS), re-establish before spending the request on a
  // predictable login redirect. Passing `env` also clamps the stored expiry
  // to the current TTL (TOG-6528): a TTL lowered after login forces a refresh
  // of the far-future stored session. A waiter that gives up on a hung
  // refresh fails closed to 502 (TOG-6526) — never forward with the expired
  // cookie.
  if (sessionNeedsRefresh(session, Date.now(), env)) {
    try {
      await establishSession(env, sessionStub, env.LOGIN_URL);
    } catch (err) {
      if (isConcurrentRefreshTimeout(err)) {
        return concurrentRefreshTimeoutProblem(err.timeoutMs, new URL(incoming.url).pathname, env);
      }
      throw err;
    }
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
      return upstreamTimeoutProblem(err.timeoutMs, new URL(incoming.url).pathname, env);
    }
    throw err;
  }

  // TOG-6515: the common ASP.NET expiry shape is HTTP 200 with a login
  // form, not a 302. A 200 carrying a login page takes the same single
  // re-login + retry as a login redirect; every other response (including
  // 401/429) is returned as-is and never retried.
  if (!isLoginRedirect(response)) {
    if (response.status !== 200 || !(await isLoginPageResponse(response, timeoutMs))) {
      return response;
    }
  }

  // Reactive refresh: the session was rejected upstream despite the freshness
  // check (e.g. server-side invalidation). Re-establish and retry once. A
  // waiter that gives up on a hung refresh fails closed to 502 (TOG-6526) —
  // never retry with the expired cookie (which would surface login HTML).
  try {
    await establishSession(env, sessionStub, env.LOGIN_URL);
  } catch (err) {
    if (isConcurrentRefreshTimeout(err)) {
      return concurrentRefreshTimeoutProblem(err.timeoutMs, new URL(incoming.url).pathname, env);
    }
    throw err;
  }

  session = await readSessionState(sessionStub);

  try {
    return await forwardToUpstream(incoming, upstreamUrl, session, bodyBuffer, forwardOpts);
  } catch (err) {
    if (isUpstreamTimeout(err)) {
      return upstreamTimeoutProblem(err.timeoutMs, new URL(incoming.url).pathname, env);
    }
    throw err;
  }
}
