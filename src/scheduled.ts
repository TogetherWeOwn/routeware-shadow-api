import {
  runDataSnapshotSync,
  runDataSnapshotSyncChainedHttp,
  type DataSnapshotResult,
} from "./lib/d1SnapshotSync";
import { recordCronRun } from "./lib/cronSyncState";
import { isR2ArchiveDetail, type R2ArchiveDetail } from "./lib/r2SnapshotArchive";

export type CronSyncMode = "chained-http" | "single-invocation";
export type CronSyncOutcome =
  | "success"
  | "unconfigured"
  | "failed"
  | "skipped-overlap";

export type CronSyncTableCounts = {
  upserted: number;
  rowCount: number;
  deleted?: number;
  /** R2 archive outcome for this table's CSV leg (TOG-6549). Absent only when the producer predates the instrumentation. */
  r2?: R2ArchiveDetail;
} | null;

/**
 * The one structured log line the cron emits per run, prefixed with
 * `data-snapshot-sync ` so it stays greppable in `wrangler tail` and the
 * dashboard while the remainder parses as JSON.
 *
 * `outcome` is what an alarm keys on: `success` (at least one table ran),
 * `unconfigured` (no report paths — a config state, not a pass), `failed`
 * (the sync threw), or `skipped-overlap` (a previous run was still in-flight;
 * this firing did no work). A silent failure can no longer look like an empty
 * config.
 */
export type CronSyncLog = {
  event: "data-snapshot-sync";
  outcome: CronSyncOutcome;
  mode: CronSyncMode;
  /** Which configuration decided the mode. */
  configSource: "SHADOW_API_PUBLIC_BASE" | "fallback-single-invocation";
  /**
   * True when the whole job ran in one invocation: D1's per-invocation
   * operation budget (~1000 ops) applies to all three tables as one pool, so
   * a large export can die partway through. Set SHADOW_API_PUBLIC_BASE to
   * switch the cron to chained per-table invocations.
   */
  d1LimitRisk: boolean;
  tables: {
    customer: CronSyncTableCounts;
    address: CronSyncTableCounts;
    container: CronSyncTableCounts;
  };
  /** Human-readable one-liner mirroring `tables`; the JSON above is the alarm source. */
  summary: string;
  durationMs: number;
  cron: string;
  scheduledTime: string;
  /** Present only when outcome is "failed". Message only — never row data. */
  error?: string;
};

type TableResult = DataSnapshotResult["customer"];

/**
 * Validates `SHADOW_API_PUBLIC_BASE` for chained-HTTP use (TOG-6285).
 *
 * Only a bare http(s) origin — no path, query, fragment, or userinfo — is
 * usable: the chained runner appends fixed `/api/v1/...` paths, so a
 * path-suffixed value would build wrong URLs, and a malformed value would
 * throw inside `fetch`. Anything else falls back to single-invocation.
 * Never throws (a `new URL` throw before logging would be an unattributed
 * platform-level cron failure), and never echoes the raw value: it could
 * contain userinfo credentials that must not reach the logs.
 */
export function resolveChainedBase(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return null;
  }
  if (parsed.search || parsed.hash) {
    return null;
  }
  return trimmed;
}

/** Copies the per-table counts through, including `deleted` when present (TOG-7391). */
function tableCounts(t: TableResult): CronSyncTableCounts {
  // Explicit pick, never spread (TOG-7378): the result objects flow straight
  // into the `data-snapshot-sync` log line, so an extra property carrying row
  // data (company name, phone, …) would leave the Worker in the cron log.
  // The TOG-6549 exception is `r2`, and it travels only through the
  // `isR2ArchiveDetail` guard (status discriminant only) — never blind.
  if (!t) {
    return null;
  }
  const out: Exclude<CronSyncTableCounts, null> =
    t.deleted === undefined
      ? { upserted: t.upserted, rowCount: t.rowCount }
      : { upserted: t.upserted, rowCount: t.rowCount, deleted: t.deleted };
  if (isR2ArchiveDetail(t.r2)) {
    out.r2 = t.r2;
  }
  return out;
}

/**
 * Extracts per-table results from a `PartialDataSnapshotSyncError` (TOG-6546).
 * Structural, not `instanceof`: the sync module may be stubbed (tests) or the
 * error may cross a module boundary, and the handler must still report the
 * partial instead of all-null. Returns null for any other rejection, which
 * keeps the previous "threw before any result" line.
 */
function partialTables(e: unknown): DataSnapshotResult | null {
  if (typeof e !== "object" || e === null || !("partial" in e)) {
    return null;
  }
  const p = (e as { partial: unknown }).partial;
  if (typeof p !== "object" || p === null) {
    return null;
  }
  const t = p as Record<string, unknown>;
  if (!("customer" in t && "address" in t && "container" in t)) {
    return null;
  }
  return p as DataSnapshotResult;
}

/** Names the failed table on a partial error, or null when unknown. */
function failedTableName(e: unknown): string | null {
  if (typeof e !== "object" || e === null || !("failedTable" in e)) {
    return null;
  }
  const f = (e as { failedTable: unknown }).failedTable;
  return typeof f === "string" ? f : null;
}

function summarizeTable(name: string, t: CronSyncTableCounts): string {
  if (!t) {
    return `${name}: skipped (no report path configured)`;
  }
  const deleted =
    t.deleted === undefined ? "" : `, ${t.deleted} deleted`;
  // TOG-6549: the R2 archive state rides in the summary so a missing archive
  // is visible in the human-readable line, not just the JSON. `unknown` covers
  // counts produced before the instrumentation (e.g. older route callers, or a
  // test double that omitted the field).
  const r2 = t.r2?.status ?? "unknown";
  const archive = r2 === "stored" ? "" : `, r2: ${r2}`;
  return `${name}: ${t.upserted} upserted, ${t.rowCount} rows${deleted}${archive}`;
}

/**
 * Overlap guard (TOG-9216, gap B4): at most one sync body runs at a time per
 * isolate. A second firing while the first is still in-flight skips with a
 * fixed-shape `skipped-overlap` log line instead of doubling upstream load
 * and racing the first run's D1 writes.
 *
 * Skip-with-log (not bounded-wait): cron firings are minutes apart and a slow
 * run already holds the full D1 budget, so queuing behind it risks a second
 * timeout cascade. The skip deliberately does NOT call `recordCronRun` — the
 * persisted `cron_sync_state` rows stay the last run that actually moved rows,
 * so the readiness staleness probe (`src/lib/readiness.ts`) keeps reporting
 * ground truth instead of a fresh timestamp for work that never happened.
 *
 * Scope: this flag serializes firings on one isolate. A platform double-fire
 * routed to two isolates can still overlap; that residual case is visible as
 * two `success` lines for adjacent `scheduledTime`s (see
 * `docs/CRON-SYNC-ALARM-RUNBOOK.md` §1).
 */
let syncInFlight = false;

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  ctx.waitUntil(
    (async () => {
      const start = Date.now();
      const publicBase = resolveChainedBase(env.SHADOW_API_PUBLIC_BASE);
      const base = {
        event: "data-snapshot-sync" as const,
        mode: (publicBase ? "chained-http" : "single-invocation") as CronSyncMode,
        configSource: (publicBase
          ? "SHADOW_API_PUBLIC_BASE"
          : "fallback-single-invocation") as CronSyncLog["configSource"],
        d1LimitRisk: !publicBase,
        // Defensive: tests and future callers may pass a bare object; the
        // handler must never throw before it can log.
        cron: controller.cron ?? "unknown",
        scheduledTime:
          typeof controller.scheduledTime === "number"
            ? new Date(controller.scheduledTime).toISOString()
            : "unknown",
      };
      if (syncInFlight) {
        // Fixed-shape skip: no counts, no error text, no scheduledTime delta —
        // nothing here can carry row data or credentials. `tables` stays the
        // all-null shape so downstream JSON consumers see the same fields.
        console.log(
          `data-snapshot-sync ${JSON.stringify({
            ...base,
            outcome: "skipped-overlap" as CronSyncOutcome,
            tables: { customer: null, address: null, container: null },
            summary: "skipped: previous sync still in-flight",
            durationMs: Date.now() - start,
          } satisfies CronSyncLog)}`
        );
        return;
      }
      syncInFlight = true;
      try {
        let r: DataSnapshotResult;
        if (publicBase) {
          r = await runDataSnapshotSyncChainedHttp(publicBase, env);
        } else {
          // Loud on purpose: the whole job then shares one invocation's D1
          // operation budget, so a large export can die partway through.
          // TOG-5827 pins this line — the cron path-selection test asserts it.
          console.warn(
            "SHADOW_API_PUBLIC_BASE is not set; running data-snapshot-sync as a " +
              "single invocation (D1 per-invocation limit applies to all tables as one pool). " +
              "Set SHADOW_API_PUBLIC_BASE to the Worker's public origin to use chained per-table syncs."
          );
          r = await runDataSnapshotSync(env);
        }
        const tables = {
          customer: tableCounts(r.customer),
          address: tableCounts(r.address),
          container: tableCounts(r.container),
        };
        const configured = Object.values(tables).filter((t) => t !== null).length;
        const summary = [
          summarizeTable("customer", tables.customer),
          summarizeTable("address", tables.address),
          summarizeTable("container", tables.container),
        ].join("; ");
        const endedAt = Date.now();
        const outcome = (configured > 0 ? "success" : "unconfigured") as CronSyncOutcome;
        // Persist the run before logging it so the readiness timestamp lands
        // even if the Worker dies mid-log. Best-effort: a D1 failure here
        // keeps the log line as the record, never turns a good sync red.
        try {
          await recordCronRun((env as Partial<Env>).CUSTOMER_DB, {
            outcome,
            mode: base.mode,
            tables,
            ranAt: new Date().toISOString(),
            durationMs: endedAt - start,
          });
        } catch (persistErr) {
          console.error(
            `data-snapshot-sync persist failed: ${
              persistErr instanceof Error ? persistErr.message : String(persistErr)
            }`
          );
        }
        console.log(
          `data-snapshot-sync ${JSON.stringify({
            ...base,
            outcome,
            tables,
            summary,
            durationMs: endedAt - start,
          } satisfies CronSyncLog)}`
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const endedAt = Date.now();
        // TOG-6546: a table failure carries the tables that already
        // succeeded — report and persist them instead of all-null so the log
        // line and the readiness probe show what actually ran. Tables never
        // attempted stay null.
        const partial = partialTables(e);
        const tables = partial
          ? {
              customer: tableCounts(partial.customer),
              address: tableCounts(partial.address),
              container: tableCounts(partial.container),
            }
          : { customer: null, address: null, container: null };
        const failed = failedTableName(e);
        const summary = partial
          ? [
              summarizeTable("customer", tables.customer),
              summarizeTable("address", tables.address),
              summarizeTable("container", tables.container),
            ].join("; ") + (failed ? `; failed: ${failed}` : "")
          : "sync threw before any table result was recorded";
        // Persist the run before logging it so the readiness timestamp lands
        // even if the Worker dies mid-log. Best-effort: a D1 failure here
        // keeps the log line as the record, never turns a good sync red.
        try {
          await recordCronRun((env as Partial<Env>).CUSTOMER_DB, {
            outcome: "failed",
            mode: base.mode,
            tables,
            ranAt: new Date().toISOString(),
            durationMs: endedAt - start,
          });
        } catch (persistErr) {
          console.error(
            `data-snapshot-sync persist failed: ${
              persistErr instanceof Error ? persistErr.message : String(persistErr)
            }`
          );
        }
        console.error(
          `data-snapshot-sync ${JSON.stringify({
            ...base,
            outcome: "failed" as CronSyncOutcome,
            tables,
            summary,
            durationMs: endedAt - start,
            error: message,
          } satisfies CronSyncLog)}`
        );
      } finally {
        // Always release: a throw leaves the flag set otherwise, and every
        // later firing would skip forever with no error to explain it.
        syncInFlight = false;
      }
    })()
  );
}
