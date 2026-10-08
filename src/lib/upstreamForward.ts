import type { SessionState } from "./sessionState";
import { applyBrowserHeaders } from "./upstreamHeaders";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  fetchWithUpstreamTimeout,
  inheritUpstreamController
} from "./upstreamTimeout";

export type ForwardOptions = {
  /**
   * Value for the `X-Routeware-Shadow-Internal` header. Set ONLY by trusted
   * server-side callers (the anti-forgery modal fetch). It is never copied from
   * the incoming client request, so external clients cannot spoof it.
   */
  internalMarker?: string;
  /**
   * Per-attempt time-to-headers budget in ms (TOG-5835). Defaults to
   * `DEFAULT_UPSTREAM_TIMEOUT_MS`; report-CSV callers pass the larger
   * report budget. A hung upstream throws `UpstreamTimeoutError` (never
   * retried — the single retry is reserved for the login redirect).
   */
  timeoutMs?: number;
};

export async function forwardToUpstream(
  incoming: Request,
  upstreamUrl: URL,
  session: SessionState | null,
  bodyBuffer: ArrayBuffer | null,
  options: ForwardOptions = {}
): Promise<Response> {
  const headers = new Headers();
  applyBrowserHeaders(headers, upstreamUrl.origin);

  const contentType = incoming.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  const incomingAccept = incoming.headers.get("accept");
  if (incomingAccept) {
    headers.set("Accept", incomingAccept);
  }
  const incomingReferer = incoming.headers.get("referer");
  if (incomingReferer) {
    headers.set("Referer", incomingReferer);
  }
  if (options.internalMarker) {
    headers.set("X-Routeware-Shadow-Internal", options.internalMarker);
  }

  if (session?.cookieHeader) {
    headers.set("Cookie", session.cookieHeader);
  }

  // Bounded per-attempt budget (TOG-5835): a hung Routeware host throws
  // `UpstreamTimeoutError` instead of holding the Worker to the 300s CPU
  // limit. The timer covers time-to-headers only, so a started body stream is
  // not cut off. Timeouts are never retried — the single retry is reserved
  // for the login redirect (see `forwardWithSessionRetry`).
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const upstream = await fetchWithUpstreamTimeout(
    upstreamUrl.toString(),
    {
      method: incoming.method,
      headers,
      body: bodyBuffer,
      redirect: "manual"
    },
    timeoutMs
  );

  return stripUpstreamSetCookie(upstream);
}

/**
 * Strip upstream `Set-Cookie` before returning to the client. The Worker owns
 * the Routeware session (browser login → Durable Object); relaying upstream
 * `Set-Cookie` would leak the shared session cookies to shadow-API clients.
 */
function stripUpstreamSetCookie(res: Response): Response {
  if (!res.headers.has("set-cookie")) {
    return res;
  }
  const headers = new Headers(res.headers);
  headers.delete("set-cookie");
  return inheritUpstreamController(res, new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  }));
}
