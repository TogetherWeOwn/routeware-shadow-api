import { z } from "@hono/zod-openapi";

export const snapshotOrderQuery = z.enum(["asc", "desc"])
  .default("asc")
  .describe("Primary-ID order: exact case-sensitive asc (default) or desc (highest IDs first, not chronological recency). Keep order with nextCursor; changing direction starts a new traversal. Check locally with npm run check:snapshot-order.")
  .openapi({ example: "desc" });

// Only these fixed SQL fragments reach the list queries, never submitted text.
// Empty ascending suffix preserves the existing SQL as well as its behavior.
export function snapshotOrderSql(order: z.infer<typeof snapshotOrderQuery>) {
  return order === "desc"
    ? { seek: "<", suffix: " DESC" } as const
    : { seek: ">", suffix: "" } as const;
}
