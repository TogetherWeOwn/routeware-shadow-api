import { problemJsonResponse, problemType } from "./problem";

/**
 * Bounded upstream timeouts.
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

/**
 * Idle (stall) budget for streamed report-CSV consumption, in ms. Each
 * `reader.read()` on the report body must yield bytes within this window; a
 * longer gap with no bytes rejects with `UpstreamTimeoutError` and cancels
 * the read, so a hung upstream mid-stream cannot hold the Worker toward the
 * 300s CPU limit. Every completed read resets the window, so a large or slow
 * export that keeps flowing is never cut off for its total size or time —
 * there is still no total-body deadline. Overridable per deploy via optional
 * `REPORT_STREAM_STALL_TIMEOUT_MS` (absent/invalid → default), same pattern
 * as the fetch bindings above. Covers the R2 archive drain, the D1
 * `streamCsvLines` consumption, and the archive readback measure/stream
 * passes; operator `...-snapshot/import` uploads stay unbounded (a client
 * disconnect aborts them) and report-download login sniffing keeps its
 * existing unbounded opt-out for nonstandard content types.
 */
export const DEFAULT_REPORT_STREAM_STALL_TIMEOUT_MS = 30_000;

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

/** Streamed-consumption stall budget, honoring `REPORT_STREAM_STALL_TIMEOUT_MS`. */
export function readReportStreamStallTimeoutMs(env?: Env): number {
  const override =
    env === undefined
      ? null
      : readPositiveMs(
          (env as unknown as Record<string, unknown>).REPORT_STREAM_STALL_TIMEOUT_MS
        );
  return override ?? DEFAULT_REPORT_STREAM_STALL_TIMEOUT_MS;
}

/**
 * Chained-sync budget: one `POST` to our own per-table sync route
 * runs a full table sync server-side (report download + D1 streaming + R2
 * archive), so its budget must clear the 60s report budget with headroom.
 * 180s bounds a hung table well below the 300s platform CPU limit while
 * leaving the observed ~41s jobs (runbook §0) ~4x headroom. Overridable per
 * deploy via optional `CHAINED_SYNC_TIMEOUT_MS` (absent/invalid → default).
 * Unlike CSV streaming, this is one deadline for headers AND the small JSON
 * body: the chained caller passes only the remaining budget to its body reader.
 * The caller tags the timeout
 * `[chained <table>]`; the error itself carries only the budget (PII-free).
 */
export const DEFAULT_CHAINED_SYNC_TIMEOUT_MS = 180_000;

/** Chained-subrequest budget, honoring an optional `CHAINED_SYNC_TIMEOUT_MS` binding. */
export function readChainedSyncTimeoutMs(env: Env): number {
  const override = readPositiveMs(
    (env as unknown as Record<string, unknown>).CHAINED_SYNC_TIMEOUT_MS
  );
  return override ?? DEFAULT_CHAINED_SYNC_TIMEOUT_MS;
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

/**
 * One stall-bounded `reader.read()`: resolves with whatever the read yields,
 * or rejects with `UpstreamTimeoutError(stallTimeoutMs)` when no bytes arrive
 * within the window. The timer covers a single pending read — callers race
 * each read, so every completed read resets the window and slow-but-flowing
 * streams complete. On stall the reader is cancelled (not awaited: a hung
 * source's cancellation may itself hang) and the timeout is thrown verbatim,
 * never wrapped, so `app.onError` maps it to 502. A non-abort-aware hung
 * stream is still bounded: the race fires even when `cancel` never settles.
 */
export async function readWithStallTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stallTimeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new UpstreamTimeoutError(stallTimeoutMs);
      // Reject first: cancellation may reject the pending read with an
      // AbortError, or finish a partial body. Neither is a successful read.
      reject(error);
      void reader.cancel(error).catch(() => {});
    }, stallTimeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } catch (err) {
    if (timedOut) {
      throw new UpstreamTimeoutError(stallTimeoutMs);
    }
    throw err;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

/**
 * Fixed `Retry-After` (seconds) stamped on the `isUpstreamTimeout` onError
 * backstop 502 only. Value: 5.
 *
 * Rationale: the timed-out request already cost the client its full budget
 * (15s interactive, 60s report), so a short fixed backoff is enough to break
 * tight retry loops during an upstream outage without parking clients for a
 * full throttle window. Fixed — never per-request — so any HTTP client can
 * honor the delay. Among 502 responses, only this hung-upstream backstop
 * carries it: HTML error-page, concurrent-refresh and login-unavailable 502s
 * send no `Retry-After`. Auth-throttle 429s retain their own `Retry-After`;
 * clients must still verify a write's outcome before resubmitting.
 */
export const UPSTREAM_TIMEOUT_RETRY_AFTER_SEC = 5;

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
