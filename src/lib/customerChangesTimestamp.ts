import { z } from "@hono/zod-openapi";

/**
 * Lossless UTC-Z/millisecond timestamp chain shared by the customer changes
 * feed's `since` and `until` bounds and the container list's `syncedSince`.
 *
 * Stored synced_at uses toISOString(): lexical comparisons must use the same
 * milliseconds, never raw .1Z/seconds or rounded precision. `Date` rolls
 * calendar-invalid days (Feb 30 → Mar 1) instead of failing, so the calendar
 * guard rejects before the transform and normalization never alters the
 * instant it was given. The validation hook answers violations with the fixed
 * value-free 400; the handler never runs.
 */
export const changesTimestamp = z.string().datetime()
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

/**
 * Ordinary-list synced-window bounds. Same shared chain as the changes feed,
 * but these are NEW parameters with no legacy leniency: an empty value for
 * either bound is a 400 (only the changes feed's `since` keeps the
 * empty-means-epoch preprocess). The window is a filter over current
 * mirrored rows in the list's `customer_id` keyset order — never a changes
 * feed, deletion history or snapshot isolation.
 */
export const customerSyncedSinceQuery = changesTimestamp
  .optional()
  .describe("Strict lower synced_at bound on the ordinary list: only rows stored after the instant qualify (synced_at > value; a row synced at the instant itself is excluded). UTC Z datetime with seconds or 1–3 fractional digits, normalized to milliseconds before comparison; more than 3 digits is rejected, never rounded/truncated. Empty, offset and repeated values are invalid — unlike the changes feed's since, an empty value here is a 400. Stored synced_at is mirror freshness, not upstream event time; for resumable traversal of current upserts use the changes feed (not a deletion log or complete history). Omit for no lower bound.")
  .openapi({ example: "2025-12-31T00:00:00.000Z" });

export const customerSyncedUntilQuery = changesTimestamp
  .optional()
  .describe("Inclusive upper synced_at bound on the ordinary list: rows stored at or before the instant qualify (synced_at <= value; a row synced at the instant itself is included). Same UTC Z millisecond contract as syncedSince: seconds or 1–3 fractional digits, normalized to milliseconds before comparison, never rounded/truncated. Empty, offset and repeated values are invalid, and normalized syncedSince must not exceed syncedUntil. This is a filter over current mirrored rows, not the changes feed. Omit for no upper bound.")
  .openapi({ example: "2026-09-01T00:00:00.500Z" });

/**
 * Both bounds are normalized `toISOString()` by now, so lexical is
 * chronological. Equality stays valid: strict lower + inclusive upper at one
 * instant is an empty 200, matching the changes feed's posture.
 */
export const customerSyncedWindowOrdered = (p: { syncedSince?: string; syncedUntil?: string }) =>
  p.syncedSince === undefined || p.syncedUntil === undefined || p.syncedSince <= p.syncedUntil;
