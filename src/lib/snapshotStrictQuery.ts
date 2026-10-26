import { z } from "@hono/zod-openapi";
import { problemJsonResponse, problemType } from "./problem";

export const snapshotStrictQuery = z.enum(["true", "false"]).optional().default("false")
  .describe(
    "Opt-in typo detection: true rejects unknown decoded query names with a value-free 400 before D1 or conditional responses. " +
    "Omit or send false (default) to ignore unknown names. Send this key once as true or false."
  )
  .openapi({ example: "true" });

/** Use the mounted schema itself, not a second inventory of query names. */
export function rejectUnknownSnapshotListQuery(
  c: { req: { url: string }; env?: Env },
  strictQuery: "true" | "false",
  schema: { shape: Record<string, unknown> }
): Response | null {
  if (strictQuery !== "true") return null;
  const allowed = new Set(Object.keys(schema.shape));
  // URLSearchParams preserves empty names and decodes encoded/Unicode keys;
  // the framework's parsed query object can drop empty names. Never echo or
  // log these untrusted names, even as validation paths or an unknown-key list.
  for (const name of new URL(c.req.url).searchParams.keys()) {
    if (!allowed.has(name)) {
      return problemJsonResponse({
        type: problemType("bad-request", c.env),
        title: "Bad Request",
        status: 400,
        detail: "Unknown query parameter. Use supported query names from this mounted OpenAPI operation, " +
          "remove unknown keys, or set strictQuery=false. See docs/PROBLEMS.md#bad-request."
      });
    }
  }
  return null;
}
