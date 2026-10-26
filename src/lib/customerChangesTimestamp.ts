import { z } from "@hono/zod-openapi";

/**
 * Lossless UTC-Z/millisecond timestamp chain shared by the customer changes
 * feed's `since` and `until` bounds.
 *
 * Stored synced_at uses toISOString(): lexical comparisons must use the same
 * milliseconds, never raw .1Z/seconds or rounded precision. `Date` rolls
 * calendar-invalid days (Feb 30 → Mar 1) instead of failing, so the calendar
 * guard rejects before the transform and normalization never alters the
 * instant it was given. The validation hook answers violations with the fixed
 * value-free 400; the handler never runs.
 */
const changesTimestamp = z.string().datetime()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/)
  .refine((v) => {
    const date = new Date(v);
    return !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === v.slice(0, 10);
  })
  .transform((v) => new Date(v).toISOString());

/**
 * Lower cursor bound. Empty stays an initial page: legacy empty `since`
 * (without `since_id`) keeps its epoch behavior.
 */
export const customerChangesSinceQuery = z
  .preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    changesTimestamp.optional()
  )
  .describe("UTC Z datetime cursor with seconds or 1–3 fractional digits, normalized to milliseconds before comparison. More than 3 digits is rejected, never rounded/truncated. Only later synced_at values qualify (plus the since_id tiebreak). Omit or leave empty for the first page without since_id.")
  .openapi({ example: "2025-12-31T00:00:00.000Z" });

/**
 * Inclusive upper bound. Unlike `since`, an empty value is a 400 — only the
 * lower cursor keeps the legacy empty-string leniency.
 */
export const customerChangesUntilQuery = changesTimestamp
  .optional()
  .describe("Inclusive synced_at upper bound with the same UTC Z datetime contract as since: seconds or 1–3 fractional digits, normalized to milliseconds before comparison. More than 3 digits is rejected, never rounded/truncated. Empty, offset and repeated values are invalid, and normalized since must not exceed until. Omit for the unbounded tail.")
  .openapi({ example: "2026-09-01T00:00:00.500Z" });
