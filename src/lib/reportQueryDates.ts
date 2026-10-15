export class InvalidReportQueryDatesError extends Error {
  constructor() {
    super("REPORT_QUERY dates must be real yyyy-MM-dd dates with start <= end.");
    this.name = "InvalidReportQueryDatesError";
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Validate the effective range before any report poll, login or download. */
export function readReportQueryDates(
  env: { REPORT_QUERY_START_DATE?: string; REPORT_QUERY_END_DATE?: string }
): { startDate: string; endDate: string } {
  const startDate = env.REPORT_QUERY_START_DATE?.trim() || "1900-01-01";
  const endDate = env.REPORT_QUERY_END_DATE?.trim() || "1900-01-01";
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate) || startDate > endDate) {
    // This error reaches both API responses and cron logs: never include values.
    throw new InvalidReportQueryDatesError();
  }
  return { startDate, endDate };
}
