import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Scalar `/docs` try-it kit for the snapshot import/sync flow (TOG-8360,
 * gap G4).
 *
 * The highest-friction flow — customer CSV import plus the per-table and
 * combined syncs — must be one click in Scalar: the `bearerAuth` scheme is
 * preselected, the token persists across calls, code samples default to
 * curl, every worked response carries a 200 `example` matching the real
 * body, and the descriptions tell the reviewer exactly what to paste and
 * send. The gated-404 behaviour (docs disabled) stays pinned by
 * `openapiDocsGate.test.ts`; one disabled check here guards the `/docs`
 * HTML path this file owns.
 */

type Operation = {
  description?: string;
  requestBody?: { content?: Record<string, { example?: unknown }> };
  responses?: Record<string, { content?: Record<string, { example?: unknown }> }>;
};

type Doc = { paths: Record<string, Record<string, Operation>> };

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function docsEnv(value: unknown): Env {
  return { OPENAPI_DOCS_ENABLED: value } as unknown as Env;
}

async function fetchSpec(): Promise<Doc> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as Doc;
}

function op(doc: Doc, path: string): Operation {
  const item = doc.paths[path];
  expect(item, `missing path ${path}`).toBeDefined();
  const operation = item.post;
  expect(operation, `missing POST ${path}`).toBeDefined();
  return operation;
}

function jsonExample(operation: Operation): unknown {
  return operation.responses?.["200"]?.content?.["application/json"]?.example;
}

describe("Scalar /docs import/sync try-it kit (TOG-8360)", () => {
  it("embeds the bearer auth prefill in the /docs HTML", async () => {
    // Arrange / Act
    const res = await app.fetch(
      new Request("http://test.local/docs"),
      docsEnv("true"),
      ctx
    );

    // Assert — preselected scheme, persisted token, curl samples. No token
    // value is embedded: the reviewer pastes CUSTOMER_SNAPSHOT_SYNC_SECRET
    // once into the Authorize dialog.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("preferredSecurityScheme");
    expect(html).toContain("bearerAuth");
    expect(html).toContain("persistAuth");
    expect(html).toContain("curl");
  });

  it("still 404s /docs when docs are disabled", async () => {
    // Arrange / Act
    const res = await app.fetch(
      new Request("http://test.local/docs"),
      docsEnv("false"),
      ctx
    );

    // Assert
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("customer import carries a CSV try-it request plus the worked 200 example", async () => {
    // Arrange
    const doc = await fetchSpec();

    // Act
    const operation = op(doc, "/api/v1/customer-snapshot/import");
    const requestExample =
      operation.requestBody?.content?.["text/csv"]?.example;

    // Assert — request example is the real export body; the 200 example is
    // the exact import summary (imports never delete, so deleted is 0).
    expect(typeof requestExample).toBe("string");
    expect((requestExample as string).split("\n")[0]).toBe(
      "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled"
    );
    expect(jsonExample(operation)).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
    expect(operation.description).toMatch(/Authorization:\s*Bearer/);
    expect(operation.description).toMatch(/Try it/);
  });

  it("customer sync carries the worked 200 example and try-it steps", async () => {
    // Arrange
    const doc = await fetchSpec();

    // Act
    const operation = op(doc, "/api/v1/customer-snapshot/sync");

    // Assert
    expect(jsonExample(operation)).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
    expect(operation.description).toMatch(/Authorization:\s*Bearer/);
    expect(operation.description).toMatch(/Try it/);
  });

  it("the spec's own CSV example imports to a 200 with the worked shape", async () => {
    // Arrange — the reviewer follows the description: authorize once, paste
    // the request example as the raw body, Send.
    await ensureD1TestTables();
    const doc = await fetchSpec();
    const csv = op(doc, "/api/v1/customer-snapshot/import").requestBody
      ?.content?.["text/csv"]?.example as string;

    // Act
    const res = await exports.default.fetch(
      "http://test.local/api/v1/customer-snapshot/import",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-sync-secret",
          "content-type": "text/csv"
        },
        body: csv
      }
    );

    // Assert — one data row in the example, so one row upserted; imports
    // never delete.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
  });

  it("combined data-snapshot/sync carries the per-table worked 200 example", async () => {
    // Arrange
    const doc = await fetchSpec();

    // Act
    const operation = op(doc, "/api/v1/data-snapshot/sync");

    // Assert — one {upserted, rowCount} pair per table, no deleted leak.
    expect(jsonExample(operation)).toEqual({
      customer: { upserted: 2, rowCount: 2 },
      address: { upserted: 2, rowCount: 2 },
      container: { upserted: 2, rowCount: 2 }
    });
    expect(operation.description).toMatch(/Authorization:\s*Bearer/);
    expect(operation.description).toMatch(/Try it/);
  });
});
