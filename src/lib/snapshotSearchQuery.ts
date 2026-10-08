import { z } from "@hono/zod-openapi";

// String iteration counts code points, matching OpenAPI's maxLength semantics.
// Reject >200 UTF-16 units first so untrusted input cannot grow the spread array.
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/Symbol.iterator
export const snapshotSearchQuery = z.string()
  .refine((q) => q.length <= 200 && [...q].length <= 100, {
    error: "Search query must contain at most 100 Unicode code points"
  })
  .openapi({ maxLength: 100 });
