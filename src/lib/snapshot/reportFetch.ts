import { establishSession } from "../establishSession";
import { isLoginPageResponse, isLoginRedirect } from "../loginRedirect";
import { readSessionState } from "../sessionState";
import { forwardToUpstream } from "../upstreamForward";
import { readReportTimeoutMs } from "../upstreamTimeout";

/** Fetch CSV from Routeware using the DO session (same as shadow API). */
export function createReportRequest(env: Env): Request {
  return new Request("http://internal/report", {
    method: "GET",
    headers: {
      accept: "text/csv,*/*;q=0.8",
      referer: `${env.TARGET_ORIGIN}${env.TARGET_BASE_PATH}/`
    }
  });
}

export async function fetchReportCsvForPath(
  env: Env,
  reportPath: string
): Promise<Response> {
  const url = new URL(reportPath, env.TARGET_ORIGIN);
  const stub = env.AUTH_SESSION.get(env.AUTH_SESSION.idFromName("primary"));
  // Report budget (TOG-5835): same 60s-per-attempt as the query-ID path.
  // Timeouts throw `UpstreamTimeoutError` and are never retried.
  const timeoutMs = readReportTimeoutMs(env);
  let session = await readSessionState(stub);
  const req = createReportRequest(env);
  let resp = await forwardToUpstream(req, url, session, null, { timeoutMs });
  // TOG-6540: the common ASP.NET expiry shape is HTTP 200 with a login form,
  // not a 302 — same single re-login + retry as `forwardWithSessionRetry`
  // (TOG-6515). `isLoginPageResponse` never throws/logs the body (PII) and
  // skips JSON/CSV/octet-stream without reading.
  if (resp.status !== 200 || isLoginRedirect(resp) || (await isLoginPageResponse(resp))) {
    await establishSession(env, stub, env.LOGIN_URL);
    session = await readSessionState(stub);
    resp = await forwardToUpstream(req, url, session, null, { timeoutMs });
  }
  // A retry that still sees a login page throws instead of returning HTML as
  // CSV (which `streamSync` would reject as "not valid CSV" or, worse, parse
  // to zero rows). Body never embedded (TOG-5821).
  if (!resp.ok || (await isLoginPageResponse(resp))) {
    throw new Error(`Report fetch failed: ${resp.status} ${resp.statusText}`);
  }
  return resp;
}
