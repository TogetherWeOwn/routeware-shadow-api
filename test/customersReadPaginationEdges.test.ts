import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Worker-level pagination contract, not a claim about live Routeware validation.
 * Invalid aliases are forwarded byte-identical; valid aliases are translated
 * atomically, with explicit start/limit winning even when their values are odd.
 * Each edge pins both a mocked JSON 200 and a contained upstream 400 (docs/PROBLEMS.md#upstream-error).
 * No upstream request may escape the stub (docs/TEST-INVARIANTS.md).
 */
const cases: [label: string, body: string, forwarded: string][] = [
  ["negative skip", '{ "skip": -1, "take": 5 }', '{ "skip": -1, "take": 5 }'],
  ["negative take", '{ "skip": 5, "take": -1 }', '{ "skip": 5, "take": -1 }'],
  ["zero pair", '{"skip":0,"take":0}', '{"start":0,"limit":0}'],
  ["lone zero skip", '{"skip":0}', '{"start":0}'],
  ["lone zero take", '{"take":0}', '{"limit":0}'],
  [
    "maximum safe integers",
    '{"skip":9007199254740991,"take":9007199254740991}',
    '{"start":9007199254740991,"limit":9007199254740991}'
  ],
  [
    "integers beyond the safe range are not capped",
    '{"skip":9007199254740992,"take":9007199254740992}',
    '{"start":9007199254740992,"limit":9007199254740992}'
  ],
  ["huge finite skip", '{"skip":1e308,"take":1}', '{"start":1e+308,"limit":1}'],
  ["huge finite take", '{"skip":0,"take":1e308}', '{"start":0,"limit":1e+308}'],
  ["overflowing skip", '{ "skip": 1e309, "take": 5 }', '{ "skip": 1e309, "take": 5 }'],
  ["overflowing take", '{ "skip": 5, "take": 1e309 }', '{ "skip": 5, "take": 1e309 }'],
  ["fractional skip", '{"skip":0.5,"take":5}', '{"skip":0.5,"take":5}'],
  ["fractional take", '{"skip":5,"take":0.5}', '{"skip":5,"take":0.5}'],
  ["numeric string skip", '{"skip":"5","take":10}', '{"skip":"5","take":10}'],
  ["numeric string take", '{"skip":5,"take":"10"}', '{"skip":5,"take":"10"}'],
  ["non-numeric string", '{"skip":"abc","take":5}', '{"skip":"abc","take":5}'],
  ["null skip", '{"skip":null,"take":5}', '{"skip":null,"take":5}'],
  ["null take", '{"skip":5,"take":null}', '{"skip":5,"take":null}'],
  ["boolean skip", '{"skip":false,"take":5}', '{"skip":false,"take":5}'],
  ["boolean take", '{"skip":5,"take":true}', '{"skip":5,"take":true}'],
  ["array skip", '{"skip":[],"take":5}', '{"skip":[],"take":5}'],
  ["object take", '{"skip":5,"take":{}}', '{"skip":5,"take":{}}'],
  [
    "explicit zero window beats nonzero aliases",
    '{"skip":20,"take":10,"start":0,"limit":0}',
    '{"start":0,"limit":0}'
  ],
  [
    "explicit start with translated take",
    '{"skip":20,"take":10,"start":3}',
    '{"start":3,"limit":10}'
  ],
  [
    "explicit limit with translated skip",
    '{"skip":20,"take":10,"limit":7}',
    '{"limit":7,"start":20}'
  ],
  [
    "explicit null and negative targets are not validated",
    '{"skip":20,"take":10,"start":null,"limit":-1}',
    '{"start":null,"limit":-1}'
  ],
  [
    "explicit non-numeric targets are not coerced",
    '{"skip":20,"take":10,"start":"abc","limit":false}',
    '{"start":"abc","limit":false}'
  ],
  [
    "invalid skip prevents take mapping despite explicit targets",
    '{ "skip": -1, "take": 10, "start": 3, "limit": 7 }',
    '{ "skip": -1, "take": 10, "start": 3, "limit": 7 }'
  ],
  [
    "invalid take prevents skip mapping despite explicit start",
    '{ "skip": 20, "take": "abc", "start": 3 }',
    '{ "skip": 20, "take": "abc", "start": 3 }'
  ],
  [
    "other store keys survive translation",
    '{"skip":0,"take":0,"page":2,"filter":[],"sort":"[]","group":"[]"}',
    '{"page":2,"filter":[],"sort":"[]","group":"[]","start":0,"limit":0}'
  ],
  [
    "target-only window remains byte-identical",
    '{ "start": -1, "limit": "abc" }',
    '{ "start": -1, "limit": "abc" }'
  ]
];

const seen: { method: string; body: string }[] = [];
let upstreamStatus: 200 | 400;
let upstreamBody: string;

async function postShadow(body: string): Promise<Response> {
  return exports.default.fetch("http://test.local/api/v1/routeware/customer/customers-read", {
    method: "POST",
    headers: {
      authorization: "Bearer test-api-token",
      "content-type": "application/json",
      accept: "application/json"
    },
    body
  });
}

beforeEach(() => {
  seen.length = 0;
  upstreamStatus = 200;
  upstreamBody = '{"total":2,"data":[{"CustomerID":101},{"CustomerID":202}]}';
  // exports.default.fetch runs in the test isolate, so global mocks apply:
  // https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "killeen.routeware.com" || url.pathname !== "/WebRW/Customer/CustomersRead") {
      throw new Error(`Unexpected upstream fetch in test: ${request.url}`);
    }
    seen.push({ method: request.method, body: await request.text() });
    return new Response(upstreamBody, {
      status: upstreamStatus,
      headers: { "content-type": "application/json" }
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("customers-read adversarial pagination", () => {
  it.each(cases)("pins a JSON 200 and forwarded body for %s", async (_label, body, forwarded) => {
    const response = await postShadow(body);

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ method: "POST", body: forwarded }]);
    expect(response.headers.get("content-type")).toBe("application/json");
    const text = await response.text();
    expect(text).toBe(upstreamBody);
    expect(JSON.parse(text)).toEqual({
      total: 2,
      data: [{ CustomerID: 101 }, { CustomerID: 202 }]
    });
  });

  it.each(cases)("contains an upstream 400 for %s", async (_label, body, forwarded) => {
    upstreamStatus = 400;
    upstreamBody = '{"success":false,"message":"Invalid pagination window"}';
    const response = await postShadow(body);

    expect(response.status).toBe(400);
    expect(seen).toEqual([{ method: "POST", body: forwarded }]);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await response.text())).toEqual({
      type: "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#upstream-error",
      title: "Upstream request failed",
      status: 400,
      detail: "Routeware returned an error. Its response body has been withheld."
    });
  });
});
