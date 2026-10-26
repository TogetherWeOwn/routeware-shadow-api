import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/app";
import { scalarDocsConfiguration } from "../src/lib/docsPresentation";
import { ensureD1TestTables } from "./d1TestMigrations";

type Operation = {
  operationId?: string;
  tags: string[];
  description: string;
  parameters?: { name: string; schema: { example?: unknown } }[];
  security?: unknown[];
  responses: Record<string, { content: Record<string, { example?: unknown; examples?: Record<string, { value?: unknown }> }> }>;
};
type Doc = { paths: Record<string, Record<string, Operation>> };
type Configuration = typeof scalarDocsConfiguration;

async function fetchSpec(): Promise<Doc> {
  const response = await exports.default.fetch("http://test.local/openapi.json");
  expect(response.status).toBe(200);
  return response.json() as Promise<Doc>;
}

async function fetchDocs(): Promise<string> {
  const response = await exports.default.fetch("http://test.local/docs");
  expect(response.status).toBe(200);
  return response.text();
}

// Exercise the generated browser script, including function serialization.
function browserConfiguration(html: string): Configuration {
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();
  let config: Configuration | undefined;
  new Function("Scalar", script!)({
    createApiReference: (selector: string, value: Configuration) => {
      expect(selector).toBe("#app");
      config = value;
    }
  });
  expect(config).toBeDefined();
  return config!;
}

describe("Scalar /docs presentation", () => {
  it("renders local branding and read-only shortcuts with the themed Scalar config", async () => {
    const html = await fetchDocs();
    const config = browserConfiguration(html);
    expect(html).toContain("<title>Routeware Shadow API</title>");
    expect(html).toContain('class="routeware-docs-logo"');
    expect(html).toContain("data-scalar-scroll-header");
    expect(html).toContain('aria-label="Try-it examples"');
    expect(html).toContain('href="/openapi.json"');
    expect(config.customCss).toContain("--scalar-sidebar-color-active");
    expect(config.theme).toBe("none");
    expect(config.showSidebar).toBe(true);
    expect(config.hideTestRequestButton).toBe(false);
    expect(config.url).toBe("/openapi.json");
    expect(config.authentication).toEqual({ preferredSecurityScheme: "bearerAuth" });
    expect(config.persistAuth).toBe(true);
    expect(config.defaultHttpClient).toEqual({ targetKey: "shell", clientKey: "curl" });
    expect(config.proxyUrl).toBeUndefined();
  });

  it("generates unique, stable operation anchors and points both shortcuts at real operations", async () => {
    const html = await fetchDocs();
    const slug = browserConfiguration(html).generateOperationSlug!;
    const doc = await fetchSpec();
    const anchors: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
        anchors.push(`#tag/${operation.tags[0]}/${slug({ path, method: method.toUpperCase(), operationId: operation.operationId })}`);
      }
    }
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const anchor of ["#tag/meta/health", "#tag/customer-snapshot/listCustomerSnapshot"]) {
      expect(anchors).toContain(anchor);
      expect(html).toContain(`href="${anchor}"`);
    }
    expect(slug({ method: "GET", path: "/api/v1/data/customer/{customerId}" }))
      .toBe("GET/api/v1/data/customer/{customerId}");
    expect(slug({ method: "POST", path: "/renamed", operationId: "health" })).toBe("health");
  });

  it("keeps disabled docs unbranded and fail-closed", async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    for (const path of ["/docs", "/openapi.json"]) {
      const response = await app.fetch(
        new Request(`http://test.local${path}`),
        { OPENAPI_DOCS_ENABLED: "false" } as unknown as Env,
        ctx
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("problem+json");
      expect(await response.text()).not.toContain("routeware-docs-logo");
    }
  });

  it("health Try It is public and its worked example matches the actual response", async () => {
    const doc = await fetchSpec();
    const operation = doc.paths["/api/v1/health"].get;
    expect(operation.security).toEqual([]);
    expect(operation.description).toContain("Try it:");
    const response = await exports.default.fetch("http://test.local/api/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(operation.responses["200"].content["application/json"].example);
  });

  it("snapshot browse try-it executes as a GET with the read-only token", async () => {
    await ensureD1TestTables();
    const doc = await fetchSpec();
    const operation = doc.paths["/api/v1/customer-snapshot"].get;
    expect(operation.description).toContain("SHADOW_API_READ_TOKEN");
    expect(operation.description).toContain("Try it:");
    const examples = new Map(
      (operation.parameters ?? []).map((parameter) => [parameter.name, parameter.schema.example])
    );
    // The documented try-it pair is prefilled for one-click Send.
    expect(examples.get("enabled")).toBe("true");
    expect(examples.get("limit")).toBe(10);
    // Named modes must retain the full-row counted page, not substitute the
    // empty count-only envelope; the live try-it below still proves the GET path.
    const media = operation.responses["200"].content["application/json"];
    expect(media.example).toBeUndefined();
    expect(media.examples?.counted.value).toEqual({
      rows: [{
        customer_id: 345734,
        customer_type_id: 1,
        company_name: "ExampleCo",
        first_name: "Jane",
        middle_initial: null,
        last_name: "Doe",
        name_suffix: null,
        customer_number: "C-1001",
        sub_customer_number: null,
        phone1: "555-0100",
        phone2: null,
        comments: null,
        enabled: 1,
        synced_at: "2026-01-01T00:00:00.000Z"
      }],
      total: 1,
      nextCursor: null
    });
    const query = new URLSearchParams({ enabled: "true", limit: "10" });
    const response = await exports.default.fetch(`http://test.local/api/v1/customer-snapshot?${query}`, {
      headers: { authorization: "Bearer test-read-token" }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: unknown[]; total: number };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.total).toBe("number");
  });
});
