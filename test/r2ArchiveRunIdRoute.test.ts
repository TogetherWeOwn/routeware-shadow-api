import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-run correlation id on the R2 archive leg of real per-table syncs.
 *
 * Each table route's `x-run-id` must reach its snapshot runner and from there
 * every `snapshot.r2*` line, through `syncTableWithR2`. Driven through the real
 * routes with R2 enabled against the test bucket, so a dropped pass-through in
 * `src/lib/snapshot/orchestration.ts` (the customer leg at line ~159, the
 * address leg at line ~208, the container leg at line ~257) surfaces as a
 * missing runId here. All three tables are covered: the address and container
 * legs were unpinned before (Paperclip Review 4/5 on b0eabbe, warning 1).
 *
 * Address rows reference customer 101 and container rows reference address 10,
 * so each test syncs its own parents first (without a run id) to satisfy the
 * D1 foreign keys; the log capture is cleared before the assertion sync.
 */

const RUN_ID = "123e4567-e89b-12d3-a456-426614174000";

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=r2-runid-test-session", Date.now() + 60_000, lockToken);
  })
}));

import { env } from "cloudflare:workers";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

const SYNC_SECRET = "test-sync-secret";

const CUSTOMER_CSV = [
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled",
  "101,,Acme Corp,John,,Doe,,,,,,,true",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true"
].join("\n");

const ADDRESS_CSV = [
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date",
  "10,101,,10 Main St,Killeen,TX,76541,,,false,true,,,,"
].join("\n");

const CONTAINER_CSV = [
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote",
  "100,10,,SN-100,,false,,false,,,true,100 Main St,Killeen,TX,76541,"
].join("\n");

const CSV_BY_QID: Record<string, string> = {
  "23": CUSTOMER_CSV,
  "24": ADDRESS_CSV,
  "25": CONTAINER_CSV
};

const PATH_BY_TABLE: Record<string, string> = {
  customer: "/api/v1/customer-snapshot/sync",
  address: "/api/v1/address-snapshot/sync",
  container: "/api/v1/container-snapshot/sync"
};

const CTX = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function r2EnabledEnv(): Env {
  return { ...env, SNAPSHOTS_R2_ENABLED: "true" } as unknown as Env;
}

const logged: Array<Record<string, unknown>> = [];
const realConsoleInfo = console.info;

async function postSync(table: string, runId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${SYNC_SECRET}`
  };
  if (runId) headers["x-run-id"] = runId;
  return app.fetch(
    new Request(`http://test.local${PATH_BY_TABLE[table]}`, {
      method: "POST",
      headers
    }),
    r2EnabledEnv(),
    CTX
  );
}

function r2Lines(): Array<Record<string, unknown>> {
  return logged.filter((l) => String(l.route ?? "").startsWith("snapshot.r2"));
}

describe("per-table sync routes stamp the x-run-id on every R2 archive line", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(() => {
    logged.length = 0;
    console.info = (...args: unknown[]) => {
      logged.push(args[0] as Record<string, unknown>);
    };
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/Reports/QueryRequestIsComplete")) {
        return new Response("true", {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/Reports/QueryExecuteDownload")) {
        const qid = new URL(url).searchParams.get("queryID") ?? "";
        const csv = CSV_BY_QID[qid];
        if (!csv) {
          throw new Error(`Unexpected report queryID in test: ${qid}`);
        }
        return new Response(csv, {
          status: 200,
          headers: { "content-type": "text/csv" }
        });
      }
      if (url.includes("killeen.routeware.com")) {
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    console.info = realConsoleInfo;
    globalThis.fetch = originalFetch;
  });

  it("customer: every snapshot.r2 line carries the runId the route received", async () => {
    // Act
    const res = await postSync("customer", RUN_ID);

    // Assert — the R2 leg really ran, so its lines are the ones under test.
    expect(res.status).toBe(200);
    const bucket = (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
    const listed = await bucket.list({ prefix: "snapshots/" });
    expect(listed.objects.length).toBeGreaterThan(0);

    const lines = r2Lines();
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(["R2 snapshot stored", "R2 snapshot manifest updated"])
    );
    for (const line of lines) {
      expect(line.runId).toBe(RUN_ID);
    }
  });

  it("address: every snapshot.r2 line carries the runId the route received", async () => {
    // Arrange — the address FK needs customer 101; sync it first with no id.
    expect((await postSync("customer")).status).toBe(200);
    logged.length = 0;

    // Act
    const res = await postSync("address", RUN_ID);

    // Assert
    expect(res.status).toBe(200);
    const lines = r2Lines();
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(["R2 snapshot stored", "R2 snapshot manifest updated"])
    );
    for (const line of lines) {
      expect(line.runId).toBe(RUN_ID);
    }
  });

  it("container: every snapshot.r2 line carries the runId the route received", async () => {
    // Arrange — the container FK needs address 10 (which needs customer 101).
    expect((await postSync("customer")).status).toBe(200);
    expect((await postSync("address")).status).toBe(200);
    logged.length = 0;

    // Act
    const res = await postSync("container", RUN_ID);

    // Assert
    expect(res.status).toBe(200);
    const lines = r2Lines();
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(["R2 snapshot stored", "R2 snapshot manifest updated"])
    );
    for (const line of lines) {
      expect(line.runId).toBe(RUN_ID);
    }
  });
});
