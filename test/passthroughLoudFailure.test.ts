import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { establishSession } from "../src/lib/establishSession";

vi.mock("../src/lib/establishSession", () => ({
  establishSession: vi.fn(async () => {})
}));

// Synthetic only: pin customer/session containment without real upstream data.
const MARKERS = ["Jane Example", "555-0199", "FAKE-SESSION-VALUE"];
const PII_HTML = `<html><body>${MARKERS.join(" ")}</body></html>`;
const routes: { path: string; upstream: string; method: string; body?: string; contentType?: string }[] = [
  {
    path: "/api/v1/routeware/customer/customers-read",
    upstream: "/WebRW/Customer/CustomersRead",
    method: "POST",
    body: "{}"
  },
  {
    path: "/api/v1/routeware/home/index",
    upstream: "/WebRW/Home/Index",
    method: "GET"
  },
  {
    path: "/api/v1/routeware/customer/detail-full",
    upstream: "/WebRW/Customer/GetCustomerDetailFull",
    method: "POST", body: '{"CustomerID":5}'
  },
  {
    path: "/api/v1/routeware/customer/customer-types-read",
    upstream: "/WebRW/Customer/CustomerTypesRead",
    method: "POST", body: "EnabledOnly=true", contentType: "application/x-www-form-urlencoded"
  },
  {
    path: "/api/v1/routeware/data/app-settings-get",
    upstream: "/WebRW/Data/appSettingsGet",
    method: "POST", body: "{}"
  },
  {
    path: "/api/v1/routeware/reports/query-request-is-complete?requestID=synthetic",
    upstream: "/WebRW/Reports/QueryRequestIsComplete",
    method: "GET"
  },
  {
    path: "/api/v1/routeware/customer/add-new-long",
    upstream: "/WebRW/Customer/AddNewLong",
    method: "GET"
  },
  {
    path: "/api/v1/routeware/customer/load-long-modal?customerID=5",
    upstream: "/WebRW/Customer/LoadLongCustomerModal",
    method: "GET"
  },
  {
    path: "/api/v1/routeware/customer/save-long-form",
    upstream: "/WebRW/Customer/SaveCustomerLongForm",
    method: "POST", body: "CustomerID=5&__RequestVerificationToken=client-token",
    contentType: "application/x-www-form-urlencoded"
  },
  {
    path: "/api/v1/routeware/address/save-address-form",
    upstream: "/WebRW/PickupAddress/SaveAddressForm",
    method: "POST", body: "PickupAddressID=10&CustomerID=5&__RequestVerificationToken=client-token",
    contentType: "application/x-www-form-urlencoded"
  },
  {
    path: "/api/v1/routeware/container/save-container-form",
    upstream: "/WebRW/Container/SaveContainerForm",
    method: "POST", body: "ContainerID=100&PickupAddressID=10&__RequestVerificationToken=client-token",
    contentType: "application/x-www-form-urlencoded"
  }
];

let status = 503;
let contentType = "text/html";
let upstreamBody = PII_HTML;
let loginFirst: false | "redirect" | "html" = false;
let target = routes[0].upstream;
let attempts = 0;

async function call(route: (typeof routes)[number]): Promise<Response> {
  return exports.default.fetch(`http://test.local${route.path}`, {
    method: route.method,
    body: route.body,
    headers: {
      authorization: "Bearer test-api-token",
      "content-type": route.contentType ?? "application/json"
    }
  });
}

async function expectContained(response: Response): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("x-upstream-debug")).toBeNull();
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  for (const marker of MARKERS) {
    expect(text).not.toContain(marker);
    expect(response.statusText).not.toContain(marker);
  }
  expect(JSON.parse(text)).toMatchObject({
    type: "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#upstream-error",
    title: "Upstream request failed",
    status,
    detail: "Routeware returned an error. Its response body has been withheld."
  });
}

describe("client-facing passthrough loud-error containment", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    status = 503;
    contentType = "text/html";
    upstreamBody = PII_HTML;
    loginFirst = false;
    attempts = 0;
    vi.mocked(establishSession).mockClear();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      );
      if (url.pathname !== target) {
        throw new Error(`Unexpected upstream fetch in test: ${url.pathname}`);
      }
      attempts += 1;
      if (loginFirst && attempts === 1) {
        if (loginFirst === "html") {
          return new Response(
            '<html><form action="/WebRW/Account/Login"><input name="UserName" /><input name="Password" type="password" /></form></html>',
            { status: 200, headers: { "content-type": "text/html" } }
          );
        }
        return new Response(null, {
          status: 302,
          headers: { location: "/WebRW/Account/Login" }
        });
      }
      return new Response(upstreamBody, {
        status,
        statusText: MARKERS.join(" "),
        headers: {
          "content-type": contentType,
          "cache-control": "no-store, private",
          "set-cookie": `.WebRW=${MARKERS[2]}`,
          "x-upstream-debug": MARKERS.join(" "),
          location: `https://upstream.invalid/${MARKERS[2]}`
        }
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each(routes)("withholds a 503 body on $path without retrying", async (route) => {
    target = route.upstream;
    await expectContained(await call(route));
    expect(attempts).toBe(1);
    expect(establishSession).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 410, 429, 500, 503, 599])("preserves HTTP %i, not its body", async (code) => {
    status = code;
    target = routes[1].upstream;
    await expectContained(await call(routes[1]));
    expect(attempts).toBe(1);
  });

  it.each(["application/json", "text/plain", "application/octet-stream"])(
    "withholds loud errors regardless of content type %s",
    async (type) => {
      contentType = type;
      upstreamBody = JSON.stringify({ customer: MARKERS });
      target = routes[1].upstream;
      await expectContained(await call(routes[1]));
    }
  );

  it.each(routes)("withholds the error after one login retry on $path", async (route) => {
    target = route.upstream;
    loginFirst = "redirect";
    status = 500;
    await expectContained(await call(route));
    expect(attempts).toBe(2);
    expect(establishSession).toHaveBeenCalledTimes(1);
  });

  it("withholds a loud error after an HTTP-200 login-form retry", async () => {
    target = routes[1].upstream;
    loginFirst = "html";
    await expectContained(await call(routes[1]));
    expect(attempts).toBe(2);
    expect(establishSession).toHaveBeenCalledTimes(1);
  });

  it.each(["text/html", "application/json"])("keeps successful %s bytes unchanged", async (type) => {
    target = routes[1].upstream;
    status = 200;
    contentType = type;
    upstreamBody = type === "text/html" ? "<html>Form shell</html>" : '{"success":true}';
    const response = await call(routes[1]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe(upstreamBody);
    expect(attempts).toBe(1);
  });
});
