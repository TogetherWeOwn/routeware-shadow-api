import {
  runDataSnapshotSync,
  runDataSnapshotSyncChainedHttp,
  type DataSnapshotResult,
} from "./lib/d1SnapshotSync";

export type CronSyncMode = "chained-http" | "single-invocation";
export type CronSyncOutcome = "success" | "unconfigured" | "failed";

export type CronSyncTableCounts = {
  upserted: number;
  rowCount: number;
  deleted?: number;
} | null;

/**
 * The one structured log line the cron emits per run, prefixed with
 * `data-snapshot-sync ` so it stays greppable in `wrangler tail` and the
 * dashboard while the remainder parses as JSON.
 *
 * `outcome` is what an alarm keys on: `success` (at least one table ran),
 * `unconfigured` (no report paths — a config state, not a pass), or `failed`
 * (the sync threw). A silent failure can no longer look like an empty config.
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
  return t ? { ...t } : null;
}

function summarizeTable(name: string, t: CronSyncTableCounts): string {
  if (!t) {
    return `${name}: skipped (no report path configured)`;
  }
  const deleted =
    t.deleted === undefined ? "" : `, ${t.deleted} deleted`;
  return `${name}: ${t.upserted} upserted, ${t.rowCount} rows${deleted}`;
}

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
        console.log(
          `data-snapshot-sync ${JSON.stringify({
            ...base,
            outcome: (configured > 0 ? "success" : "unconfigured") as CronSyncOutcome,
            tables,
            summary,
            durationMs: Date.now() - start,
          } satisfies CronSyncLog)}`
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `data-snapshot-sync ${JSON.stringify({
            ...base,
            outcome: "failed" as CronSyncOutcome,
            tables: { customer: null, address: null, container: null },
            summary: "sync threw before any table result was recorded",
            durationMs: Date.now() - start,
            error: message,
          } satisfies CronSyncLog)}`
        );
      }
    })()
  );
}
