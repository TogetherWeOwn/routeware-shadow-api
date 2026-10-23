import type { Context } from "hono";
import { z } from "@hono/zod-openapi";
import { matchesIfNoneMatch } from "./conditionalRequest";
import { sha256Etag } from "./entityDataCache";

export const snapshotListConditionalHeaders = z.object({
  "If-None-Match": z.string().optional().openapi({
    description:
      "Validate the final JSON envelope with a quoted ETag, weak tag, comma-separated tag list or *. Saves response bytes only: authentication, query validation and D1 reads still run; Cache-Control remains no-store. Malformed validators do not match."
  })
});

export const snapshotListEtagHeaders = {
  ETag: {
    description: "Quoted SHA-256 of the exact served JSON envelope (rows, total, nextCursor).",
    schema: { type: "string" as const }
  }
};

export const snapshotListNotModifiedResponse = {
  description:
    "If-None-Match matched the current JSON envelope. Empty body; unchanged D1 work and no-store policy.",
  headers: snapshotListEtagHeaders
};

/** Called only after successful validation, D1 reads and row projection. */
export async function snapshotListJsonResponse(
  c: Context,
  envelope: { rows: unknown[]; total: number | null; nextCursor: number | null }
): Promise<Response> {
  const body = JSON.stringify(envelope);
  const etag = `"${await sha256Etag(body)}"`;
  c.header("ETag", etag);
  // Use the context on both paths to retain any existing response metadata.
  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304);
  }
  c.header("Content-Type", "application/json; charset=utf-8");
  return c.body(body, 200);
}
