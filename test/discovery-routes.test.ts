import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import routeMapJson from "../tools/api-discovery/route-map.json";
import {
  assertExactUpstreamCall,
  installUpstreamStub,
  shadowRequestFor,
  type RouteMapEntry
} from "./discoveryForwardingHarness";

const routeMap = routeMapJson as RouteMapEntry[];

describe("route-map → shadow Worker", () => {
  let upstream: ReturnType<typeof installUpstreamStub>;

  beforeEach(() => {
    upstream = installUpstreamStub(routeMap);
  });

  afterEach(() => {
    upstream.restore();
  });

  for (const route of routeMap) {
    it(`${route.method} ${route.shadowPath} forwards exactly ${route.method} ${route.upstreamPath} (route-map contract)`, async () => {
      const { url, init } = shadowRequestFor(route);

      const response = await exports.default.fetch(url, init);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { mocked: boolean; url: string };
      expect(body.mocked).toBe(true);
      // Exact upstream method + pathname + intended query; a substring match
      // here accepted prefix/suffix lookalikes.
      assertExactUpstreamCall(upstream.calls, route);
    });
  }
});
