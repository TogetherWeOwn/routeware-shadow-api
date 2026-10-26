import { describe, expect, it } from "vitest";
import {
  CHECK_NAME,
  CURRENT_BATCH,
  CURRENT_ROWS,
  D1_FREE_BUDGET,
  D1_PAID_BUDGET,
  R_PER_STMT,
  batchCallsForRows,
  d1OpsForSync,
  evaluateAll,
  evaluateTable,
  formatReport,
  parseStreamBatch,
  stmtsForRows,
  stmtsPerBatch,
} from "../scripts/lib/syncBatchBudget.mjs";

/**
 * Sync batch-sizing benchmark vs the D1 per-invocation budget.
 *
 * Pure-logic pins for `scripts/lib/syncBatchBudget.mjs` (numbers in, numbers
 * out — no Wrangler, credentials, or network). The headline assertions lock
 * the benchmark finding: at the committed `STREAM_BATCH_*` sizes and the
 * measured row counts, every per-table sync exceeds the 1000-op
 * per-invocation budget under the documented per-call counting model, while
 * the 120/120/400 candidates fit per-table (chained) with margin.
 */

const SOURCE = `
export const STREAM_BATCH_CUST = 80;
export const STREAM_BATCH_ADDR = 80;
export const STREAM_BATCH_CONT = 40;
`;

describe("sync-batch-budget benchmark", () => {
  it("pins the D1 budgets, rows-per-statement, batch sizes, and row counts", () => {
    expect(D1_PAID_BUDGET).toBe(1000);
    expect(D1_FREE_BUDGET).toBe(50);
    // floor(100 binds / ncols): customer 14 cols, address 16, container 29.
    expect(R_PER_STMT).toEqual({ customer: 7, address: 6, container: 3 });
    expect(CURRENT_BATCH).toEqual({ customer: 80, address: 80, container: 40 });
    expect(CURRENT_ROWS).toEqual({ customer: 109894, address: 111620, container: 388735 });
  });

  it("parses the committed STREAM_BATCH_* constants out of streamSync source", () => {
    expect(parseStreamBatch(SOURCE)).toEqual({ customer: 80, address: 80, container: 40 });
  });

  it("throws naming the missing constant so a rename never falls back silently", () => {
    expect(() => parseStreamBatch("export const STREAM_BATCH_CUST = 80;")).toThrow(
      `${CHECK_NAME}: STREAM_BATCH_ADDR not found in streamSync source`,
    );
  });

  it("counts one db.batch() call per chunk, zero rows costing zero calls", () => {
    expect(batchCallsForRows(0, 80)).toBe(0);
    expect(batchCallsForRows(80, 80)).toBe(1);
    expect(batchCallsForRows(81, 80)).toBe(2);
    expect(batchCallsForRows(109894, 80)).toBe(1374);
  });

  it("counts total statements independently of batch size", () => {
    expect(stmtsForRows(0, 7)).toBe(0);
    expect(stmtsForRows(109894, 7)).toBe(15700);
    expect(stmtsForRows(111620, 6)).toBe(18604);
    expect(stmtsForRows(388735, 3)).toBe(129579);
    // Packing density inside one batch call grows with the chunk size.
    expect(stmtsPerBatch(80, 7)).toBe(12);
    expect(stmtsPerBatch(400, 3)).toBe(134);
  });

  it("charges the reconcile DELETE only on non-empty reconciling runs", () => {
    expect(d1OpsForSync(0, 80)).toEqual({ batchCalls: 0, reconcileOps: 0, ops: 0 });
    expect(d1OpsForSync(109894, 80)).toEqual({ batchCalls: 1374, reconcileOps: 1, ops: 1375 });
    expect(d1OpsForSync(109894, 80, { reconcile: false })).toEqual({
      batchCalls: 1374,
      reconcileOps: 0,
      ops: 1374,
    });
  });

  it("finds every committed per-table sync OVER budget at current row counts", () => {
    const customer = evaluateTable({
      name: "customer",
      nRows: CURRENT_ROWS.customer,
      batchSize: CURRENT_BATCH.customer,
      rowsPerStmt: R_PER_STMT.customer,
      budget: D1_PAID_BUDGET,
    });
    expect(customer.ops).toBe(1375);
    expect(customer.fits).toBe(false);
    expect(customer.marginOps).toBe(-375);

    const address = evaluateTable({
      name: "address",
      nRows: CURRENT_ROWS.address,
      batchSize: CURRENT_BATCH.address,
      rowsPerStmt: R_PER_STMT.address,
      budget: D1_PAID_BUDGET,
    });
    expect(address.ops).toBe(1397);
    expect(address.fits).toBe(false);

    const container = evaluateTable({
      name: "container",
      nRows: CURRENT_ROWS.container,
      batchSize: CURRENT_BATCH.container,
      rowsPerStmt: R_PER_STMT.container,
      budget: D1_PAID_BUDGET,
    });
    expect(container.ops).toBe(9720);
    expect(container.fits).toBe(false);
  });

  it("fits each table separately at 120/120/400 but still not pooled in one invocation", () => {
    const outcome = evaluateAll({
      rows: { ...CURRENT_ROWS },
      batchSizes: { customer: 120, address: 120, container: 400 },
      rowsPerStmt: { ...R_PER_STMT },
      budgets: { default: D1_PAID_BUDGET },
    });
    expect(outcome.tables.map((t) => t.ops)).toEqual([917, 932, 973]);
    expect(outcome.tables.every((t) => t.fits)).toBe(true);
    expect(outcome.tables.map((t) => t.marginOps)).toEqual([83, 68, 27]);
    // Chained per-table invocations are required: pooling all three in one
    // invocation still exceeds the budget (2822 > 1000).
    expect(outcome.singleInvocationOps).toBe(2822);
    expect(outcome.singleFits).toBe(false);
  });

  it("formats a report naming the check, the assumption, and each verdict", () => {
    const outcome = evaluateAll({
      rows: { ...CURRENT_ROWS },
      batchSizes: { ...CURRENT_BATCH },
      rowsPerStmt: { ...R_PER_STMT },
      budgets: { default: D1_PAID_BUDGET },
    });
    const lines = formatReport(outcome, D1_PAID_BUDGET);
    expect(lines[0]).toContain(`${CHECK_NAME}: D1 per-invocation budget 1,000 ops`);
    expect(lines.some((l) => l.includes("customer:") && l.includes("OVER by 375"))).toBe(true);
    expect(lines.some((l) => l.includes("single-invocation") && l.includes("OVER by 11,492"))).toBe(
      true,
    );
  });
});
