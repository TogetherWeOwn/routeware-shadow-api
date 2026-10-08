import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { apiAccessToken, isApiAuthorized } from "../src/lib/auth";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";

/**
 * TOG-6298: dual-secret fallback precedence matrix.
 *
 * Two-tier gate under audit:
 * - Outer (`src/app.ts` via `isApiAuthorized`): accepts SHADOW_API_TOKEN **or**
 *   CUSTOMER_SNAPSHOT_SYNC_SECRET. `apiAccessToken()` prefers the dedicated
 *   token and falls back to the sync secret; `isApiAuthorized()` then accepts
 *   either, so the chained snapshot sync (sync-secret authenticated) passes
 *   even when a distinct API token is configured.
 * - Inner (`src/routes/shared.ts` `requireSnapshotAuth`): privileged routes
 *   (sync/import, `/api/v1/data/*`, `/api/v1/data-snapshot/sync`) require the
 *   sync secret specifically. A valid API token passes the outer gate and is
 *   then rejected here.
 *
 * Matrix 1 (unit, outer gate) covers every env-config x bearer cell below.
 * Matrix 2 (HTTP, both-set test env) proves the route-class split: general
 * routes accept either secret, privileged routes accept only the sync secret.
 * `docs/PROBLEMS.md` § Authentication reproduces both matrices; every cell
 * here maps to a cell there.
 */

const API = "api-token-xyz";
const SYNC = "sync-secret-xyz";
const WRONG = "wrong-token";

// Matches wrangler.toml [env.test.vars] — the HTTP matrix runs under both-set.
const TEST_API_TOKEN = "test-api-token";
const TEST_SYNC_SECRET = "test-sync-secret";

const UNAUTHORIZED_TYPE = `${PROBLEM_TYPE_BASE}unauthorized`;

function reqWith(auth?: string): { header: (n: string) => string | undefined } {
  return {
    header: (n: string) => (n.toLowerCase() === "authorization" ? auth : undefined)
  };
}

type EnvConfig = {
  name: string;
  env: Record<string, string>;
  /** Expected apiAccessToken() for this config. */
  accessToken: string | undefined;
  /** Expected isApiAuthorized() per bearer: [api, sync, wrong, none]. */
  outer: [boolean, boolean, boolean, boolean];
};

const ENV_CONFIGS: EnvConfig[] = [
  {
    name: "both set",
    env: { SHADOW_API_TOKEN: API, CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC },
    accessToken: API,
    outer: [true, true, false, false]
  },
  {
    name: "token-only (sync unset)",
    env: { SHADOW_API_TOKEN: API },
    accessToken: API,
    // The SYNC string is not configured here, so presenting it must fail.
    outer: [true, false, false, false]
  },
  {
    name: "sync-only (api unset)",
    env: { CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC },
    accessToken: SYNC,
    // The API string is not configured here, so presenting it must fail.
    outer: [false, true, false, false]
  },
  {
    name: "neither set",
    env: {},
    accessToken: undefined,
    outer: [false, false, false, false]
  }
];

describe("dual-secret outer-gate matrix (unit)", () => {
  it.each(ENV_CONFIGS)("apiAccessToken prefers the dedicated token: $name", (cfg) => {
    expect(apiAccessToken(cfg.env as unknown as Env)).toBe(cfg.accessToken);
  });

  it.each(ENV_CONFIGS)("isApiAuthorized matrix row: $name", (cfg) => {
    const env = cfg.env as unknown as Env;
    const [apiOk, syncOk, wrongOk, noneOk] = cfg.outer;
    expect(isApiAuthorized(env, reqWith(`Bearer ${API}`))).toBe(apiOk);
    expect(isApiAuthorized(env, reqWith(`Bearer ${SYNC}`))).toBe(syncOk);
    expect(isApiAuthorized(env, reqWith(`Bearer ${WRONG}`))).toBe(wrongOk);
    expect(isApiAuthorized(env, reqWith(undefined))).toBe(noneOk);
  });

  it("blank secrets are unconfigured, not empty-string tokens", () => {
    const env = { SHADOW_API_TOKEN: "   ", CUSTOMER_SNAPSHOT_SYNC_SECRET: "" } as unknown as Env;
    expect(apiAccessToken(env)).toBeUndefined();
    expect(isApiAuthorized(env, reqWith(`Bearer ${API}`))).toBe(false);
    expect(isApiAuthorized(env, reqWith(`Bearer ${SYNC}`))).toBe(false);
  });
});

// Distinct TEST-NET-1 IPs per HTTP case so per-IP throttle buckets never leak
// state between cells (or into authThrottle/authGateSweep/throttleBurst).
const IP_BASE = "203.0.113.22";
let ipSeq = 1;
function freshIp(): string {
  return `${IP_BASE}${ipSeq++}`;
}

async function call(
  method: string,
  path: string,
  opts: { token?: string | null; ip: string }
): Promise<Response> {
  const headers = new Headers();
  if (opts.token !== null && opts.token !== undefined) {
    headers.set("authorization", `Bearer ${opts.token}`);
  }
  headers.set("CF-Connecting-IP", opts.ip);
  return exports.default.fetch(`http://test.local${path}`, { method, headers });
}

type ProblemBody = { type: string; title: string; status: number; detail?: string };

// General route needing no upstream: proves outer-gate passage with a 200.
const GENERAL = { method: "GET", path: "/api/v1/shadow/health" };
// Privileged route that 400s on a missing id AFTER the inner check, so the
// sync secret yields 400 (inner passed, no DB/upstream touched) while the API
// token yields the inner 401. Query string omitted deliberately.
const PRIVILEGED = { method: "GET", path: "/api/v1/data/customer" };
const PRIVILEGED_INNER_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";

describe("dual-secret route-class matrix (HTTP, both-set test env)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No matrix request may reach upstream: 200s answer directly, 401s/400s
    // stop at the gates. A throw turns any future gate leak into a loud failure.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in dual-secret matrix test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("general route accepts the API token", async () => {
    const res = await call(GENERAL.method, GENERAL.path, { token: TEST_API_TOKEN, ip: freshIp() });
    expect(res.status).toBe(200);
  });

  it("general route accepts the sync secret (outer gate dual-accept)", async () => {
    const res = await call(GENERAL.method, GENERAL.path, { token: TEST_SYNC_SECRET, ip: freshIp() });
    expect(res.status).toBe(200);
  });

  it("general route rejects a wrong token at the outer gate", async () => {
    const res = await call(GENERAL.method, GENERAL.path, { token: "nope", ip: freshIp() });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toContain("SHADOW_API_TOKEN");
  });

  it("general route rejects a missing token at the outer gate", async () => {
    const res = await call(GENERAL.method, GENERAL.path, { token: null, ip: freshIp() });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
  });

  it("privileged route rejects the API token at the inner check", async () => {
    const res = await call(PRIVILEGED.method, PRIVILEGED.path, {
      token: TEST_API_TOKEN,
      ip: freshIp()
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    // Inner detail, not the outer gate's SHADOW_API_TOKEN wording.
    expect(body.detail).toBe(PRIVILEGED_INNER_DETAIL);
  });

  it("privileged route lets the sync secret past the inner check (400 on the missing id)", async () => {
    const res = await call(PRIVILEGED.method, PRIVILEGED.path, {
      token: TEST_SYNC_SECRET,
      ip: freshIp()
    });
    // 400 proves the inner check was cleared: the id guard runs after it and
    // needs no DB or upstream. A 404/500 here would mean the route or its
    // wiring changed, not that auth passed.
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.detail).toBe("Query `id` or `customerId` (customer_id) is required. See docs/PROBLEMS.md#bad-request.");
  });

  it("privileged route rejects a wrong token at the outer gate", async () => {
    const res = await call(PRIVILEGED.method, PRIVILEGED.path, { token: "nope", ip: freshIp() });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toContain("SHADOW_API_TOKEN");
  });

  it("privileged route rejects a missing token at the outer gate", async () => {
    const res = await call(PRIVILEGED.method, PRIVILEGED.path, { token: null, ip: freshIp() });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toContain("SHADOW_API_TOKEN");
  });

  it("public health probe needs no token (control)", async () => {
    const res = await call("GET", "/api/v1/health", { token: null, ip: freshIp() });
    expect(res.status).toBe(200);
  });
});

/**
 * TOG-8383 (G28): living HTTP re-test contract across all four secret configs.
 *
 * Matrix 2 above proves the route-class split, but only under the both-set
 * `[env.test.vars]` — the one config the `cloudflare:workers` self-fetch path
 * can run. An auth refactor that collapses the inner check, swaps the
 * fallback order, or fails open on unset secrets would keep Matrices 1–2
 * green while changing live wire behavior. This block replays the
 * PROBLEMS.md outer-gate table at the HTTP layer under every env config by
 * driving `app.fetch` directly with a synthetic env (the
 * `test/authModeValidation.test.ts` seam): the throttle DO is a stub that
 * never blocks, and any upstream fetch throws, so every assertion below is
 * hermetic.
 *
 * Per config × bearer, on the general route (`GET /api/v1/shadow/health`):
 * outer-gate pass → 200, fail → 401 with the outer (`SHADOW_API_TOKEN`)
 * detail. On the privileged route (`GET /api/v1/data/customer`, id omitted
 * so the missing-id 400 proves the inner check was cleared without touching
 * D1 or upstream):
 * - bearer clears the outer gate but is not the sync secret → 401 with the
 *   INNER detail (proves the two-tier split survived);
 * - bearer is the configured sync secret → 400 missing-id (inner cleared);
 * - otherwise → 401 with the OUTER detail (stopped at the gate).
 */

const MATRIX_CTX = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function matrixAppEnv(secrets: Record<string, string>): Env {
  const stub = {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      if (url.includes("/throttle/failure")) {
        return Response.json({ blocked: false, retryAfterSec: 0 });
      }
      if (url.includes("/throttle/clear")) {
        return new Response("OK");
      }
      throw new Error(`Unexpected AUTH_SESSION fetch in dual-secret matrix contract: ${url}`);
    }
  };
  const AUTH_SESSION = {
    idFromName: (name: string) => name,
    get: (_id: string) => stub
  };
  return { ...secrets, AUTH_SESSION } as unknown as Env;
}

let matrixIpSeq = 1;

async function matrixCall(
  method: string,
  path: string,
  env: Env,
  token: string | null
): Promise<Response> {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  // Distinct IP per call: a future stateful throttle stub must never leak
  // budget between matrix cells.
  headers.set("CF-Connecting-IP", `198.51.100.${matrixIpSeq++}`);
  return app.fetch(new Request(`http://test.local${path}`, { method, headers }), env, MATRIX_CTX);
}

const PRIVILEGED_PASS_DETAIL =
  "Query `id` or `customerId` (customer_id) is required. See docs/PROBLEMS.md#bad-request.";

describe("dual-secret HTTP matrix across all four secret configs (TOG-8383)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in dual-secret matrix contract");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each(ENV_CONFIGS)("general route follows the outer gate: $name", async (cfg) => {
    const env = matrixAppEnv(cfg.env);
    const bearers: Array<string | null> = [API, SYNC, WRONG, null];
    for (let i = 0; i < bearers.length; i++) {
      const res = await matrixCall(GENERAL.method, GENERAL.path, env, bearers[i]);
      if (cfg.outer[i]) {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(401);
        const body = (await res.json()) as ProblemBody;
        expect(body.type).toBe(UNAUTHORIZED_TYPE);
        expect(body.detail).toContain("SHADOW_API_TOKEN");
      }
    }
  });

  it.each(ENV_CONFIGS)("privileged route enforces the inner check: $name", async (cfg) => {
    const env = matrixAppEnv(cfg.env);
    const [apiOuter, syncOuter] = cfg.outer;

    // Bearer API: outer pass lands on the inner 401 (never the sync secret);
    // outer fail stops at the gate with the outer wording.
    const apiRes = await matrixCall(PRIVILEGED.method, PRIVILEGED.path, env, API);
    expect(apiRes.status).toBe(401);
    const apiBody = (await apiRes.json()) as ProblemBody;
    expect(apiBody.type).toBe(UNAUTHORIZED_TYPE);
    if (apiOuter) {
      expect(apiBody.detail).toBe(PRIVILEGED_INNER_DETAIL);
    } else {
      expect(apiBody.detail).toContain("SHADOW_API_TOKEN");
    }

    // Bearer SYNC: outer pass clears the inner check (400 on the missing id);
    // outer fail stops at the gate.
    const syncRes = await matrixCall(PRIVILEGED.method, PRIVILEGED.path, env, SYNC);
    if (syncOuter) {
      expect(syncRes.status).toBe(400);
      const syncBody = (await syncRes.json()) as ProblemBody;
      expect(syncBody.detail).toBe(PRIVILEGED_PASS_DETAIL);
    } else {
      expect(syncRes.status).toBe(401);
      const syncBody = (await syncRes.json()) as ProblemBody;
      expect(syncBody.type).toBe(UNAUTHORIZED_TYPE);
      expect(syncBody.detail).toContain("SHADOW_API_TOKEN");
    }

    // Wrong and missing tokens never clear the outer gate in any config.
    for (const token of [WRONG, null]) {
      const res = await matrixCall(PRIVILEGED.method, PRIVILEGED.path, env, token);
      expect(res.status).toBe(401);
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(UNAUTHORIZED_TYPE);
      expect(body.detail).toContain("SHADOW_API_TOKEN");
    }
  });

  it.each(ENV_CONFIGS)("public health probe stays open: $name", async (cfg) => {
    const res = await matrixCall("GET", "/api/v1/health", matrixAppEnv(cfg.env), null);
    expect(res.status).toBe(200);
  });
});
