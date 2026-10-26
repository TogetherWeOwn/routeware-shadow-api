import {
  runDataSnapshotSync,
  runDataSnapshotSyncChainedHttp,
  type DataSnapshotResult,
} from "./lib/d1SnapshotSync";
import { recordCronRun } from "./lib/cronSyncState";
import { errorKind, logEvent } from "./lib/logger";
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
  /** R2 archive outcome for this table's CSV leg. Absent only when the producer predates the instrumentation. */
  r2?: R2ArchiveDetail;
} | null;

/**
 * The structured cron event emitted through the shared logger per run. The
 * logger adds severity, message, route, and `ms` fields around it.
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
  /**
   * Per-invocation correlation id: one `crypto.randomUUID()` minted
   * at `scheduled()` entry, spread via `base` onto the scheduled-owned lines
   * (success, failed, skipped-overlap, fallback warning, persistence-failure)
   * and threaded through `SnapshotSyncRunOptions` into the orchestration skip
   * lines and the R2-archive lines. On the chained path it rides to each
   * per-table sub-invocation on the `x-run-id` header (UUID-validated at the
   * per-table routes), so one run's records correlate across invocations.
   * Stable within a run, distinct across runs; a bare UUID, PII-free by
   * construction.
   */
  runId: string;
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
  /** Present only when outcome is "failed" and the table is known. Allowlisted table name only — never exception text. */
  table?: "customer" | "address" | "container";
  /** Failed chained observations are not safe to replay without inspecting remote effects. */
  next_action?: "inspect_table_sync_before_resubmitting";
};

type TableResult = DataSnapshotResult["customer"];

const CHAINED_REFUSAL_KINDS = new Set([
  "ChainedTimeoutError", "ChainedResponseTooLargeError", "ChainedInvalidJsonError",
  "ChainedResponseReadError", "ChainedHttpError", "ChainedNetworkError"
]);

/**
 * Validates `SHADOW_API_PUBLIC_BASE` for chained-HTTP use.
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
  // URL.search/hash are empty for bare delimiters, but appending a sync path
  // to the original string would put that path in the query or fragment.
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return null;
  }
  return trimmed;
}

/** Copies the per-table counts through, including `deleted` when present. */
function tableCounts(t: TableResult): CronSyncTableCounts {
  // Explicit pick, never spread: the result objects flow straight
  // into the `data-snapshot-sync` log line, so an extra property carrying row
  // data (company name, phone, …) would leave the Worker in the cron log.
  // The exception is `r2`: it travels only through the
  // `isR2ArchiveDetail` guard, which checks `status`. Its `reason` is the R2
  // driver's message text, the one exception-derived string in these records.
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
 * Extracts per-table results from a `PartialDataSnapshotSyncError`.
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

/**
 * HTTP status of the failed chained subrequest, from a `PartialDataSnapshotSyncError`
 * (structural, as `partialTables`). Absent for timeouts and local failures.
 */
function failedSubrequestStatus(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null || !("partial" in e) || !("status" in e)) {
    return undefined;
  }
  const status = (e as { status: unknown }).status;
  return typeof status === "number" && Number.isSafeInteger(status) ? status : undefined;
}

/**
 * Names the failed table for the structured failure event, or undefined when
 * unknown. Prefers the `failedTable` carried by `PartialDataSnapshotSyncError`;
 * falls back to the `[<table> snapshot]` / `[chained <table>]`
 * step tag in the message. Only the allowlisted customer/address/container
 * names ever reach the log — never exception text, which could carry row data.
 */
function failedSnapshotTable(
  e: unknown
): "customer" | "address" | "container" | undefined {
  if (typeof e === "object" && e !== null && "failedTable" in e) {
    const f = (e as { failedTable: unknown }).failedTable;
    if (f === "customer" || f === "address" || f === "container") {
      return f;
    }
  }
  const message =
    e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const table = /^\[(?:chained )?(customer|address|container)(?: snapshot)?\]/.exec(
    message
  )?.[1];
  return table === "customer" || table === "address" || table === "container"
    ? table
    : undefined;
}

function summarizeTable(name: string, t: CronSyncTableCounts): string {
  if (!t) {
    return `${name}: skipped (no report path configured)`;
  }
  const deleted =
    t.deleted === undefined ? "" : `, ${t.deleted} deleted`;
  // The R2 archive state rides in the summary so a missing archive
  // is visible in the human-readable line, not just the JSON. `unknown` covers
  // counts produced before the instrumentation (e.g. older route callers, or a
  // test double that omitted the field).
  const r2 = t.r2?.status ?? "unknown";
  const archive = r2 === "stored" ? "" : `, r2: ${r2}`;
  return `${name}: ${t.upserted} upserted, ${t.rowCount} rows${deleted}${archive}`;
}

/**
 * Overlap guard: at most one sync body runs at a time per
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
        // Per-run correlation id: minted once per invocation so all
        // lines from this run share it. A bare random UUID — PII-free.
        runId: crypto.randomUUID(),
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
        {
          const durationMs = Date.now() - start;
          logEvent({
            level: "info",
            msg: "data-snapshot-sync",
            route: "scheduled.data-snapshot-sync",
            ms: durationMs,
            ...base,
            outcome: "skipped-overlap",
            tables: { customer: null, address: null, container: null },
            summary: "skipped: previous sync still in-flight",
            durationMs
          });
        }
        return;
      }
      syncInFlight = true;
      try {
        let r: DataSnapshotResult;
        if (publicBase) {
          r = await runDataSnapshotSyncChainedHttp(publicBase, env, {
            runId: base.runId
          });
        } else {
          // Loud on purpose: the whole job then shares one invocation's D1
          // operation budget, so a large export can die partway through.
          logEvent({
            level: "warn",
            msg: "SHADOW_API_PUBLIC_BASE is not set; data-snapshot-sync is using one invocation",
            route: "scheduled.data-snapshot-sync",
            ms: null,
            ...base
          });
          r = await runDataSnapshotSync(env, { runId: base.runId });
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
          logEvent({
            level: "error",
            msg: "data-snapshot-sync persistence failed",
            route: "scheduled.data-snapshot-sync",
            ms: endedAt - start,
            kind: errorKind(persistErr),
            ...base
          });
        }
        logEvent({
          level: "info",
          msg: "data-snapshot-sync",
          route: "scheduled.data-snapshot-sync",
          ms: endedAt - start,
          ...base,
          outcome,
          tables,
          summary,
          durationMs: endedAt - start
        });
      } catch (e) {
        const endedAt = Date.now();
        // A table failure carries the tables that already
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
        const failed = failedSnapshotTable(e);
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
          logEvent({
            level: "error",
            msg: "data-snapshot-sync persistence failed",
            route: "scheduled.data-snapshot-sync",
            ms: endedAt - start,
            kind: errorKind(persistErr),
            ...base
          });
        }
        logEvent({
          level: "error",
          msg: "data-snapshot-sync failed",
          route: "scheduled.data-snapshot-sync",
          ms: endedAt - start,
          ...base,
          outcome: "failed",
          tables,
          summary,
          durationMs: endedAt - start,
          kind: errorKind(e),
          status: failedSubrequestStatus(e),
          ...(base.mode === "chained-http" && CHAINED_REFUSAL_KINDS.has(errorKind(e))
            ? { next_action: "inspect_table_sync_before_resubmitting" as const }
            : {}),
          ...(failed ? { table: failed } : {})
        });
      } finally {
        // Always release: a throw leaves the flag set otherwise, and every
        // later firing would skip forever with no error to explain it.
        syncInFlight = false;
      }
    })()
  );
}
