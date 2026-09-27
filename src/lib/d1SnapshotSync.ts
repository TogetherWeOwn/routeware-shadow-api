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
  findForeignKeyError,
  isForeignKeyConstraintFailure,
  SnapshotForeignKeyError,
  upsertAddressSnapshotRows,
  upsertContainerSnapshotRows,
  upsertCustomerSnapshotRows
} from "./snapshot/upsert";

export { createReportRequest, fetchReportCsvForPath } from "./snapshot/reportFetch";

export {
  InvalidSnapshotCsvError,
  SNAPSHOT_IMPORT_MAX_BYTES,
  STREAM_BATCH_ADDR,
  STREAM_BATCH_CONT,
  STREAM_BATCH_CUST,
  SnapshotTooLargeError,
  isSnapshotTooLarge,
  syncAddressSnapshotFromCsvText,
  syncAddressSnapshotFromStream,
  syncContainerSnapshotFromCsvText,
  syncContainerSnapshotFromStream,
  syncCustomerSnapshotFromCsvText,
  syncCustomerSnapshotFromStream
} from "./snapshot/streamSync";

export type {
  SnapshotOrphanReport,
  SnapshotOrphanSample
} from "./snapshot/reconcile";
export {
  ORPHAN_SAMPLE_LIMIT_DEFAULT,
  ORPHAN_SAMPLE_LIMIT_MAX,
  getSnapshotOrphans
} from "./snapshot/reconcile";

export type { DataSnapshotResult, SnapshotTableResult } from "./snapshot/orchestration";
export {
  getDataSnapshotPlan,
  runAddressSnapshotSync,
  runContainerSnapshotSync,
  runCustomerSnapshotSync,
  runDataSnapshotSync,
  runDataSnapshotSyncChainedHttp
} from "./snapshot/orchestration";
