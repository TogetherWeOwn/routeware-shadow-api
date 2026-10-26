import { z } from "@hono/zod-openapi";

// Whole stored route/frequency list text: binary cell equality, never token
// membership. Unlike the opaque-label selectors, whitespace-only input is
// VALID literal data here (it can match a stored whitespace-only cell), so
// there is deliberately no trim/nonblank rule. Bound UTF-16 length before
// code-point iteration; never normalize opaque data.
export const containerStoredListTextQuery = z.string()
  .refine((value) => value.length <= 1000 && [...value].length >= 1 && [...value].length <= 500, {
    error: "Stored list text must contain 1..500 Unicode code points"
  })
  .describe(
    "Case-sensitive binary exact match on the entire stored list-text cell, 1..500 Unicode code points. Whitespace-only input is valid literal data; order, duplicates and whitespace are significant, without trimming or Unicode normalization. A single value only; empty, repeated and overlength values are rejected before D1."
  )
  .openapi({ minLength: 1, maxLength: 500 });
