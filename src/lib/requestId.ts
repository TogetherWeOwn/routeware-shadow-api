/**
 * X-Request-Id adoption + emission for `/api/v1/*`.
 *
 * Agents correlate every attempt (including retries) with server-side logs
 * through one id: the earliest `/api/v1/*` middleware adopts a valid inbound
 * value, mints a UUID otherwise, and every response echoes it — success, the
 * 401/429 gate, notFound, and every onError branch (thrown errors bypass the
 * success-path middleware, so onError stamps directly).
 *
 * Validity is 1–128 chars of RFC 7230 token chars. Invalid values never fail
 * the request; a fresh `crypto.randomUUID()` is minted instead. Kept distinct
 * from idempotency keys by design.
 */

export const REQUEST_ID_HEADER = "X-Request-Id";

/** Maximum inbound length; longer values mint instead of echoing. */
export const REQUEST_ID_MAX_LENGTH = 128;

// RFC 7230 token chars: `!#$%&'*+-.^_`|~` plus ASCII alphanumerics.
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Adopt the inbound id when it is 1–128 chars of token chars, else mint a
 * UUID. Never throws, never fails the request.
 */
export function resolveRequestId(inbound: string | null | undefined): string {
  if (
    inbound !== null &&
    inbound !== undefined &&
    inbound.length >= 1 &&
    inbound.length <= REQUEST_ID_MAX_LENGTH &&
    TOKEN_RE.test(inbound)
  ) {
    return inbound;
  }
  return crypto.randomUUID();
}

/**
 * Echo `requestId` on `res` via the `X-Request-Id` header, preserving status
 * and body. Bodies pass through untouched (no buffering of JSON or streams);
 * the gate/notFound/onError problem bodies carry `requestId` explicitly via
 * `ProblemBody.requestId`, while route-level problem bodies keep their exact
 * existing shape (header correlation only).
 */
export function stampRequestId(res: Response, requestId: string): Response {
  const headers = new Headers(res.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  });
}
