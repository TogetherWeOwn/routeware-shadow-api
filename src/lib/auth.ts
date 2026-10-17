/**
 * Client authentication for the shadow API.
 *
 * Every `/api/v1/*` route except a small public allowlist (currently just
 * `GET /api/v1/health`) requires `Authorization: Bearer <token>`. The Worker
 * proxies to Routeware with a stored admin session, so an unauthenticated
 * surface is effectively an open proxy into the tenant's data — this gate closes
 * that.
 *
 * The expected token is `SHADOW_API_TOKEN` when set, otherwise it falls back to
 * `CUSTOMER_SNAPSHOT_SYNC_SECRET` so a deployment can run with a single secret.
 * Privileged snapshot/data routes additionally check the sync secret directly.
 *
 * Read-only role: `SHADOW_API_READ_TOKEN`, when set, grants
 * GET-only access to non-privileged reads. It passes the outer gate on GET
 * requests; writes/sync/import (non-GET) never pass with it, and privileged
 * routes reject it at their inner sync-secret check.
 */

type EnvWithApiToken = Env & { SHADOW_API_TOKEN?: string };

type EnvWithReadToken = Env & { SHADOW_API_READ_TOKEN?: string };

type HeaderReader = { header: (name: string) => string | undefined };

/**
 * Constant-time string comparison. Avoids the timing side-channel of `===`,
 * which can leak how many leading characters matched. Length differences are
 * folded into the result instead of short-circuiting.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const len = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/** Parse the bearer token from an Authorization header, or null if absent.
 *
 * The match is end-anchored: `Bearer <token> <junk>` must NOT parse as
 * `<token>`, otherwise the gate (prefix) and any full-header audit/redaction
 * would disagree about what credential was presented.
 */
export function bearerFromRequest(req: HeaderReader): string | null {
  const auth = req.header("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  // noUncheckedIndexedAccess: the capture is always present on a match, but
  // the index type is `string | undefined`, so fall back to null explicitly.
  const token = m?.[1];
  return token ?? null;
}

/** True when the request carries a bearer token matching `expected` (constant-time). */
export function bearerMatches(req: HeaderReader, expected: string | undefined): boolean {
  const want = expected?.trim();
  if (!want) {
    return false;
  }
  const got = bearerFromRequest(req);
  return got !== null && timingSafeEqualStr(got, want);
}

/** The token that gates general `/api/v1/*` access (SHADOW_API_TOKEN, else the sync secret). */
export function apiAccessToken(env: Env): string | undefined {
  const dedicated = (env as EnvWithApiToken).SHADOW_API_TOKEN?.trim();
  if (dedicated) {
    return dedicated;
  }
  const fallback = env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim();
  return fallback || undefined;
}

/**
 * True when the request is authorized for general `/api/v1/*` access.
 * Accepts the general access token or the privileged sync secret (the latter so
 * the internal chained snapshot sync, which authenticates with the sync secret,
 * passes the gate even when a distinct SHADOW_API_TOKEN is configured).
 */
export function isApiAuthorized(env: Env, req: HeaderReader): boolean {
  return (
    bearerMatches(req, apiAccessToken(env)) ||
    bearerMatches(req, env.CUSTOMER_SNAPSHOT_SYNC_SECRET)
  );
}

/** The read-only token (`SHADOW_API_READ_TOKEN`), or undefined when unset. */
export function readAccessToken(env: Env): string | undefined {
  const raw = (env as EnvWithReadToken).SHADOW_API_READ_TOKEN?.trim();
  return raw || undefined;
}

/**
 * True when the request carries the read-only bearer on a GET request.
 * The read token never authorizes non-GET methods — writes, sync
 * and import stay on the full token — and it never clears the privileged
 * inner check (`requireSnapshotAuth` only accepts the sync secret), so no
 * privileged route accepts it. Unset/blank means unconfigured: fail closed.
 */
export function isReadAuthorized(env: Env, req: HeaderReader, method: string): boolean {
  return method === "GET" && bearerMatches(req, readAccessToken(env));
}
