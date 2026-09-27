import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-5819: mocked-upstream proof of how `customers-read` and `detail-full`
 * behave at scale, and of how pagination keys (`page`/`start`/`limit`,
 * `skip`/`take`) are treated by the shadow worker.
 *
 * What these tests pin:
 *
 * 1. The shadow worker has no row-cap logic of its own. Both routes stream the
 *    upstream response back with only `Set-Cookie` stripped
 *    (`src/lib/upstreamForward.ts`), so "does the worker truncate large
 *    payloads" has a fixed answer: it cannot — there is no code path that
 *    inspects, let alone caps, the row count. `detail-full` still forwards
 *    its body byte-identical; `customers-read` forwards byte-identical too
 *    except for the TOG-5936 skip/take translation below.
 * 2. TOG-5936: `skip`/`take` are translated server-side onto the Ext.NET
 *    `start`/`limit` spelling the harvested SPA traffic
 *    (`tools/api-discovery/examples/customers-read.post.example.json`) uses.
 *    Whether upstream honors `skip`/`take` was never established, so a client
 *    sending them risked a silent unpaged/default-window result; the worker
 *    now maps them before forwarding. Bodies without those keys still forward
 *    byte-identical.
 *
 * House pattern (see docs/TEST-INVARIANTS.md § "No test may reach the
 * network"): `globalThis.fetch` is stubbed and throws on any upstream URL the
 * test did not anticipate.
 */

const API_TOKEN = "test-api-token";

type UpstreamRequest = { url: string; method: string; body: string | null };

const seen: UpstreamRequest[] = [];
let responder: (req: UpstreamRequest) => Response = () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

function decodeBody(body: unknown): string | null {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (typeof body === "object" && ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  return String(body);
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function customerRow(i: number): Record<string, unknown> {
  return {
    CustomerID: i,
    CustomerTypeID: (i % 4) + 1,
    CompanyName: `Scale Co ${i}`,
    NameFirst: "Ada",
    NameLast: `Lovelace-${i}`,
    CustomerNumber: `C-${i}`,
    Phone1: "555-0100",
    Enabled: true
  };
}

function detailFullPayload(addresses: number, containersPerAddress: number) {
  const data = [];
  let containerId = 1;
  for (let a = 1; a <= addresses; a += 1) {
    const containers = [];
    for (let k = 0; k < containersPerAddress; k += 1) {
      containers.push({ ContainerID: containerId, PickupAddressID: 1000 + a });
      containerId += 1;
    }
    data.push({
      PickupAddressID: 1000 + a,
      CustomerID: 5,
      Address: `${a} Scale Ave`,
      Containers: containers
    });
  }
  return {
    currentCustomer: { CustomerID: 5, CompanyName: "Scale Co", Enabled: true },
    data
  };
}

async function postShadow(path: string, body: string): Promise<Response> {
  return exports.default.fetch(`http://test.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body
  });
}

beforeEach(() => {
  seen.length = 0;
  responder = () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("killeen.routeware.com") || !url.includes("/WebRW/")) {
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
      const req: UpstreamRequest = {
        url,
        method: init?.method ?? "GET",
        body: decodeBody(init?.body)
      };
      seen.push(req);
      return responder(req);
    }
  ) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("customers-read pagination passthrough", () => {
  it("forwards the harvested Ext.NET store body (page/start/limit) byte-identical", async () => {
    // Arrange — the exact shape the SPA sends (see the harvested example).
    const body = JSON.stringify({
      filter: [{ property: "CustomerID", operator: ">", value: 0 }],
      page: 1,
      start: 0,
      limit: 50,
      group: "[]",
      sort: '[{"property":"CustomerID","direction":"ASC"}]'
    });
    responder = () => jsonResponse({ total: 1, data: [customerRow(1)] });

    // Act
    const res = await postShadow("/api/v1/routeware/customer/customers-read", body);

    // Assert
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/WebRW/Customer/CustomersRead");
    expect(seen[0].body).toBe(body);
  });

  it("translates skip/take onto start/limit before forwarding (TOG-5936)", async () => {
    // Arrange — whether upstream honors skip/take was never established, so
    // the worker maps them onto the proven Ext.NET start/limit spelling.
    responder = () => jsonResponse({ total: 0, data: [] });

    // Act
    await postShadow(
      "/api/v1/routeware/customer/customers-read",
      JSON.stringify({ skip: 200, take: 100 })
    );

    // Assert — one window, one spelling: translated keys added, source keys
    // dropped so upstream never sees two spellings of the same window.
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0].body ?? "")).toEqual({ start: 200, limit: 100 });
  });

  it("lets an explicit start/limit win over skip/take", async () => {
    // Arrange
    responder = () => jsonResponse({ total: 0, data: [] });

    // Act
    await postShadow(
      "/api/v1/routeware/customer/customers-read",
      JSON.stringify({ skip: 200, take: 100, start: 0, limit: 50 })
    );

    // Assert — the explicit window survives; the conflicting skip/take pair
    // is dropped, not merged.
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0].body ?? "")).toEqual({ start: 0, limit: 50 });
  });

  it("forwards an invalid skip/take body unchanged instead of half-mapping", async () => {
    // Arrange — a present-but-invalid key translates nothing.
    const body = JSON.stringify({ skip: -5, take: 100 });
    responder = () => jsonResponse({ total: 0, data: [] });

    // Act
    await postShadow("/api/v1/routeware/customer/customers-read", body);

    // Assert
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe(body);
  });

  it("keeps consecutive pages distinct: each start/limit window is its own upstream call", async () => {
    // Arrange — paging is N independent passthroughs; the worker holds no
    // cursor, cache or merged state between them.
    const pages: Record<string, unknown> = {
      '{"start":0,"limit":50}': { total: 120, data: [customerRow(1), customerRow(2)] },
      '{"start":50,"limit":50}': { total: 120, data: [customerRow(51)] }
    };
    responder = (req) => jsonResponse(pages[req.body ?? ""] ?? { total: 120, data: [] });

    // Act
    const first = await postShadow(
      "/api/v1/routeware/customer/customers-read",
      '{"start":0,"limit":50}'
    );
    const second = await postShadow(
      "/api/v1/routeware/customer/customers-read",
      '{"start":50,"limit":50}'
    );

    // Assert
    expect(seen.map((r) => r.body)).toEqual(['{"start":0,"limit":50}', '{"start":50,"limit":50}']);
    expect(((await first.json()) as { data: unknown[] }).data).toHaveLength(2);
    expect(((await second.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it("returns a 2,500-row upstream page intact (no worker-side row cap)", async () => {
    // Arrange
    const rows = Array.from({ length: 2500 }, (_, i) => customerRow(i + 1));
    const payload = { total: 10000, data: rows };
    const upstreamText = JSON.stringify(payload);
    responder = () => jsonResponse(payload);

    // Act
    const res = await postShadow(
      "/api/v1/routeware/customer/customers-read",
      '{"start":0,"limit":2500}'
    );

    // Assert — byte-identity, not just row count: any worker truncation,
    // re-serialization or envelope rewrite would change the bytes.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(upstreamText);
  });

  it("streams a multi-megabyte upstream page (~8,000 rows) without truncation", async () => {
    // Arrange — ~1.3 MB of JSON; the worker streams `res.body` through
    // `stripUpstreamSetCookie` without buffering, so size must not matter.
    const rows = Array.from({ length: 8000 }, (_, i) => customerRow(i + 1));
    const payload = { total: 600000, data: rows };
    const upstreamText = JSON.stringify(payload);
    expect(upstreamText.length).toBeGreaterThan(1_000_000);
    responder = () => jsonResponse(payload);

    // Act
    const res = await postShadow(
      "/api/v1/routeware/customer/customers-read",
      '{"start":0,"limit":8000}'
    );

    // Assert
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBe(upstreamText.length);
    expect(text).toBe(upstreamText);
  });
});

describe("detail-full passthrough at scale", () => {
  it("returns a large customer graph (300 addresses x 12 containers) byte-identical", async () => {
    // Arrange
    const payload = detailFullPayload(300, 12);
    const upstreamText = JSON.stringify(payload);
    responder = () => jsonResponse(payload);

    // Act
    const res = await postShadow(
      "/api/v1/routeware/customer/detail-full",
      JSON.stringify({ customerID: 5, showDisabled: true })
    );

    // Assert
    expect(res.status).toBe(200);
    expect(seen[0].url).toContain("/WebRW/Customer/GetCustomerDetailFull");
    expect(await res.text()).toBe(upstreamText);
  });
});
