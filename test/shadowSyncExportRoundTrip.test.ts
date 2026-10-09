import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-8370 (R2 gap G14) — shadow sync → export round-trip, hermetic end to end.
 *
 * The two halves already exist apart and this file does not re-pin them:
 *
 * - `test/snapshotSyncE2E.test.ts` pins the per-table sync bodies
 *   (`{upserted, rowCount, deleted}`) through the real routes, including the
 *   R2 archive leg and the reconcile-delete path;
 * - `test/snapshotCsvExport.test.ts` pins the export download contract
 *   (filenames, headers, keyset streaming) against fakes plus a seeded-D1
 *   spot check;
 * - `test/snapshotExportRoundTrip.test.ts` (TOG-8887, on main) pins
 *   export → reimport idempotence from hand-written import seeds.
 *
 * What nothing pins is the full loop the operator actually runs: seed D1,
 * run the **combined** shadow sync (`POST /api/v1/data-snapshot/sync`, the
 * chained per-table path production cron uses when `SHADOW_API_PUBLIC_BASE`
 * is set), then download all three exports and compare them against the
 * upstream CSVs that fed the sync. A sync that upserts into the wrong columns
 * and an export that reads back the same wrong columns would each pass their
 * half in isolation; only the round-trip comparison catches the pair.
 *
 * Shape: pre-seed one stale customer row → combined sync → assert the exact
 * combined body (`{upserted, rowCount}` per table, `deleted` stripped) →
 * assert the stale row reconciled away → GET all three exports → mask the
 * per-run `synced_at` trailer → parse both sides with the SAME row parsers
 * the import path uses and assert deep equality.
 *
 * Hermetic like `test/snapshotSyncE2E.test.ts`: only `src/lib/httpAuth` is
 * mocked (login strategies stubbed but publishing through the REAL
 * `storeSession`, so the session-refresh wiring is exercised). The fetch stub
 * serves CSV only for `QueryExecuteDownload`, answers the
 * `QueryRequestIsComplete` poll as complete, forwards the chained per-table
 * subrequests back into the app in-process, and throws on any other upstream
 * URL — no test can reach `killeen.routeware.com`. The per-report download
 * counts below are the network-free proof: every byte arrived via the stub.
 *
 * Deliberately does NOT assert problem+json wording (owned by
 * `test/snapshotAuth.test.ts`) nor the R2 archive leg (owned by
 * `test/snapshotSyncE2E.test.ts`).
 */

const httpLoginCalls = { count: 0 };

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub) => {
    httpLoginCalls.count += 1;
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=shadow-roundtrip-test-session", Date.now() + 60_000);
  })
}));

import { env, exports } from "cloudflare:workers";
import { parseAddressSnapshotRow } from "../src/lib/csvAddressSnapshot";
import { parseContainerSnapshotRow } from "../src/lib/csvContainerSnapshot";
import { parseCustomerSnapshotRow } from "../src/lib/csvCustomerSnapshot";
import { mapCsvHeaders, parseCsvLine } from "../src/lib/csvParse";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";
import { ensureD1TestTables } from "./d1TestMigrations";

const SYNC_SECRET = "test-sync-secret";

// Report query ids from wrangler.toml [env.test.vars].
const CUSTOMER_QID = "23";
const ADDRESS_QID = "24";
const CONTAINER_QID = "25";

// Upstream fixtures: FK-consistent chain customer → address → container.
const CUSTOMER_CSV = [
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled",
  "101,,Acme Corp,John,,Doe,,,,,,,true",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true"
].join("\n");

const ADDRESS_CSV = [
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date",
  "201,101,,201 Main St,Killeen,TX,76541,,,false,true,,,,",
  "202,102,,202 Main St,Killeen,TX,76541,,,false,true,,,,"
].join("\n");

const CONTAINER_CSV = [
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote,UD-Cost_Share-UD,UD-Enclosure_Doors-UD,UD-Last_Compactor_Inspection-UD,UD-Last_Enclosure_Inspection-UD,UD-Material_Stream-UD,Color,ServiceCodeType,ServiceCode_input,ServiceCode,ServiceDate,RouteIDs,FrequencyIDs",
  "301,201,,SN-301,,false,,false,,,true,201 Main St,Killeen,TX,76541,,,,,,,,,,,,,",
  "302,202,,SN-302,,false,,false,,,true,202 Main St,Killeen,TX,76541,,,,,,,,,,,,,"
].join("\n");

const CSV_BY_QID: Record<string, string> = {
  [CUSTOMER_QID]: CUSTOMER_CSV,
  [ADDRESS_QID]: ADDRESS_CSV,
  [CONTAINER_QID]: CONTAINER_CSV
};

type RowParser = (
  cols: Record<string, number>,
  line: string
) => Record<string, unknown> | null;

type TableSpec = {
  name: string;
  exportPath: string;
  filename: string;
  upstreamCsv: string;
  parse: RowParser;
};

const SPECS: TableSpec[] = [
  {
    name: "customer",
    exportPath: "/api/v1/customer-snapshot/export",
    filename: "customer-snapshot.csv",
    upstreamCsv: CUSTOMER_CSV,
    parse: parseCustomerSnapshotRow as RowParser
  },
  {
    name: "address",
    exportPath: "/api/v1/address-snapshot/export",
    filename: "address-snapshot.csv",
    upstreamCsv: ADDRESS_CSV,
    parse: parseAddressSnapshotRow as RowParser
  },
  {
    name: "container",
    exportPath: "/api/v1/container-snapshot/export",
    filename: "container-snapshot.csv",
    upstreamCsv: CONTAINER_CSV,
    parse: parseContainerSnapshotRow as RowParser
  }
];

type CombinedSummary = {
  customer: { upserted: number; rowCount: number } | null;
  address: { upserted: number; rowCount: number } | null;
  container: { upserted: number; rowCount: number } | null;
};

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

/** Logical CSV lines (multiline quoted fields stay one line), via the import scanner. */
async function logicalLines(csv: string): Promise<string[]> {
  const out: string[] = [];
  for await (const line of streamCsvLines(stringToUint8Stream(csv))) {
    out.push(line);
  }
  return out;
}

/**
 * Mask the per-run `synced_at` trailer on each logical line. Precise: the
 * export always renders `synced_at` as the last column, so only a trailing
 * ISO timestamp is masked — a business timestamp mid-row never matches.
 */
function maskSyncedAtLine(line: string): string {
  return line.replace(/,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, ",<STAMP>");
}

/**
 * Strip the trailing `synced_at` stamp entirely, so an export line can be
 * compared byte-for-byte against its upstream source line. Same precision
 * note as `maskSyncedAtLine`: only a trailing ISO timestamp is removed.
 */
function decodeExportBusinessLine(line: string): string {
  const cells = parseCsvLine(line);
  expect(cells.at(-2)).toBe("1");
  expect(cells.at(-1)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  return cells.slice(0, -2).map((value) => {
    // Independent byte-level oracle: undo one export prefix, then serialize
    // RFC 4180 without spreadsheet escaping. Do not reuse production cell().
    const raw = value.startsWith("'") ? value.slice(1) : value;
    return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  }).join(",");
}

/** Parse data lines with the table's import-path row parser (header via mapCsvHeaders). */
function parseBusinessRows(spec: TableSpec, lines: string[]): Array<Record<string, unknown>> {
  const cols = mapCsvHeaders(lines[0]!);
  return lines.slice(1).map((line) => {
    const row = spec.parse(cols, line);
    expect(row, `${spec.name} line must parse: ${line.slice(0, 80)}`).not.toBeNull();
    return row!;
  });
}

describe("shadow sync → export round-trip", () => {
  const originalFetch = globalThis.fetch;
  // First download attempt per report fails with the silent-expiry signal
  // (302 → /Account/Login), so every table exercises the re-auth retry.
  const downloadAttempts = new Map<string, number>();

  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(() => {
    downloadAttempts.clear();
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      // Chained per-table subrequests from POST /api/v1/data-snapshot/sync go
      // back into this same Worker (origin http://test.local). Dispatch them
      // in-process through the real app — same routes, same auth gates, same
      // D1 — rather than the network, where `test.local` cannot resolve.
      if (url.startsWith("http://test.local/api/v1/")) {
        return exports.default.fetch(url, {
          method: init?.method ?? "GET",
          headers: init?.headers as HeadersInit | undefined
        });
      }
      // TOG-6543: every query-id fetch polls QueryRequestIsComplete before
      // its download. The poll answers complete immediately so the sync keeps
      // exercising the download re-auth retry leg (first download 302s, then
      // CSV).
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
        const n = (downloadAttempts.get(qid) ?? 0) + 1;
        downloadAttempts.set(qid, n);
        if (n === 1) {
          return new Response("", {
            status: 302,
            headers: { location: "https://killeen.routeware.com/WebRW/Account/Login?expired=1" }
          });
        }
        return new Response(csv, {
          status: 200,
          headers: { "content-type": "text/csv" }
        });
      }
      // Fail loudly on any other upstream URL instead of hitting the network.
      if (url.includes("killeen.routeware.com")) {
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("seeds D1, runs the combined shadow sync, and exports match the upstream CSVs", async () => {
    // Arrange — a stale customer row the sync's reconcile step must delete;
    // the export comparison below then proves it is gone.
    await db()
      .prepare(
        "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
      )
      .run();
    httpLoginCalls.count = 0;

    // Act — the combined route production cron uses: customer → address →
    // container as chained per-table subrequests in FK order.
    const syncResp = await exports.default.fetch("http://test.local/api/v1/data-snapshot/sync", {
      method: "POST",
      headers: { authorization: `Bearer ${SYNC_SECRET}` }
    });

    // Assert — exact combined body: per-table `{upserted, rowCount}` only, no
    // `deleted` leak (pinned end to end in syncSummaryContract.test.ts, exact
    // here so a shape drift breaks the round-trip first). Each table ran its
    // real download: one login per table after the forced 302, two download
    // attempts per report — every byte via the stub, nothing touched the
    // network.
    expect(syncResp.status).toBe(200);
    const summary = (await syncResp.json()) as CombinedSummary;
    expect(summary).toEqual({
      customer: { upserted: 2, rowCount: 2 },
      address: { upserted: 2, rowCount: 2 },
      container: { upserted: 2, rowCount: 2 }
    });
    expect(httpLoginCalls.count).toBe(3);
    expect(downloadAttempts.get(CUSTOMER_QID)).toBe(2);
    expect(downloadAttempts.get(ADDRESS_QID)).toBe(2);
    expect(downloadAttempts.get(CONTAINER_QID)).toBe(2);

    // Assert — the stale seed reconciled away; each table holds exactly the
    // synced rows.
    for (const table of [
      "customer_snapshot",
      "address_snapshot",
      "container_snapshot"
    ] as const) {
      const n = await db()
        .prepare(`SELECT COUNT(*) as n FROM ${table}`)
        .first<{ n: number }>();
      expect(n?.n, `${table} holds exactly the synced rows`).toBe(2);
    }
    const stale = await db()
      .prepare("SELECT customer_id FROM customer_snapshot WHERE customer_id = 999")
      .first<{ customer_id: number }>();
    expect(stale).toBeNull();

    // Act + Assert — download each export and compare against the upstream
    // CSV that fed the sync: same row count, same business cells through the
    // same parsers the import path uses (a sync writing wrong columns and an
    // export reading them back would pass every half-test; this catches the
    // pair). `synced_at` is Worker metadata restamped on every sync, so the
    // trailing stamp is masked before comparing.
    for (const spec of SPECS) {
      const res = await exports.default.fetch(`http://test.local${spec.exportPath}`, {
        headers: { authorization: `Bearer ${SYNC_SECRET}` }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(
        `attachment; filename="${spec.filename}"`
      );
      const exportLines = await logicalLines(await res.text());
      const upstreamLines = await logicalLines(spec.upstreamCsv);
      // Header plus exactly the synced rows; the export carries the extra
      // trailing `synced_at` column the import parsers ignore by design.
      expect(exportLines.length - 1, `${spec.name} export row count`).toBe(
        upstreamLines.length - 1
      );
      expect(exportLines[0]).toMatch(/,synced_at$/);
      expect(parseBusinessRows(spec, exportLines)).toEqual(
        parseBusinessRows(spec, upstreamLines)
      );
      // Independent byte equality after removing export metadata and undoing
      // spreadsheet escaping.
      expect(exportLines[0]).toBe(`${upstreamLines[0]},_shadow_csv_encoding,synced_at`);
      expect(exportLines.slice(1).map(decodeExportBusinessLine)).toEqual(
        upstreamLines.slice(1)
      );
    }
  });

  it("re-running sync then export is stable: masked exports are identical", async () => {
    // Arrange — table state comes from the previous test's sync in this file.
    // (Each test file gets a fresh D1; order within the file is top-to-bottom.)
    const before: string[] = [];
    for (const spec of SPECS) {
      const res = await exports.default.fetch(`http://test.local${spec.exportPath}`, {
        headers: { authorization: `Bearer ${SYNC_SECRET}` }
      });
      expect(res.status).toBe(200);
      before.push((await logicalLines(await res.text())).map(maskSyncedAtLine).join("\n"));
    }

    // Act — full loop again: sync restamps `synced_at`, export re-renders.
    httpLoginCalls.count = 0;
    const syncResp = await exports.default.fetch("http://test.local/api/v1/data-snapshot/sync", {
      method: "POST",
      headers: { authorization: `Bearer ${SYNC_SECRET}` }
    });
    expect(syncResp.status).toBe(200);
    expect(httpLoginCalls.count).toBe(3);

    // Assert — business content stable across the second loop; only the
    // masked trailer moved.
    for (const [i, spec] of SPECS.entries()) {
      const res = await exports.default.fetch(`http://test.local${spec.exportPath}`, {
        headers: { authorization: `Bearer ${SYNC_SECRET}` }
      });
      expect(res.status).toBe(200);
      const after = (await logicalLines(await res.text())).map(maskSyncedAtLine).join("\n");
      expect(after, `${spec.name} masked export stable across re-sync`).toBe(before[i]);
    }
  });
});
