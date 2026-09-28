/**
 * Public surface for the D1 snapshot pipeline.
 *
 * The implementation lives in `./snapshot/*`, split by responsibility:
 *
 * - `tableSql`      per-table INSERT/UPSERT SQL and row bindings
 * - `upsert`        batched row upserts and stale-row reconciliation
 * - `reportFetch`   fetching a Routeware report CSV with the stored session
 * - `streamSync`    streaming a CSV body into D1
 * - `orchestration` per-table and combined sync runs, including the chained-HTTP variant
 *
 * This module re-exports that surface unchanged so importers keep a single,
 * stable entry point.
 */

export type { SnapshotSyncCounts, StreamSyncOptions } from "./snapshot/upsert";
export {
  upsertAddressSnapshotRows,
  upsertContainerSnapshotRows,
  upsertCustomerSnapshotRows
} from "./snapshot/upsert";

export { createReportRequest, fetchReportCsvForPath } from "./snapshot/reportFetch";

export {
  syncAddressSnapshotFromCsvText,
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromCsvText,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromCsvText,
  syncCustomerSnapshotFromStream
} from "./snapshot/streamSync";

export type {
  DataSnapshotResult,
  SnapshotTableName,
  SnapshotTableResult
} from "./snapshot/orchestration";
export {
  PartialDataSnapshotSyncError,
  getDataSnapshotPlan,
  runAddressSnapshotSync,
  runContainerSnapshotSync,
  runCustomerSnapshotSync,
  runDataSnapshotSync,
  runDataSnapshotSyncChainedHttp
} from "./snapshot/orchestration";
