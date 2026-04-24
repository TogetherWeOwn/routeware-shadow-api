import type { SessionState } from "./sessionState";
import { applyBrowserHeaders } from "./upstreamHeaders";

export async function forwardToUpstream(
  incoming: Request,
  upstreamUrl: URL,
  session: SessionState | null,
  bodyBuffer: ArrayBuffer | null
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
  const shadowInternal = incoming.headers.get("X-Routeware-Shadow-Internal");
  if (shadowInternal) {
    headers.set("X-Routeware-Shadow-Internal", shadowInternal);
  }

  if (session?.cookieHeader) {
    headers.set("Cookie", session.cookieHeader);
  }

  return fetch(upstreamUrl.toString(), {
    method: incoming.method,
    headers,
    body: bodyBuffer,
    redirect: "manual"
  });
}
