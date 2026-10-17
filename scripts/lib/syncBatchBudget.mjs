/**
 * Pure helpers for the sync batch-sizing benchmark.
 *
 * Question: do the `STREAM_BATCH_*` chunk sizes in
 * `src/lib/snapshot/streamSync.ts` fit Cloudflare D1's per-invocation query
 * budget at current row counts?
 *
 * Counting model (documented assumption, see CUSTOMER_SNAPSHOT.md): one
 * `db.batch(stmts)` call costs **1** D1 operation against the per-invocation
 * budget (~1000 on Workers Paid, 50 on Free — see
 * https://developers.cloudflare.com/d1/platform/limits/), and the reconcile
 * `DELETE` costs 1 more when the run is non-empty (the skip-on-empty guard in
 * `streamSync.ts` means an empty export issues zero D1 calls). Per-statement
 * caps (100 bound parameters, 100 KB statement length) apply *inside* each
 * batch call and are pinned separately by `test/snapshotUpsert.test.ts` — this
 * module only counts calls per invocation.
 *
 * Under the alternative reading (every statement inside a batch counts
 * against the per-invocation budget), no batch size fits at current counts —
 * total statements are ~15.7k customer / ~18.6k address / ~129.6k container
 * (see `stmtsForRows`), so multi-pass per-table syncs would be required
 * regardless of chunk size. This check reports both numbers so the reviewer
 * can see which regime the code is in.
 *
 * Everything here is pure (numbers in, numbers out) so it is unit-testable
 * without Wrangler, credentials, or network access. The impure wrapper lives
 * in `scripts/check-sync-batch-budget.mjs`, which parses the live
 * `STREAM_BATCH_*` constants out of the source so the report always measures
 * the code as committed.
 */

export const CHECK_NAME = "sync-batch-budget";

/** D1 queries per Worker invocation (see D1 platform limits). */
export const D1_PAID_BUDGET = 1000;
export const D1_FREE_BUDGET = 50;

/**
 * Rows packed per multi-row INSERT, mirroring `src/lib/snapshot/tableSql.ts`
 * (`CUST_R_PER_STMT` / `ADDR_R_PER_STMT` / `CONT_R_PER_STMT`). The CLI
 * measures the committed source; these defaults let the report run without
 * flags and are asserted against the doc's headline numbers in tests.
 */
export const R_PER_STMT = { customer: 7, address: 6, container: 3 };

/** Current `STREAM_BATCH_*` in `src/lib/snapshot/streamSync.ts`. */
export const CURRENT_BATCH = { customer: 80, address: 80, container: 40 };

/**
 * Live row counts, measured read-only on 2026-09-27 (no PII — `COUNT(*)` only):
 *   npx wrangler d1 execute routeware-customer-snapshot --remote --json \
 *     --command "SELECT COUNT(*) AS n FROM customer_snapshot"   → 109894
 *   ... FROM address_snapshot   → 111620
 *   ... FROM container_snapshot → 388735
 * Total 610249 ≈ the ~609k documented in `docs/HANDOVER.md` fact 2. The
 * illustrative counts in `docs/CRON-SYNC-ALARM-RUNBOOK.md` §0 (203411/198002)
 * are synthetic examples, not measurements — do not use them here. Pass
 * `--customer-rows=` etc. with fresh `SELECT COUNT(*)` values when they exist.
 */
export const CURRENT_ROWS = { customer: 109894, address: 111620, container: 388735 };

export function ceilDiv(a, b) {
  if (!Number.isInteger(a) || a < 0) throw new Error(`${CHECK_NAME}: rows must be a non-negative integer (got ${a})`);
  if (!Number.isInteger(b) || b <= 0) throw new Error(`${CHECK_NAME}: divisor must be a positive integer (got ${b})`);
  return Math.ceil(a / b);
}

/**
 * Parse `export const STREAM_BATCH_CUST/ADDR/CONT = <n>` out of the committed
 * `streamSync.ts` source. Throws when any constant is absent — a rename must
 * update this parser, never silently fall back to stale defaults.
 */
export function parseStreamBatch(sourceText) {
  const found = {};
  for (const [key, name] of [["customer", "CUST"], ["address", "ADDR"], ["container", "CONT"]]) {
    const match = String(sourceText).match(new RegExp(`STREAM_BATCH_${name}\\s*=\\s*(\\d+)`));
    if (!match) throw new Error(`${CHECK_NAME}: STREAM_BATCH_${name} not found in streamSync source`);
    found[key] = Number(match[1]);
  }
  return found;
}

/** `db.batch()` calls for N rows at batchSize rows per chunk (0 rows → 0 calls). */
export function batchCallsForRows(nRows, batchSize) {
  if (nRows === 0) return 0;
  return ceilDiv(nRows, batchSize);
}

/** Total multi-row INSERT statements for N rows (independent of batchSize). */
export function stmtsForRows(nRows, rowsPerStmt) {
  if (nRows === 0) return 0;
  return ceilDiv(nRows, rowsPerStmt);
}

/** Statements packed into one `db.batch()` call at this chunk size. */
export function stmtsPerBatch(batchSize, rowsPerStmt) {
  return ceilDiv(batchSize, rowsPerStmt);
}

/**
 * D1 operations charged to one per-table sync invocation: one per batch call
 * plus the reconcile DELETE when the run is non-empty and reconciling.
 */
export function d1OpsForSync(nRows, batchSize, { reconcile = true } = {}) {
  const calls = batchCallsForRows(nRows, batchSize);
  const del = reconcile && nRows > 0 ? 1 : 0;
  return { batchCalls: calls, reconcileOps: del, ops: calls + del };
}

export function evaluateTable({ name, nRows, batchSize, rowsPerStmt, budget, reconcile = true }) {
  const { batchCalls, reconcileOps, ops } = d1OpsForSync(nRows, batchSize, { reconcile });
  return {
    name,
    nRows,
    batchSize,
    rowsPerStmt,
    stmtsTotal: stmtsForRows(nRows, rowsPerStmt),
    stmtsPerBatch: stmtsPerBatch(batchSize, rowsPerStmt),
    batchCalls,
    reconcileOps,
    ops,
    budget,
    marginOps: budget - ops,
    fits: ops <= budget,
  };
}

export function evaluateAll({ rows, batchSizes, budgets, rowsPerStmt = R_PER_STMT, reconcile = true }) {
  const tables = ["customer", "address", "container"].map((name) =>
    evaluateTable({
      name,
      nRows: rows[name],
      batchSize: batchSizes[name],
      rowsPerStmt: rowsPerStmt[name],
      budget: budgets[name] ?? budgets.default,
      reconcile,
    }),
  );
  const singleInvocationOps = tables.reduce((n, t) => n + t.ops, 0);
  return { tables, singleInvocationOps, singleFits: singleInvocationOps <= budgets.default };
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

export function formatReport({ tables, singleInvocationOps, singleFits }, budget) {
  const lines = [];
  lines.push(`${CHECK_NAME}: D1 per-invocation budget ${fmt(budget)} ops (Workers Paid; Free allows ${D1_FREE_BUDGET})`);
  lines.push(`assumption: 1 db.batch() call = 1 op + 1 reconcile DELETE per non-empty sync (see CUSTOMER_SNAPSHOT.md)`);
  for (const t of tables) {
    const verdict = t.fits ? "FIT" : `OVER by ${fmt(-t.marginOps)}`;
    lines.push(
      `${t.name}: rows=${fmt(t.nRows)} batch=${t.batchSize} rows/stmt=${t.rowsPerStmt} ` +
        `batch-calls=${fmt(t.batchCalls)} +reconcile=${t.reconcileOps} ops=${fmt(t.ops)} ` +
        `stmts-total=${fmt(t.stmtsTotal)} stmts/batch=${t.stmtsPerBatch} margin=${fmt(t.marginOps)} → ${verdict}`,
    );
  }
  lines.push(
    `single-invocation (all three pooled): ops=${fmt(singleInvocationOps)} → ${singleFits ? "FIT" : `OVER by ${fmt(singleInvocationOps - budget)}`}`,
  );
  return lines;
}
