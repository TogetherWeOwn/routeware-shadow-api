import { abortUpstreamResponse, UpstreamTimeoutError } from "./upstreamTimeout";

/**
 * A separate, total buffered-body budget, starting when consumption begins.
 * Preserve the original only for passthrough handlers; on timeout cancel BOTH
 * tee branches without awaiting the source's potentially hanging cancellation.
 * Streaming CSV/report consumers do not call this helper.
 * https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultReader/cancel
 */
export async function readUpstreamText(
  response: Response,
  timeoutMs: number,
  preserveBody = false
): Promise<string> {
  const body = (preserveBody ? response.clone() : response).body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new UpstreamTimeoutError(timeoutMs);
      // Reject first: an abort-aware stream may reject with AbortError, or
      // cancellation may finish a partial body. Neither is a successful read.
      reject(error);
      abortUpstreamResponse(response);
      void reader.cancel(error).catch(() => {});
      if (preserveBody) {
        void response.body?.cancel(error).catch(() => {});
      }
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  const text = (async () => {
    const decoder = new TextDecoder();
    const parts: string[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        parts.push(decoder.decode());
        return parts.join("");
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
  })();
  try {
    return await Promise.race([text, timeout]);
  } catch (err) {
    if (timedOut) {
      throw new UpstreamTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
