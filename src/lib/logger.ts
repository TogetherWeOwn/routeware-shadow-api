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

export type LogTableCounts = {
  upserted: number;
  rowCount: number;
  deleted?: number;
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
  "kind"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
    safeTables[table] = {
      upserted: counts.upserted,
      rowCount: counts.rowCount,
      ...(isSafeCount(counts.deleted) ? { deleted: counts.deleted } : {})
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
    } else if (isSafeScalar(value)) {
      record[key] = value;
    }
  }
  console[level](record);
}
