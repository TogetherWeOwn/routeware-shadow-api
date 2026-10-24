import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

/**
 * The customer, address and container routes publish
 * request/response `example` or named `examples` payloads so Scalar shows realistic bodies.
 *
 * The examples are docs-only: every schema is a raw OpenAPI object (never a
 * zod schema), so `@hono/zod-openapi` renders it into `/openapi.json`
 * verbatim while its `isZod` check skips validator installation. The second
 * half of this file pins that: POSTs with missing or foreign bodies still
 * reach the forwarder untouched — a docs change must never become a
 * validation gate on the proxy path.
 */

type ExampleSchema = {
  $ref?: string;
  type?: string | string[];
  nullable?: boolean;
  anyOf?: ExampleSchema[];
  oneOf?: ExampleSchema[];
  properties?: Record<string, ExampleSchema>;
  required?: string[];
  items?: ExampleSchema;
  example?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
};
type MediaExample = {
  schema?: ExampleSchema;
  example?: unknown;
  examples?: Record<string, { value?: unknown }>;
};
type Operation = {
  tags?: string[];
  parameters?: Array<{ name: string; in: string; schema?: ExampleSchema; example?: unknown }>;
  requestBody?: { content?: Record<string, MediaExample> };
  responses?: Record<string, { content?: Record<string, MediaExample> }>;
};
type ExampleDoc = {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, ExampleSchema> };
};

async function fetchDoc(): Promise<ExampleDoc> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as ExampleDoc;
}

function op(
  doc: { paths: Record<string, Record<string, Operation>> },
  path: string,
  method = "post"
): Operation {
  const item = doc.paths[path];
  expect(item, `missing path ${path}`).toBeDefined();
  const operation = item[method];
  expect(operation, `missing ${method.toUpperCase()} ${path}`).toBeDefined();
  return operation;
}

/** Minimal structural check: example value matches its sibling schema. */
function assertExampleMatchesSchema(
  route: string,
  mediaType: string,
  media: MediaExample | undefined,
  schemas: Record<string, ExampleSchema> = {}
): void {
  expect(media, `${route} ${mediaType} media`).toBeDefined();
  const { schema, example, examples } = media!;
  expect(schema, `${route} ${mediaType} schema`).toBeDefined();
  if (examples !== undefined) {
    expect(example, `${route} ${mediaType} example and examples are mutually exclusive`).toBeUndefined();
    const entries = Object.entries(examples);
    expect(entries.length, `${route} ${mediaType} named examples`).toBeGreaterThan(0);
    for (const [name, named] of entries) {
      const label = `${route} ${mediaType} example ${name}`;
      expect(named.value, `${label} value`).toBeDefined();
      assertValueMatchesSchema(schema!, named.value, label, schemas);
    }
  } else {
    expect(example, `${route} ${mediaType} example`).toBeDefined();
    assertValueMatchesSchema(schema!, example, `${route} ${mediaType}`, schemas);
  }
}

function assertValueMatchesSchema(
  schema: ExampleSchema,
  value: unknown,
  label: string,
  schemas: Record<string, ExampleSchema> = {}
): void {
  if (schema.$ref) {
    const referenced = schemas[schema.$ref.replace("#/components/schemas/", "")];
    expect(referenced, `${label} reference`).toBeDefined();
    return assertValueMatchesSchema(referenced, value, label, schemas);
  }
  if (schema.nullable && value === null) return;
  for (const [kind, branches] of [["anyOf", schema.anyOf], ["oneOf", schema.oneOf]] as const) {
    if (!branches) continue;
    const matches = branches.filter((branch) => {
      try {
        assertValueMatchesSchema(branch, value, label, schemas);
        return true;
      } catch {
        return false;
      }
    });
    if (kind === "oneOf") expect(matches.length, `${label} oneOf matches`).toBe(1);
    else expect(matches.length, `${label} anyOf matches`).toBeGreaterThan(0);
  }
  if (schema.enum) expect(schema.enum, label).toContain(value);
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  if (Array.isArray(schema.type) && schema.type.includes("null") && value === null) return;
  // Null-only schemas (`z.null()` renders as `{type: "null"}`): the value
  // must be exactly null. Nullable unions are handled by the early return
  // above; anything else reaching the dispatcher with a null-only type fails
  // closed instead of falling into the `typeof` check (`typeof null` is
  // "object", never "null").
  if (type === "null" || (Array.isArray(schema.type) && schema.type.every((candidate) => candidate === "null"))) {
    expect(value, label).toBeNull();
    return;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined) expect(value, label).toBeGreaterThanOrEqual(schema.minimum);
    if (schema.maximum !== undefined) expect(value, label).toBeLessThanOrEqual(schema.maximum);
  }
  if (type === "object") {
    expect(value, label).not.toBeNull();
    expect(typeof value, label).toBe("object");
    expect(Array.isArray(value), label).toBe(false);
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      expect(Object.hasOwn(object, key), `${label}.${key}`).toBe(true);
    }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(object, key)) {
        assertValueMatchesSchema(property, object[key], `${label}.${key}`, schemas);
      }
    }
  } else if (type === "array") {
    expect(Array.isArray(value), label).toBe(true);
    for (const [index, item] of (value as unknown[]).entries()) {
      if (schema.items) assertValueMatchesSchema(schema.items, item, `${label}[${index}]`, schemas);
    }
  } else if (type === "integer") {
    expect(Number.isInteger(value), label).toBe(true);
  } else if (type) {
    expect(typeof value, label).toBe(type);
  }
}

describe("media example schema checks", () => {
  const schemas: Record<string, ExampleSchema> = {
    Result: {
      type: "object",
      required: ["id", "localSync"],
      properties: {
        id: { type: ["integer", "null"], minimum: 1 },
        localSync: { $ref: "#/components/schemas/LocalSync" }
      }
    },
    LocalSync: {
      anyOf: [
        { type: "object", required: ["done"], properties: { done: { type: "boolean", enum: [true] } } },
        {
          type: "object",
          required: ["done", "code"],
          properties: { done: { type: "boolean", enum: [false] }, code: { type: "string", enum: ["sync_failed"] } }
        }
      ]
    }
  };
  const schema = { $ref: "#/components/schemas/Result" };
  const refreshed = { id: 5, localSync: { done: true } };
  const failed = { id: null, localSync: { done: false, code: "sync_failed" } };

  it("checks named values through shared refs, including nullable fields and both union branches", () => {
    const media = { schema, examples: { refreshed: { value: refreshed }, failed: { value: failed } } };
    expect(() => assertExampleMatchesSchema("fixture", "application/json", media, schemas)).not.toThrow();
  });

  it.each([
    ["missing examples", { schema }],
    ["empty named examples", { schema, examples: {} }],
    ["a named example without a value", { schema, examples: { missing: {} } }],
    ["both singular and named examples", { schema, example: refreshed, examples: { refreshed: { value: refreshed } } }],
    ["missing media", undefined],
    ["missing schema", { examples: { refreshed: { value: refreshed } } }]
  ] as Array<[string, MediaExample | undefined]>)("rejects %s", (_name, media) => {
    expect(() => assertExampleMatchesSchema("fixture", "application/json", media, schemas)).toThrow();
  });

  it.each([
    ["wrong integer type", { ...failed, id: "5" }],
    ["below-minimum integer", { ...failed, id: 0 }],
    ["missing required field", { localSync: failed.localSync }],
    ["wrong discriminator type", { id: null, localSync: { done: "false", code: "sync_failed" } }],
    ["unknown union code", { id: null, localSync: { done: false, code: "exception text" } }],
    ["missing union field", { id: null, localSync: { done: false } }]
  ])("rejects a later named value with %s", (_name, value) => {
    const media = { schema, examples: { refreshed: { value: refreshed }, invalid: { value } } };
    expect(() => assertExampleMatchesSchema("fixture", "application/json", media, schemas)).toThrow();
  });

  it("retains singular examples and OpenAPI nullable fields", () => {
    expect(() => assertExampleMatchesSchema("fixture", "application/json", {
      schema: { type: "integer", nullable: true }, example: null
    })).not.toThrow();
  });

  it("accepts null-only type schemas with a null value", () => {
    expect(() => assertExampleMatchesSchema("fixture", "application/json", {
      schema: { type: "null" }, example: null
    })).not.toThrow();
    expect(() => assertExampleMatchesSchema("fixture", "application/json", {
      schema: { type: ["null"] }, example: null
    })).not.toThrow();
  });

  it("matches a null value against the null branch of a union", () => {
    expect(() => assertExampleMatchesSchema("fixture", "application/json", {
      schema: { anyOf: [{ type: "integer" }, { type: "null" }] }, example: null
    })).not.toThrow();
  });

  it.each([
    ["a null-only type with an integer", { type: "null" }, 0],
    ["a null-only type with a string", { type: "null" }, "null"],
    ["a null-only type with false", { type: "null" }, false],
    ["a null-only array type with an integer", { type: ["null"] }, 5]
  ] as Array<[string, ExampleSchema, unknown]>)("rejects %s", (_name, schema, value) => {
    expect(() => assertExampleMatchesSchema("fixture", "application/json", {
      schema, example: value
    })).toThrow();
  });

  it("rejects a oneOf value matching more than one branch", () => {
    expect(() => assertExampleMatchesSchema("fixture", "application/json", {
      schema: { oneOf: [{ type: "integer" }, { type: "number" }] }, example: 5
    })).toThrow();
  });
});

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

describe("OpenAPI example payloads", () => {
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

const REMAINING_RESPONSES = [
  ...["customer", "address", "container"].flatMap((entity) => [
    { path: `/api/v1/${entity}-snapshot`, method: "get", mediaType: "application/json" },
    {
      path: `/api/v1/${entity}-snapshot/{${entity === "address" ? "pickupAddress" : entity}Id}`,
      method: "get",
      mediaType: "application/json"
    },
    { path: `/api/v1/${entity}-snapshot/export`, method: "get", mediaType: "text/csv" },
    { path: `/api/v1/${entity}-snapshot/import`, method: "post", mediaType: "application/json" },
    { path: `/api/v1/${entity}-snapshot/sync`, method: "post", mediaType: "application/json" },
    { path: `/api/v1/data/${entity}`, method: "get", mediaType: "application/json" },
    { path: `/api/v1/data/${entity}`, method: "post", mediaType: "application/json" }
  ]),
  { path: "/api/v1/snapshots/{table}/{date}", method: "get", mediaType: "text/csv" },
  { path: "/api/v1/snapshots/{table}", method: "get", mediaType: "application/json" },
  { path: "/api/v1/snapshots/{table}/latest", method: "get", mediaType: "text/csv" },
  { path: "/api/v1/customer-snapshot/changes", method: "get", mediaType: "application/json" },
  { path: "/api/v1/customer-snapshot/{customerId}", method: "delete", mediaType: "application/json" },
  { path: "/api/v1/data-snapshot/sync", method: "post", mediaType: "application/json" },
  { path: "/api/v1/data-snapshot/orphans", method: "get", mediaType: "application/json" },
  { path: "/api/v1/routeware/home/index", method: "get", mediaType: "text/html" },
  { path: "/api/v1/routeware/account/login-page", method: "get", mediaType: "text/html" },
  { path: "/api/v1/routeware/data/app-settings-get", method: "post", mediaType: "application/json" },
  { path: "/api/v1/routeware/reports/query-request-is-complete", method: "get", mediaType: "application/json" }
];

const REMAINING_REQUESTS = [
  ...["customer", "address", "container"].flatMap((entity) => [
    { path: `/api/v1/${entity}-snapshot/import`, mediaType: "text/csv" },
    { path: `/api/v1/data/${entity}`, mediaType: "application/x-www-form-urlencoded" }
  ]),
  { path: "/api/v1/routeware/data/app-settings-get", mediaType: "application/json" }
];

describe("snapshot, data-entity and Routeware examples", () => {
  it.each(REMAINING_RESPONSES)(
    "$method $path publishes a 200 $mediaType example",
    async ({ path, method, mediaType }) => {
      const doc = await fetchDoc();
      const media = op(doc, path, method).responses?.["200"]?.content?.[mediaType];
      assertExampleMatchesSchema(path, mediaType, media, doc.components?.schemas);
    }
  );

  it("pins the complete operation inventory of the remaining route modules", async () => {
    const doc = await fetchDoc();
    const tags = new Set([
      "customer-snapshot", "address-snapshot", "container-snapshot", "data-snapshot",
      "data-entity", "routeware", "data", "reports"
    ]);
    const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, operation]) => operation.tags?.some((tag) => tags.has(tag)))
        .map(([method]) => `${method} ${path}`)
    );
    expect(operations.sort()).toEqual(
      REMAINING_RESPONSES.map(({ method, path }) => `${method} ${path}`).sort()
    );
  });

  it("publishes schema-compatible examples for every query and path parameter", async () => {
    const doc = await fetchDoc();
    expect(
      op(doc, "/api/v1/customer-snapshot/changes", "get").parameters?.filter(
        (parameter) => parameter.in === "query" && parameter.name === "fields"
      )
    ).toHaveLength(1);
    let checked = 0;
    for (const { method, path } of REMAINING_RESPONSES) {
      for (const parameter of op(doc, path, method).parameters ?? []) {
        if (parameter.in !== "query" && parameter.in !== "path") continue;
        const example = parameter.example ?? parameter.schema?.example;
        expect(example, `${method} ${path} ${parameter.name}`).toBeDefined();
        assertValueMatchesSchema(parameter.schema!, example, `${path} ${parameter.name}`);
        checked++;
      }
    }
    // 46 parameters before includeTotal; +3 for the opt-in on the three ordinary lists;
    // +3 for the batch `ids` param on the three data-entity GETs.
    // +6 for fields on the three lists and three details; +1 for partialProgress on the combined sync;
    // +3 for order on the three ordinary lists;
    // +3 for fields on the three hydrated single-ID GETs;
    // +2 for routeId and franchiseId on the address snapshot list;
    // +3 for dryRun on the three data-entity POST saves;
    // +2 for table + limit on the archived-date listing;
    // +1 for table on the latest-pointer readback;
    // +1 for fields on the customer changes feed;
    // +2 for serialNumber and rfid on the container snapshot list.
    expect(checked).toBe(75);
  });

  it("keeps sync requests bodyless and conditional data responses bodyless", async () => {
    const doc = await fetchDoc();
    for (const path of ["customer-snapshot", "address-snapshot", "container-snapshot", "data-snapshot"]) {
      expect(op(doc, `/api/v1/${path}/sync`).requestBody).toBeUndefined();
    }
    for (const entity of ["customer", "address", "container"]) {
      expect(op(doc, `/api/v1/data/${entity}`, "get").responses?.["304"].content).toBeUndefined();
    }
  });

  it.each(REMAINING_REQUESTS)(
    "POST $path publishes a $mediaType request example",
    async ({ path, mediaType }) => {
      const doc = await fetchDoc();
      assertExampleMatchesSchema(path, mediaType, op(doc, path).requestBody?.content?.[mediaType]);
    }
  );
});

describe("example bodies install no runtime validators", () => {
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

  it("forwards an app-settings body outside the documented example", async () => {
    const res = await post("/api/v1/routeware/data/app-settings-get", "foreign=1");
    expect(res.status).toBe(200);
    expect(forwarded.some((url) => url.includes("/WebRW/Data/appSettingsGet"))).toBe(true);
  });

  it("forwards non-object JSON app-settings bytes without validation", async () => {
    // A matching Content-Type exercises JSON validation; an optional object
    // validator would reject null instead of forwarding it.
    // Source: https://hono.dev/docs/guides/validation
    const res = await exports.default.fetch("http://test.local/api/v1/routeware/data/app-settings-get", {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json"
      },
      body: "null"
    });
    expect(res.status).toBe(200);
    expect(forwarded.some((url) => url.includes("/WebRW/Data/appSettingsGet"))).toBe(true);
    const upstreamCall = vi.mocked(globalThis.fetch).mock.calls.find(
      ([input]) => typeof input === "string" && input.includes("/WebRW/Data/appSettingsGet")
    );
    expect(upstreamCall).toBeDefined();
    const upstreamBody = upstreamCall![1]?.body;
    expect(upstreamBody).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(upstreamBody as ArrayBuffer)).toStrictEqual(new TextEncoder().encode("null"));
  });

  it("keeps data-entity form examples docs-only", async () => {
    const res = await exports.default.fetch("http://test.local/api/v1/data/customer", {
      method: "POST",
      headers: {
        authorization: "Bearer test-sync-secret",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "foreign=1&__RequestVerificationToken=client-token"
    });
    expect(res.status).toBe(200);
    expect(forwarded.some((url) => url.includes("/WebRW/Customer/SaveCustomerLongForm"))).toBe(true);
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
