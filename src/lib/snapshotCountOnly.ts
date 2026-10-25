import { z } from "@hono/zod-openapi";

/** Ordinary flat lists only; keep every selector's validation unconditional. */
export const snapshotCountOnlyQuery = z.enum(["true", "false"]).optional().default("false")
  .describe(
    "Count-only: true returns {rows:[], total:N, nextCursor:null} with exactly one COUNT and zero row-payload/page SELECTs, no next Link. " +
    "Uses the existing filters, IDs, direction-dependent exclusive cursor and inclusive upperId: a cursor-relative query-time count, not a whole-traversal total. " +
    "Offset and limit do not subtract from total; fields and all other known parameters still validate. No snapshot isolation or no-scan guarantee; the database may scan stored rows. " +
    "False or omission preserves normal pages. Cannot combine with includeTotal=false: omit includeTotal=false or set countOnly=false and retry. " +
    "Uses the existing read tokens, no-store and representation ETag/304; even 304 executes a fresh COUNT."
  ).openapi({ example: "true" });

export function snapshotCountModeCompatible(p: { countOnly: string; includeTotal: string }): boolean {
  return p.countOnly !== "true" || p.includeTotal !== "false";
}

/** Retain the full counted example alongside both opt-in retrieval modes. */
export function snapshotListModeExamples(row: unknown) {
  return {
    counted: { summary: "Normal counted page (default)", value: { rows: [row], total: 1, nextCursor: null } },
    countFree: { summary: "includeTotal=false: page without a count", value: { rows: [row], total: null, nextCursor: null } },
    countOnly: { summary: "countOnly=true: count without row payloads", value: { rows: [], total: 1, nextCursor: null } }
  };
}
