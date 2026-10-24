import type { Context } from "hono";
import { z } from "@hono/zod-openapi";
import { matchesIfNoneMatch } from "./conditionalRequest";
import { sha256Etag } from "./entityDataCache";

const headers = z.object({
  "If-None-Match": z.string().optional().openapi({
    description:
      "Validate the final JSON row with a quoted ETag, weak tag, comma-separated tag list or *. Saves response bytes only: authentication, id/fields validation and the D1 lookup still run; Cache-Control remains no-store. Malformed validators do not match."
  })
});

const etagHeaders = {
  ETag: {
    description: "Quoted SHA-256 of the exact served JSON row, after fields projection.",
    schema: { type: "string" as const }
  }
};

const notModified = {
  description:
    "If-None-Match matched the current JSON row. Empty body; unchanged D1 work and no-store policy.",
  headers: { ...etagHeaders }
};

/** Called only after successful validation, D1 lookup and row projection. */
async function jsonResponse(c: Context, row: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(row);
  const etag = `"${await sha256Etag(body)}"`;
  c.header("ETag", etag);
  // Use the context on both paths to retain any existing response metadata.
  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304);
  }
  // Same Content-Type `c.json` stamps, with the exact hashed bytes served.
  c.header("Content-Type", "application/json");
  return c.body(body, 200);
}

// Single-import surface for the three flat by-ID routes: customerSnapshot.ts
// sits at the 800-line source gate, so one binding instead of four named ones.
// Do not split this into named re-exports without re-checking that budget.
export const snapshotByIdConditional = { headers, etagHeaders, notModified, jsonResponse };
