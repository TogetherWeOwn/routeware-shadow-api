import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-run correlation id on the R2 archive leg of a real per-table sync (TOG-19134).
 *
 * The route's `x-run-id` must reach `runCustomerSnapshotSync` and from there every
 * `snapshot.r2*` line, through `syncTableWithR2`. Driven through the real route with
 * R2 enabled against the test bucket, so a dropped pass-through in
 * `src/lib/snapshot/orchestration.ts` surfaces as a missing runId here.
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
const CUSTOMER_QID = "23";

const CUSTOMER_CSV = [
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled",
  "101,,Acme Corp,John,,Doe,,,,,,,true",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true"
].join("\n");

const CTX = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function r2EnabledEnv(): Env {
  return { ...env, SNAPSHOTS_R2_ENABLED: "true" } as unknown as Env;
}

const logged: Array<Record<string, unknown>> = [];
const realConsoleInfo = console.info;

describe("customer sync route stamps the x-run-id on every R2 archive line", () => {
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
        if (qid !== CUSTOMER_QID) {
          throw new Error(`Unexpected report queryID in test: ${qid}`);
        }
        return new Response(CUSTOMER_CSV, {
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

  it("every snapshot.r2 line carries the runId the route received", async () => {
    // Act
    const res = await app.fetch(
      new Request("http://test.local/api/v1/customer-snapshot/sync", {
        method: "POST",
        headers: { authorization: `Bearer ${SYNC_SECRET}`, "x-run-id": RUN_ID }
      }),
      r2EnabledEnv(),
      CTX
    );

    // Assert — the R2 leg really ran, so its lines are the ones under test.
    expect(res.status).toBe(200);
    const bucket = (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
    const listed = await bucket.list({ prefix: "snapshots/" });
    expect(listed.objects.length).toBeGreaterThan(0);

    const r2Lines = logged.filter((l) => String(l.route ?? "").startsWith("snapshot.r2"));
    expect(r2Lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(["R2 snapshot stored", "R2 snapshot manifest updated"])
    );
    for (const line of r2Lines) {
      expect(line.runId).toBe(RUN_ID);
    }
  });
});
