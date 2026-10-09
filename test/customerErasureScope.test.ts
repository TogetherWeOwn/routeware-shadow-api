/// <reference types="vite/client" />

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import customerSnapshotMd from "../CUSTOMER_SNAPSHOT.md?raw";
import problemsMd from "../docs/PROBLEMS.md?raw";
import r2RetentionMd from "../docs/R2-RETENTION.md?raw";

/**
 * Erasure-scope pins (TOG-18933).
 *
 * `DELETE /api/v1/customer-snapshot/{customerId}` removes the D1 row and the
 * data-entity cache entry only — R2 history CSVs, daily aliases, latest
 * pointers and the archived-CSV readback keep the customer's row, upstream
 * Routeware is untouched, and the row returns on the next sync while upstream
 * still holds it. A consumer reading "erasure" assumes more than the code
 * does, so these sentences must survive verbatim: a later edit that drops the
 * R2 sentence or the next-sync sentence fails here, not in production docs.
 *
 * Follows the `test/openapiDocsContent.test.ts` pattern (generated
 * `/openapi.json` for the description, bundled `?raw` text for the docs —
 * the suite runs inside the workers pool with no `node:fs`).
 */

type OpenApiOperation = {
  tags?: string[];
  summary?: string;
  description?: string;
};

type OpenApiDocument = {
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation>>;
};

/** Not removed: R2 copies, aliases, pointers and readback, plus upstream. */
const NOT_REMOVED =
  "It does not remove R2 history CSVs, daily aliases, latest pointers, or the archived-CSV readback";

/** The row comes back while upstream still reports it. */
const RETURNS_ON_NEXT_SYNC =
  "The row returns on the next sync while upstream still holds it";

const DOCS: Array<{ name: string; text: string }> = [
  { name: "docs/PROBLEMS.md", text: problemsMd },
  { name: "CUSTOMER_SNAPSHOT.md", text: customerSnapshotMd },
  { name: "docs/R2-RETENTION.md", text: r2RetentionMd }
];

async function fetchOpenApiDocument(): Promise<OpenApiDocument> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiDocument;
}

function operationDescription(doc: OpenApiDocument, op: string): string {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, body] of Object.entries(item)) {
      if (`${method.toUpperCase()} ${path}` === op) return body.description ?? "";
    }
  }
  throw new Error(`operation not found in spec: ${op}`);
}

/** Markdown wraps the sentences across lines; compare on collapsed space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("Customer erasure scope (TOG-18933)", () => {
  it("DELETE description states what erasure removes and what it leaves", async () => {
    // Arrange
    const doc = await fetchOpenApiDocument();

    // Act
    const description = oneLine(
      operationDescription(doc, "DELETE /api/v1/customer-snapshot/{customerId}")
    );

    // Assert — removed = D1 row + data-entity cache; not removed = R2
    // copies + upstream; the row returns on the next sync.
    expect(description).toContain("D1 `customer_snapshot` row");
    expect(description).toContain("data-entity");
    expect(description).toContain(NOT_REMOVED);
    expect(description).toContain("upstream Routeware");
    expect(description).toContain(RETURNS_ON_NEXT_SYNC);
  });

  it.each(DOCS.map((d) => [d.name, d.text] as [string, string]))(
    "%s carries the same erasure scope",
    (_name, text) => {
      // Arrange / Act
      const flat = oneLine(text);

      // Assert — the same two sentences, verbatim apart from line wrapping,
      // so neither the R2 limit nor the next-sync limit can be softened
      // silently; plus the removed half (D1 row + cache).
      expect(flat).toContain("D1 `customer_snapshot` row");
      expect(flat).toContain("data-entity");
      expect(flat).toContain(NOT_REMOVED);
      expect(flat).toContain(RETURNS_ON_NEXT_SYNC);
    }
  );
});
