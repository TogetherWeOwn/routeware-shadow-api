/**
 * Deep readiness probe.
 *
 * `GET /api/v1/health` is an unauthenticated liveness check — it proves the
 * Worker is running and nothing more. This module answers the next question an
 * operator asks after a deploy: is D1 reachable, is the R2 binding present,
 * are the report sources the snapshot sync needs actually configured, and
 * when did the daily cron last run (the advisory `cron` staleness probe,
 * never flips the overall status)?
 *
 * Only booleans and short status strings leave this module — never secret
 * values, never row data (customer PII flows through the snapshot path, so
 * readiness must not echo configuration values that could leak selectors).
 */

import { readCronState } from "./cronSyncState";
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./upstreamTimeout";

export type ReadinessStatus = "ok" | "degraded";

export type D1Check = {
  ok: boolean;
  detail?: string;
  code?: "d1_ping_timeout" | "d1_ping_failed";
  next_action?: "retry_after_cache_ttl";
};
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

export type CronTableState = {
  outcome: "success" | "skipped" | "failed";
  upserted: number | null;
  rowCount: number | null;
  deleted: number | null;
  ranAt: string;
};

/**
 * Cron staleness probe. Reports the last persisted cron run per
 * table (`cron_sync_state`, written by `src/scheduled.ts` after every run):
 * `lastRunAt` is the newest row timestamp, `tables` carries each table's own
 * outcome + timestamp, `stale` is true when no row exists or the newest row
 * is older than the threshold. Only timestamps, outcomes and counts leave
 * here — never row data or error text (no PII by column construction).
 *
 * Advisory only: `ok` mirrors `stale` (false while fresh) but the overall
 * readiness status ignores it — a never-yet-run staging Worker is deployable,
 * and the cron's own `success`/`failed` log line remains the alarm source.
 */
export type CronCheck = {
  ok: boolean;
  stale: boolean;
  lastRunAt: string | null;
  tables: Record<"customer" | "address" | "container", CronTableState | null>;
  detail?: string;
  code?: "cron_state_timeout" | "cron_state_failed";
  next_action?: "retry_after_cache_ttl";
};

export type ReadinessReport = {
  status: ReadinessStatus;
  service: "routeware-shadow-api";
  checks: {
    d1: D1Check;
    r2: R2Check;
    config: ConfigCheck;
    cron: CronCheck;
  };
};

/**
 * A run older than this counts as stale. The cron fires once daily, so 48h
 * tolerates one missed firing (deploy at 07:00 UTC, platform retry wobble)
 * without paging; two consecutive misses page.
 */
export const CRON_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/** Dependency observations can lag by 20s; hits never extend this window. */
export const READINESS_CACHE_TTL_MS = 20_000;

/** Parallel dependency response waits, not cancellation of underlying D1 work. */
export const READINESS_REFRESH_BUDGET_MS = Math.min(
  DEFAULT_UPSTREAM_TIMEOUT_MS, READINESS_CACHE_TTL_MS
);

type Observation<T> = { status: "ok"; value: T } | { status: "timeout" | "failed" };

async function observeDependency<T>(observe: () => Promise<T>): Promise<Observation<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<Observation<T>>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout" }), READINESS_REFRESH_BUDGET_MS);
    });
    // The race observes late rejection too. Neither late result can mutate cache
    // state, and a timeout does not cancel the still-running dependency query.
    return await Promise.race([
      observe().then((value): Observation<T> => ({ status: "ok", value })), timeout
    ]);
  } catch {
    // Do not read, stringify or log dependency exceptions at this boundary.
    return { status: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

type DependencyChecks = Pick<ReadinessReport["checks"], "d1" | "r2" | "cron">;
type CachedDependencies = {
  db: D1Database | undefined;
  bucket: R2Bucket | undefined;
  r2Enabled: boolean;
  startedAt: number;
  pending: boolean;
  checks: Promise<DependencyChecks>;
};

// Best-effort, isolate-local only; weak keys do not retain retired environments.
// Binding-only deploys can reuse isolates, so validate binding identities on hits.
// Source: https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings
const dependencyCache = new WeakMap<Env, CachedDependencies>();

function r2Enabled(env: Env): boolean {
  return String((env as Partial<Env>).SNAPSHOTS_R2_ENABLED ?? "true").toLowerCase() !== "false";
}

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
  // No table access — the ping does not depend on migrations having run.
  const result = await observeDependency(() => db.prepare("SELECT 1 AS ok").first<{ ok: number }>());
  if (result.status === "ok") return { ok: true };
  return {
    ok: false,
    detail: result.status === "timeout" ? "D1 ping timed out." : "D1 ping failed.",
    code: result.status === "timeout" ? "d1_ping_timeout" : "d1_ping_failed",
    next_action: "retry_after_cache_ttl"
  };
}

function checkR2(env: Env): R2Check {
  const partial = env as Partial<Env>;
  const bound = partial.SNAPSHOTS !== undefined && partial.SNAPSHOTS !== null;
  const enabled = r2Enabled(env);
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

async function checkCron(env: Env, nowMs: number = Date.now()): Promise<CronCheck> {
  const empty: CronCheck["tables"] = { customer: null, address: null, container: null };
  const db = (env as Partial<Env>).CUSTOMER_DB;
  const result = await observeDependency(() => readCronState(db));
  if (result.status !== "ok" || result.value === null) {
    const timedOut = result.status === "timeout";
    return {
      ok: false, stale: true, lastRunAt: null, tables: empty,
      detail: timedOut ? "Cron state observation timed out." : "Cron state observation failed.",
      code: timedOut ? "cron_state_timeout" : "cron_state_failed",
      next_action: "retry_after_cache_ttl"
    };
  }
  const rows = result.value;
  if (rows.length === 0) {
    return {
      ok: false,
      stale: true,
      lastRunAt: null,
      tables: empty,
      detail: "No cron run recorded yet (cron_sync_state is empty or unreadable)."
    };
  }
  const tables: CronCheck["tables"] = { ...empty };
  let newest: string | null = null;
  for (const r of rows) {
    tables[r.tableName] = {
      outcome: r.outcome,
      upserted: r.upserted,
      rowCount: r.rowCount,
      deleted: r.deleted,
      ranAt: r.ranAt
    };
    if (newest === null || r.ranAt > newest) {
      newest = r.ranAt;
    }
  }
  const newestMs = newest === null ? NaN : Date.parse(newest);
  const stale =
    newest === null ||
    Number.isNaN(newestMs) ||
    newestMs > nowMs ||
    nowMs - newestMs > CRON_STALE_AFTER_MS;
  if (stale) {
    return {
      ok: false,
      stale: true,
      lastRunAt: newest,
      tables,
      detail:
        "Last cron run is older than 48h (or unreadable) — check the cron trigger and the data-snapshot-sync log line."
    };
  }
  return { ok: true, stale: false, lastRunAt: newest, tables };
}

async function cachedDependencyChecks(env: Env): Promise<DependencyChecks> {
  const { CUSTOMER_DB: db, SNAPSHOTS: bucket } = env as Partial<Env>;
  const enabled = r2Enabled(env);
  const nowMs = Date.now();
  const cached = dependencyCache.get(env);
  if (
    cached &&
    cached.db === db &&
    cached.bucket === bucket &&
    cached.r2Enabled === enabled &&
    (cached.pending ||
      (nowMs >= cached.startedAt &&
        nowMs - cached.startedAt < READINESS_CACHE_TTL_MS))
  ) {
    return cached.checks;
  }

  const r2 = checkR2(env);
  // Cache the pending promise before yielding, so a cold burst shares both D1
  // queries (ping + advisory cron read). Bounded observations settle pending;
  // successes, failures and timeouts all retain the original non-sliding TTL.
  const entry: CachedDependencies = {
    db, bucket, r2Enabled: enabled, startedAt: nowMs, pending: true,
    checks: Promise.all([checkD1(env), checkCron(env, nowMs)])
      .then(([d1, cron]) => ({ d1, r2, cron }))
      .finally(() => { entry.pending = false; })
  };
  dependencyCache.set(env, entry);
  return entry.checks;
}

/**
 * Run every readiness check and fold them into one report.
 * Overall status is `ok` only when D1 answers, R2 is bound (or archiving is
 * explicitly disabled), and all three report sources are configured. The
 * `cron` staleness probe is advisory: it never flips the overall status, so
 * a never-yet-run Worker still deploys.
 */
export async function checkReadiness(env: Env): Promise<{
  report: ReadinessReport;
  httpStatus: 200 | 503;
}> {
  // Never hand mutable cache objects to callers. Config and auth are not cached.
  const { d1, r2, cron } = structuredClone(await cachedDependencyChecks(env));
  const config = checkConfig(env);
  const ok = d1.ok && r2.ok && config.ok;
  return {
    report: {
      status: ok ? "ok" : "degraded",
      service: "routeware-shadow-api",
      checks: { d1, r2, config, cron }
    },
    httpStatus: ok ? 200 : 503
  };
}
