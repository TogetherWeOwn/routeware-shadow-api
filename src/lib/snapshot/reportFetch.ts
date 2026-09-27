import { establishSession } from "../establishSession";
import { isLoginRedirect } from "../loginRedirect";
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
  if (resp.status !== 200 || isLoginRedirect(resp)) {
    await establishSession(env, stub, env.LOGIN_URL);
    session = await readSessionState(stub);
    resp = await forwardToUpstream(req, url, session, null, { timeoutMs });
  }
  if (!resp.ok) {
    throw new Error(`Report fetch failed: ${resp.status} ${resp.statusText}`);
  }
  return resp;
}
