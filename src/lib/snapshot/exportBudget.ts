/** D1 Paid per-invocation contract; leave room for other request work. */
export const SNAPSHOT_EXPORT_D1_QUERY_LIMIT = 1000;
export const SNAPSHOT_EXPORT_QUERY_HEADROOM = 50;
export const SNAPSHOT_EXPORT_QUERY_ALLOWANCE =
  SNAPSHOT_EXPORT_D1_QUERY_LIMIT - SNAPSHOT_EXPORT_QUERY_HEADROOM;

function validatePageSize(pageSize: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("Export page size must be a positive safe integer");
  }
}

/** ETag + body, each with a terminal empty-page read (even on exact multiples). */
export function snapshotExportQueryCost(rows: number, pageSize: number): number {
  validatePageSize(pageSize);
  if (!Number.isSafeInteger(rows) || rows < 0) {
    throw new RangeError("Export row count must be a non-negative safe integer");
  }
  return 2 * (Math.ceil(rows / pageSize) + 1);
}

export function snapshotExportFitsBudget(rows: number, pageSize: number): boolean {
  return snapshotExportQueryCost(rows, pageSize) <= SNAPSHOT_EXPORT_QUERY_ALLOWANCE;
}

/** Largest admissible table, reserving one empty read in each pass. */
export function snapshotExportMaxRows(pageSize: number): number {
  validatePageSize(pageSize);
  return (Math.floor(SNAPSHOT_EXPORT_QUERY_ALLOWANCE / 2) - 1) * pageSize;
}
