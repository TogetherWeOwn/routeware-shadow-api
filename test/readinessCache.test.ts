import { afterEach, describe, expect, it, vi } from "vitest";
import { checkReadiness, READINESS_CACHE_TTL_MS } from "../src/lib/readiness";
import { metaRoutes, readinessResponseSchema } from "../src/routes/meta";

function countedDb() {
  const first = vi.fn(async () => ({ ok: 1 }));
  const all = vi.fn(async () => ({
    results: [{
      table_name: "customer",
      outcome: "success",
      mode: "chained-http",
      upserted: 3,
      row_count: 4,
      deleted: 0,
      ran_at: new Date(Date.now() - 60_000).toISOString(),
      duration_ms: 900
    }]
  }));
  const prepare = vi.fn((sql: string) => {
    if (sql === "SELECT 1 AS ok") return { first };
    if (sql.includes("FROM cron_sync_state")) return { all };
    throw new Error("Unexpected readiness query");
  });
  return { db: { prepare } as unknown as D1Database, prepare, first, all };
}

function makeEnv(db: D1Database): Env {
  return {
    CUSTOMER_DB: db,
    SNAPSHOTS: {} as R2Bucket,
    SNAPSHOTS_R2_ENABLED: "true",
    CUSTOMER_REPORT_QUERY_ID: "23",
    ADDRESS_REPORT_QUERY_ID: "24",
    CONTAINER_REPORT_QUERY_ID: "25"
  } as unknown as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function readiness(env: Env) {
  const response = await metaRoutes.fetch(
    new Request("http://test.local/api/v1/readiness"), env, ctx
  );
  return { status: response.status, body: await response.json() };
}

afterEach(() => vi.restoreAllMocks());

describe("readiness dependency cache", () => {
  it("serves ten rapid route hits with exactly two D1 queries and unchanged JSON shape", async () => {
    const now = Date.parse("2026-10-08T07:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = countedDb();
    const env = makeEnv(db.db);
    const responses = [];
    for (let i = 0; i < 10; i++) responses.push(await readiness(env));

    expect(db.prepare).toHaveBeenCalledTimes(2);
    expect(db.first).toHaveBeenCalledTimes(1);
    expect(db.all).toHaveBeenCalledTimes(1);
    const expected = {
      status: 200,
      body: {
        status: "ok",
        service: "routeware-shadow-api",
        checks: {
          d1: { ok: true },
          r2: { ok: true, bound: true, enabled: true },
          config: { ok: true, customer: true, address: true, container: true },
          cron: {
            ok: true, stale: false,
            lastRunAt: new Date(now - 60_000).toISOString(),
            tables: {
              customer: {
                outcome: "success", upserted: 3, rowCount: 4, deleted: 0,
                ranAt: new Date(now - 60_000).toISOString()
              },
              address: null,
              container: null
            }
          }
        }
      }
    };
    // Exact payload is pinned as well as the schema (which strips extra keys).
    for (const response of responses) {
      expect(readinessResponseSchema.safeParse(response.body).success).toBe(true);
      expect(response).toEqual(expected);
    }
  });

  it("coalesces ten concurrent cold route hits while D1 is still pending", async () => {
    const db = countedDb();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    db.first.mockImplementation(async () => { await pending; return { ok: 1 }; });
    const env = makeEnv(db.db);
    const burst = Promise.all(Array.from({ length: 10 }, () => readiness(env)));
    try {
      expect(db.prepare).toHaveBeenCalledTimes(2);
      expect(db.first).toHaveBeenCalledTimes(1);
      expect(db.all).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    const responses = await burst;
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.every((r) => JSON.stringify(r) === JSON.stringify(responses[0]))).toBe(true);
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it("expires exactly at 20 seconds without sliding on repeated hits", async () => {
    expect(READINESS_CACHE_TTL_MS).toBe(20_000);
    let now = Date.parse("2026-10-08T07:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const db = countedDb();
    const env = makeEnv(db.db);
    await readiness(env);
    db.first.mockRejectedValue(new Error("D1 unavailable"));
    now += READINESS_CACHE_TTL_MS - 1;
    expect((await readiness(env)).status).toBe(200);
    expect(db.prepare).toHaveBeenCalledTimes(2);
    now++;
    const expired = await readiness(env);
    expect(expired.status).toBe(503);
    expect(readinessResponseSchema.safeParse(expired.body).success).toBe(true);
    expect(db.prepare).toHaveBeenCalledTimes(4);
  });

  it("caches degraded results but observes recovery on expiry", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const db = countedDb();
    db.first.mockRejectedValue(new Error("D1 unavailable"));
    const env = makeEnv(db.db);
    for (let i = 0; i < 10; i++) expect((await readiness(env)).status).toBe(503);
    expect(db.prepare).toHaveBeenCalledTimes(2);
    db.first.mockResolvedValue({ ok: 1 });
    expect((await readiness(env)).status).toBe(503);
    now += READINESS_CACHE_TTL_MS;
    expect((await readiness(env)).status).toBe(200);
    expect(db.prepare).toHaveBeenCalledTimes(4);
  });

  it("starts the TTL before slow D1 I/O, not when it completes", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const db = countedDb();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    db.first.mockImplementationOnce(async () => { await pending; return { ok: 1 }; });
    const env = makeEnv(db.db);
    const first = checkReadiness(env);
    now += READINESS_CACHE_TTL_MS;
    release();
    await first;
    await checkReadiness(env);
    expect(db.prepare).toHaveBeenCalledTimes(4);
  });

  it("keeps a pending refresh single-flight even after multiple TTL windows", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const db = countedDb();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    db.first.mockImplementationOnce(async () => { await pending; return { ok: 1 }; });
    const env = makeEnv(db.db);
    const requests = [readiness(env)];
    for (let i = 1; i < 10; i++) {
      now += READINESS_CACHE_TTL_MS;
      requests.push(readiness(env));
    }
    try {
      expect(db.prepare).toHaveBeenCalledTimes(2);
      expect(db.first).toHaveBeenCalledTimes(1);
      expect(db.all).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    const responses = await Promise.all(requests);
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(db.prepare).toHaveBeenCalledTimes(2);
    // The expired observation is not made fresh by slow completion.
    expect((await readiness(env)).status).toBe(200);
    expect(db.prepare).toHaveBeenCalledTimes(4);
  });

  it("does not share observations between environments", async () => {
    const db = countedDb();
    const healthyEnv = makeEnv(db.db);
    await checkReadiness(healthyEnv);
    const missingBucketEnv = { ...healthyEnv, SNAPSHOTS: undefined } as unknown as Env;
    expect((await checkReadiness(missingBucketEnv)).httpStatus).toBe(503);
    expect((await checkReadiness(healthyEnv)).httpStatus).toBe(200);
    expect(db.prepare).toHaveBeenCalledTimes(4);
  });

  it("invalidates immediately when the D1 binding changes or disappears", async () => {
    const db = countedDb();
    const env = makeEnv(db.db);
    await checkReadiness(env);
    const replacement = countedDb();
    replacement.first.mockRejectedValue(new Error("replacement unavailable"));
    env.CUSTOMER_DB = replacement.db;
    expect((await checkReadiness(env)).httpStatus).toBe(503);
    expect(replacement.prepare).toHaveBeenCalledTimes(2);
    delete (env as Partial<Env>).CUSTOMER_DB;
    expect((await checkReadiness(env)).report.checks.d1).toEqual({
      ok: false, detail: "CUSTOMER_DB binding missing"
    });
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it("invalidates immediately when R2 is removed, disabled, or rebound", async () => {
    const db = countedDb();
    const env = makeEnv(db.db);
    await checkReadiness(env);
    delete (env as Partial<Env>).SNAPSHOTS;
    expect((await checkReadiness(env)).httpStatus).toBe(503);
    Object.assign(env, { SNAPSHOTS_R2_ENABLED: "false" });
    expect((await checkReadiness(env)).report.checks.r2).toEqual({
      ok: true, bound: false, enabled: false,
      detail: "R2 archiving disabled (SNAPSHOTS_R2_ENABLED=false)"
    });
    env.SNAPSHOTS = {} as R2Bucket;
    env.SNAPSHOTS_R2_ENABLED = "true";
    expect((await checkReadiness(env)).httpStatus).toBe(200);
    expect(db.prepare).toHaveBeenCalledTimes(8);
  });

  it("checks report configuration on every hit even with warm dependencies", async () => {
    const db = countedDb();
    const env = makeEnv(db.db);
    await checkReadiness(env);
    Object.assign(env, { CUSTOMER_REPORT_QUERY_ID: "" });
    const result = await checkReadiness(env);
    expect(result.httpStatus).toBe(503);
    expect(result.report.checks.config.customer).toBe(false);
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it("does not let a caller mutate the cached D1, R2, or nested cron result", async () => {
    const db = countedDb();
    const env = makeEnv(db.db);
    const { report } = await checkReadiness(env);
    report.checks.d1.ok = false;
    report.checks.r2.bound = false;
    report.checks.cron.tables.customer!.outcome = "failed";
    const next = await checkReadiness(env);
    expect(next.httpStatus).toBe(200);
    expect(next.report.checks.r2.bound).toBe(true);
    expect(next.report.checks.cron.tables.customer!.outcome).toBe("success");
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });
});
