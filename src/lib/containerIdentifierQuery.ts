import { z } from "@hono/zod-openapi";

// Bound UTF-16 length before code-point iteration; never normalize opaque data.
export const containerIdentifierQuery = z.string()
  .refine((value) => value.length <= 200 && [...value].length <= 100 && value.trim() !== "", {
    error: "Identifier must contain 1..100 Unicode code points and not be whitespace-only"
  })
  .describe(
    "Case-sensitive opaque exact string, 1..100 Unicode code points. Leading zeros and nonblank whitespace are preserved, without trimming or Unicode normalization. A single value only; empty, whitespace-only, repeated and overlength values are rejected before D1."
  )
  .openapi({ minLength: 1, maxLength: 100 });
