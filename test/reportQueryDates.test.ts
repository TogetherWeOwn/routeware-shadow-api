import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import { InvalidReportQueryDatesError, readReportQueryDates } from "../src/lib/reportQueryDates";
import { fetchReportCsvByQueryId } from "../src/lib/routewareQueryReportCsv";
import { runDataSnapshotSync } from "../src/lib/snapshot/orchestration";
import { ensureD1TestTables } from "./d1TestMigrations";

const MESSAGE = "REPORT_QUERY dates must be real yyyy-MM-dd dates with start <= end.";
const INVALID_DATES = [
  "bogus-private-config",
  "2026-1-01",
  "2026/01/01",
  "20260101",
  "2026-01-01T00:00:00Z",
  "2026-01-01-extra",
  "2026-00-01",
  "2026-13-01",
  "2026-01-00",
  "2026-01-32",
  "2026-02-29",
  "1900-02-29",
  "2024-02-30",
  "2026-04-31"
];

function dates(start?: string, end?: string) {
  return { REPORT_QUERY_START_DATE: start, REPORT_QUERY_END_DATE: end };
}

describe("report query effective date range", () => {
  it.each(INVALID_DATES)("rejects %s in either date without retaining values", (bad) => {
    for (const range of [dates(bad, "9999-12-31"), dates("1900-01-01", bad)]) {
      let error: unknown;
      try {
        readReportQueryDates(range);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(InvalidReportQueryDatesError);
      expect((error as Error).message).toBe(MESSAGE);
      expect((error as Error).stack).not.toContain(bad);
    }
  });

  it("accepts leap days, ordered ranges and equal dates", () => {
    for (const [start, end] of [
      ["2024-02-29", "2024-03-01"],
      ["2000-02-29", "2000-02-29"],
      ["2025-12-31", "2026-01-01"],
      ["1900-01-01", "1900-01-01"]
    ]) {
      expect(readReportQueryDates(dates(start, end))).toEqual({ startDate: start, endDate: end });
    }
  });

  it("preserves trimming and missing/blank placeholder defaults", () => {
    expect(readReportQueryDates(dates())).toEqual({ startDate: "1900-01-01", endDate: "1900-01-01" });
    expect(readReportQueryDates(dates("", "  "))).toEqual({ startDate: "1900-01-01", endDate: "1900-01-01" });
    expect(readReportQueryDates(dates(" 2024-02-29 ", "2024-03-01\n"))).toEqual({ startDate: "2024-02-29", endDate: "2024-03-01" });
    expect(readReportQueryDates(dates(undefined, "2026-01-01"))).toEqual({ startDate: "1900-01-01", endDate: "2026-01-01" });
  });

  it("compares effective dates, including the fallback for a missing end", () => {
    expect(() => readReportQueryDates(dates("2026-06-10", "2026-06-01"))).toThrow(MESSAGE);
    expect(() => readReportQueryDates(dates("2026-06-10"))).toThrow(MESSAGE);
  });
});

const upstreamCalls: URL[] = [];
const capturedLogs: string[] = [];
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const db = (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
const bucket = (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
const CSV = "CustomerID,CompanyName,Enabled\n101,Synthetic Company,true\n";
const ADDRESS_CSV = "PickupAddressID,CustomerID\n201,101\n";
const CONTAINER_CSV = "ContainerID,PickupAddressID\n301,201\n";

function syncEnv(range: ReturnType<typeof dates>): Env {
  return {
    ...env,
    SHADOW_API_TOKEN: "test-api-token",
    CUSTOMER_SNAPSHOT_SYNC_SECRET: "test-sync-secret",
    ...range
  } as unknown as Env;
}

async function sync(path: string, bindings: Env): Promise<Response> {
  return app.fetch(new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { authorization: "Bearer test-sync-secret", origin: "https://client.example.test" }
  }), bindings, ctx);
}

describe("sync rejects invalid report query dates before side effects", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
    await db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Synthetic stale row', 1, '2000-01-01T00:00:00.000Z')").run();
  });

  beforeEach(() => {
    upstreamCalls.length = 0;
    capturedLogs.length = 0;
    for (const method of ["error", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        capturedLogs.push(args.map(String).join(" "));
      });
    }
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      upstreamCalls.push(url);
      if (url.pathname === "/WebRW/Reports/QueryRequestIsComplete") {
        return new Response("true", { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/WebRW/Reports/QueryExecuteDownload" || url.pathname === "/WebRW/reports/customer-static.csv") {
        return new Response(CSV, { headers: { "content-type": "text/csv" } });
      }
      if (url.pathname === "/WebRW/reports/address-static.csv") {
        return new Response(ADDRESS_CSV, { headers: { "content-type": "text/csv" } });
      }
      if (url.pathname === "/WebRW/reports/container-static.csv") {
        return new Response(CONTAINER_CSV, { headers: { "content-type": "text/csv" } });
      }
      throw new Error("Unexpected fetch in report date test");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    dates("bogus-private-config", "2042-12-31"),
    dates("2024-02-29", "bad-end-private-config"),
    dates("2026-02-30", "2026-03-01"),
    dates("2026-06-10", "2026-06-01"),
    dates("2026-06-10")
  ])("customer sync returns a fixed 503 for %j without upstream or storage writes", async (range) => {
    const path = "/api/v1/customer-snapshot/sync";
    const response = await sync(path, syncEnv(range));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example.test");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      type: problemType("misconfigured"),
      title: "Service Unavailable",
      status: 503,
      detail: `${MESSAGE} See docs/PROBLEMS.md#misconfigured.`,
      instance: path
    });
    const logs = capturedLogs.join("\n");
    for (const value of Object.values(range)) {
      if (value) {
        expect(text).not.toContain(value);
        expect(logs).not.toContain(value);
      }
    }
    expect(upstreamCalls).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM customer_snapshot WHERE customer_id = 999").first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM customer_snapshot").first("n")).toBe(1);
    expect((await bucket.list()).objects).toHaveLength(0);
  });

  it.each(["address", "container", "data"])("%s sync also returns 503 before fetching", async (table) => {
    const response = await sync(`/api/v1/${table}-snapshot/sync`, syncEnv(dates("bogus-private-config", "2042-12-31")));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect((await response.json() as { detail: string }).detail).toBe(`${MESSAGE} See docs/PROBLEMS.md#misconfigured.`);
    expect(upstreamCalls).toHaveLength(0);
  });

  it.each(["single-invocation", "chained-HTTP"])("%s combined sync preflights a later query before a static customer import", async (mode) => {
    const bindings = {
      ...syncEnv(dates("2026-02-30", "2026-03-01")),
      CUSTOMER_REPORT_QUERY_ID: "",
      CUSTOMER_REPORT_EXPORT_PATH: "/WebRW/reports/customer-static.csv"
    } as unknown as Env;
    if (mode === "single-invocation") {
      const error = await runDataSnapshotSync(bindings).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidReportQueryDatesError);
      expect((error as Error).message).toBe(MESSAGE);
    } else {
      const response = await sync("/api/v1/data-snapshot/sync", bindings);
      expect(response.status).toBe(503);
      expect((await response.json() as { detail: string }).detail).toBe(`${MESSAGE} See docs/PROBLEMS.md#misconfigured.`);
    }
    expect(upstreamCalls).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM customer_snapshot WHERE customer_id = 999").first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM customer_snapshot").first("n")).toBe(1);
    expect((await bucket.list()).objects).toHaveLength(0);
  });

  it.each(["single-invocation", "chained-HTTP"])(
    "static-export-only combined sync skips date validation (%s) and still imports",
    async (mode) => {
      const bindings = {
        ...syncEnv(dates("2026-06-10", "2026-06-01")),
        CUSTOMER_REPORT_QUERY_ID: "",
        ADDRESS_REPORT_QUERY_ID: "",
        CONTAINER_REPORT_QUERY_ID: "",
        CUSTOMER_REPORT_EXPORT_PATH: "/WebRW/reports/customer-static.csv",
        ADDRESS_REPORT_EXPORT_PATH: "/WebRW/reports/address-static.csv",
        CONTAINER_REPORT_EXPORT_PATH: "/WebRW/reports/container-static.csv",
        SNAPSHOTS_R2_ENABLED: "false"
      } as unknown as Env;
      if (mode === "single-invocation") {
        const out = await runDataSnapshotSync(bindings);
        expect(out.customer).toMatchObject({ upserted: 1, rowCount: 1 });
        expect(out.address).toMatchObject({ upserted: 1, rowCount: 1 });
        expect(out.container).toMatchObject({ upserted: 1, rowCount: 1 });
      } else {
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const raw =
            typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
          const url = new URL(raw);
          // Loop chained per-table subrequests back into the app with the same bindings.
          if (url.origin === "http://test.local") {
            return app.fetch(
              new Request(raw, { method: init?.method ?? "GET", headers: init?.headers as HeadersInit }),
              bindings,
              ctx
            );
          }
          upstreamCalls.push(url);
          if (url.pathname === "/WebRW/reports/customer-static.csv") {
            return new Response(CSV, { headers: { "content-type": "text/csv" } });
          }
          if (url.pathname === "/WebRW/reports/address-static.csv") {
            return new Response(ADDRESS_CSV, { headers: { "content-type": "text/csv" } });
          }
          if (url.pathname === "/WebRW/reports/container-static.csv") {
            return new Response(CONTAINER_CSV, { headers: { "content-type": "text/csv" } });
          }
          throw new Error("Unexpected fetch in report date test");
        });
        const response = await sync("/api/v1/data-snapshot/sync", bindings);
        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<
          string,
          { upserted: number; rowCount: number } | null
        >;
        expect(body.customer).toMatchObject({ upserted: 1, rowCount: 1 });
        expect(body.address).toMatchObject({ upserted: 1, rowCount: 1 });
        expect(body.container).toMatchObject({ upserted: 1, rowCount: 1 });
      }
      expect(
        await db
          .prepare("SELECT company_name FROM customer_snapshot WHERE customer_id = 101")
          .first("company_name")
      ).toBe("Synthetic Company");
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM address_snapshot WHERE pickup_address_id = 201")
          .first("n")
      ).toBe(1);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM container_snapshot WHERE container_id = 301")
          .first("n")
      ).toBe(1);
    }
  );

  it("rejects at the CSV fetch helper as well, before session access or polling", async () => {
    const bindings = { ...dates("bogus-private-config", "2042-12-31") } as unknown as Env;
    const error = await fetchReportCsvByQueryId(bindings, "23").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidReportQueryDatesError);
    expect((error as Error).message).toBe(MESSAGE);
    expect(upstreamCalls).toHaveLength(0);
  });

  it.each([
    ["2024-02-29", "2024-03-01"],
    ["2000-02-29", "2000-02-29"],
    [undefined, undefined],
    ["", "  "]
  ])("valid customer sync still imports with range %s to %s", async (start, end) => {
    const response = await sync("/api/v1/customer-snapshot/sync", {
      ...syncEnv(dates(start, end)), SNAPSHOTS_R2_ENABLED: "false"
    } as unknown as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ upserted: 1, rowCount: 1 });
    expect(await db.prepare("SELECT company_name FROM customer_snapshot WHERE customer_id = 101").first("company_name")).toBe("Synthetic Company");
    expect(upstreamCalls).toHaveLength(2);
    const download = upstreamCalls[1];
    expect(download.pathname).toBe("/WebRW/Reports/QueryExecuteDownload");
    expect(download.searchParams.get("startDate")).toBe(start?.trim() || "1900-01-01");
    expect(download.searchParams.get("endDate")).toBe(end?.trim() || "1900-01-01");
  });
});
