import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { APP_VERSION } from "../src/lib/version";
import { healthResponseSchema, metaRoutes, readinessResponseSchema } from "../src/routes/meta";

/**
 * Dedicated route tests for `src/routes/meta.ts`.
 *
 * `test/readiness.test.ts` pins `checkReadiness` lib behaviour and the
 * readiness auth/200/503 paths through the full app; `test/integration.test.ts`
 * and `test/authGateSweep.test.ts` pin the health gate from the outside. What
 * nothing pinned is the meta module's own wiring: that `GET /health` answers
 * without touching env, and that `GET /readiness` maps the lib's
 * `{ report, httpStatus }` onto the HTTP response (status code + body shape)
 * for both the 200 and 503 cases.
 *
 * Hermeticity: the shape cases call `metaRoutes.fetch` directly with a fake
 * env, and the gate cases go through the full app *without* a token.
 */

function fakeDb(ok = true): D1Database {
  return {
    prepare(_sql: string) {
      return {
        bind(..._binds: unknown[]) {
          return this;
        },
        async first<T>() {
          if (!ok) {
            throw new Error("D1_ERROR: boom");
          }
          return { ok: 1 } as unknown as T;
        }
      };
    }
  } as unknown as D1Database;
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    CUSTOMER_DB: fakeDb(true),
    SNAPSHOTS: {} as unknown as R2Bucket,
    SNAPSHOTS_R2_ENABLED: "true",
    CUSTOMER_REPORT_QUERY_ID: "23",
    ADDRESS_REPORT_QUERY_ID: "24",
    CONTAINER_REPORT_QUERY_ID: "25",
    ...overrides
  } as unknown as Env;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

async function callMeta(path: string, env: Env): Promise<Response> {
  return metaRoutes.fetch(new Request(`http://test.local${path}`), env, ctx);
}

describe("GET /api/v1/health route", () => {
  it("answers 200 with status/service/version without reading env", async () => {
    // Arrange — an empty env proves the liveness probe touches no binding.
    // Act
    const res = await callMeta("/api/v1/health", {} as unknown as Env);

    // Assert — version is single-sourced from package.json via APP_VERSION
    // (TOG-5840 pattern, TOG-8880): the literal pins the wire shape, the
    // package.json comparison pins the single-sourcing.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body: unknown = await res.json();
    expect(body).toEqual({
      status: "ok",
      service: "routeware-shadow-api",
      version: packageJson.version
    });
    expect(healthResponseSchema.safeParse(body).success).toBe(true);
  });

  it("is public through the app gate (no token)", async () => {
    // Arrange / Act — no Authorization header at all.
    const res = await exports.default.fetch("http://test.local/api/v1/health");

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("routeware-shadow-api");
    expect(body.version).toBe(APP_VERSION);
    expect(body.version).toBe(packageJson.version);
  });
});

describe("GET /api/v1/readiness route", () => {
  it("is not public: the app gate 401s without a token", async () => {
    // Arrange / Act — the one meta route the gate does not allow through.
    const res = await exports.default.fetch("http://test.local/api/v1/readiness");

    // Assert
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("maps an all-ready lib report to HTTP 200 with a schema-valid body", async () => {
    // Arrange — D1 answers, R2 bound, all three report sources configured.
    // Act
    const res = await callMeta("/api/v1/readiness", makeEnv());

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body: unknown = await res.json();
    expect(readinessResponseSchema.safeParse(body).success).toBe(true);
    const report = body as {
      status: string;
      service: string;
      checks: { d1: { ok: boolean }; r2: { ok: boolean }; config: { ok: boolean } };
    };
    expect(report.status).toBe("ok");
    expect(report.service).toBe("routeware-shadow-api");
    expect(report.checks.d1.ok).toBe(true);
    expect(report.checks.r2.ok).toBe(true);
    expect(report.checks.config.ok).toBe(true);
  });

  it("maps a failed D1 check to HTTP 503 with a schema-valid degraded body", async () => {
    // Arrange — binding missing, so the ping never runs.
    const env = makeEnv();
    delete (env as Partial<Env>).CUSTOMER_DB;

    // Act
    const res = await callMeta("/api/v1/readiness", env);

    // Assert
    expect(res.status).toBe(503);
    const body: unknown = await res.json();
    expect(readinessResponseSchema.safeParse(body).success).toBe(true);
    const report = body as { status: string; checks: { d1: { ok: boolean } } };
    expect(report.status).toBe("degraded");
    expect(report.checks.d1.ok).toBe(false);
  });

  it("maps missing report config to HTTP 503 with per-table flags", async () => {
    // Arrange — no export path and no query id for any table.
    const env = makeEnv({
      CUSTOMER_REPORT_QUERY_ID: "",
      ADDRESS_REPORT_QUERY_ID: "",
      CONTAINER_REPORT_QUERY_ID: ""
    });

    // Act
    const res = await callMeta("/api/v1/readiness", env);

    // Assert
    expect(res.status).toBe(503);
    const body: unknown = await res.json();
    expect(readinessResponseSchema.safeParse(body).success).toBe(true);
    const report = body as {
      status: string;
      checks: { config: { ok: boolean; customer: boolean; address: boolean; container: boolean } };
    };
    expect(report.status).toBe("degraded");
    expect(report.checks.config).toMatchObject({
      ok: false,
      customer: false,
      address: false,
      container: false
    });
  });

  it("maps a missing R2 binding (archiving enabled) to HTTP 503", async () => {
    // Arrange — archiving on but the bucket unbound.
    const env = makeEnv({ SNAPSHOTS: undefined });

    // Act
    const res = await callMeta("/api/v1/readiness", env);

    // Assert
    expect(res.status).toBe(503);
    const body: unknown = await res.json();
    expect(readinessResponseSchema.safeParse(body).success).toBe(true);
    const report = body as {
      status: string;
      checks: { r2: { ok: boolean; bound: boolean; enabled: boolean } };
    };
    expect(report.status).toBe("degraded");
    expect(report.checks.r2).toMatchObject({ ok: false, bound: false, enabled: true });
  });
});
