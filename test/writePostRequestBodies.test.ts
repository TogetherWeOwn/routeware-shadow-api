import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars]. The data-entity POSTs carry an
// inner `requireSnapshotAuth` check, so they need the sync secret (which also
// passes the outer gate); every other route here uses the API token.
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";

/**
 * Every write POST that carries a body publishes a
 * machine-readable `requestBody` schema (urlencoded `type: "object"` for the
 * save/read forms, `type: "string"` under `text/csv` for the snapshot
 * imports), so codegen produces typed calls and hand-rolled forms stay on
 * the `CustomerID=0` / `Enabled=false` conventions.
 *
 * Hand-written (not a snapshot) so `vitest -u` cannot silently re-record a
 * regression away. Schemas are docs-only raw OpenAPI objects (never zod), so
 * `@hono/zod-openapi` installs no runtime validators — the last describe
 * pins that a foreign body still forwards on the newly covered routes, the
 * same way the earlier tests pinned it for the customer/address/container routes.
 */

type MediaEntry = {
  schema?: { type?: string; properties?: Record<string, unknown> };
  example?: unknown;
};
type Operation = {
  requestBody?: { content?: Record<string, MediaEntry> };
  responses?: Record<string, unknown>;
};

async function fetchDoc(): Promise<{ paths: Record<string, Record<string, Operation>> }> {
  const res = await exports.default.fetch("http://test.local/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as { paths: Record<string, Record<string, Operation>> };
}

function postOp(
  doc: { paths: Record<string, Record<string, Operation>> },
  path: string
): Operation {
  const item = doc.paths[path];
  expect(item, `missing path ${path}`).toBeDefined();
  const operation = item.post;
  expect(operation, `missing POST ${path}`).toBeDefined();
  return operation;
}

/** Body-carrying write POSTs: path, media type, schema type, key fields. */
const BODY_POSTS: Array<{
  path: string;
  media: string;
  schemaType: string;
  keys: string[];
}> = [
  {
    path: "/api/v1/routeware/customer/customers-read",
    media: "application/json",
    schemaType: "object",
    keys: ["filter", "start", "limit"]
  },
  {
    path: "/api/v1/routeware/customer/detail-full",
    media: "application/json",
    schemaType: "object",
    keys: ["CustomerID"]
  },
  {
    path: "/api/v1/routeware/customer/customer-types-read",
    media: "application/x-www-form-urlencoded",
    schemaType: "object",
    keys: ["EnabledOnly"]
  },
  {
    path: "/api/v1/routeware/customer/save-long-form",
    media: "application/x-www-form-urlencoded",
    schemaType: "object",
    keys: ["CustomerID", "Enabled"]
  },
  {
    path: "/api/v1/routeware/address/save-address-form",
    media: "application/x-www-form-urlencoded",
    schemaType: "object",
    keys: ["PickupAddressID", "CustomerID"]
  },
  {
    path: "/api/v1/routeware/container/save-container-form",
    media: "application/x-www-form-urlencoded",
    schemaType: "object",
    keys: ["ContainerID", "PickupAddressID"]
  },
  {
    path: "/api/v1/data/customer",
    media: "application/x-www-form-urlencoded",
    schemaType: "object",
    keys: ["CustomerID", "Enabled"]
  },
  {
    path: "/api/v1/data/address",
    media: "application/x-www-form-urlencoded",
    schemaType: "object",
    keys: ["PickupAddressID", "CustomerID"]
  },
  {
    path: "/api/v1/data/container",
    media: "application/x-www-form-urlencoded",
    schemaType: "object",
    keys: ["ContainerID", "PickupAddressID"]
  },
  {
    path: "/api/v1/routeware/data/app-settings-get",
    media: "application/json",
    schemaType: "object",
    keys: []
  },
  {
    path: "/api/v1/customer-snapshot/import",
    media: "text/csv",
    schemaType: "string",
    keys: []
  },
  {
    path: "/api/v1/address-snapshot/import",
    media: "text/csv",
    schemaType: "string",
    keys: []
  },
  {
    path: "/api/v1/container-snapshot/import",
    media: "text/csv",
    schemaType: "string",
    keys: []
  }
];

/**
 * Write POSTs that intentionally carry NO body: the handlers never read one
 * (syncs pull from Routeware exports / chain internal calls). A `requestBody`
 * here would be noise, not documentation — Scalar would render a body field
 * the server ignores.
 */
const BODYLESS_SYNC_POSTS = [
  "/api/v1/customer-snapshot/sync",
  "/api/v1/address-snapshot/sync",
  "/api/v1/container-snapshot/sync",
  "/api/v1/data-snapshot/sync"
];

describe("write POST requestBody schemas", () => {
  it.each(BODY_POSTS)(
    "$path publishes a machine-readable $media requestBody schema",
    async ({ path, media, schemaType, keys }) => {
      // Arrange
      const doc = await fetchDoc();

      // Act
      const operation = postOp(doc, path);
      const entry = operation.requestBody?.content?.[media];

      // Assert — schema present and typed for codegen, with the
      // convention-carrying fields hand-rolled forms must not drift from.
      expect(operation.requestBody, `${path} requestBody`).toBeDefined();
      expect(entry, `${path} ${media} media`).toBeDefined();
      expect(entry!.schema?.type, `${path} schema type`).toBe(schemaType);
      for (const key of keys) {
        expect(
          Object.keys(entry!.schema?.properties ?? {}),
          `${path} schema properties`
        ).toContain(key);
      }
    }
  );

  it.each(BODYLESS_SYNC_POSTS)(
    "%s publishes no requestBody (bodiless trigger)",
    async (path) => {
      // Arrange
      const doc = await fetchDoc();

      // Act
      const operation = postOp(doc, path);

      // Assert
      expect(operation.requestBody, `${path} requestBody`).toBeUndefined();
    }
  );
});

describe("write POST schemas install no runtime validators", () => {
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

  async function post(
    path: string,
    body: string,
    contentType: string,
    token: string = API_TOKEN
  ): Promise<Response> {
    return exports.default.fetch(`http://test.local${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": contentType
      },
      body
    });
  }

  it("forwards data-entity POSTs with a foreign form body (no validation gate)", async () => {
    // Arrange — none of the documented save shapes; a client token skips the
    // anti-forgery modal fetch, and no id resolves so no D1 sync is attempted.
    const foreign = "totally=foreign&shape=1&__RequestVerificationToken=client-token";

    // Act
    const customer = await post(
      "/api/v1/data/customer",
      foreign,
      "application/x-www-form-urlencoded",
      SYNC_SECRET
    );
    const address = await post(
      "/api/v1/data/address",
      foreign,
      "application/x-www-form-urlencoded",
      SYNC_SECRET
    );
    const container = await post(
      "/api/v1/data/container",
      foreign,
      "application/x-www-form-urlencoded",
      SYNC_SECRET
    );

    // Assert — the proxy path validates nothing; upstream decides. A body
    // with no usable entity id marks an address/container create, which
    // answers 201 on upstream success (R21-05); customer saves stay 200.
    expect(customer.status).toBe(200);
    expect(address.status).toBe(201);
    expect(container.status).toBe(201);
    expect(forwarded.some((u) => u.includes("/WebRW/Customer/SaveCustomerLongForm"))).toBe(true);
    expect(forwarded.some((u) => u.includes("/WebRW/PickupAddress/SaveAddressForm"))).toBe(true);
    expect(forwarded.some((u) => u.includes("/WebRW/Container/SaveContainerForm"))).toBe(true);
  });

  it("forwards app-settings-get with a foreign JSON body (no validation gate)", async () => {
    // Arrange / Act
    const res = await post(
      "/api/v1/routeware/data/app-settings-get",
      JSON.stringify({ unexpected: ["shape"] }),
      "application/json"
    );

    // Assert
    expect(res.status).toBe(200);
    expect(forwarded.some((u) => u.includes("/WebRW/Data/appSettingsGet"))).toBe(true);
  });
});
