import { forwardToUpstream } from "./upstreamForward";
import { establishSessionWithBrowser } from "./browserAuth";
import { isLoginRedirect } from "./loginRedirect";
import { readSessionState } from "./sessionState";

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
    return keyPref[1].toLowerCase();
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
  body: ArrayBuffer | null
): Promise<Response> {
  const stub = env.AUTH_SESSION.get(env.AUTH_SESSION.idFromName("primary"));
  let session = await readSessionState(stub);
  const run = () => forwardToUpstream(makeReq(), url, session, body);
  let resp = await run();
  if (resp.status !== 200 || isLoginRedirect(resp)) {
    await establishSessionWithBrowser(env, stub, env.LOGIN_URL);
    session = await readSessionState(stub);
    resp = await forwardToUpstream(makeReq(), url, session, body);
  }
  return resp;
}

/**
 * Fetches a custom report CSV the same way the WebRW modal does:
 * **client** `lastRequestID = crypto.randomUUID()`, then
 * `GET` `QueryExecuteDownload?requestID=…&queryID=…&startDate=…&endDate=…`
 * in a hidden iframe. There is **no** `QueryExecute` POST; the one-time
 * `requestID` is generated in the browser.
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
  const startDate = env.REPORT_QUERY_START_DATE?.trim() || "1900-01-01";
  const endDate = env.REPORT_QUERY_END_DATE?.trim() || "1900-01-01";
  const requestId = crypto.randomUUID();

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
  if (downResp.status !== 200 || isLoginRedirect(downResp)) {
    const t = await downResp.text();
    throw new Error(`QueryExecuteDownload failed: ${downResp.status} — ${t.slice(0, 400)}`);
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
