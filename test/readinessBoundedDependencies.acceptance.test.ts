import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { checkReadiness, READINESS_CACHE_TTL_MS } from "../src/lib/readiness";
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "../src/lib/upstreamTimeout";
import { metaRoutes, readinessResponseSchema } from "../src/routes/meta";

// Focused, credential-free check (intentionally RED until the paired build):
// npx vitest run test/readinessBoundedDependencies.acceptance.test.ts test/readinessCache.test.ts test/readiness.test.ts
// Only existing entry points/constants are imported. The lesser of the existing
// interactive timeout and cache TTL is a conservative response-wait ceiling,
// not a new setting or a claim that a timeout cancels underlying D1 work.
const RESPONSE_WAIT_CEILING_MS = Math.min(DEFAULT_UPSTREAM_TIMEOUT_MS, READINESS_CACHE_TTL_MS);
const START = Date.parse("2026-10-21T12:00:00Z");
const MARKERS = [
  "SYNTHETIC_SECRET_NEVER_ECHO",
  "SYNTHETIC_CUSTOMER_NEVER_ECHO",
  "SELECT private_fixture FROM synthetic_customer",
  "SYNTHETIC_ENV_NEVER_ECHO",
  "SYNTHETIC_STACK_NEVER_ECHO"
];
const DIAGNOSTICS = {
  pingTimeout: { code: "d1_ping_timeout", next_action: "retry_after_cache_ttl" },
  pingFailure: { code: "d1_ping_failed", next_action: "retry_after_cache_ttl" },
  cronTimeout: { code: "cron_state_timeout", next_action: "retry_after_cache_ttl" },
  cronFailure: { code: "cron_state_failed", next_action: "retry_after_cache_ttl" }
} as const;

type Result = Awaited<ReturnType<typeof checkReadiness>>;
type Ping = { ok: number };
type CronRows = {
  results: Array<{
    table_name: string; outcome: string; mode: string; upserted: number;
    row_count: number; deleted: number; ran_at: string; duration_ms: number;
  }>;
};
const cleanups: Array<() => void> = [];
let capturedLogs: unknown[][] = [];
let networkCalls = 0;

function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((yes, no) => {
    resolve = (value) => { settled = true; yes(value); };
    reject = (error) => { settled = true; no(error); };
  });
  cleanups.push(() => { if (!settled) resolve(cleanupValue); });
  return { promise, resolve, reject, isSettled: () => settled };
}

function healthyCron(): CronRows {
  return {
    results: [{
      table_name: "customer", outcome: "success", mode: "chained-http",
      upserted: 3, row_count: 4, deleted: 0,
      ran_at: new Date(START - 60_000).toISOString(), duration_ms: 900
    }]
  };
}

function fakeDb() {
  const first = vi.fn<() => Promise<Ping>>(() => Promise.resolve({ ok: 1 }));
  const all = vi.fn<() => Promise<CronRows>>(() => Promise.resolve(healthyCron()));
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
    CONTAINER_REPORT_QUERY_ID: "25",
    SHADOW_API_TOKEN: "test-api-token",
    AUTH_SESSION: {
      idFromName: () => "synthetic-readiness-session",
      get: () => ({ fetch: async () => new Response("{}") })
    }
  } as unknown as Env;
}

function observe<T>(promise: Promise<T>) {
  let outcome: { value: T } | { error: unknown } | undefined;
  void promise.then(
    (value) => { outcome = { value }; },
    (error: unknown) => { outcome = { error }; }
  );
  return {
    settled: () => outcome !== undefined,
    take(): T {
      expect(outcome, "readiness must settle within the repository response-wait ceiling").toBeDefined();
      if (!outcome) throw new Error("Readiness response-wait budget exceeded");
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    }
  };
}

async function flush() {
  // No real sleeps or I/O: let route/dependency continuations drain.
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function withinBudget<T>(pending: ReturnType<typeof observe<T>>) {
  await vi.advanceTimersByTimeAsync(RESPONSE_WAIT_CEILING_MS);
  await flush();
  return pending.take();
}

async function expireInitialRefresh() {
  await vi.advanceTimersByTimeAsync(START + READINESS_CACHE_TTL_MS - Date.now());
}

function expectQueries(db: ReturnType<typeof fakeDb>, refreshes: number) {
  expect(db.prepare).toHaveBeenCalledTimes(refreshes * 2);
  expect(db.first).toHaveBeenCalledTimes(refreshes);
  expect(db.all).toHaveBeenCalledTimes(refreshes);
}

function expectReport(result: Result, status: 200 | 503) {
  expect(result.httpStatus).toBe(status);
  expect(result.report.status).toBe(status === 200 ? "ok" : "degraded");
  expect(result.report.service).toBe("routeware-shadow-api");
  expect(result.report.checks.r2).toMatchObject({ ok: true, bound: true, enabled: true });
  expect(result.report.checks.config).toEqual({
    ok: true, customer: true, address: true, container: true
  });
  const parsed = readinessResponseSchema.safeParse(result.report);
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data).toEqual(result.report);
}

function expectDiagnostic(check: unknown, diagnostic: { code: string; next_action: string }) {
  // This is a consumer-visible allowlist, not an implementation export. It
  // deliberately leaves healthy payloads and existing fixed detail text alone.
  expect(check).toMatchObject({ ok: false, ...diagnostic });
}

function markerError(variant = "one") {
  const error = new Error(`${variant}: ${MARKERS.join(" | ")}`);
  error.stack = `${MARKERS[4]} at synthetic-fixture:1:1`;
  return error;
}

function expectNoLeaks(value: unknown) {
  const text = JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error ? { ...item, message: item.message, stack: item.stack } : item);
  for (const marker of MARKERS) expect(text).not.toContain(marker);
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  capturedLogs = [];
  networkCalls = 0;
  // The readiness boundary may never escape to a real upstream.
  vi.stubGlobal("fetch", () => {
    networkCalls++;
    throw new Error("Unexpected network call");
  });
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { capturedLogs.push(args); });
  }
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await flush();
  try {
    expectNoLeaks(capturedLogs);
    expect(JSON.stringify(capturedLogs)).not.toContain("SELECT 1 AS ok");
    expect(JSON.stringify(capturedLogs)).not.toContain("cron_sync_state");
    expect(networkCalls).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("bounded readiness dependency observations", () => {
  it("shares a healthy pending refresh across ten callers without changing the healthy payload", async () => {
    const db = fakeDb();
    const ping = deferred<Ping>({ ok: 1 });
    const cron = deferred<CronRows>(healthyCron());
    db.first.mockReturnValueOnce(ping.promise);
    db.all.mockReturnValueOnce(cron.promise);
    const env = makeEnv(db.db);
    const burst = observe(Promise.all(Array.from({ length: 10 }, () => checkReadiness(env))));
    await vi.advanceTimersByTimeAsync(1);
    expect(burst.settled()).toBe(false);
    expectQueries(db, 1);
    ping.resolve({ ok: 1 });
    cron.resolve(healthyCron());
    await flush();
    const results = burst.take();
    for (const result of results) {
      expectReport(result, 200);
      expect(result).toEqual(results[0]);
      expect(result.report.checks.d1).toEqual({ ok: true });
      expect(result.report.checks.cron).toMatchObject({
        ok: true, stale: false, lastRunAt: new Date(START - 60_000).toISOString()
      });
    }
    expectQueries(db, 1);
  });

  it.each(["ping", "cron", "both"] as const)(
    "bounds a never-settling %s observation for ten callers without cancelling its underlying promise",
    async (hang) => {
      const db = fakeDb();
      const ping = deferred<Ping>({ ok: 1 });
      const cron = deferred<CronRows>(healthyCron());
      if (hang !== "cron") db.first.mockReturnValueOnce(ping.promise);
      if (hang !== "ping") db.all.mockReturnValueOnce(cron.promise);
      const env = makeEnv(db.db);
      const burst = observe(Promise.all(Array.from({ length: 10 }, () => checkReadiness(env))));
      const results = await withinBudget(burst);
      for (const result of results) {
        expectReport(result, hang === "cron" ? 200 : 503);
        expect(result).toEqual(results[0]);
        if (hang !== "cron") {
          expectDiagnostic(result.report.checks.d1, DIAGNOSTICS.pingTimeout);
          expect(ping.isSettled()).toBe(false);
        } else {
          expect(result.report.checks.d1).toEqual({ ok: true });
        }
        if (hang !== "ping") {
          expectDiagnostic(result.report.checks.cron, DIAGNOSTICS.cronTimeout);
          expect(result.report.checks.cron).toMatchObject({
            stale: true, lastRunAt: null,
            tables: { customer: null, address: null, container: null }
          });
          expect(cron.isSettled()).toBe(false);
        }
      }
      expectQueries(db, 1);
    }
  );

  it.each(["ping", "cron"] as const)(
    "expires a timed-out %s entry and recovers with one refresh for ten new callers",
    async (hang) => {
      const db = fakeDb();
      const unresolved = hang === "ping" ? deferred<Ping>({ ok: 1 }) : deferred<CronRows>(healthyCron());
      if (hang === "ping") db.first.mockReturnValueOnce(unresolved.promise as Promise<Ping>);
      else db.all.mockReturnValueOnce(unresolved.promise as Promise<CronRows>);
      const env = makeEnv(db.db);
      const first = observe(checkReadiness(env));
      const failed = await withinBudget(first);
      expectReport(failed, hang === "ping" ? 503 : 200);
      expectDiagnostic(hang === "ping" ? failed.report.checks.d1 : failed.report.checks.cron,
        hang === "ping" ? DIAGNOSTICS.pingTimeout : DIAGNOSTICS.cronTimeout);
      // Cache timeout failures too: ten more hits just BEFORE inclusive expiry
      // must not start ten replacement queries, or slide the original TTL.
      vi.setSystemTime(START + READINESS_CACHE_TTL_MS - 1);
      const cached = await Promise.all(Array.from({ length: 10 }, () => checkReadiness(env)));
      for (const result of cached) expect(result).toEqual(failed);
      expectQueries(db, 1);
      // Expiry is measured from refresh START, never from its timeout/completion.
      await expireInitialRefresh();
      const recovered = await Promise.all(Array.from({ length: 10 }, () => checkReadiness(env)));
      for (const result of recovered) {
        expectReport(result, 200);
        expect(result.report.checks.d1).toEqual({ ok: true });
        expect(result.report.checks.cron.ok).toBe(true);
      }
      expectQueries(db, 2);
      expect(unresolved.isSettled()).toBe(false);
    }
  );

  it.each(["ping", "cron"] as const)(
    "caches a rejected %s observation without sliding expiry on repeated hits",
    async (failedDependency) => {
      const db = fakeDb();
      if (failedDependency === "ping") db.first.mockRejectedValueOnce(new Error("synthetic unavailable"));
      else db.all.mockRejectedValueOnce(new Error("synthetic unavailable"));
      const env = makeEnv(db.db);
      const initial = await checkReadiness(env);
      expect(initial.httpStatus).toBe(failedDependency === "ping" ? 503 : 200);
      expect(failedDependency === "ping" ? initial.report.checks.d1.ok : initial.report.checks.cron.ok).toBe(false);
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(START + Math.floor((READINESS_CACHE_TTL_MS - 1) * i / 9));
        expect(await checkReadiness(env)).toEqual(initial);
      }
      expectQueries(db, 1);
      vi.setSystemTime(START + READINESS_CACHE_TTL_MS);
      expectReport(await checkReadiness(env), 200);
      expectQueries(db, 2);
    }
  );

  it.each(["resolve", "reject"] as const)(
    "ignores a late ping %s after timeout and a newer failed refresh",
    async (completion) => {
      const db = fakeDb();
      const late = deferred<Ping>({ ok: 1 });
      db.first.mockReturnValueOnce(late.promise);
      const env = makeEnv(db.db);
      const timedOut = await withinBudget(observe(checkReadiness(env)));
      await expireInitialRefresh();
      db.first.mockRejectedValueOnce(new Error("new observation unavailable"));
      db.all.mockResolvedValueOnce({
        results: [{ ...healthyCron().results[0], upserted: 99, row_count: 100 }]
      });
      const newer = await checkReadiness(env);
      expectReport(newer, 503);
      expect(newer.report.checks.cron.tables.customer?.rowCount).toBe(100);
      if (completion === "resolve") late.resolve({ ok: 1 });
      else late.reject(markerError("late"));
      await flush();
      expect(await checkReadiness(env)).toEqual(newer);
      expectDiagnostic(newer.report.checks.d1, DIAGNOSTICS.pingFailure);
      expectDiagnostic(timedOut.report.checks.d1, DIAGNOSTICS.pingTimeout);
      expectQueries(db, 2);
    }
  );

  it.each(["resolve", "reject"] as const)(
    "ignores a late cron %s after timeout and a newer healthy refresh",
    async (completion) => {
      const db = fakeDb();
      const late = deferred<CronRows>(healthyCron());
      db.all.mockReturnValueOnce(late.promise);
      const env = makeEnv(db.db);
      await withinBudget(observe(checkReadiness(env)));
      await expireInitialRefresh();
      const newer = await checkReadiness(env);
      expectReport(newer, 200);
      if (completion === "resolve") late.resolve({ results: [] });
      else late.reject(markerError("late"));
      await flush();
      expect(await checkReadiness(env)).toEqual(newer);
      expect(newer.report.checks.cron.ok).toBe(true);
      expectQueries(db, 2);
    }
  );

  it("isolates environments even while another environment has a stuck refresh", async () => {
    const stuck = fakeDb();
    stuck.first.mockReturnValueOnce(deferred<Ping>({ ok: 1 }).promise);
    const pending = observe(checkReadiness(makeEnv(stuck.db)));
    const healthy = fakeDb();
    const env = makeEnv(healthy.db);
    expectReport(await checkReadiness(env), 200);
    expectReport(await checkReadiness(env), 200);
    expect(pending.settled()).toBe(false);
    expectQueries(stuck, 1);
    expectQueries(healthy, 1);
  });

  it.each(["d1", "r2", "r2-mode"] as const)(
    "invalidates a pending refresh immediately after a %s binding/mode change",
    async (change) => {
      const old = fakeDb();
      const late = deferred<Ping>({ ok: 1 });
      old.first.mockReturnValueOnce(late.promise);
      const env = makeEnv(old.db);
      const pending = observe(checkReadiness(env));
      await flush();
      const replacement = fakeDb();
      if (change === "d1") env.CUSTOMER_DB = replacement.db;
      else if (change === "r2") env.SNAPSHOTS = {} as R2Bucket;
      else Object.assign(env, { SNAPSHOTS_R2_ENABLED: "false" });
      const newer = await checkReadiness(env);
      expect(newer.httpStatus).toBe(200);
      if (change === "r2-mode") expect(newer.report.checks.r2.enabled).toBe(false);
      expect(pending.settled()).toBe(false);
      late.reject(new Error("superseded binding unavailable"));
      await flush();
      expect(await checkReadiness(env)).toEqual(newer);
      expectQueries(old, change === "d1" ? 1 : 2);
      if (change === "d1") expectQueries(replacement, 1);
    }
  );
});

describe("bounded readiness HTTP contract", () => {
  async function request(env: Env, token?: string) {
    return app.fetch(new Request("http://test.local/api/v1/readiness", {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    }), env, ctx);
  }

  it("reauthorizes every warm-cache hit and keeps 200/401 responses no-store", async () => {
    const db = fakeDb();
    const env = makeEnv(db.db);
    const healthy = await request(env, "test-api-token");
    expect(healthy.status).toBe(200);
    expect(healthy.headers.get("cache-control")).toBe("no-store");
    for (const token of [undefined, "wrong-synthetic-token"]) {
      const unauthorized = await request(env, token);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("cache-control")).toBe("no-store");
      expect(unauthorized.headers.get("content-type")).toContain("problem+json");
    }
    expectQueries(db, 1);
  });

  it.each(["ping", "cron"] as const)(
    "returns the bounded %s result through auth and no-store middleware",
    async (hang) => {
      const db = fakeDb();
      if (hang === "ping") db.first.mockReturnValueOnce(deferred<Ping>({ ok: 1 }).promise);
      else db.all.mockReturnValueOnce(deferred<CronRows>(healthyCron()).promise);
      const env = makeEnv(db.db);
      const pending = observe(request(env, "test-api-token"));
      const unauthorized = await request(env);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("cache-control")).toBe("no-store");
      const response = await withinBudget(pending);
      expect(response.status).toBe(hang === "ping" ? 503 : 200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json() as { checks: { d1: unknown; cron: unknown } };
      expectDiagnostic(hang === "ping" ? body.checks.d1 : body.checks.cron,
        hang === "ping" ? DIAGNOSTICS.pingTimeout : DIAGNOSTICS.cronTimeout);
      expectNoLeaks(body);
      expectQueries(db, 1);
    }
  );
});

describe("allowlisted readiness recovery diagnostics", () => {
  it.each([
    ["ping", "reject"], ["ping", "throw"], ["ping", "prepare"],
    ["cron", "reject"], ["cron", "throw"], ["cron", "prepare"]
  ] as const)("sanitizes marker-bearing %s %s errors in HTTP responses and logs", async (dependency, failure) => {
    const reports: unknown[] = [];
    for (const variant of ["one", "two"]) {
      const db = fakeDb();
      const error = markerError(variant);
      if (failure === "prepare") {
        const prepare = db.prepare.getMockImplementation()!;
        db.prepare.mockImplementation((sql) => {
          if ((dependency === "ping" && sql === "SELECT 1 AS ok") ||
              (dependency === "cron" && sql.includes("FROM cron_sync_state"))) throw error;
          return prepare(sql);
        });
      } else if (dependency === "ping") {
        if (failure === "throw") db.first.mockImplementationOnce(() => { throw error; });
        else db.first.mockRejectedValueOnce(error);
      } else {
        if (failure === "throw") db.all.mockImplementationOnce(() => { throw error; });
        else db.all.mockRejectedValueOnce(error);
      }
      const response = await metaRoutes.fetch(
        new Request("http://test.local/api/v1/readiness"), makeEnv(db.db), ctx
      );
      const body = await response.json() as { status: string; checks: { d1: unknown; cron: unknown } };
      expect(response.status).toBe(dependency === "ping" ? 503 : 200);
      expect(body.status).toBe(dependency === "ping" ? "degraded" : "ok");
      const parsed = readinessResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(body);
      expectNoLeaks(body);
      expectDiagnostic(dependency === "ping" ? body.checks.d1 : body.checks.cron,
        dependency === "ping" ? DIAGNOSTICS.pingFailure : DIAGNOSTICS.cronFailure);
      reports.push(body);
      expect(db.prepare).toHaveBeenCalledTimes(2);
      expect(db.first).toHaveBeenCalledTimes(failure === "prepare" && dependency === "ping" ? 0 : 1);
      expect(db.all).toHaveBeenCalledTimes(failure === "prepare" && dependency === "cron" ? 0 : 1);
    }
    // Distinct exception messages must select the same fixed diagnostic, not a
    // truncated/redacted/hash-encoded variant of the original exception.
    expect(reports[1]).toEqual(reports[0]);
  });
});
