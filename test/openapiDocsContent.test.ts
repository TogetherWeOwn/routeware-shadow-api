/// <reference types="vite/client" />

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * Consumer-content pass for Scalar `/docs`.
 *
 * Covers the gated-404 vs enabled-render states only. This pins the
 * *content* quality a first consumer sees in Scalar, driven off the generated
 * `/openapi.json` (the same document Scalar renders), without freezing the
 * whole doc — that is the snapshot's job in `openapiContract.test.ts`:
 *
 *  - every tagged operation carries a `summary` and a `description`, so no
 *    sidebar entry renders blank;
 *  - every POST with a `requestBody` carries a non-empty `example`, so the
 *    Scalar "try it" panel is pre-filled with something that works;
 *  - auth-gated POST descriptions name the bearer requirement, so a consumer
 *    does not discover the 401 by trial and error;
 *  - JSON POST examples stay byte-identical to the harvested files under
 *    `tools/api-discovery/examples/` (route comments already say "Mirrors …");
 *  - CSV import examples carry the real export header, so a copy-pasted body
 *    parses instead of failing on unknown columns.
 */

type OpenApiDocument = {
  openapi: string;
  paths: Record<
    string,
    Record<
      string,
      {
        tags?: string[];
        summary?: string;
        description?: string;
        requestBody?: {
          content?: Record<
            string,
            { schema?: unknown; example?: unknown; examples?: unknown }
          >;
        };
      }
    >
  >;
};

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

// Same ?raw-bundling pattern as problemsAnchorCoverage.test.ts: the suite runs
// inside the workers pool (no node:fs), so example text is bundled at
// transform time instead of read from the filesystem.
const exampleModules = import.meta.glob(
  "../tools/api-discovery/examples/*",
  {
    query: "?raw",
    import: "default",
    eager: true,
  }
) as Record<string, string>;

function readExample(name: string): string {
  const key = `../tools/api-discovery/examples/${name}`;
  const text = exampleModules[key];
  if (text == null) throw new Error(`example not bundled: ${name}`);
  return text.trim();
}

/** JSON POST examples pinned byte-identical to the harvested files. */
const JSON_EXAMPLE_PINS: Array<{ op: string; file: string }> = [
  { op: "POST /api/v1/routeware/customer/customers-read", file: "customers-read.post.example.json" },
  { op: "POST /api/v1/routeware/customer/detail-full", file: "get-customer-detail-full.post.example.json" },
  { op: "POST /api/v1/routeware/data/app-settings-get", file: "app-settings-get.post.example.json" }
];

/** CSV import examples must start with the real export header. */
const CSV_HEADER_PINS: Array<{ op: string; header: string }> = [
  {
    op: "POST /api/v1/customer-snapshot/import",
    header:
      "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled"
  },
  {
    op: "POST /api/v1/address-snapshot/import",
    header:
      "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date"
  },
  {
    op: "POST /api/v1/container-snapshot/import",
    header:
      "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote"
  }
];

/** Auth-gated POST writes whose descriptions must name the bearer secret. */
const BEARER_GATED_POSTS = [
  "POST /api/v1/data/customer",
  "POST /api/v1/data/address",
  "POST /api/v1/data/container"
];

async function fetchOpenApiDocument(): Promise<OpenApiDocument> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiDocument;
}

function operations(doc: OpenApiDocument): Array<{ op: string; body: OpenApiDocument["paths"][string][string] }> {
  const out: Array<{ op: string; body: OpenApiDocument["paths"][string][string] }> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, body] of Object.entries(item)) {
      if (HTTP_METHODS.includes(method.toLowerCase())) {
        out.push({ op: `${method.toUpperCase()} ${path}`, body });
      }
    }
  }
  return out;
}

function bodies(doc: OpenApiDocument, op: string) {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, body] of Object.entries(item)) {
      if (`${method.toUpperCase()} ${path}` === op) return body;
    }
  }
  throw new Error(`operation not found in spec: ${op}`);
}

function docExample(body: { requestBody?: OpenApiDocument["paths"][string][string]["requestBody"] }): unknown {
  const content = body.requestBody?.content ?? {};
  const first = Object.values(content)[0];
  return first?.example ?? first?.examples;
}

describe("Scalar /docs consumer content", () => {
  it("every tagged operation has a summary and a description", async () => {
    // Arrange
    const doc = await fetchOpenApiDocument();

    // Act
    const missing = operations(doc).filter(
      ({ body }) => (body.tags?.length ?? 0) > 0 && (!body.summary || !body.description)
    );

    // Assert — Scalar renders untagged ops too, but a missing summary or
    // description on a *tagged* op is a blank sidebar entry for the consumer.
    expect(missing.map(({ op }) => op)).toEqual([]);
  });

  it("every POST with a requestBody carries a non-empty example", async () => {
    // Arrange
    const doc = await fetchOpenApiDocument();

    // Act
    const withoutExample = operations(doc).filter(
      ({ op, body }) =>
        op.startsWith("POST ") && body.requestBody && docExample(body) == null
    );

    // Assert — empty-string examples are as useless as missing ones for the
    // Scalar "try it" panel, so treat both as absent.
    const emptyExample = operations(doc).filter(({ op, body }) => {
      if (!op.startsWith("POST ") || !body.requestBody) return false;
      const ex = docExample(body);
      return ex === "";
    });
    expect(withoutExample.map(({ op }) => op)).toEqual([]);
    expect(emptyExample.map(({ op }) => op)).toEqual([]);
  });

  it("auth-gated POST descriptions name the bearer requirement", async () => {
    // Arrange
    const doc = await fetchOpenApiDocument();

    // Act / Assert
    for (const op of BEARER_GATED_POSTS) {
      expect(bodies(doc, op).description).toMatch(/Authorization:\s*Bearer/);
    }
  });

  it("JSON POST examples match the harvested example files", async () => {
    // Arrange
    const doc = await fetchOpenApiDocument();

    // Act / Assert — route comments say "Mirrors …"; this makes the mirror
    // checkable. Parse both sides so formatting drift does not fail the test.
    for (const { op, file } of JSON_EXAMPLE_PINS) {
      const expected = JSON.parse(readExample(file));
      expect(JSON.parse(JSON.stringify(docExample(bodies(doc, op))))).toEqual(expected);
    }
  });

  it("CSV import examples carry the real export header", async () => {
    // Arrange
    const doc = await fetchOpenApiDocument();

    // Act / Assert — a pasted body with a wrong header fails import on
    // unknown columns; the first line must be the real export header.
    for (const { op, header } of CSV_HEADER_PINS) {
      const example = docExample(bodies(doc, op));
      expect(typeof example).toBe("string");
      expect((example as string).split("\n")[0]).toBe(header);
    }
  });
});
