/**
 * Deep readiness probe (TOG-5816).
 *
 * `GET /api/v1/health` is an unauthenticated liveness check — it proves the
 * Worker is running and nothing more. This module answers the next question an
 * operator asks after a deploy: is D1 reachable, is the R2 binding present,
 * and are the report sources the snapshot sync needs actually configured?
 *
 * Only booleans and short status strings leave this module — never secret
 * values, never row data (customer PII flows through the snapshot path, so
 * readiness must not echo configuration values that could leak selectors).
 */

export type ReadinessStatus = "ok" | "degraded";

export type D1Check = { ok: boolean; detail?: string };
export type R2Check = {
  ok: boolean;
  bound: boolean;
  enabled: boolean;
  detail?: string;
};
export type ConfigCheck = {
  ok: boolean;
  customer: boolean;
  address: boolean;
  container: boolean;
  detail?: string;
};

export type ReadinessReport = {
  status: ReadinessStatus;
  service: "routeware-shadow-api";
  checks: {
    d1: D1Check;
    r2: R2Check;
    config: ConfigCheck;
  };
};

function reportSourceConfigured(
  env: Env,
  pathKey:
    | "CUSTOMER_REPORT_EXPORT_PATH"
    | "ADDRESS_REPORT_EXPORT_PATH"
    | "CONTAINER_REPORT_EXPORT_PATH",
  queryKey:
    | "CUSTOMER_REPORT_QUERY_ID"
    | "ADDRESS_REPORT_QUERY_ID"
    | "CONTAINER_REPORT_QUERY_ID"
): boolean {
  return Boolean(env[pathKey]?.trim() || env[queryKey]?.trim());
}

async function checkD1(env: Env): Promise<D1Check> {
  const db = (env as Partial<Env>).CUSTOMER_DB;
  if (!db) {
    return { ok: false, detail: "CUSTOMER_DB binding missing" };
  }
  try {
    // No table access — `SELECT 1` proves the binding resolves and D1 answers,
    // without depending on migrations having run.
    await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `D1 ping failed: ${message.slice(0, 200)}` };
  }
}

function checkR2(env: Env): R2Check {
  const partial = env as Partial<Env>;
  const bound = partial.SNAPSHOTS !== undefined && partial.SNAPSHOTS !== null;
  const enabled =
    String(partial.SNAPSHOTS_R2_ENABLED ?? "true").toLowerCase() !== "false";
  if (!enabled) {
    // Archiving is deliberately off — the binding is not needed.
    return {
      ok: true,
      bound,
      enabled,
      detail: "R2 archiving disabled (SNAPSHOTS_R2_ENABLED=false)"
    };
  }
  if (!bound) {
    return {
      ok: false,
      bound,
      enabled,
      detail: "SNAPSHOTS binding missing"
    };
  }
  return { ok: true, bound, enabled };
}

function checkConfig(env: Env): ConfigCheck {
  const customer = reportSourceConfigured(
    env,
    "CUSTOMER_REPORT_EXPORT_PATH",
    "CUSTOMER_REPORT_QUERY_ID"
  );
  const address = reportSourceConfigured(
    env,
    "ADDRESS_REPORT_EXPORT_PATH",
    "ADDRESS_REPORT_QUERY_ID"
  );
  const container = reportSourceConfigured(
    env,
    "CONTAINER_REPORT_EXPORT_PATH",
    "CONTAINER_REPORT_QUERY_ID"
  );
  const ok = customer && address && container;
  if (ok) {
    return { ok, customer, address, container };
  }
  const missing = [
    customer ? null : "customer",
    address ? null : "address",
    container ? null : "container"
  ].filter((s): s is string => s !== null);
  return {
    ok,
    customer,
    address,
    container,
    detail: `No report source for: ${missing.join(", ")}. Set *_REPORT_EXPORT_PATH or *_REPORT_QUERY_ID (see CUSTOMER_SNAPSHOT.md).`
  };
}

/**
 * Run every readiness check and fold them into one report.
 * Overall status is `ok` only when D1 answers, R2 is bound (or archiving is
 * explicitly disabled), and all three report sources are configured.
 */
export async function checkReadiness(env: Env): Promise<{
  report: ReadinessReport;
  httpStatus: 200 | 503;
}> {
  const d1 = await checkD1(env);
  const r2 = checkR2(env);
  const config = checkConfig(env);
  const ok = d1.ok && r2.ok && config.ok;
  return {
    report: {
      status: ok ? "ok" : "degraded",
      service: "routeware-shadow-api",
      checks: { d1, r2, config }
    },
    httpStatus: ok ? 200 : 503
  };
}
