import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import appSettingsExample from "../tools/api-discovery/examples/app-settings-get.post.example.json";
import customersReadExample from "../tools/api-discovery/examples/customers-read.post.example.json";
import detailFullExample from "../tools/api-discovery/examples/get-customer-detail-full.post.example.json";
import routeMapJson from "../tools/api-discovery/route-map.json";
import { customerTypesReadBody, saveCustomerLongFormBody } from "./customerFormExamples";

type RouteMapEntry = {
  method: string;
  upstreamPath: string;
  shadowPath: string;
  exampleFile?: string;
  exampleQuery?: string;
  exampleContentType?: string;
};

const routeMap = routeMapJson as RouteMapEntry[];

const exampleBodies: Record<string, string> = {
  "examples/customers-read.post.example.json": JSON.stringify(customersReadExample),
  "examples/get-customer-detail-full.post.example.json": JSON.stringify(detailFullExample),
  "examples/app-settings-get.post.example.json": JSON.stringify(appSettingsExample)
};

describe("route-map → shadow Worker", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const shadowHdr =
          init && typeof init === "object" && "headers" in init && init.headers
            ? new Headers(init.headers as HeadersInit).get("X-Routeware-Shadow-Internal") ?? ""
            : "";
        const internalTokenFetch = shadowHdr === "anti-forgery-modal";
        if (
          internalTokenFetch &&
          url.includes("killeen.routeware.com") &&
          url.includes("/WebRW/Customer/LoadLongCustomerModal")
        ) {
          return new Response(
            '<input name="__RequestVerificationToken" type="hidden" value="DISCOVERY-MODAL-TOKEN" />',
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        if (
          internalTokenFetch &&
          url.includes("killeen.routeware.com") &&
          url.includes("/WebRW/Customer/AddNewLong")
        ) {
          return new Response(
            '<input name="__RequestVerificationToken" type="hidden" value="DISCOVERY-NEW-TOKEN" />',
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        if (url.includes("killeen.routeware.com") && url.includes("/WebRW/")) {
          return new Response(JSON.stringify({ mocked: true, url }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return originalFetch(input, init);
      }
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const route of routeMap) {
    it(`${route.method} ${route.shadowPath} forwards (route-map contract)`, async () => {
      let reqUrl = `http://test.local${route.shadowPath}`;
      if (route.method === "GET" && route.exampleQuery) {
        reqUrl += reqUrl.includes("?") ? `&${route.exampleQuery}` : `?${route.exampleQuery}`;
      }

      const init: RequestInit = { method: route.method };
      if (route.method !== "GET" && route.method !== "HEAD") {
        if (route.shadowPath === "/api/v1/routeware/customer/save-long-form") {
          init.body = saveCustomerLongFormBody;
          init.headers = {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            accept: "*/*"
          };
        } else if (route.shadowPath === "/api/v1/routeware/customer/customer-types-read") {
          init.body = customerTypesReadBody;
          init.headers = {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            accept: "application/json, text/javascript, */*; q=0.01"
          };
        } else {
          const bodyText = route.exampleFile
            ? (exampleBodies[route.exampleFile] ?? "{}")
            : "{}";
          init.body = bodyText;
          init.headers = {
            "content-type": "application/json",
            accept: "application/json"
          };
        }
      }

      const response = await exports.default.fetch(reqUrl, init);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { mocked: boolean; url: string };
      expect(body.mocked).toBe(true);
      expect(body.url).toContain(route.upstreamPath);
    });
  }
});
