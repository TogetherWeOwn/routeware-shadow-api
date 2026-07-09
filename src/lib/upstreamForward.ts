import type { SessionState } from "./sessionState";
import { applyBrowserHeaders } from "./upstreamHeaders";

export type ForwardOptions = {
  /**
   * Value for the `X-Routeware-Shadow-Internal` header. Set ONLY by trusted
   * server-side callers (the anti-forgery modal fetch). It is never copied from
   * the incoming client request, so external clients cannot spoof it.
   */
  internalMarker?: string;
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

  const upstream = await fetch(upstreamUrl.toString(), {
    method: incoming.method,
    headers,
    body: bodyBuffer,
    redirect: "manual"
  });

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
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  });
}
