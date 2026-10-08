import { problemJsonResponse, problemType } from "./problem";

/**
 * Bounded upstream timeouts (TOG-5835).
 *
 * Upstream forwards had session retry but no documented timeout: a hung
 * Routeware host held the Worker until the 300s CPU limit mid-sync. Every
 * Routeware `fetch` now races a timer; the timer covers time-to-headers (the
 * `fetch` promise), not total body streaming, so a large report CSV that
 * starts quickly is not cut off mid-stream.
 *
 * Budgets (single-retry max, so worst case is 2x one attempt):
 * - interactive forwards (API passthrough, modals, login): 15s per attempt
 * - report CSV downloads (full-table exports): 60s per attempt
 *
 * Both are overridable per deploy via optional `UPSTREAM_TIMEOUT_MS` /
 * `UPSTREAM_REPORT_TIMEOUT_MS` bindings without a `wrangler.toml` change
 * (absent/invalid falls back to the default), same pattern as
 * `CUSTOMER_SAVE_AUTO_TOKEN_TTL_SECONDS`.
 *
 * Forwarding timeouts are NOT retried: `forwardWithSessionRetry` reserves
 * its single retry for a login redirect. Primary-response timeouts map to
 * 502 problem+json; auth fallback and post-save refresh retain their caller
 * policies (docs/PROBLEMS.md).
 */

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
export const REPORT_UPSTREAM_TIMEOUT_MS = 60_000;

function readPositiveMs(value: unknown): number | null {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Interactive budget, honoring an optional `UPSTREAM_TIMEOUT_MS` binding. */
export function readUpstreamTimeoutMs(env?: Env): number {
  const override =
    env === undefined
      ? null
      : readPositiveMs((env as unknown as Record<string, unknown>).UPSTREAM_TIMEOUT_MS);
  return override ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
}

/** Report-download budget, honoring `UPSTREAM_REPORT_TIMEOUT_MS`. */
export function readReportTimeoutMs(env?: Env): number {
  const override =
    env === undefined
      ? null
      : readPositiveMs(
          (env as unknown as Record<string, unknown>).UPSTREAM_REPORT_TIMEOUT_MS
        );
  return override ?? REPORT_UPSTREAM_TIMEOUT_MS;
}

/** Thrown when a Routeware fetch exceeds its timeout budget. Never carries URL/body. */
export class UpstreamTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Upstream request timed out after ${timeoutMs}ms`);
    this.name = "UpstreamTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isUpstreamTimeout(err: unknown): err is UpstreamTimeoutError {
  return err instanceof UpstreamTimeoutError;
}

const upstreamControllers = new WeakMap<Response, AbortController>();

/** Header-only wrappers still own the same upstream fetch and body. */
export function inheritUpstreamController(source: Response, target: Response): Response {
  const controller = upstreamControllers.get(source);
  if (controller) {
    upstreamControllers.set(target, controller);
  }
  return target;
}

/** Abort body consumption after headers, without imposing a streaming deadline. */
export function abortUpstreamResponse(response: Response): void {
  try {
    upstreamControllers.get(response)?.abort();
  } catch {
    // Best effort; the body-read race and stream cancellation still run.
  }
}

/**
 * `fetch` bounded to time-to-headers. Clears the timer once headers arrive so
 * a slow-but-started body stream is not cut off; callers that buffer
 * (`resp.text()`) should bound that read separately if needed.
 *
 * Maps only our own timer firing to `UpstreamTimeoutError`. A caller abort
 * (client disconnect) rethrows verbatim so it is never misreported as a 502.
 */
export async function fetchWithUpstreamTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  // `init.signal` is the caller's (client disconnect). A dedicated controller
  // merges it with our timer: the timer aborts on hang, the caller aborts on
  // disconnect. Manual `setTimeout` (not `AbortSignal.timeout`) so this works
  // on every runtime the Worker targets.
  const callerSignal = init.signal as AbortSignal | undefined | null;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // ignore — abort is best-effort; the race below enforces the budget
      }
      reject(new UpstreamTimeoutError(timeoutMs));
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  const onCallerAbort = () => {
    if (!timedOut) {
      try {
        controller.abort((callerSignal as AbortSignal).reason);
      } catch {
        // ignore
      }
    }
  };
  callerSignal?.addEventListener?.("abort", onCallerAbort, { once: true });
  try {
    // Race (not abort alone) enforces the budget: a non-abort-aware fetch
    // (e.g. a test mock returning a never-settling promise) would otherwise
    // hang past the timer. Real fetches abort and reject; the race covers both.
    const response = await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeoutPromise
    ]);
    upstreamControllers.set(response, controller);
    return response;
  } catch (err) {
    // Our timer fired (or the fetch rejected with an abort our timer caused):
    // report the bounded, PII-free timeout. A caller abort with the timer
    // unfired rethrows verbatim and is never misreported as a 502; when both
    // fired, the timeout wins.
    if (timedOut || err instanceof UpstreamTimeoutError) {
      throw err instanceof UpstreamTimeoutError ? err : new UpstreamTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    callerSignal?.removeEventListener?.("abort", onCallerAbort);
  }
}

/** 502 problem+json for a timed-out upstream step. No URL, no body, no PII. */
export function upstreamTimeoutProblem(
  timeoutMs: number,
  instance?: string,
  env?: Env
): Response {
  return problemJsonResponse({
    type: problemType("bad-gateway", env),
    title: "Upstream timed out",
    status: 502,
    detail:
      `Routeware did not complete its response within ${timeoutMs}ms. ` +
      `A save may have completed upstream; verify the record before resubmitting. ` +
      `See docs/PROBLEMS.md#bad-gateway.`,
    instance
  });
}
