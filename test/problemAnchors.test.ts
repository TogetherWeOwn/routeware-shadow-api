import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBLEM_TYPE_BASE, problemType } from "../src/lib/problem";
import { validationFailureHook } from "../src/routes/shared";

/**
 * problem+json anchor audit (TOG-5836). Every error `type` the API emits must
 * anchor into `docs/PROBLEMS.md` — i.e. equal `${PROBLEM_TYPE_BASE}<slug>`
 * verbatim, with the slug row present in the PROBLEMS.md table.
 *
 * Route-by-error matrix (full sweep 2026-09-27). `type` is the anchored slug;
 * "hook 400" means the `@hono/zod-openapi` schema rejection, which
 * `validationFailureHook` (wired as every module's `defaultHook`) turns into
 * an anchored `bad-request` problem+json instead of the library's raw
 * `{success:false}` 400. Before this change that raw shape was the ONE error
 * body in the API that did not anchor anywhere.
 *
 * | Route | 400 bad-request | 401 unauthorized | 404 not-found/forbidden | 405 | 429 | 502 bad-gateway | 503 misconfigured | 500 internal |
 * |---|---|---|---|---|---|---|---|---|
 * | `GET /api/v1/health` | — (no schema) | — (public) | | | | | | |
 * | `GET /api/v1/readiness` | — | outer gate | | | shared | | R1 (own schema, not problem+json) | shared |
 * | `GET /api/v1/shadow/health` | — | outer gate | | | shared | | | shared |
 * | Routeware passthroughs (customers-read, detail-full, customer-types-read, add-new-long, load-long-modal, app-settings-get, home/index, login-page, query-request-is-complete) | — (no schemas) | outer gate | | | shared | | | shared; upstream status/body streams through verbatim (R2) |
 * | `POST …/save-long-form` | — | outer gate | | | shared | token-prep + HTML-200 silent failure | | shared |
 * | `POST …/save-address-form`, `…/save-container-form` | create w/o parent id (TOG-8148) | outer gate | | | shared | token-prep | | shared |
 * | `DELETE /api/v1/routeware/customer` | — | outer gate | | anchored | shared | | | shared |
 * | Snapshot lists (customer/address/container) | hook 400 (query) | outer gate | | | shared | | | shared |
 * | Snapshot by-id (×3) | hook 400 (params) | outer gate | anchored (missing row) | | shared | | | shared |
 * | Snapshot export CSV (×3) | — (no schema) | outer + inner 401 | | | shared | | | shared |
 * | Snapshot sync (×3) | — | outer + inner 401 | | | shared | | secret-unset / report-source-unset | shared |
 * | Snapshot import (×3) | empty body | outer + inner 401 | | | shared | | | shared |
 * | `POST /api/v1/data-snapshot/sync` | — | outer + inner 401 | | | shared | | secret-unset | shared |
 * | `GET /api/v1/data/*` (×3) | missing/invalid id | outer + inner 401 | anchored (not in D1) | | shared | | | shared |
 * | `POST /api/v1/data/*` (×3) | empty body | outer + inner 401 | | | shared | token-prep | | shared |
 * | `GET /openapi.json`, `/docs` | — | — | anchored `forbidden` (404, docs disabled) | | | | | |
 * | unknown `/api/v1/*` path | — | outer gate first | anchored `not-found` | | shared | | | |
 * | any route, IP over the failure budget | | | | | anchored `rate-limited` (+ `Retry-After`) | | | |
 * | any route, handler throws | | | | | | | | anchored `internal` (message stays in the Worker log) |
 *
 * Deliberate non-anchored surfaces (not drift — changing them would break
 * clients; each is pinned by its own test):
 * - R1: readiness 503 carries the `ReadinessResponse` schema, not
 *   problem+json (`test/readiness.test.ts`). It is a deploy probe, not an
 *   entry in the PROBLEMS.md error table.
 * - R2: upstream passthroughs stream Routeware's own status/body (`R3` in
 *   `test/customerSaveLongFormSilentFailure.test.ts` pins the one shape we
 *   DO rewrite: HTML-200 silent failures become 502).
 * - R3: `src/authSession.do.ts` plain-text 400/404/423s are the Durable
 *   Object's internal stub protocol, unreachable from the public API surface.
 * - R4: `POST /api/v1/data/*` returns ids + `upstreamBytes` + fixed
 *   `localSync.code` only — never submitted fields or the upstream body
 *   (TOG-6535; pinned by `test/dataEntityPostHandlers.test.ts`).
 *
 * The `type` assertions below compare against string literals, never against
 * `problemType(...)` output: recomputing the expected value with the function
 * under test would let a base-URL change pass silently.
 */

const BASE = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";

const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";

// Top-level await, house pattern (see test/snapshotRoutes.test.ts): the route
// modules are imported once so every describe below shares them.
const { customerSnapshotRoutes } = await import("../src/routes/customerSnapshot");
const { addressSnapshotRoutes } = await import("../src/routes/addressSnapshot");
const { dataEntityRoutes } = await import("../src/routes/dataEntity");

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
};

describe("problem type URLs pin verbatim into docs/PROBLEMS.md", () => {
  it("publishes the documented base URL", () => {
    expect(PROBLEM_TYPE_BASE).toBe(BASE);
  });

  it.each([
    "bad-request",
    "unauthorized",
    "forbidden",
    "not-found",
    "method-not-allowed",
    "rate-limited",
    "misconfigured",
    "bad-gateway",
    "internal"
  ])("anchors #%s", (slug) => {
    // Every slug in the PROBLEMS.md table resolves through problemType().
    expect(problemType(slug)).toBe(`${BASE}${slug}`);
  });
});

describe("validationFailureHook (the drift fix)", () => {
  it("passes successful validations through untouched", () => {
    expect(
      validationFailureHook({ success: true, target: "query" })
    ).toBeUndefined();
  });

  it("answers a query rejection with an anchored bad-request problem+json", async () => {
    // Arrange — the shape @hono/zod-validator hands the hook on failure.
    const res = validationFailureHook({
      success: false,
      target: "query",
      error: { issues: [{ path: ["limit"] }] }
    });

    // Assert
    expect(res).toBeInstanceOf(Response);
    expect(res?.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res?.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}bad-request`);
    expect(body.title).toBe("Bad Request");
    expect(body.status).toBe(400);
    expect(body.detail).toBe(
      "Invalid request query (limit). See docs/PROBLEMS.md#bad-request."
    );
  });

  it("names every rejected field once, never the rejected values (PII)", async () => {
    // Arrange — `q` carries a company-name substring; zod messages echo it.
    const res = validationFailureHook({
      success: false,
      target: "query",
      error: { issues: [{ path: ["q"] }, { path: ["limit"] }, { path: ["limit"] }] }
    });

    // Assert — fields named, deduplicated, values nowhere.
    const body = (await res?.json()) as ProblemBody;
    expect(body.detail).toBe(
      "Invalid request query (q, limit). See docs/PROBLEMS.md#bad-request."
    );
    expect(body.detail).not.toContain("Acme");
  });

  it("falls back to the target name when an issue has an empty path", async () => {
    const res = validationFailureHook({
      success: false,
      target: "param",
      error: { issues: [{ path: [] }] }
    });
    const body = (await res?.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}bad-request`);
    expect(body.detail).toBe(
      "Invalid request param (param). See docs/PROBLEMS.md#bad-request."
    );
  });

  it("every route module wires the hook as its defaultHook (new-route drift guard)", async () => {
    // Arrange — one import per module that serves traffic. A future module
    // built as a bare `new OpenAPIHono()` (no defaultHook) would silently
    // return raw {success:false} 400s again; this fails first.
    const modules = await Promise.all([
      import("../src/routes/meta"),
      import("../src/routes/shadow"),
      import("../src/routes/routeware"),
      import("../src/routes/customer"),
      import("../src/routes/address"),
      import("../src/routes/container"),
      import("../src/routes/customerSnapshot"),
      import("../src/routes/dataSnapshot"),
      import("../src/routes/addressSnapshot"),
      import("../src/routes/containerSnapshot"),
      import("../src/routes/dataEntity")
    ]);
    const apps = [
      modules[0].metaRoutes,
      modules[1].shadowRoutes,
      modules[2].routewareRoutes,
      modules[3].customerRoutes,
      modules[4].addressRoutes,
      modules[5].containerRoutes,
      modules[6].customerSnapshotRoutes,
      modules[7].dataSnapshotRoutes,
      modules[8].addressSnapshotRoutes,
      modules[9].containerSnapshotRoutes,
      modules[10].dataEntityRoutes
    ];

    // Assert
    expect(apps).toHaveLength(11);
    for (const app of apps) {
      expect(app.defaultHook).toBe(validationFailureHook);
    }
  });
});

describe("schema rejections arrive anchored (were raw {success:false} before)", () => {
  const SECRET = "sync-secret";
  const ctx = {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;

  function authed(path: string): Request {
    return new Request(`http://test.local${path}`, {
      headers: { authorization: `Bearer ${SECRET}` }
    });
  }

  async function callModule(
    routes: { fetch: typeof customerSnapshotRoutes.fetch },
    path: string,
    env: Env
  ): Promise<Response> {
    return routes.fetch(authed(path), env, ctx);
  }

  function moduleEnv(db = {}): Env {
    return {
      CUSTOMER_DB: db,
      CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET
    } as unknown as Env;
  }

  it("pins a bad list query as bad-request problem+json, not {success:false}", async () => {
    // Arrange / Act
    const res = await callModule(
      customerSnapshotRoutes,
      "/api/v1/customer-snapshot?limit=501",
      moduleEnv()
    );

    // Assert — status is unchanged (400); the shape is what this card fixes.
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as ProblemBody & { success?: boolean };
    expect(body.type).toBe(`${BASE}bad-request`);
    expect(body.status).toBe(400);
    expect(body.success).toBeUndefined();
  });

  it("pins a non-numeric by-id param as bad-request", async () => {
    const res = await callModule(
      customerSnapshotRoutes,
      "/api/v1/customer-snapshot/abc",
      moduleEnv()
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}bad-request`);
  });

  it("pins an out-of-range address-list limit as bad-request", async () => {
    // Backport note (TOG-6461): the shared-branch original pinned
    // `/api/v1/data-snapshot/orphans?sampleLimit=501`, but the orphans route
    // (TOG-5814) has not merged to main yet — the same hook path is pinned
    // here against the address list's bounded `limit` instead.
    const res = await callModule(
      addressSnapshotRoutes,
      "/api/v1/address-snapshot?limit=501",
      moduleEnv()
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}bad-request`);
  });

  it("pins a non-numeric data-entity id as bad-request", async () => {
    const res = await callModule(
      dataEntityRoutes,
      "/api/v1/data/customer?id=abc",
      moduleEnv()
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}bad-request`);
  });
});

describe("handler-level errors anchor verbatim (matrix spot-checks)", () => {
  const SECRET = "sync-secret";
  const ctx = {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;

  function moduleEnv(db = {}): Env {
    return {
      CUSTOMER_DB: db,
      CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET
    } as unknown as Env;
  }

  /** D1 fake whose by-id lookup finds nothing (the 404 path). */
  function emptyDb(): D1Database {
    return {
      prepare() {
        return {
          bind() {
            return {
              async first<T>() {
                return null as T;
              },
              async all<T>() {
                return { results: [] } as unknown as T;
              }
            };
          }
        };
      }
    } as unknown as D1Database;
  }

  it("missing data-entity id: 400 bad-request with the documented detail", async () => {
    const res = await dataEntityRoutes.fetch(
      new Request("http://test.local/api/v1/data/customer", {
        headers: { authorization: `Bearer ${SECRET}` }
      }),
      moduleEnv(),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}bad-request`);
    expect(body.detail).toBe("Query `id` or `customerId` (customer_id) is required. See docs/PROBLEMS.md#bad-request.");
  });

  it("body-less snapshot import: 400 bad-request", async () => {
    const res = await customerSnapshotRoutes.fetch(
      new Request("http://test.local/api/v1/customer-snapshot/import", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` }
      }),
      moduleEnv(),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}bad-request`);
    expect(body.title).toBe("Bad Request");
  });

  it("body-less data-entity POST: 400 bad-request", async () => {
    const res = await dataEntityRoutes.fetch(
      new Request("http://test.local/api/v1/data/address", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` }
      }),
      moduleEnv(),
      ctx
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}bad-request`);
  });

  it("missing snapshot row: 404 not-found naming the id", async () => {
    const res = await customerSnapshotRoutes.fetch(
      new Request("http://test.local/api/v1/customer-snapshot/9999", {
        headers: { authorization: `Bearer ${SECRET}` }
      }),
      moduleEnv(emptyDb()),
      ctx
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}not-found`);
    expect(body.detail).toBe("No snapshot row for customer_id=9999. See docs/PROBLEMS.md#not-found.");
  });

  it("unconfigured sync: 503 misconfigured", async () => {
    // Arrange — sync secret set (clears both auth gates) but neither the
    // export path nor the query id configured.
    const env = moduleEnv() as unknown as Record<string, unknown>;
    delete env.CUSTOMER_REPORT_EXPORT_PATH;
    delete env.CUSTOMER_REPORT_QUERY_ID;
    const res = await customerSnapshotRoutes.fetch(
      new Request("http://test.local/api/v1/customer-snapshot/sync", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` }
      }),
      env as unknown as Env,
      ctx
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}misconfigured`);
    expect(body.title).toBe("Service Unavailable");
  });
});

describe("app-level errors anchor verbatim (through the full stack)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Plain function, not vi.fn(): the spy wrapper records each call's settled
    // result, which turns a deliberate rejection into an unhandled rejection
    // under @cloudflare/vitest-pool-workers (house pattern).
    globalThis.fetch = (async () => {
      throw new Error("Unexpected upstream fetch in problem-anchors test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function appCall(path: string, init: RequestInit = {}, token = API_TOKEN): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
  }

  it("no bearer: 401 unauthorized (outer gate)", async () => {
    const res = await exports.default.fetch("http://test.local/api/v1/readiness");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}unauthorized`);
    expect(body.status).toBe(401);
  });

  it("wrong bearer on a sync-secret route: 401 unauthorized (inner gate)", async () => {
    const res = await appCall("/api/v1/data/customer?id=1");
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}unauthorized`);
  });

  it("unknown path: 404 not-found", async () => {
    const res = await appCall("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}not-found`);
    expect(body.detail).toContain("/api/v1/does-not-exist");
  });

  it("docs disabled: 404 forbidden (not not-found)", async () => {
    // Arrange / Act — direct app.fetch with docs OFF (the self-fetch test env
    // keeps them ON, so this branch is unreachable through exports.default).
    const res = await (
      await import("../src/app")
    ).default.fetch(
      new Request("http://test.local/openapi.json"),
      { OPENAPI_DOCS_ENABLED: "false" } as unknown as Env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}forbidden`);
  });

  it("customer hard delete: 405 method-not-allowed", async () => {
    const res = await appCall("/api/v1/routeware/customer", { method: "DELETE" });
    expect(res.status).toBe(405);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}method-not-allowed`);
    expect(body.status).toBe(405);
  });

  it("token-guessing loop: 429 rate-limited with Retry-After", async () => {
    // Arrange — 19 failures stay 401; the 20th trips the block. A TEST-NET-3
    // IP no other file uses, so per-IP DO buckets never leak between suites.
    const ip = "203.0.113.61";
    const attempt = (token: string) =>
      exports.default.fetch("http://test.local/api/v1/routeware/home/index", {
        headers: { authorization: `Bearer ${token}`, "CF-Connecting-IP": ip }
      });
    for (let i = 0; i < 19; i++) {
      expect((await attempt(`guess-${i}`)).status).toBe(401);
    }

    // Act
    const throttled = await attempt("guess-final");

    // Assert
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("content-type")).toContain("application/problem+json");
    expect(throttled.headers.get("retry-after")).toMatch(/^\d+$/);
    const body = (await throttled.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}rate-limited`);
    expect(body.status).toBe(429);
  });

  it("upstream HTML-200 silent failure: 502 bad-gateway", async () => {
    // Arrange — Routeware's silent-failure shape; explicit token skips the
    // anti-forgery modal fetch so only the save matters.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/WebRW/Customer/SaveCustomerLongForm")) {
        return new Response(
          "<!DOCTYPE html><html><body>Object reference not set to an instance of an object</body></html>",
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;

    // Act
    const res = await appCall(
      "/api/v1/routeware/customer/save-long-form",
      {
        method: "POST",
        body: "CustomerID=5&CompanyName=Acme&__RequestVerificationToken=client-token",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
      }
    );

    // Assert
    expect(res.status).toBe(502);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}bad-gateway`);
    expect(body.title).toBe("Bad Gateway");
  });

  it("throwing handler: 500 internal without leaking internals", async () => {
    // Arrange — the sync secret clears both gates; the stubbed fetch throws
    // inside the sync body, so the global onError answers.
    const res = await appCall("/api/v1/container-snapshot/sync", { method: "POST" }, SYNC_SECRET);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(`${BASE}internal`);
    expect(body.title).toBe("Internal Server Error");
    expect(body.status).toBe(500);
  });
});
