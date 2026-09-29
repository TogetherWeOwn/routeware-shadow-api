import {
  archiveReportCsvToR2AfterD1,
  isR2ArchiveDetail,
  type R2ArchiveDetail,
  type SnapshotArchiveTable
} from "../r2SnapshotArchive";
import { fetchReportCsvByQueryId } from "../routewareQueryReportCsv";
import {
  fetchWithUpstreamTimeout,
  isUpstreamTimeout,
  readChainedSyncTimeoutMs
} from "../upstreamTimeout";
import { fetchReportCsvForPath } from "./reportFetch";
import type { SnapshotSyncCounts } from "./upsert";
import {
  STREAM_BATCH_ADDR,
  STREAM_BATCH_CONT,
  STREAM_BATCH_CUST,
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromStream
} from "./streamSync";

export type SnapshotTableResult = {
  upserted: number;
  rowCount: number;
  /**
   * Rows the reconcile step deleted (upstream deletions). Present when the
   * table ran a reconciling sync; the single-invocation path always carries
   * it, and the chained path carries it once the per-table sync reported it.
   */
  deleted?: number;
  /** R2 archive outcome for this table's CSV leg (TOG-6549). */
  r2?: R2ArchiveDetail;
} | null;

export type DataSnapshotResult = {
  customer: SnapshotTableResult;
  address: SnapshotTableResult;
  container: SnapshotTableResult;
};

/**
 * Runs one table's D1→R2 legs and stamps the R2 outcome flat onto the D1
 * counts (TOG-6549), following the house precedent that extra count fields
 * (e.g. `deleted`) travel by spread. The per-table route serializes the
 * counts as-is, so the chained path and the cron line see the R2 status each
 * table observed. `r2` is always set: the helper fires `onArchive` on every
 * path (disabled/stored/failed), so a missing callback can only mean an older
 * caller — default to a `failed` marker rather than inventing success.
 */
function syncTableWithR2(
  env: Env,
  table: SnapshotArchiveTable,
  body: ReadableStream<Uint8Array>,
  sync: (stream: ReadableStream<Uint8Array>) => Promise<SnapshotSyncCounts>
): Promise<SnapshotSyncCounts & { r2: R2ArchiveDetail }> {
  let archive: R2ArchiveDetail | null = null;
  return archiveReportCsvToR2AfterD1(env, table, body, sync, (d) => {
    archive = d;
  }).then((counts) => ({
    ...counts,
    r2: archive ?? { status: "failed", reason: "R2 outcome unreported" }
  }));
}

/**
 * Dry-run switch for the per-table sync runners (TOG-9203): parse and count
 * the report CSV as usual, but write nothing — no D1 upserts, no reconcile
 * deletes, and no R2 archive. The second positional is optional so existing
 * callers (cron, tests) keep compiling unchanged.
 */
export type SnapshotSyncRunOptions = {
  dryRun?: boolean;
};

export async function runCustomerSnapshotSync(
  env: Env,
  opts: SnapshotSyncRunOptions = {}
): Promise<SnapshotSyncCounts | null> {
  const path = env.CUSTOMER_REPORT_EXPORT_PATH?.trim();
  const queryId = env.CUSTOMER_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log("CUSTOMER_REPORT_EXPORT_PATH and CUSTOMER_REPORT_QUERY_ID unset; skip customer sync");
    return null;
  }
  // A POST may refresh D1 while the upstream export is still being generated.
  const syncedAt = new Date().toISOString();
  const dryRun = opts.dryRun === true;
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  if (!resp.body) {
    throw new Error("Report response has no body");
  }
  if (dryRun) {
    console.log("Customer snapshot dry run: validating without writing D1 or R2");
    return syncCustomerSnapshotFromStream(env.CUSTOMER_DB, resp.body, STREAM_BATCH_CUST, {
      reconcile: true,
      syncedAt,
      dryRun
    });
  }
  return syncTableWithR2(env, "customer", resp.body, (s) =>
    syncCustomerSnapshotFromStream(env.CUSTOMER_DB, s, STREAM_BATCH_CUST, {
      reconcile: true,
      syncedAt,
      dryRun
    })
  );
}

export async function runAddressSnapshotSync(
  env: Env,
  opts: SnapshotSyncRunOptions = {}
): Promise<SnapshotSyncCounts | null> {
  const path = env.ADDRESS_REPORT_EXPORT_PATH?.trim();
  const queryId = env.ADDRESS_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log("ADDRESS_REPORT_EXPORT_PATH and ADDRESS_REPORT_QUERY_ID unset; skip address sync");
    return null;
  }
  // A POST may refresh D1 while the upstream export is still being generated.
  const syncedAt = new Date().toISOString();
  const dryRun = opts.dryRun === true;
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  if (!resp.body) {
    throw new Error("Report response has no body");
  }
  if (dryRun) {
    console.log("Address snapshot dry run: validating without writing D1 or R2");
    return syncAddressSnapshotFromStream(env.CUSTOMER_DB, resp.body, STREAM_BATCH_ADDR, {
      reconcile: true,
      syncedAt,
      dryRun
    });
  }
  return syncTableWithR2(env, "address", resp.body, (s) =>
    syncAddressSnapshotFromStream(env.CUSTOMER_DB, s, STREAM_BATCH_ADDR, {
      reconcile: true,
      syncedAt,
      dryRun
    })
  );
}

export async function runContainerSnapshotSync(
  env: Env,
  opts: SnapshotSyncRunOptions = {}
): Promise<SnapshotSyncCounts | null> {
  const path = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
  const queryId = env.CONTAINER_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log(
      "CONTAINER_REPORT_EXPORT_PATH and CONTAINER_REPORT_QUERY_ID unset; skip container sync"
    );
    return null;
  }
  // A POST may refresh D1 while the upstream export is still being generated.
  const syncedAt = new Date().toISOString();
  const dryRun = opts.dryRun === true;
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  if (!resp.body) {
    throw new Error("Report response has no body");
  }
  if (dryRun) {
    console.log("Container snapshot dry run: validating without writing D1 or R2");
    return syncContainerSnapshotFromStream(env.CUSTOMER_DB, resp.body, STREAM_BATCH_CONT, {
      reconcile: true,
      syncedAt,
      dryRun
    });
  }
  return syncTableWithR2(env, "container", resp.body, (s) =>
    syncContainerSnapshotFromStream(env.CUSTOMER_DB, s, STREAM_BATCH_CONT, {
      reconcile: true,
      syncedAt,
      dryRun
    })
  );
}

export type SnapshotTableName = "customer" | "address" | "container";

function rethrowWithSnapshotContext(
  step: string,
  failedTable: SnapshotTableName,
  err: unknown,
  partial: DataSnapshotResult
): never {
  const m = err instanceof Error ? err.message : String(err);
  // A chained subrequest already carries its `[chained <table>]` tag from
  // `post()` — re-prefixing would double it.
  const message = m.startsWith(`[${step}]`) ? m : `[${step}] ${m}`;
  throw new PartialDataSnapshotSyncError(step, failedTable, message, {
    ...partial
  }, { cause: err });
}

/**
 * Thrown when a table sync fails after earlier tables may have completed
 * (TOG-6546). Carries the per-table results collected so far so the cron log
 * can report partial progress instead of all-null: tables that succeeded keep
 * their counts, the failed table is named by `failedTable`, and tables never
 * attempted stay null.
 *
 * The message keeps the established `[step]` prefix and `cause` so existing
 * triage (runbook §4, `test/snapshotOrchestration.test.ts`) is unchanged.
 * Only counts travel here — never row data (CONVENTIONS.md fact 2).
 */
export class PartialDataSnapshotSyncError extends Error {
  readonly step: string;
  readonly failedTable: SnapshotTableName;
  readonly partial: DataSnapshotResult;

  constructor(
    step: string,
    failedTable: SnapshotTableName,
    message: string,
    partial: DataSnapshotResult,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PartialDataSnapshotSyncError";
    this.step = step;
    this.failedTable = failedTable;
    this.partial = partial;
  }
}

/**
 * Which snapshot steps should run, mirroring the guards in
 * `runDataSnapshotSync` (address only if customer is configured, etc.).
 */
export function getDataSnapshotPlan(env: Env): {
  runCustomer: boolean;
  runAddress: boolean;
  runContainer: boolean;
} {
  const cPath = env.CUSTOMER_REPORT_EXPORT_PATH?.trim();
  const cQ = env.CUSTOMER_REPORT_QUERY_ID?.trim();
  const aPath = env.ADDRESS_REPORT_EXPORT_PATH?.trim();
  const aQ = env.ADDRESS_REPORT_QUERY_ID?.trim();
  const tPath = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
  const tQ = env.CONTAINER_REPORT_QUERY_ID?.trim();
  const hasC = Boolean(cPath || cQ);
  const hasA = Boolean(aPath || aQ);
  const hasT = Boolean(tPath || tQ);
  return {
    runCustomer: hasC,
    runAddress: hasA && hasC,
    runContainer: hasT && hasC && hasA
  };
}

type PerTableJson = {
  upserted: number;
  rowCount: number;
  deleted?: number;
  skipped?: boolean;
  /** R2 outcome stamped by the per-table sync route (TOG-6549); validated, never trusted blind. */
  r2?: unknown;
};

/**
 * Carry the per-table sync counts through, including `deleted` when the
 * subrequest reported it (TOG-7391). The chained runner previously rebuilt
 * `{upserted, rowCount}` here, so the cron line showed `deleted` only on the
 * single-invocation path. The combined `POST /api/v1/data-snapshot/sync`
 * route strips `deleted` back out (its `{upserted, rowCount}` shape is
 * pinned by `test/syncSummaryContract.test.ts`), so this never leaks there.
 */
function syncJsonToResult(j: PerTableJson): SnapshotTableResult {
  if (j.skipped) {
    return null;
  }
  const base =
    j.deleted === undefined
      ? { upserted: j.upserted, rowCount: j.rowCount }
      : { upserted: j.upserted, rowCount: j.rowCount, deleted: j.deleted };
  // Extra count fields are dropped on the chained path by precedent (TOG-7378
  // pins the explicit pick: subrequest JSON crosses a trust boundary, so row
  // data must not ride it into the cron line); the R2 outcome is the
  // exception — without it a failed archive hides behind a D1
  // `outcome:success`. Guarded: only a well-formed detail travels (status
  // discriminant only; `reason`/`key` are log strings, never row data).
  return isR2ArchiveDetail(j.r2)
    ? { ...base, r2: j.r2 }
    : base;
}

/**
 * Runs the three sync routes via **separate** `fetch` subrequests to this
 * Worker's public URL. Each subrequest is a new Worker **invocation**, so D1's
 * per-invocation limit (~1000 operations) is applied per table, not as one pool
 * for the whole combined job.
 */
export async function runDataSnapshotSyncChainedHttp(
  publicBaseUrl: string,
  env: Env,
  opts: SnapshotSyncRunOptions = {}
): Promise<DataSnapshotResult> {
  const bearer = env.CUSTOMER_SNAPSHOT_SYNC_SECRET?.trim();
  if (!bearer) {
    throw new Error("CUSTOMER_SNAPSHOT_SYNC_SECRET is not set");
  }
  const base = publicBaseUrl.replace(/\/$/, "");
  const h = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json"
  } as const;
  const plan = getDataSnapshotPlan(env);
  const out: DataSnapshotResult = {
    customer: null,
    address: null,
    container: null
  };
  // Bounded per-table budget (TOG-6547): a hung subrequest threw nothing
  // before, holding the cron invocation to the platform timeout and starving
  // the tables behind it. The timer covers time-to-headers (the `fetch`
  // promise) — the per-table route sends no headers until its report
  // download + D1 import + R2 archive finish — and the small JSON body that
  // follows needs no separate bound. A non-abort-aware stubbed hang is still
  // bounded: the helper races the timer, not just the abort.
  const timeoutMs = readChainedSyncTimeoutMs(env);

  // TOG-9203: a combined dry run must dry-run every table — a real write
  // hiding behind one subrequest would defeat the no-write guarantee.
  const drySuffix = opts.dryRun === true ? "?dryRun=true" : "";
  async function post(
    path: string,
    step: string
  ): Promise<PerTableJson> {
    const u = `${base}${path}${drySuffix}`;
    let resp: Response;
    try {
      resp = await fetchWithUpstreamTimeout(u, { method: "POST", headers: h }, timeoutMs);
    } catch (e) {
      if (isUpstreamTimeout(e)) {
        throw new Error(
          `[chained ${step}] POST ${path} timed out after ${e.timeoutMs}ms`
        );
      }
      throw e;
    }
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `[chained ${step}] POST ${path} → ${resp.status}: ${text.slice(0, 1200)}`
      );
    }
    return JSON.parse(text) as PerTableJson;
  }

  if (plan.runCustomer) {
    try {
      out.customer = syncJsonToResult(
        await post("/api/v1/customer-snapshot/sync", "customer")
      );
    } catch (e) {
      rethrowWithSnapshotContext("chained customer", "customer", e, out);
    }
  } else {
    console.log("No customer path or query ID; not syncing customers");
  }
  if (plan.runAddress) {
    try {
      out.address = syncJsonToResult(
        await post("/api/v1/address-snapshot/sync", "address")
      );
    } catch (e) {
      rethrowWithSnapshotContext("chained address", "address", e, out);
    }
  } else {
    if (env.ADDRESS_REPORT_EXPORT_PATH?.trim() || env.ADDRESS_REPORT_QUERY_ID?.trim()) {
      console.log(
        "Address is configured but customer is not — skip address (FK to customer). Set customer first."
      );
    } else {
      console.log("No address path or query ID; not syncing addresses");
    }
  }
  if (plan.runContainer) {
    try {
      out.container = syncJsonToResult(
        await post("/api/v1/container-snapshot/sync", "container")
      );
    } catch (e) {
      rethrowWithSnapshotContext("chained container", "container", e, out);
    }
  } else {
    const tP = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
    const tQ = env.CONTAINER_REPORT_QUERY_ID?.trim();
    if (tP || tQ) {
      console.log(
        "Container is configured but customer and/or address is not — skip container (FKs). Set all three."
      );
    } else {
      console.log("No container path or query ID; not syncing containers");
    }
  }
  return out;
}

/**
 * Runs each configured export in one Worker **invocation** (sequential in-process).
 * Large imports can hit D1’s per-invocation query cap; use
 * {@link runDataSnapshotSyncChainedHttp} for `POST /data-snapshot/sync` instead.
 */
export async function runDataSnapshotSync(env: Env): Promise<DataSnapshotResult> {
  const plan = getDataSnapshotPlan(env);
  const out: DataSnapshotResult = {
    customer: null,
    address: null,
    container: null
  };
  if (plan.runCustomer) {
    try {
      out.customer = await runCustomerSnapshotSync(env);
    } catch (e) {
      rethrowWithSnapshotContext("customer snapshot", "customer", e, out);
    }
  } else {
    console.log("No customer path or query ID; not syncing customers");
  }
  if (plan.runAddress) {
    try {
      out.address = await runAddressSnapshotSync(env);
    } catch (e) {
      rethrowWithSnapshotContext("address snapshot", "address", e, out);
    }
  } else {
    if (env.ADDRESS_REPORT_EXPORT_PATH?.trim() || env.ADDRESS_REPORT_QUERY_ID?.trim()) {
      console.log(
        "Address is configured but customer is not — skip address (FK to customer). Set customer first."
      );
    } else {
      console.log("No address path or query ID; not syncing addresses");
    }
  }
  if (plan.runContainer) {
    try {
      out.container = await runContainerSnapshotSync(env);
    } catch (e) {
      rethrowWithSnapshotContext("container snapshot", "container", e, out);
    }
  } else {
    const tP = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
    const tQ = env.CONTAINER_REPORT_QUERY_ID?.trim();
    if (tP || tQ) {
      console.log(
        "Container is configured but customer and/or address is not — skip container (FKs). Set all three."
      );
    } else {
      console.log("No container path or query ID; not syncing containers");
    }
  }
  return out;
}
