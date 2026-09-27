import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { checkReadiness } from "../src/lib/readiness";
import { metaRoutes, readinessResponseSchema } from "../src/routes/meta";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

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

describe("checkReadiness lib", () => {
  it("reports ok when D1 answers, R2 is bound, and all reports are configured", async () => {
    const { report, httpStatus } = await checkReadiness(makeEnv());
    expect(httpStatus).toBe(200);
    expect(report.status).toBe("ok");
    expect(report.service).toBe("routeware-shadow-api");
    expect(report.checks.d1.ok).toBe(true);
    expect(report.checks.r2).toMatchObject({ ok: true, bound: true, enabled: true });
    expect(report.checks.config).toMatchObject({
      ok: true,
      customer: true,
      address: true,
      container: true
    });
    expect(readinessResponseSchema.safeParse(report).success).toBe(true);
  });

  it("marks D1 failed when the binding is missing", async () => {
    const env = makeEnv();
    delete (env as Partial<Env>).CUSTOMER_DB;
    const { report, httpStatus } = await checkReadiness(env);
    expect(httpStatus).toBe(503);
    expect(report.status).toBe("degraded");
    expect(report.checks.d1.ok).toBe(false);
  });

  it("marks D1 failed when the ping throws (detail truncated, no secrets)", async () => {
    const env = makeEnv({ CUSTOMER_DB: fakeDb(false) });
    const { report, httpStatus } = await checkReadiness(env);
    expect(httpStatus).toBe(503);
    expect(report.checks.d1.ok).toBe(false);
    expect(report.checks.d1.detail).toContain("D1 ping failed");
  });

  it("marks R2 failed when archiving is enabled but the binding is missing", async () => {
    const env = makeEnv({ SNAPSHOTS: undefined });
    const { report, httpStatus } = await checkReadiness(env);
    expect(httpStatus).toBe(503);
    expect(report.checks.r2).toMatchObject({ ok: false, bound: false, enabled: true });
  });

  it("treats R2 as ok when archiving is explicitly disabled", async () => {
    const env = makeEnv({ SNAPSHOTS: undefined, SNAPSHOTS_R2_ENABLED: "false" });
    const { report, httpStatus } = await checkReadiness(env);
    expect(report.checks.r2).toMatchObject({ ok: true, bound: false, enabled: false });
    // D1 + config still ok would make overall ok; here they are ok.
    expect(httpStatus).toBe(200);
    expect(report.status).toBe("ok");
  });

  it("reports per-table config gaps without echoing var values", async () => {
    const env = makeEnv({
      CUSTOMER_REPORT_QUERY_ID: "",
      CUSTOMER_REPORT_EXPORT_PATH: "   ",
      ADDRESS_REPORT_QUERY_ID: "24"
      // CONTAINER_* left configured from makeEnv
    });
    const { report, httpStatus } = await checkReadiness(env);
    expect(httpStatus).toBe(503);
    expect(report.checks.config.customer).toBe(false);
    expect(report.checks.config.address).toBe(true);
    expect(report.checks.config.container).toBe(true);
    expect(report.checks.config.detail).toContain("customer");
    expect(JSON.stringify(report)).not.toContain("23");
  });

  it("accepts a static export path as a configured source", async () => {
    const env = makeEnv({
      CUSTOMER_REPORT_QUERY_ID: "",
      CUSTOMER_REPORT_EXPORT_PATH: "/WebRW/Reports/X?export=1"
    });
    const { report } = await checkReadiness(env);
    expect(report.checks.config.customer).toBe(true);
  });
});

describe("GET /api/v1/readiness route", () => {
  it("requires the bearer token (not public like health)", async () => {
    const res = await exports.default.fetch("http://test.local/api/v1/readiness");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("rejects a wrong token", async () => {
    const res = await exports.default.fetch("http://test.local/api/v1/readiness", {
      headers: { authorization: "Bearer nope" }
    });
    expect(res.status).toBe(401);
  });

  it("returns per-dependency status when authorized", async () => {
    const res = await exports.default.fetch("http://test.local/api/v1/readiness", {
      headers: { authorization: `Bearer ${API_TOKEN}` }
    });
    // env.test sets all three query ids + R2 bucket; D1 SELECT 1 works in-workerd.
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const parsed = readinessResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    const report = body as { status: string; checks: Record<string, { ok: boolean }> };
    expect(report.status).toBe("ok");
    expect(report.checks.d1.ok).toBe(true);
    expect(report.checks.r2.ok).toBe(true);
    expect(report.checks.config.ok).toBe(true);
  });

  it("returns 503 with per-dependency body when a check fails (direct, missing config)", async () => {
    const env = makeEnv({
      CUSTOMER_REPORT_QUERY_ID: "",
      ADDRESS_REPORT_QUERY_ID: "",
      CONTAINER_REPORT_QUERY_ID: ""
    });
    const res = await callMeta("/api/v1/readiness", env);
    expect(res.status).toBe(503);
    const body: unknown = await res.json();
    expect(readinessResponseSchema.safeParse(body).success).toBe(true);
    expect((body as { status: string }).status).toBe("degraded");
  });

  it("is advertised in the OpenAPI document with the readiness schema", async () => {
    const res = await exports.default.fetch("http://test.local/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(doc.paths["/api/v1/readiness"]).toBeDefined();
    expect(doc.paths["/api/v1/readiness"].get.responses?.["200"]).toBeDefined();
    expect(doc.paths["/api/v1/readiness"].get.responses?.["503"]).toBeDefined();
    expect(doc.components?.schemas?.["ReadinessResponse"]).toBeDefined();
  });
});
