import { archiveReportCsvToR2AfterD1 } from "../r2SnapshotArchive";
import { fetchReportCsvByQueryId } from "../routewareQueryReportCsv";
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
} | null;

export type DataSnapshotResult = {
  customer: SnapshotTableResult;
  address: SnapshotTableResult;
  container: SnapshotTableResult;
};

export async function runCustomerSnapshotSync(
  env: Env
): Promise<SnapshotSyncCounts | null> {
  const path = env.CUSTOMER_REPORT_EXPORT_PATH?.trim();
  const queryId = env.CUSTOMER_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log("CUSTOMER_REPORT_EXPORT_PATH and CUSTOMER_REPORT_QUERY_ID unset; skip customer sync");
    return null;
  }
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  if (!resp.body) {
    throw new Error("Report response has no body");
  }
  return archiveReportCsvToR2AfterD1(env, "customer", resp.body, (s) =>
    syncCustomerSnapshotFromStream(env.CUSTOMER_DB, s, STREAM_BATCH_CUST, {
      reconcile: true
    })
  );
}

export async function runAddressSnapshotSync(
  env: Env
): Promise<SnapshotSyncCounts | null> {
  const path = env.ADDRESS_REPORT_EXPORT_PATH?.trim();
  const queryId = env.ADDRESS_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log("ADDRESS_REPORT_EXPORT_PATH and ADDRESS_REPORT_QUERY_ID unset; skip address sync");
    return null;
  }
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  if (!resp.body) {
    throw new Error("Report response has no body");
  }
  return archiveReportCsvToR2AfterD1(env, "address", resp.body, (s) =>
    syncAddressSnapshotFromStream(env.CUSTOMER_DB, s, STREAM_BATCH_ADDR, {
      reconcile: true
    })
  );
}

export async function runContainerSnapshotSync(
  env: Env
): Promise<SnapshotSyncCounts | null> {
  const path = env.CONTAINER_REPORT_EXPORT_PATH?.trim();
  const queryId = env.CONTAINER_REPORT_QUERY_ID?.trim();
  if (!path && !queryId) {
    console.log(
      "CONTAINER_REPORT_EXPORT_PATH and CONTAINER_REPORT_QUERY_ID unset; skip container sync"
    );
    return null;
  }
  const resp = queryId
    ? await fetchReportCsvByQueryId(env, queryId)
    : await fetchReportCsvForPath(env, path!);
  if (!resp.body) {
    throw new Error("Report response has no body");
  }
  return archiveReportCsvToR2AfterD1(env, "container", resp.body, (s) =>
    syncContainerSnapshotFromStream(env.CUSTOMER_DB, s, STREAM_BATCH_CONT, {
      reconcile: true
    })
  );
}

function rethrowWithSnapshotContext(step: string, err: unknown): never {
  const m = err instanceof Error ? err.message : String(err);
  throw new Error(`[${step}] ${m}`, { cause: err });
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

type PerTableJson = { upserted: number; rowCount: number; skipped?: boolean };

function syncJsonToResult(j: PerTableJson): SnapshotTableResult {
  if (j.skipped) {
    return null;
  }
  return { upserted: j.upserted, rowCount: j.rowCount };
}

/**
 * Runs the three sync routes via **separate** `fetch` subrequests to this
 * Worker's public URL. Each subrequest is a new Worker **invocation**, so D1's
 * per-invocation limit (~1000 operations) is applied per table, not as one pool
 * for the whole combined job.
 */
export async function runDataSnapshotSyncChainedHttp(
  publicBaseUrl: string,
  env: Env
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

  async function post(
    path: string,
    step: string
  ): Promise<PerTableJson> {
    const u = `${base}${path}`;
    const resp = await fetch(u, { method: "POST", headers: h });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `[chained ${step}] POST ${path} → ${resp.status}: ${text.slice(0, 1200)}`
      );
    }
    return JSON.parse(text) as PerTableJson;
  }

  if (plan.runCustomer) {
    out.customer = syncJsonToResult(
      await post("/api/v1/customer-snapshot/sync", "customer")
    );
  } else {
    console.log("No customer path or query ID; not syncing customers");
  }
  if (plan.runAddress) {
    out.address = syncJsonToResult(
      await post("/api/v1/address-snapshot/sync", "address")
    );
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
    out.container = syncJsonToResult(
      await post("/api/v1/container-snapshot/sync", "container")
    );
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
      rethrowWithSnapshotContext("customer snapshot", e);
    }
  } else {
    console.log("No customer path or query ID; not syncing customers");
  }
  if (plan.runAddress) {
    try {
      out.address = await runAddressSnapshotSync(env);
    } catch (e) {
      rethrowWithSnapshotContext("address snapshot", e);
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
      rethrowWithSnapshotContext("container snapshot", e);
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
