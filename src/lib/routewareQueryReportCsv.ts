import { forwardToUpstream } from "./upstreamForward";
import { establishSession } from "./establishSession";
import { isLoginPageResponse, isLoginRedirect } from "./loginRedirect";
import { readReportQueryDates } from "./reportQueryDates";
import { readSessionState } from "./sessionState";
import { readUpstreamText } from "./upstreamBody";
import { readReportTimeoutMs, readUpstreamTimeoutMs } from "./upstreamTimeout";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Find a report `requestID` (UUID) in HTML, JSON, or plain text.
 * Prefers explicit `requestID` / `RequestId` JSON keys over arbitrary UUIDs.
 */
export function extractRequestIdFromText(text: string): string | null {
  const keyPref =
    /"requestID"\s*:\s*"([0-9a-f-]{36})"/i.exec(text) ??
    /"RequestId"\s*:\s*"([0-9a-f-]{36})"/i.exec(text) ??
    /"requestId"\s*:\s*"([0-9a-f-]{36})"/i.exec(text) ??
    /requestID=([0-9a-f-]{36})/i.exec(text) ??
    /RequestID=([0-9a-f-]{36})/i.exec(text);
  if (keyPref) {
    const id = keyPref[1];
    return id !== undefined ? id.toLowerCase() : null;
  }
  const m = UUID_RE.exec(text);
  return m ? m[0].toLowerCase() : null;
}

export function parseQueryRequestIsCompleteResponse(text: string): boolean {
  const t = text.trim();
  if (t === "") {
    return false;
  }
  const lower = t.toLowerCase();
  if (lower === "true" || lower === "1") {
    return true;
  }
  if (lower === "false" || lower === "0") {
    return false;
  }
  try {
    const j = JSON.parse(t) as unknown;
    if (j && typeof j === "object" && "d" in j && typeof (j as { d: unknown }).d === "boolean") {
      return (j as { d: boolean }).d;
    }
  } catch {
    // not JSON
  }
  if (t.includes("<!DOCTYPE") || /<html[\s>]/i.test(t)) {
    throw new Error("QueryRequestIsComplete returned HTML (session lost or error page).");
  }
  return false;
}

function reportQueriesReferer(env: Env): string {
  return `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/Reports/Queries`;
}

async function forwardSessionAware(
  env: Env,
  makeReq: () => Request,
  url: URL,
  body: ArrayBuffer | null,
  bodyTimeoutMs: number | null = null
): Promise<Response> {
  // Report budget: full-table CSV downloads get 60s per attempt
  // (vs 15s interactive) — worst case 2x with the single login-redirect retry.
  // Timeouts throw `UpstreamTimeoutError` and are never retried.
  const timeoutMs = readReportTimeoutMs(env);
  const stub = env.AUTH_SESSION.get(env.AUTH_SESSION.idFromName("primary"));
  let session = await readSessionState(stub);
  const run = () => forwardToUpstream(makeReq(), url, session, body, { timeoutMs });
  let resp = await run();
  // Same 200-with-login-form expiry shape as `fetchReportCsvForPath`
  // and `forwardWithSessionRetry` — one re-login + retry.
  // `isLoginPageResponse` never throws/logs the body (PII) and skips
  // JSON/CSV/octet-stream without reading.
  if (resp.status !== 200 || isLoginRedirect(resp) || (await isLoginPageResponse(resp, bodyTimeoutMs))) {
    await establishSession(env, stub, env.LOGIN_URL);
    session = await readSessionState(stub);
    resp = await forwardToUpstream(makeReq(), url, session, body, { timeoutMs });
  }
  return resp;
}

/**
 * Poll budget for `QueryRequestIsComplete`: the WebRW modal polls
 * every 2.5s for its loading indicator, so the Worker polls on the same
 * cadence. 24 attempts ≈ 60s, inside one Worker invocation alongside the
 * 60s-per-attempt download budget. Both knobs are overridable per
 * deploy/tests via `REPORT_QUERY_POLL_INTERVAL_MS` /
 * `REPORT_QUERY_POLL_MAX_ATTEMPTS` (absent/invalid falls back here).
 */
export const QUERY_REQUEST_POLL_INTERVAL_MS = 2_500;
export const QUERY_REQUEST_POLL_MAX_ATTEMPTS = 24;

function readPositivePollValue(value: unknown): number | null {
  const n =
    typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function readQueryPollIntervalMs(env: Env): number {
  return (
    readPositivePollValue(
      (env as unknown as Record<string, unknown>).REPORT_QUERY_POLL_INTERVAL_MS
    ) ?? QUERY_REQUEST_POLL_INTERVAL_MS
  );
}

function readQueryPollMaxAttempts(env: Env): number {
  return (
    readPositivePollValue(
      (env as unknown as Record<string, unknown>).REPORT_QUERY_POLL_MAX_ATTEMPTS
    ) ?? QUERY_REQUEST_POLL_MAX_ATTEMPTS
  );
}

/**
 * Polls `GET .../Reports/QueryRequestIsComplete?requestID=…` until Routeware
 * reports the async query complete. Same `requestID` the download then uses —
 * downloading early returns a truncated CSV, which reconcile (`dataRows > 0`)
 * would treat as the full table and delete the missing tail as stale.
 *
 * Session/login handling matches the download path (single re-login + retry
 * via `forwardSessionAware`). Errors are status-only — the poll body is
 * upstream-controlled.
 */
async function pollQueryRequestIsComplete(env: Env, requestId: string): Promise<void> {
  const intervalMs = readQueryPollIntervalMs(env);
  const maxAttempts = readQueryPollMaxAttempts(env);
  const pollUrl = new URL(
    `${env.TARGET_BASE_PATH}/Reports/QueryRequestIsComplete`,
    env.TARGET_ORIGIN
  );
  pollUrl.searchParams.set("requestID", requestId);
  const pollReq = () =>
    new Request("http://internal/qpoll", {
      method: "GET",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        referer: reportQueriesReferer(env)
      }
    });
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const bodyTimeoutMs = readUpstreamTimeoutMs(env);
    const resp = await forwardSessionAware(env, pollReq, pollUrl, null, bodyTimeoutMs);
    if (
      resp.status !== 200 ||
      isLoginRedirect(resp) ||
      (await isLoginPageResponse(resp, bodyTimeoutMs))
    ) {
      throw new Error(`QueryRequestIsComplete failed: HTTP ${resp.status}`);
    }
    if (parseQueryRequestIsCompleteResponse(await readUpstreamText(resp, bodyTimeoutMs))) {
      return;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`QueryRequestIsComplete timed out after ${maxAttempts} attempts`);
}

/**
 * Fetches a custom report CSV the same way the WebRW modal does:
 * **client** `lastRequestID = crypto.randomUUID()`, poll
 * `GET QueryRequestIsComplete?requestID=…` every 2.5s, then
 * `GET` `QueryExecuteDownload?requestID=…&queryID=…&startDate=…&endDate=…`
 * in a hidden iframe. There is **no** `QueryExecute` POST; the one-time
 * `requestID` is generated in the browser.
 *
 * The poll is load-bearing: downloading before the async query
 * completes returns a truncated CSV with `dataRows > 0`, which reconcile
 * treats as the full table and deletes the missing tail as stale.
 *
 * `REPORT_QUERY_START_DATE` / `REPORT_QUERY_END_DATE` should match what you would
 * use in the modal (for reports with date pickers) or the placeholder `1900-01-01`
 * when the form does not surface dates.
 */
export async function fetchReportCsvByQueryId(env: Env, queryId: string): Promise<Response> {
  const qid = queryId.trim();
  if (!qid) {
    throw new Error("queryId is empty");
  }
  const { startDate, endDate } = readReportQueryDates(env);
  const requestId = crypto.randomUUID();
  await pollQueryRequestIsComplete(env, requestId);

  const downPath = `${env.TARGET_BASE_PATH}/Reports/QueryExecuteDownload`;
  const downUrl = new URL(downPath, env.TARGET_ORIGIN);
  downUrl.searchParams.set("requestID", requestId);
  downUrl.searchParams.set("queryID", qid);
  downUrl.searchParams.set("startDate", startDate);
  downUrl.searchParams.set("endDate", endDate);

  const downReq = () =>
    new Request("http://internal/qdown", {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.8",
        referer: reportQueriesReferer(env),
        "upgrade-insecure-requests": "1"
      }
    });
  const downResp = await forwardSessionAware(env, downReq, downUrl, null);
  // A retry that still sees a login page throws instead of returning HTML as
  // CSV. Body never embedded.
  if (downResp.status !== 200 || isLoginRedirect(downResp) || (await isLoginPageResponse(downResp, null))) {
    // The body is upstream-controlled and may carry customer PII — never embed
    // it in the message: this error reaches the cron log wrapped in `[step]`
    // context.
    throw new Error(`QueryExecuteDownload failed: HTTP ${downResp.status}`);
  }
  if (!downResp.body) {
    throw new Error("QueryExecuteDownload returned an empty body");
  }
  /** Pass through the raw stream; snapshot sync uses `streamCsvLines` and never buffers the full CSV. */
  return new Response(downResp.body, {
    status: 200,
    headers: {
      "content-type": downResp.headers.get("content-type")?.includes("csv")
        ? (downResp.headers.get("content-type") as string)
        : "text/csv; charset=utf-8"
    }
  });
}
