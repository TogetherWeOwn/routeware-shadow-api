#!/usr/bin/env node
/**
 * Sync batch-sizing benchmark vs the D1 per-invocation budget (TOG-6293).
 *
 * Measures the committed `STREAM_BATCH_*` chunk sizes in
 * `src/lib/snapshot/streamSync.ts` against D1's per-invocation query budget
 * at current row counts, under the documented counting model (1 db.batch()
 * call = 1 op + 1 reconcile DELETE per non-empty sync). Prints the per-table
 * ops, margin, and FIT/OVER verdict, plus the single-invocation pooled total.
 *
 * Usage:
 *   node scripts/check-sync-batch-budget.mjs [--customer-rows=N] [--address-rows=N]
 *     [--container-rows=N] [--budget=N] [--batch-customer=N] [--batch-address=N]
 *     [--batch-container=N] [--rows-per-stmt=cust,addr,cont] [--no-reconcile]
 *
 * Row counts default to the measured `SELECT COUNT(*)` values in
 * `scripts/lib/syncBatchBudget.mjs` (`CURRENT_ROWS`, read-only on
 * 2026-09-27 — no PII, counts only). Pass live counts with the --*-rows
 * flags when they exist; the illustrative counts in
 * `docs/CRON-SYNC-ALARM-RUNBOOK.md` §0 are synthetic examples, not
 * measurements — do not use them here. `--batch-*` overrides measure a candidate
 * size without editing the source. Exit 0 always on a successful measurement —
 * an OVER verdict is a finding to act on, not a gate failure — exit 2 on
 * unparseable inputs only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

import {
  CHECK_NAME,
  CURRENT_BATCH,
  CURRENT_ROWS,
  D1_PAID_BUDGET,
  R_PER_STMT,
  evaluateAll,
  formatReport,
  parseStreamBatch,
} from "./lib/syncBatchBudget.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function flagInt(name, fallback) {
  const raw = flagValue(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${CHECK_NAME}: --${name} must be a non-negative integer (got ${raw})`);
    exit(2);
  }
  return n;
}

function usage() {
  return [
    `Usage: node scripts/check-sync-batch-budget.mjs [flags]`,
    ``,
    `  --customer-rows=N --address-rows=N --container-rows=N  row counts (default: measured COUNT(*) in lib/syncBatchBudget.mjs)`,
    `  --budget=N            D1 per-invocation budget (default ${D1_PAID_BUDGET}, Workers Paid)`,
    `  --batch-customer=N --batch-address=N --batch-container=N  candidate chunk sizes (default: committed STREAM_BATCH_*)`,
    `  --rows-per-stmt=c,a,t rows per multi-row INSERT, e.g. 7,6,3 (default from tableSql.ts)`,
    `  --no-reconcile        omit the reconcile DELETE op`,
  ].join("\n");
}

for (const arg of argv.slice(2)) {
  if (arg === "--help" || arg === "-h") {
    console.log(usage());
    exit(0);
  }
  if (
    !arg.startsWith("--customer-rows=") &&
    !arg.startsWith("--address-rows=") &&
    !arg.startsWith("--container-rows=") &&
    !arg.startsWith("--budget=") &&
    !arg.startsWith("--batch-customer=") &&
    !arg.startsWith("--batch-address=") &&
    !arg.startsWith("--batch-container=") &&
    !arg.startsWith("--rows-per-stmt=") &&
    arg !== "--no-reconcile"
  ) {
    console.error(`Unknown flag: ${arg}\n\n${usage()}`);
    exit(2);
  }
}

let sourceText;
try {
  sourceText = readFileSync(path.join(root, "src/lib/snapshot/streamSync.ts"), "utf8");
} catch (error) {
  console.error(`${CHECK_NAME}: cannot read src/lib/snapshot/streamSync.ts: ${error.message}`);
  exit(2);
}

let committed;
try {
  committed = parseStreamBatch(sourceText);
} catch (error) {
  console.error(`${CHECK_NAME}: ${error.message}`);
  exit(2);
}

const rowsPerStmtRaw = flagValue("rows-per-stmt");
let rowsPerStmt = { ...R_PER_STMT };
if (rowsPerStmtRaw !== null) {
  const parts = rowsPerStmtRaw.split(",").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error(`${CHECK_NAME}: --rows-per-stmt must be three positive integers, e.g. 7,6,3 (got ${rowsPerStmtRaw})`);
    exit(2);
  }
  rowsPerStmt = { customer: parts[0], address: parts[1], container: parts[2] };
}

const budget = flagInt("budget", D1_PAID_BUDGET);
if (budget === 0) {
  console.error(`${CHECK_NAME}: --budget must be positive (got 0)`);
  exit(2);
}

const rows = {
  customer: flagInt("customer-rows", CURRENT_ROWS.customer),
  address: flagInt("address-rows", CURRENT_ROWS.address),
  container: flagInt("container-rows", CURRENT_ROWS.container),
};
const batchSizes = {
  customer: flagInt("batch-customer", committed.customer ?? CURRENT_BATCH.customer),
  address: flagInt("batch-address", committed.address ?? CURRENT_BATCH.address),
  container: flagInt("batch-container", committed.container ?? CURRENT_BATCH.container),
};
for (const [k, v] of Object.entries(batchSizes)) {
  if (v <= 0) {
    console.error(`${CHECK_NAME}: batch size for ${k} must be positive (got ${v})`);
    exit(2);
  }
}

const outcome = evaluateAll({
  rows,
  batchSizes,
  rowsPerStmt,
  budgets: { default: budget },
  reconcile: !argv.includes("--no-reconcile"),
});

for (const line of formatReport(outcome, budget)) console.log(line);
const over = outcome.tables.filter((t) => !t.fits);
if (over.length > 0) {
  console.log(
    `${CHECK_NAME}: OVER — ${over.map((t) => t.name).join(", ")} exceed(s) the per-invocation budget at these row counts; ` +
      `see CUSTOMER_SNAPSHOT.md § "Sync batch sizing vs the D1 budget" for the safe sizes.`,
  );
} else {
  console.log(`${CHECK_NAME}: FIT — all three per-table syncs fit the per-invocation budget with margin.`);
}
