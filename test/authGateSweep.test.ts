import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import {
  AUTH_THROTTLE_BLOCK_MS,
  AUTH_THROTTLE_MAX_FAILURES
} from "../src/lib/authThrottle";
import { problemType } from "../src/lib/problem";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

const UNAUTHORIZED_TYPE = problemType("unauthorized");
const RATE_LIMITED_TYPE = problemType("rate-limited");

const PUBLIC_HEALTH = { method: "GET", path: "/api/v1/health" };

// TEST-NET ranges reserved for this file so per-IP throttle buckets never leak
// state between cases here (or into test/authThrottle.test.ts, which uses
// 203.0.113.7/.99, 198.51.100.23 and 192.0.2.44/.71). Every sweep case gets its
// own IP, so each unauthenticated hit counts as failure #1 on a fresh bucket
// and asserts a 401 — never an incidental 429.
const SWEEP_NET = "198.51.100";
const THROTTLE_IP = "203.0.113.140";
const HEALTH_IP = "192.0.2.140";
const PREFLIGHT_IP = "192.0.2.141";

type GatedRoute = { method: string; path: string; ip: string };

function concretePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, "1");
}

/**
 * TOG-6277: one parameterized auth-gate sweep pinned per route.
 *
 * The route list is read off the live router (`app.routes`), not hardcoded, so
 * a newly added `/api/v1/*` route is swept automatically — and the count pin
 * below forces an explicit acknowledgement when the surface changes. If any
 * route leaks past the gate (wrong status, wrong envelope, upstream reached),
 * its case fails.
 */
function gatedRoutes(): GatedRoute[] {
  // Dedupe: the merged OpenAPIHono registry lists some routes more than once.
  const seen = new Set<string>();
  const routes: Array<{ method: string; path: string }> = [];
  for (const r of app.routes) {
    if (r.method === "ALL" || !r.path.startsWith("/api/v1/")) {
      continue;
    }
    const key = `${r.method} ${r.path}`;
    if (key === `${PUBLIC_HEALTH.method} ${PUBLIC_HEALTH.path}` || seen.has(key)) {
      continue;
    }
    seen.add(key);
    routes.push({ method: r.method, path: r.path });
  }
  routes.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
  return routes.map((r, i) => ({ ...r, ip: `${SWEEP_NET}.${64 + i}` }));
}

async function call(
  method: string,
  path: string,
  opts: { token?: string | null; ip?: string } = {}
): Promise<Response> {
  const headers = new Headers();
  if (opts.token) {
    headers.set("authorization", `Bearer ${opts.token}`);
  }
  if (opts.ip) {
    headers.set("CF-Connecting-IP", opts.ip);
  }
  return exports.default.fetch(`http://test.local${path}`, { method, headers });
}

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
};

async function expectUnauthorized(res: Response, route: string): Promise<ProblemBody> {
  expect(res.status, route).toBe(401);
  expect(res.headers.get("content-type")).toContain("problem+json");
  const body = (await res.json()) as ProblemBody;
  expect(body.type).toBe(UNAUTHORIZED_TYPE);
  expect(body.title).toBe("Unauthorized");
  expect(body.status).toBe(401);
  expect(body.detail).toContain("SHADOW_API_TOKEN");
  return body;
}

describe("auth-gate negative sweep (TOG-6277)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No swept request may reach upstream: 401s/429s stop at the gate and the
    // health probe answers directly. A throw here turns any future gate leak
    // into a loud failure instead of a live-network call.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in auth-gate sweep");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sweeps every registered /api/v1/* route except the public health probe", () => {
    const routes = gatedRoutes();
    const registered = new Set(
      app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`)
    );
    expect(registered).toContain(`${PUBLIC_HEALTH.method} ${PUBLIC_HEALTH.path}`);
    // Pinned count: adding/removing a v1 route must update this sweep explicitly.
    expect(routes).toHaveLength(33);
  });

  it.each(gatedRoutes())("401 problem+json without a token: $method $path", async (route) => {
    const res = await call(route.method, concretePath(route.path), { ip: route.ip });
    await expectUnauthorized(res, `${route.method} ${route.path}`);
  });

  it.each(gatedRoutes())("401 problem+json with a bad token: $method $path", async (route) => {
    // Mirror octet into 192.0.2.0/24 so the bad-token pass never shares a
    // throttle bucket with the no-token pass above.
    const res = await call(route.method, concretePath(route.path), {
      token: "wrong-token",
      ip: route.ip.replace(SWEEP_NET, "192.0.2")
    });
    await expectUnauthorized(res, `${route.method} ${route.path}`);
  });

  it("drives bad tokens to the throttle threshold: 429 + Retry-After", async () => {
    const path = "/api/v1/routeware/home/index";
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
      const res = await call("GET", path, { token: `guess-${i}`, ip: THROTTLE_IP });
      expect(res.status).toBe(401);
    }
    const throttled = await call("GET", path, { token: "guess-final", ip: THROTTLE_IP });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("content-type")).toContain("problem+json");
    const retryAfter = throttled.headers.get("retry-after");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(
      Math.ceil(AUTH_THROTTLE_BLOCK_MS / 1000)
    );
    const body = (await throttled.json()) as ProblemBody;
    expect(body.type).toBe(RATE_LIMITED_TYPE);
    expect(body.title).toBe("Too Many Requests");
    expect(body.status).toBe(429);
  });

  it("keeps GET /api/v1/health public under bad-token hammering", async () => {
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      const res = await call("GET", "/api/v1/health", { token: "wrong", ip: HEALTH_IP });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    }
    // The probe never consumed throttle budget: the IP's first gated failure
    // is still a 401, not a 429.
    const gated = await call("GET", "/api/v1/routeware/home/index", {
      token: "wrong",
      ip: HEALTH_IP
    });
    expect(gated.status).toBe(401);
    // No-token health check is public too.
    const anonymous = await call("GET", "/api/v1/health", { ip: HEALTH_IP });
    expect(anonymous.status).toBe(200);
  });

  it("lets a valid token past the gate (control against blanket breakage)", async () => {
    // Shadow health needs no upstream, so this proves the 401s above are
    // gate-caused without stubbing the network for a proxy route.
    const res = await call("GET", "/api/v1/shadow/health", {
      token: API_TOKEN,
      ip: "198.51.100.200"
    });
    expect(res.status).toBe(200);
  });

  it("CORS preflight stays 401 without consuming throttle budget", async () => {
    const path = "/api/v1/routeware/home/index";
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      const res = await call("OPTIONS", path, { token: "wrong", ip: PREFLIGHT_IP });
      expect(res.status).toBe(401);
    }
    const gated = await call("GET", path, { token: "wrong", ip: PREFLIGHT_IP });
    expect(gated.status).toBe(401);
  });
});
