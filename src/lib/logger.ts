export type LogLevel = "info" | "warn" | "error";

export type LogValue =
  | string
  | number
  | boolean
  | null
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };

export interface StructuredLogEvent {
  level: LogLevel;
  msg: string;
  route: string;
  ms: number | null;
  [key: string]: LogValue;
}

export type LogR2Detail = {
  status: "stored" | "disabled" | "failed";
  reason?: string;
  key?: string;
};

export type LogTableCounts = {
  upserted: number;
  rowCount: number;
  deleted?: number;
  r2?: LogR2Detail;
} | null;

export type LogTables = {
  customer: LogTableCounts;
  address: LogTableCounts;
  container: LogTableCounts;
};

export type LogEventInput = {
  level: LogLevel;
  msg: string;
  route: string;
  ms?: number | null;
  requestId?: string;
  method?: string;
  status?: number;
  timeoutMs?: number;
  reason?: string;
  key?: string;
  manifestKey?: string;
  event?: string;
  runId?: string;
  outcome?: string;
  mode?: string;
  configSource?: string;
  d1LimitRisk?: boolean;
  tables?: LogTables;
  summary?: string;
  durationMs?: number;
  cron?: string;
  scheduledTime?: string;
  table?: "customer" | "address" | "container";
  entity?: "customer" | "address" | "container";
  hits?: number;
  misses?: number;
  attempt?: number;
  attempts?: number;
  dependency?: string;
  fallback?: string;
  kind?: string;
  next_action?: "inspect_table_sync_before_resubmitting";
  customerId?: number;
  addressCount?: number;
  containerCount?: number;
  d1Ops?: number;
  d1OpsBudget?: number;
  cacheInvalidations?: number;
  cacheInvalidationBudget?: number;
};

const allowedContextFields = new Set([
  "requestId",
  "method",
  "status",
  "timeoutMs",
  "reason",
  "key",
  "manifestKey",
  "event",
  "runId",
  "outcome",
  "mode",
  "configSource",
  "d1LimitRisk",
  "tables",
  "summary",
  "durationMs",
  "cron",
  "scheduledTime",
  "table",
  "entity",
  "hits",
  "misses",
  "attempt",
  "attempts",
  "dependency",
  "fallback",
  "kind",
  "next_action",
  "customerId",
  "addressCount",
  "containerCount",
  "d1Ops",
  "d1OpsBudget",
  "cacheInvalidations",
  "cacheInvalidationBudget"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Utilization fields are numeric internal counts only. They ride
// the global allowlist (so `sync.detailFull` can emit `customerId`), but a
// string or negative value must never reach the log — e.g. a `customerId:
// "alice@example.com"` from another caller would otherwise pass through as
// PII. `Number.isInteger` pins the model: every value is produced by a count
// or budget constant, never a float.
const UTILIZATION_COUNT_FIELDS = new Set([
  "customerId",
  "addressCount",
  "containerCount",
  "d1Ops",
  "d1OpsBudget",
  "cacheInvalidations",
  "cacheInvalidationBudget"
]);

const R2_STATUSES = new Set(["stored", "disabled", "failed"]);

function safeR2Detail(value: unknown): LogR2Detail | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  if (typeof status !== "string" || !R2_STATUSES.has(status)) return undefined;
  const out: LogR2Detail = { status: status as LogR2Detail["status"] };
  if (typeof value.reason === "string") out.reason = value.reason;
  if (typeof value.key === "string") out.key = value.key;
  return out;
}

function safeTableCounts(value: unknown): LogValue | undefined {
  if (!isRecord(value)) return undefined;
  const safeTables: Record<string, LogValue> = {};
  for (const table of ["customer", "address", "container"] as const) {
    if (!Object.hasOwn(value, table)) continue;
    const counts = value[table];
    if (counts === null) {
      safeTables[table] = null;
      continue;
    }
    if (!isRecord(counts) || !isSafeCount(counts.upserted) || !isSafeCount(counts.rowCount)) {
      continue;
    }
    const r2 = Object.hasOwn(counts, "r2") ? safeR2Detail(counts.r2) : undefined;
    safeTables[table] = {
      upserted: counts.upserted,
      rowCount: counts.rowCount,
      ...(isSafeCount(counts.deleted) ? { deleted: counts.deleted } : {}),
      ...(r2 !== undefined ? { r2 } : {})
    };
  }
  return Object.keys(safeTables).length > 0 ? safeTables : undefined;
}

function isSafeScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function logEvent(event: LogEventInput): void {
  const { level } = event;
  const record: StructuredLogEvent = {
    level: event.level,
    msg: event.msg,
    route: event.route,
    ms: event.ms ?? null
  };
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined || !allowedContextFields.has(key)) continue;
    if (key === "tables") {
      const tables = safeTableCounts(value);
      if (tables !== undefined) record.tables = tables;
    } else if (key === "next_action") {
      if (value === "inspect_table_sync_before_resubmitting") record[key] = value;
    } else if (UTILIZATION_COUNT_FIELDS.has(key)) {
      if (!isSafeCount(value) || !Number.isInteger(value)) continue;
      record[key] = value;
    } else if (isSafeScalar(value)) {
      record[key] = value;
    }
  }
  console[level](record);
}

export function errorKind(err: unknown): string {
  const seen = new Set<Error>();
  let kind = "unknown";
  let cause: unknown = err;
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (kind === "unknown" || cause.name !== "Error") kind = cause.name;
    cause = cause.cause;
  }
  return kind;
}
