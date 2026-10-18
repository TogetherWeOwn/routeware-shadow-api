import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-run correlation id on the single-invocation fallback path.
 *
 * `runDataSnapshotSync` hands `opts` to the three per-table runners
 * (`src/lib/snapshot/orchestration.ts` lines ~570/~585/~611). Those call sites
 * were unpinned: dropping all three left the suite green because the
 * threading tests only drove `runDataSnapshotSync` with an empty env, where
 * no per-table runner runs (Paperclip Review 4/5 on b0eabbe, warning 2).
 *
 * This file configures all three report sources with a stubbed report fetch
 * and drives the real runners against the test D1, so a dropped handoff at
 * any of the three call sites surfaces as a missing runId: the dry-run test
 * pins the handoff to each runner's dry-run line, and the archive test pins
 * the whole chain down to every `snapshot.r2*` line. The report fetch is
 * stubbed at the module boundary; everything below it (runners, D1 sync, R2
 * archive logging) is real. R2 archival is disabled, so nothing writes to R2
 * beyond the disabled marker lines — the enabled-bucket leg is pinned per
 * table by `test/r2ArchiveRunIdRoute.test.ts`.
 */

const RUN_ID = "123e4567-e89b-12d3-a456-426614174000";

const CUSTOMER_CSV = [
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled",
  "901,,Acme Corp,John,,Doe,,,,,,,true",
  "902,,Beta LLC,Jane,,Smith,,,,,,,true"
].join("\n");

const ADDRESS_CSV = [
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date",
  "90,901,,90 Main St,Killeen,TX,76541,,,false,true,,,,"
].join("\n");

const CONTAINER_CSV = [
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote",
  "900,90,,SN-900,,false,,false,,,true,900 Main St,Killeen,TX,76541,"
].join("\n");

const CSV_BY_QID: Record<string, string> = {
  "23": CUSTOMER_CSV,
  "24": ADDRESS_CSV,
  "25": CONTAINER_CSV
};

vi.mock("../src/lib/routewareQueryReportCsv", () => ({
  fetchReportCsvByQueryId: async (_env: unknown, queryId: string) => {
    const csv = CSV_BY_QID[queryId];
    if (!csv) throw new Error(`Unexpected report queryID in test: ${queryId}`);
    const { stringToUint8Stream } = await import("../src/lib/csvStream");
    return { body: stringToUint8Stream(csv) };
  }
}));

vi.mock("../src/lib/snapshot/reportFetch", () => ({
  fetchReportCsvForPath: async (_env: unknown, path: string) => {
    throw new Error(`Unexpected report path fetch in test: ${path}`);
  }
}));

import { env } from "cloudflare:workers";
import { runDataSnapshotSync } from "../src/lib/snapshot/orchestration";
import { ensureD1TestTables } from "./d1TestMigrations";

function configuredEnv(): Env {
  return {
    ...env,
    CUSTOMER_REPORT_QUERY_ID: "23",
    ADDRESS_REPORT_QUERY_ID: "24",
    CONTAINER_REPORT_QUERY_ID: "25",
    SNAPSHOTS_R2_ENABLED: "false"
  } as unknown as Env;
}

const logs: Array<Record<string, unknown>> = [];
const realConsoleInfo = console.info;

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(() => {
  logs.length = 0;
  console.info = (...args: unknown[]) => {
    logs.push(args[0] as Record<string, unknown>);
  };
});

afterEach(() => {
  console.info = realConsoleInfo;
});

describe("runDataSnapshotSync configured-source runId threading", () => {
  it("carries runId onto every per-table dry-run line", async () => {
    // Act — all three runners execute (dry-run: parse/validate, write nothing).
    const result = await runDataSnapshotSync(configuredEnv(), {
      runId: RUN_ID,
      dryRun: true
    });

    // Assert — every runner ran, so its dry-run line is the one under test.
    expect(result.customer).not.toBeNull();
    expect(result.address).not.toBeNull();
    expect(result.container).not.toBeNull();
    const dryRunLines = logs.filter((l) => String(l.msg ?? "").includes("dry run"));
    expect(dryRunLines.map((l) => l.table).sort()).toEqual([
      "address",
      "container",
      "customer"
    ]);
    for (const line of dryRunLines) {
      expect(line.runId).toBe(RUN_ID);
    }
  });

  it("carries runId onto every snapshot.r2 line through the real runners", async () => {
    // Act — full D1 sync per table; the R2 leg logs its disabled marker.
    const result = await runDataSnapshotSync(configuredEnv(), { runId: RUN_ID });

    // Assert — the R2 leg really ran for every table, so its lines are pinned.
    expect(result.customer).toMatchObject({ r2: { status: "disabled" } });
    expect(result.address).toMatchObject({ r2: { status: "disabled" } });
    expect(result.container).toMatchObject({ r2: { status: "disabled" } });
    const lines = logs.filter((l) => String(l.route ?? "").startsWith("snapshot.r2"));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.table).sort()).toEqual([
      "address",
      "container",
      "customer"
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({ msg: "R2 snapshot archive disabled", runId: RUN_ID });
    }
  });

  it("emits byte-identical lines without a runId", async () => {
    // Act — direct callers without a run keep the previous shape.
    await runDataSnapshotSync(configuredEnv(), { dryRun: true });

    // Assert
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect("runId" in line).toBe(false);
    }
  });
});
