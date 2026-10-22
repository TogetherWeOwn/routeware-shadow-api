import { vi } from "vitest";
import appSettingsExample from "../tools/api-discovery/examples/app-settings-get.post.example.json";
import customersReadExample from "../tools/api-discovery/examples/customers-read.post.example.json";
import detailFullExample from "../tools/api-discovery/examples/get-customer-detail-full.post.example.json";
import { customerTypesReadBody, saveCustomerLongFormBody } from "./customerFormExamples";
import { isUpstreamUrl } from "./upstreamHost";

/**
 * Shared hermetic harness for the route-map forwarding contract
 * (test/discovery-routes.test.ts, test/discoveryMapContract.test.ts).
 *
 * The upstream is a stub that RECORDS every outbound call and THROWS on
 * anything it does not recognise (other hosts, other paths, unknown
 * methods). Nothing is ever recorded against, or replayed to, the real
 * tenant; the throw is the tripwire if a route starts calling somewhere new.
 */

export type RouteMapEntry = {
  method: string;
  upstreamPath: string;
  shadowPath: string;
  exampleFile?: string;
  exampleQuery?: string;
  exampleContentType?: string;
};

export type UpstreamCall = { method: string; url: string; internalToken: boolean };

const exampleBodies: Record<string, string> = {
  "examples/customers-read.post.example.json": JSON.stringify(customersReadExample),
  "examples/get-customer-detail-full.post.example.json": JSON.stringify(detailFullExample),
  "examples/app-settings-get.post.example.json": JSON.stringify(appSettingsExample)
};

/** Upstream paths the Worker may legitimately fetch for an anti-forgery token. */
const TOKEN_PATHS = ["/WebRW/Customer/LoadLongCustomerModal", "/WebRW/Customer/AddNewLong"];

export function installUpstreamStub(knownUpstream: { method: string; upstreamPath: string }[]) {
  const original = globalThis.fetch;
  const calls: UpstreamCall[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (request as Request).url;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers ?? undefined);
    const internalToken = headers.get("X-Routeware-Shadow-Internal") === "anti-forgery-modal";
    if (!isUpstreamUrl(url)) {
      throw new Error(`Unexpected outbound fetch to a non-upstream host in test: ${method} ${url}`);
    }
    const parsed = new URL(url);
    calls.push({ method, url, internalToken });
    if (internalToken && TOKEN_PATHS.includes(parsed.pathname)) {
      return new Response(
        '<input name="__RequestVerificationToken" type="hidden" value="DISCOVERY-MODAL-TOKEN" />',
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    const known = knownUpstream.some((r) => r.method === method && r.upstreamPath === parsed.pathname);
    if (!known) {
      throw new Error(`Unexpected upstream fetch in test: ${method} ${url}`);
    }
    return new Response(JSON.stringify({ mocked: true, url }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

/** The request a client would send to the shadow Worker for this map entry. */
export function shadowRequestFor(route: RouteMapEntry): { url: string; init: RequestInit } {
  let url = `http://test.local${route.shadowPath}`;
  if (route.method === "GET" && route.exampleQuery) {
    url += url.includes("?") ? `&${route.exampleQuery}` : `?${route.exampleQuery}`;
  }
  const init: RequestInit = { method: route.method };
  let headers: HeadersInit | undefined;
  if (route.method !== "GET" && route.method !== "HEAD") {
    if (route.shadowPath === "/api/v1/routeware/customer/save-long-form") {
      init.body = saveCustomerLongFormBody;
      headers = {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        accept: "*/*"
      };
    } else if (route.shadowPath === "/api/v1/routeware/customer/customer-types-read") {
      init.body = customerTypesReadBody;
      headers = {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        accept: "application/json, text/javascript, */*; q=0.01"
      };
    } else {
      init.body = route.exampleFile ? (exampleBodies[route.exampleFile] ?? "{}") : "{}";
      headers = { "content-type": "application/json", accept: "application/json" };
    }
  }
  const merged = new Headers(headers);
  merged.set("authorization", "Bearer test-api-token");
  init.headers = merged;
  return { url, init };
}

/**
 * The forwarded call must be EXACTLY the mapped operation: same method, the
 * upstream pathname equal (never a substring, prefix or suffix lookalike),
 * and the query only what the map intends to forward (the GET exampleQuery;
 * nothing for other methods).
 *
 * Returns the matching call; throws a descriptive Error otherwise.
 */
export function assertExactUpstreamCall(calls: UpstreamCall[], route: RouteMapEntry): UpstreamCall {
  const forwarded = calls.filter((c) => !c.internalToken);
  if (forwarded.length !== 1) {
    throw new Error(
      `${route.method} ${route.shadowPath}: expected exactly one forwarded upstream call, saw ${forwarded.length}: ` +
        forwarded.map((c) => `${c.method} ${new URL(c.url).pathname}`).join(", ")
    );
  }
  const call = forwarded[0];
  const parsed = new URL(call.url);
  if (call.method !== route.method) {
    throw new Error(`${route.shadowPath}: upstream method ${call.method}, expected ${route.method}`);
  }
  if (parsed.pathname !== route.upstreamPath) {
    throw new Error(`${route.shadowPath}: upstream path ${parsed.pathname}, expected exactly ${route.upstreamPath}`);
  }
  const expectedSearch = route.method === "GET" && route.exampleQuery ? `?${route.exampleQuery}` : "";
  if (parsed.search !== expectedSearch) {
    throw new Error(`${route.shadowPath}: upstream query "${parsed.search}", expected "${expectedSearch}"`);
  }
  return call;
}
