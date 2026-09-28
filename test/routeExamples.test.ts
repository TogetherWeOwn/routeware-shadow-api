import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

/**
 * TOG-6272 — the customer, address and container routes publish
 * request/response `example` payloads so Scalar shows realistic bodies.
 *
 * The examples are docs-only: every schema is a raw OpenAPI object (never a
 * zod schema), so `@hono/zod-openapi` renders it into `/openapi.json`
 * verbatim while its `isZod` check skips validator installation. The second
 * half of this file pins that: POSTs with missing or foreign bodies still
 * reach the forwarder untouched — a docs change must never become a
 * validation gate on the proxy path.
 */

type MediaExample = { schema?: { type?: string }; example?: unknown };
type Operation = {
  requestBody?: { content?: Record<string, MediaExample> };
  responses?: Record<string, { content?: Record<string, MediaExample> }>;
};

async function fetchDoc(): Promise<{ paths: Record<string, Record<string, Operation>> }> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as { paths: Record<string, Record<string, Operation>> };
}

function op(
  doc: { paths: Record<string, Record<string, Operation>> },
  path: string
): Operation {
  const item = doc.paths[path];
  expect(item, `missing path ${path}`).toBeDefined();
  const operation = item.post;
  expect(operation, `missing POST ${path}`).toBeDefined();
  return operation;
}

/** Minimal structural check: example value matches its sibling schema. */
function assertExampleMatchesSchema(
  route: string,
  mediaType: string,
  media: MediaExample | undefined
): void {
  expect(media, `${route} ${mediaType} media`).toBeDefined();
  const { schema, example } = media!;
  expect(schema, `${route} ${mediaType} schema`).toBeDefined();
  expect(example, `${route} ${mediaType} example`).toBeDefined();
  if (schema!.type === "object") {
    expect(
      typeof example,
      `${route} ${mediaType} example shape`
    ).toBe("object");
  }
}

const ROUTES: Array<{ path: string; group: string; requestMedia: string }> = [
  {
    path: "/api/v1/routeware/customer/customers-read",
    group: "customer",
    requestMedia: "application/json"
  },
  {
    path: "/api/v1/routeware/customer/detail-full",
    group: "customer",
    requestMedia: "application/json"
  },
  {
    path: "/api/v1/routeware/customer/customer-types-read",
    group: "customer",
    requestMedia: "application/x-www-form-urlencoded"
  },
  {
    path: "/api/v1/routeware/customer/save-long-form",
    group: "customer",
    requestMedia: "application/x-www-form-urlencoded"
  },
  {
    path: "/api/v1/routeware/address/save-address-form",
    group: "address",
    requestMedia: "application/x-www-form-urlencoded"
  },
  {
    path: "/api/v1/routeware/container/save-container-form",
    group: "container",
    requestMedia: "application/x-www-form-urlencoded"
  }
];

describe("OpenAPI example payloads (TOG-6272)", () => {
  it.each(ROUTES)(
    "$path publishes a request example matching its schema",
    async ({ path, requestMedia }) => {
      // Arrange
      const doc = await fetchDoc();

      // Act
      const operation = op(doc, path);
      const media = operation.requestBody?.content?.[requestMedia];

      // Assert
      expect(
        operation.requestBody,
        `${path} requestBody`
      ).toBeDefined();
      assertExampleMatchesSchema(path, requestMedia, media);
    }
  );

  it.each(ROUTES)(
    "$path publishes a 200 JSON response example matching its schema",
    async ({ path }) => {
      // Arrange
      const doc = await fetchDoc();

      // Act
      const operation = op(doc, path);
      const media = operation.responses?.["200"]?.content?.["application/json"];

      // Assert
      assertExampleMatchesSchema(path, "application/json response", media);
    }
  );

  it("all three route groups (customer, address, container) carry examples", async () => {
    // Arrange
    const doc = await fetchDoc();

    // Act
    const groups = new Set(
      ROUTES.map(({ path }) => {
        const operation = op(doc, path);
        const hasRequest = Object.keys(operation.requestBody?.content ?? {}).length > 0;
        const hasResponse =
          Object.keys(operation.responses?.["200"]?.content ?? {}).length > 0;
        expect(hasRequest && hasResponse, `${path} examples`).toBe(true);
        return ROUTES.find((r) => r.path === path)!.group;
      })
    );

    // Assert
    expect([...groups].sort()).toEqual(["address", "container", "customer"]);
  });
});

describe("example bodies install no runtime validators (TOG-6272)", () => {
  const originalFetch = globalThis.fetch;
  const forwarded: string[] = [];

  beforeEach(() => {
    forwarded.length = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/WebRW/")) {
        forwarded.push(url);
        return new Response('{"success":true}', {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function post(path: string, body?: string): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${API_TOKEN}` });
    // A real client token skips the anti-forgery modal fetch on save routes.
    const tokenBody =
      "CustomerID=5&PickupAddressID=10&ContainerID=100&__RequestVerificationToken=client-token";
    return exports.default.fetch(`http://test.local${path}`, {
      method: "POST",
      headers,
      body: body ?? tokenBody
    });
  }

  it("forwards a body that matches no example schema (no validation gate)", async () => {
    // Arrange — none of the documented example shapes.
    const foreign = "totally=foreign&shape=1";

    // Act
    const res = await post("/api/v1/routeware/customer/customers-read", foreign);

    // Assert — still proxied, never a 400 from a docs schema.
    expect(res.status).toBe(200);
    expect(forwarded.some((u) => u.includes("/WebRW/Customer/CustomersRead"))).toBe(true);
  });

  it("forwards the save routes with a foreign form body", async () => {
    // Arrange / Act
    const customer = await post(
      "/api/v1/routeware/customer/save-long-form",
      "CustomerID=0&WeirdField=xyz"
    );
    const address = await post(
      "/api/v1/routeware/address/save-address-form",
      "PickupAddressID=0&CustomerID=5&WeirdField=xyz"
    );
    const container = await post(
      "/api/v1/routeware/container/save-container-form",
      "ContainerID=0&PickupAddressID=10&WeirdField=xyz"
    );

    // Assert — the proxy path validates nothing; upstream decides.
    expect(customer.status).toBe(200);
    expect(address.status).toBe(200);
    expect(container.status).toBe(200);
  });
});
