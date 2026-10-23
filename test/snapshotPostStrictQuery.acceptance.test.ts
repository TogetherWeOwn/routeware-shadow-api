import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isUpstreamUrl } from "./upstreamHost";

vi.mock("../src/lib/httpAuth", () => ({
  establishSessionViaHttp: vi.fn(async (_env: Env, stub: DurableObjectStub, lockToken?: string | null) => {
    const { storeSession } = await import("../src/lib/sessionRefreshLock");
    await storeSession(stub, ".WebRW=strict-query-test-session", Date.now() + 60_000, lockToken);
  })
}));

import { env, exports } from "cloudflare:workers";
import app from "../src/app";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";
import { recordingDb, type RecordingDb } from "./snapshotDbFake";

/**
 * Strict query keys on mutating snapshot POSTs (R20-04 acceptance).
 *
 * Seven POST routes share one exposure: `dryRunQuery` (src/routes/shared.ts)
 * and `dataSnapshotSyncQuery` (src/routes/dataSnapshot.ts) are non-strict zod
 * objects, so `?dryrun=true` strips to `{}` and the mutation runs FOR REAL.
 * Invalid VALUES already 400 via the anchored enum; only unknown KEYS bypass.
 *
 * Contract pinned here:
 * - Any query key outside each route's declared set 400s with the existing
 *   value-free `bad-request` problem type BEFORE any D1/R2/upstream work.
 * - The 400 carries fixed allowed-keys guidance (`dryRun`, plus
 *   `partialProgress` on the combined route) and never echoes submitted keys
 *   or values.
 * - Sync-secret 401 precedence is preserved: outer-invalid (missing/wrong)
 *   bearer 401s before validation, and inner-invalid (API token, not the sync
 *   secret) 401s before the strict unknown-key check. Invalid VALUES keep
 *   their existing validator-first 400 (even over the inner 401); unknown
 *   KEYS are checked after auth. That split is intentional: unknown keys are
 *   stripped today (so inner-invalid 401s), while invalid values already 400.
 * - Valid paths unchanged: omitted flags run real, exact `?dryRun=true`
 *   dry-runs, `?dryRun=false` runs real, `?partialProgress=true` keeps its
 *   #340 envelope. GET lists keep ignoring unknown params byte-identically.
 *
 * Status at authoring (base `4cdc0db1`):
 * - RED (fail today, must pass after R20-04): every "unknown query keys",
 *   "strong zero-effects", "unknown repeated keys" and "empty key name" test.
 *   Today typos run real (imports 200, syncs 500 via the throwing upstream
 *   mock because the handler RAN upstream work).
 * - GREEN (pass today, Builder must keep green): invalid values, repeated
 *   KNOWN keys, empty values, all valid-path preservation, auth precedence,
 *   GET-list ignore, and OpenAPI param pins.
 *
 * Builder: build on this branch, never edit this file. If you change OpenAPI
 * query descriptions, regenerate the openapiContract snapshot
 * (`vitest run test/openapiContract.test.ts -u`); the hand-written param-name
 * assertions below must keep passing (no param added or removed).
 *
 * Focused check:
 * npx vitest run test/snapshotPostStrictQuery.acceptance.test.ts \
 *   test/snapshotListUnknownParams.test.ts test/snapshotDryRun.test.ts \
 *   test/combinedSyncPartialProgress.acceptance.test.ts test/snapshotAuth.test.ts
 */

const SYNC_SECRET = "test-sync-secret";
const API_TOKEN = "test-api-token";
const BASE = "http://test.local";

const BAD_REQUEST = `${PROBLEM_TYPE_BASE}bad-request`;
const INNER_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";

const CUSTOMER_QID = "23";
const ADDRESS_QID = "24";
const CONTAINER_QID = "25";

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";
const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments," +
  "ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";
const CONTAINER_HEADER =
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked," +
  "Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote";

const IMPORT_CUSTOMER_CSV = `${CUSTOMER_HEADER}\n9001,,Strict Co,,,,,,,,,,true`;
const IMPORT_ADDRESS_CSV = `${ADDRESS_HEADER}\n9001,9001,,9001 Main St,Killeen,TX,76541,,,false,true,,,,`;
const IMPORT_CONTAINER_CSV =
  `${CONTAINER_HEADER}\n9001,9001,,SN-9001,,false,,false,,,true,9001 Main St,Killeen,TX,76541,`;

const SYNC_CUSTOMER_CSV = [
  CUSTOMER_HEADER,
  "101,,Acme Corp,John,,Doe,,,,,,,true",
  "102,,Beta LLC,Jane,,Smith,,,,,,,true"
].join("\n");
const SYNC_ADDRESS_CSV = [
  ADDRESS_HEADER,
  "201,101,,201 Main St,Killeen,TX,76541,,,false,true,,,,",
  "202,102,,202 Main St,Killeen,TX,76541,,,false,true,,,,"
].join("\n");
const SYNC_CONTAINER_CSV = [
  `${CONTAINER_HEADER},UD-Cost_Share-UD,UD-Enclosure_Doors-UD,UD-Last_Compactor_Inspection-UD,UD-Last_Enclosure_Inspection-UD,UD-Material_Stream-UD,Color,ServiceCodeType,ServiceCode_input,ServiceCode,ServiceDate,RouteIDs,FrequencyIDs`,
  "301,201,,SN-301,,false,,false,,,true,201 Main St,Killeen,TX,76541,,,,,,,,,,,,,",
  "302,202,,SN-302,,false,,false,,,true,202 Main St,Killeen,TX,76541,,,,,,,,,,,,,"
].join("\n");

const CSV_BY_QID: Record<string, string> = {
  [CUSTOMER_QID]: SYNC_CUSTOMER_CSV,
  [ADDRESS_QID]: SYNC_ADDRESS_CSV,
  [CONTAINER_QID]: SYNC_CONTAINER_CSV
};

const PII_KEY_PROBE = "pii_probe_key_999";
const PII_VALUE_PROBE = "PII-PROBE-UNKNOWN-QUERY-999-ACME-555-0100";

type RouteKind = "sync" | "import" | "combined";
type RouteSpec = {
  name: string;
  base: string;
  kind: RouteKind;
  /** CSV body for import routes; sync/combined post no body. */
  csv?: string;
};

const SYNC_ROUTES: RouteSpec[] = [
  { name: "customer sync", base: "/api/v1/customer-snapshot/sync", kind: "sync" },
  { name: "address sync", base: "/api/v1/address-snapshot/sync", kind: "sync" },
  { name: "container sync", base: "/api/v1/container-snapshot/sync", kind: "sync" }
];
const IMPORT_ROUTES: RouteSpec[] = [
  { name: "customer import", base: "/api/v1/customer-snapshot/import", kind: "import", csv: IMPORT_CUSTOMER_CSV },
  { name: "address import", base: "/api/v1/address-snapshot/import", kind: "import", csv: IMPORT_ADDRESS_CSV },
  { name: "container import", base: "/api/v1/container-snapshot/import", kind: "import", csv: IMPORT_CONTAINER_CSV }
];
const COMBINED: RouteSpec = { name: "combined sync", base: "/api/v1/data-snapshot/sync", kind: "combined" };
const ALL_SEVEN: RouteSpec[] = [...SYNC_ROUTES, ...IMPORT_ROUTES, COMBINED];
const DRYRUN_ONLY_SIX: RouteSpec[] = [...SYNC_ROUTES, ...IMPORT_ROUTES];

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

async function rowCount(table: string): Promise<number> {
  const row = await db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? -1;
}

async function r2Keys(): Promise<string[]> {
  const bucket = (env as unknown as { SNAPSHOTS: R2Bucket }).SNAPSHOTS;
  const listed = await bucket.list({ prefix: "snapshots/" });
  return listed.objects.map((o) => o.key).sort();
}

async function cleanTables(): Promise<void> {
  await db().prepare("DELETE FROM container_snapshot").run();
  await db().prepare("DELETE FROM address_snapshot").run();
  await db().prepare("DELETE FROM customer_snapshot").run();
}

type Posted = { status: number; raw: string; contentType: string };

async function postRecording(
  spec: RouteSpec,
  query: string,
  token: string | null = SYNC_SECRET
): Promise<Posted & { recording: RecordingDb }> {
  const recording = recordingDb();
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (spec.csv !== undefined) headers["content-type"] = "text/csv";
  const response = await app.request(
    `${BASE}${spec.base}${query}`,
    { method: "POST", headers, body: spec.csv },
    { ...env, CUSTOMER_DB: recording.db }
  );
  return {
    status: response.status,
    raw: await response.text(),
    contentType: response.headers.get("content-type") ?? "",
    recording
  };
}

async function postReal(
  path: string,
  opts: { token?: string | null; body?: string; contentType?: string } = {}
): Promise<Posted> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? SYNC_SECRET}`;
  if (opts.body !== undefined) headers["content-type"] = opts.contentType ?? "text/csv";
  const response = await exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: opts.body
  });
  return {
    status: response.status,
    raw: await response.text(),
    contentType: response.headers.get("content-type") ?? ""
  };
}

function expectNoD1(recording: RecordingDb): void {
  expect(recording.selects).toEqual([]);
  expect(recording.runs).toEqual([]);
  expect(recording.batches).toEqual([]);
}

/**
 * The R20-04 strict 400: existing value-free problem type, fixed allowed-keys
 * guidance, PROBLEMS.md anchor, and no echo of submitted keys or values.
 * Wording beyond that is the Builder's; only the contract is pinned.
 */
function expectStrict400(
  posted: Posted,
  opts: { allowed: string[]; forbidden: string[] }
): Record<string, unknown> {
  expect(posted.status).toBe(400);
  expect(posted.contentType).toContain("application/problem+json");
  const body = JSON.parse(posted.raw) as Record<string, unknown>;
  expect(body.type).toBe(BAD_REQUEST);
  expect(body.title).toBe("Bad Request");
  expect(body.status).toBe(400);
  const detail = String(body.detail ?? "");
  expect(detail).toContain("docs/PROBLEMS.md#bad-request");
  for (const key of opts.allowed) expect(detail).toContain(key);
  for (const leak of opts.forbidden) expect(posted.raw).not.toContain(leak);
  return body;
}

function allowedFor(spec: RouteSpec): string[] {
  return spec.kind === "combined" ? ["dryRun", "partialProgress"] : ["dryRun"];
}

/** Serving upstream mock (report poll + CSV download) with in-process chained dispatch. */
function installUpstreamMocks(calls: string[]): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.startsWith(`${BASE}/api/v1/`)) {
      return exports.default.fetch(url, {
        method: init?.method ?? "GET",
        headers: init?.headers as HeadersInit | undefined
      });
    }
    if (url.includes("/Reports/QueryRequestIsComplete")) {
      return new Response("true", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/Reports/QueryExecuteDownload")) {
      const qid = new URL(url).searchParams.get("queryID") ?? "";
      const csv = CSV_BY_QID[qid];
      if (!csv) throw new Error(`Unexpected report queryID in test: ${qid}`);
      return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
    }
    if (isUpstreamUrl(url)) throw new Error(`Unexpected upstream fetch in test: ${url}`);
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function installThrowingFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected outbound fetch in strict-query acceptance suite");
    })
  );
}

describe("snapshot POST strict query (R20-04 acceptance)", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  beforeEach(async () => {
    await cleanTables();
  });

  describe("RED: unknown query keys 400 before any D1/upstream work", () => {
    beforeEach(() => {
      installThrowingFetch();
    });
    afterEach(() => {
      // Assert BEFORE unstubbing: the strict 400 must precede any upstream
      // work. Today sync/combined typos reach fetch (and throw to a 500),
      // so this fails alongside the 400 assertion until R20-04 lands.
      expect(vi.mocked(globalThis.fetch).mock.calls).toEqual([]);
      vi.unstubAllGlobals();
    });

    describe.each(DRYRUN_ONLY_SIX)("$name ($base)", (spec) => {
      it("?dryrun=true (lowercase typo) 400s with dryRun guidance and zero work", async () => {
        const posted = await postRecording(spec, "?dryrun=true");
        expectStrict400(posted, { allowed: allowedFor(spec), forbidden: ["dryrun"] });
        expectNoD1(posted.recording);
      });

      it("?bogus_param=1 400s without echoing the submitted key", async () => {
        const posted = await postRecording(spec, "?bogus_param=1");
        expectStrict400(posted, { allowed: allowedFor(spec), forbidden: ["bogus_param"] });
        expectNoD1(posted.recording);
      });

      it("?dryRun=true&bogus_param=1 (unknown alongside valid) 400s", async () => {
        const posted = await postRecording(spec, "?dryRun=true&bogus_param=1");
        expectStrict400(posted, {
          allowed: allowedFor(spec),
          forbidden: ["bogus_param"]
        });
        expectNoD1(posted.recording);
      });

      it("?DryRun=true (case typo) 400s: keys are case-sensitive", async () => {
        const posted = await postRecording(spec, "?DryRun=true");
        expectStrict400(posted, { allowed: allowedFor(spec), forbidden: ["DryRun"] });
        expectNoD1(posted.recording);
      });
    });

    describe("combined sync extras", () => {
      it("?dryrun=true 400s naming both allowed keys", async () => {
        const posted = await postRecording(COMBINED, "?dryrun=true");
        expectStrict400(posted, { allowed: ["dryRun", "partialProgress"], forbidden: ["dryrun"] });
        expectNoD1(posted.recording);
      });

      it("?bogus_param=1 400s without echo", async () => {
        const posted = await postRecording(COMBINED, "?bogus_param=1");
        expectStrict400(posted, { allowed: ["dryRun", "partialProgress"], forbidden: ["bogus_param"] });
        expectNoD1(posted.recording);
      });

      it("?dryRun=true&bogus_param=1 400s", async () => {
        const posted = await postRecording(COMBINED, "?dryRun=true&bogus_param=1");
        expectStrict400(posted, { allowed: ["dryRun", "partialProgress"], forbidden: ["bogus_param"] });
        expectNoD1(posted.recording);
      });

      it("?partialprogress=true (lowercase typo) 400s", async () => {
        const posted = await postRecording(COMBINED, "?partialprogress=true");
        expectStrict400(posted, { allowed: ["dryRun", "partialProgress"], forbidden: ["partialprogress"] });
        expectNoD1(posted.recording);
      });

      it("?partialProgress=true&bogus_param=1 400s", async () => {
        const posted = await postRecording(COMBINED, "?partialProgress=true&bogus_param=1");
        expectStrict400(posted, { allowed: ["dryRun", "partialProgress"], forbidden: ["bogus_param"] });
        expectNoD1(posted.recording);
      });

      it("?dryRun=true&partialProgress=true&bogus_param=1 400s", async () => {
        const posted = await postRecording(COMBINED, "?dryRun=true&partialProgress=true&bogus_param=1");
        expectStrict400(posted, { allowed: ["dryRun", "partialProgress"], forbidden: ["bogus_param"] });
        expectNoD1(posted.recording);
      });
    });

    describe("no-echo probes", () => {
      it("unknown key bytes never travel in the 400", async () => {
        const posted = await postRecording(SYNC_ROUTES[0]!, `?${PII_KEY_PROBE}=1`);
        expectStrict400(posted, { allowed: ["dryRun"], forbidden: [PII_KEY_PROBE] });
        expectNoD1(posted.recording);
      });

      it("unknown value bytes never travel in the 400", async () => {
        const posted = await postRecording(
          IMPORT_ROUTES[0]!,
          `?bogus_param=${encodeURIComponent(PII_VALUE_PROBE)}`
        );
        expectStrict400(posted, { allowed: ["dryRun"], forbidden: [PII_VALUE_PROBE, "bogus_param"] });
        expectNoD1(posted.recording);
      });

      it("combined unknown key+value bytes never travel", async () => {
        const posted = await postRecording(
          COMBINED,
          `?dryRun=true&${PII_KEY_PROBE}=${encodeURIComponent(PII_VALUE_PROBE)}`
        );
        expectStrict400(posted, {
          allowed: ["dryRun", "partialProgress"],
          forbidden: [PII_KEY_PROBE, PII_VALUE_PROBE]
        });
        expectNoD1(posted.recording);
      });
    });
  });

  describe("RED: strong zero-effects on real D1/R2", () => {
    it("customer sync typo runs nothing: 400, stale row kept, no new rows, R2 unchanged", async () => {
      await db()
        .prepare(
          "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
        )
        .run();
      const r2Before = await r2Keys();
      const calls: string[] = [];
      const restore = installUpstreamMocks(calls);
      try {
        const posted = await postReal("/api/v1/customer-snapshot/sync?dryrun=true");
        expectStrict400(posted, { allowed: ["dryRun"], forbidden: ["dryrun"] });
        expect(calls).toEqual([]);
        expect(await rowCount("customer_snapshot")).toBe(1);
        const stale = await db()
          .prepare("SELECT customer_id FROM customer_snapshot WHERE customer_id = 999")
          .first<{ customer_id: number }>();
        expect(stale?.customer_id).toBe(999);
        expect(await r2Keys()).toEqual(r2Before);
      } finally {
        restore();
      }
    });

    it("customer import typo runs nothing: 400, seeded row kept, no new rows", async () => {
      installThrowingFetch();
      try {
        await db()
          .prepare(
            "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (9000, 'Seed Co', 1, '2026-09-27T00:00:00.000Z')"
          )
          .run();
        const posted = await postReal("/api/v1/customer-snapshot/import?dryrun=true", {
          body: IMPORT_CUSTOMER_CSV
        });
        expectStrict400(posted, { allowed: ["dryRun"], forbidden: ["dryrun"] });
        expect(await rowCount("customer_snapshot")).toBe(1);
        const seed = await db()
          .prepare("SELECT customer_id FROM customer_snapshot WHERE customer_id = 9000")
          .first<{ customer_id: number }>();
        expect(seed?.customer_id).toBe(9000);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("combined typo runs nothing: 400, all tables untouched, R2 unchanged", async () => {
      await db()
        .prepare(
          "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
        )
        .run();
      const r2Before = await r2Keys();
      const calls: string[] = [];
      const restore = installUpstreamMocks(calls);
      try {
        const posted = await postReal("/api/v1/data-snapshot/sync?dryrun=true");
        expectStrict400(posted, { allowed: ["dryRun", "partialProgress"], forbidden: ["dryrun"] });
        expect(calls).toEqual([]);
        expect(await rowCount("customer_snapshot")).toBe(1);
        expect(await rowCount("address_snapshot")).toBe(0);
        expect(await rowCount("container_snapshot")).toBe(0);
        expect(await r2Keys()).toEqual(r2Before);
      } finally {
        restore();
      }
    });
  });

  describe("GREEN: invalid values still 400 before any work", () => {
    beforeEach(() => {
      installThrowingFetch();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each(ALL_SEVEN.map((s) => [s.name, s.base] as const))(
      "%s ?dryRun=maybe 400s naming dryRun with zero work",
      async (_name, base) => {
        const spec = ALL_SEVEN.find((s) => s.base === base)!;
        const posted = await postRecording(spec, "?dryRun=maybe");
        expect(posted.status).toBe(400);
        expect(posted.contentType).toContain("application/problem+json");
        const body = JSON.parse(posted.raw) as Record<string, unknown>;
        expect(body).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
        expect(String(body.detail)).toContain("dryRun");
        expect(String(body.detail)).toContain("docs/PROBLEMS.md#bad-request");
        expect(posted.raw).not.toContain("maybe");
        expectNoD1(posted.recording);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      }
    );

    it.each(["TRUE", "1", "yes", "true "])(
      "customer sync ?dryRun=%j 400s (only exact true/false pass)",
      async (value) => {
        const posted = await postRecording(SYNC_ROUTES[0]!, `?dryRun=${encodeURIComponent(value)}`);
        expect(posted.status).toBe(400);
        expectNoD1(posted.recording);
      }
    );

    it.each(["yes", "TRUE", "1", ""])(
      "combined ?partialProgress=%j 400s naming partialProgress",
      async (value) => {
        const posted = await postRecording(COMBINED, `?partialProgress=${encodeURIComponent(value)}`);
        expect(posted.status).toBe(400);
        const body = JSON.parse(posted.raw) as Record<string, unknown>;
        expect(body.type).toBe(BAD_REQUEST);
        expect(String(body.detail)).toContain("partialProgress");
        if (value) expect(posted.raw).not.toContain(value);
        expectNoD1(posted.recording);
      }
    );
  });

  describe("repeated keys", () => {
    beforeEach(() => {
      installThrowingFetch();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each(ALL_SEVEN.map((s) => [s.name, s.base] as const))(
      "GREEN: %s ?dryRun=true&dryRun=true 400s via the string schema",
      async (_name, base) => {
        const spec = ALL_SEVEN.find((s) => s.base === base)!;
        const posted = await postRecording(spec, "?dryRun=true&dryRun=true");
        expect(posted.status).toBe(400);
        expect(posted.contentType).toContain("application/problem+json");
        expectNoD1(posted.recording);
      }
    );

    it("GREEN: ?dryRun=true&dryRun=false 400s (no first-wins)", async () => {
      const posted = await postRecording(IMPORT_ROUTES[0]!, "?dryRun=true&dryRun=false");
      expect(posted.status).toBe(400);
      expectNoD1(posted.recording);
    });

    it("GREEN: combined ?partialProgress=true&partialProgress=true 400s", async () => {
      const posted = await postRecording(COMBINED, "?partialProgress=true&partialProgress=true");
      expect(posted.status).toBe(400);
      expectNoD1(posted.recording);
    });

    it.each([
      ["customer sync", SYNC_ROUTES[0]!],
      ["customer import", IMPORT_ROUTES[0]!],
      ["combined sync", COMBINED]
    ] as const)("RED: %s ?bogus_param=1&bogus_param=2 400s as unknown", async (_name, spec) => {
      const posted = await postRecording(spec, "?bogus_param=1&bogus_param=2");
      expectStrict400(posted, { allowed: allowedFor(spec), forbidden: ["bogus_param"] });
      expectNoD1(posted.recording);
    });
  });

  describe("empty keys and values", () => {
    beforeEach(() => {
      installThrowingFetch();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each(ALL_SEVEN.map((s) => [s.name, s.base] as const))(
      "RED: %s ?=1 (empty key name) 400s",
      async (_name, base) => {
        const spec = ALL_SEVEN.find((s) => s.base === base)!;
        const posted = await postRecording(spec, "?=1");
        expectStrict400(posted, { allowed: allowedFor(spec), forbidden: [] });
        expectNoD1(posted.recording);
      }
    );

    it.each([
      ["customer sync", SYNC_ROUTES[0]!],
      ["customer import", IMPORT_ROUTES[0]!],
      ["combined sync", COMBINED]
    ] as const)("RED: %s ?dryRun=true&=1 (valid plus empty) 400s", async (_name, spec) => {
      const posted = await postRecording(spec, "?dryRun=true&=1");
      expectStrict400(posted, { allowed: allowedFor(spec), forbidden: [] });
      expectNoD1(posted.recording);
    });

    it.each([
      ["customer sync", SYNC_ROUTES[0]!],
      ["customer import", IMPORT_ROUTES[0]!],
      ["combined sync", COMBINED]
    ] as const)("GREEN: %s ?dryRun= (empty value) 400s as an invalid value", async (_name, spec) => {
      const posted = await postRecording(spec, "?dryRun=");
      expect(posted.status).toBe(400);
      expect(posted.contentType).toContain("application/problem+json");
      expectNoD1(posted.recording);
    });

    it("GREEN: bare ?dryRun (no equals) 400s as an empty value", async () => {
      const posted = await postRecording(SYNC_ROUTES[0]!, "?dryRun");
      expect(posted.status).toBe(400);
      expectNoD1(posted.recording);
    });
  });

  describe("GREEN: valid dry-run preservation (200, would-be counts, no effects)", () => {
    it("customer import ?dryRun=true validates and counts without writing", async () => {
      installThrowingFetch();
      try {
        const posted = await postReal("/api/v1/customer-snapshot/import?dryRun=true", {
          body: IMPORT_CUSTOMER_CSV
        });
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
        expect(await rowCount("customer_snapshot")).toBe(0);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("address import ?dryRun=true succeeds on dangling FKs without writing", async () => {
      installThrowingFetch();
      try {
        const posted = await postReal("/api/v1/address-snapshot/import?dryRun=true", {
          body: IMPORT_ADDRESS_CSV
        });
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
        expect(await rowCount("address_snapshot")).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("container import ?dryRun=true succeeds on dangling FKs without writing", async () => {
      installThrowingFetch();
      try {
        const posted = await postReal("/api/v1/container-snapshot/import?dryRun=true", {
          body: IMPORT_CONTAINER_CSV
        });
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
        expect(await rowCount("container_snapshot")).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("customer sync ?dryRun=true carries would-be counts while D1 and R2 stay unchanged", async () => {
      await db()
        .prepare(
          "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (999, 'Stale Co', 1, '2000-01-01T00:00:00.000Z')"
        )
        .run();
      const r2Before = await r2Keys();
      const calls: string[] = [];
      const restore = installUpstreamMocks(calls);
      try {
        const posted = await postReal("/api/v1/customer-snapshot/sync?dryRun=true");
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({ upserted: 2, rowCount: 2, deleted: 1 });
        expect(await rowCount("customer_snapshot")).toBe(1);
        expect(await r2Keys()).toEqual(r2Before);
      } finally {
        restore();
      }
    });

    it("address sync ?dryRun=true validates without writing D1 or R2", async () => {
      const r2Before = await r2Keys();
      const calls: string[] = [];
      const restore = installUpstreamMocks(calls);
      try {
        const posted = await postReal("/api/v1/address-snapshot/sync?dryRun=true");
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
        expect(await rowCount("address_snapshot")).toBe(0);
        expect(await r2Keys()).toEqual(r2Before);
      } finally {
        restore();
      }
    });

    it("container sync ?dryRun=true validates without writing D1 or R2", async () => {
      const r2Before = await r2Keys();
      const calls: string[] = [];
      const restore = installUpstreamMocks(calls);
      try {
        const posted = await postReal("/api/v1/container-snapshot/sync?dryRun=true");
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({ upserted: 2, rowCount: 2, deleted: 0 });
        expect(await rowCount("container_snapshot")).toBe(0);
        expect(await r2Keys()).toEqual(r2Before);
      } finally {
        restore();
      }
    });

    it("combined ?dryRun=true forwards the flag to every chained subrequest", async () => {
      const attempted: string[] = [];
      const subrequests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          const table = ["customer", "address", "container"].find(
            (t) => url.pathname === `/api/v1/${t}-snapshot/sync`
          );
          if (url.origin !== BASE || !table || request.method !== "POST") {
            throw new Error(`Unexpected network request: ${request.url}`);
          }
          attempted.push(table);
          subrequests.push(url.href);
          return Response.json({ upserted: 3, rowCount: 4 });
        })
      );
      try {
        const posted = await postReal("/api/v1/data-snapshot/sync?dryRun=true");
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({
          customer: { upserted: 3, rowCount: 4 },
          address: { upserted: 3, rowCount: 4 },
          container: { upserted: 3, rowCount: 4 }
        });
        expect(attempted).toEqual(["customer", "address", "container"]);
        for (const href of subrequests) {
          expect(new URL(href).searchParams.get("dryRun")).toBe("true");
        }
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("GREEN: omitted flags run real with effects", () => {
    it("customer import with no query writes for real", async () => {
      installThrowingFetch();
      try {
        const posted = await postReal("/api/v1/customer-snapshot/import", { body: IMPORT_CUSTOMER_CSV });
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
        expect(await rowCount("customer_snapshot")).toBe(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("address import with no query writes for real once its customer exists", async () => {
      installThrowingFetch();
      try {
        await db().prepare(
          "INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (9001, 1, '2026-09-27T00:00:00.000Z')"
        ).run();
        const posted = await postReal("/api/v1/address-snapshot/import", { body: IMPORT_ADDRESS_CSV });
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
        expect(await rowCount("address_snapshot")).toBe(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("container import with no query writes for real once its address exists", async () => {
      installThrowingFetch();
      try {
        await db().prepare(
          "INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (9001, 1, '2026-09-27T00:00:00.000Z')"
        ).run();
        await db().prepare(
          "INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (9001, 9001, 1, '2026-09-27T00:00:00.000Z')"
        ).run();
        const posted = await postReal("/api/v1/container-snapshot/import", { body: IMPORT_CONTAINER_CSV });
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toEqual({ upserted: 1, rowCount: 1, deleted: 0 });
        expect(await rowCount("container_snapshot")).toBe(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("customer sync with no query writes for real and stamps the R2 leg", async () => {
      const calls: string[] = [];
      const restore = installUpstreamMocks(calls);
      try {
        const posted = await postReal("/api/v1/customer-snapshot/sync");
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toMatchObject({
          upserted: 2,
          rowCount: 2,
          deleted: 0,
          r2: { status: "stored" }
        });
        expect(await rowCount("customer_snapshot")).toBe(2);
      } finally {
        restore();
      }
    });

    it("address sync with no query writes for real once its customers exist", async () => {
      await db().prepare(
        "INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (101, 1, '2026-09-27T00:00:00.000Z')"
      ).run();
      await db().prepare(
        "INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (102, 1, '2026-09-27T00:00:00.000Z')"
      ).run();
      const calls: string[] = [];
      const restore = installUpstreamMocks(calls);
      try {
        const posted = await postReal("/api/v1/address-snapshot/sync");
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toMatchObject({ upserted: 2, rowCount: 2 });
        expect(await rowCount("address_snapshot")).toBe(2);
      } finally {
        restore();
      }
    });

    it("container sync with no query writes for real once its addresses exist", async () => {
      await db().prepare(
        "INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (101, 1, '2026-09-27T00:00:00.000Z')"
      ).run();
      await db().prepare(
        "INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (102, 1, '2026-09-27T00:00:00.000Z')"
      ).run();
      await db().prepare(
        "INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (201, 101, 1, '2026-09-27T00:00:00.000Z')"
      ).run();
      await db().prepare(
        "INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (202, 102, 1, '2026-09-27T00:00:00.000Z')"
      ).run();
      const calls: string[] = [];
      const restore = installUpstreamMocks(calls);
      try {
        const posted = await postReal("/api/v1/container-snapshot/sync");
        expect(posted.status).toBe(200);
        expect(JSON.parse(posted.raw)).toMatchObject({ upserted: 2, rowCount: 2 });
        expect(await rowCount("container_snapshot")).toBe(2);
      } finally {
        restore();
      }
    });

    it("combined with no query runs every table without the dry-run flag", async () => {
      const attempted: string[] = [];
      const subrequests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          const table = ["customer", "address", "container"].find(
            (t) => url.pathname === `/api/v1/${t}-snapshot/sync`
          );
          if (url.origin !== BASE || !table || request.method !== "POST") {
            throw new Error(`Unexpected network request: ${request.url}`);
          }
          attempted.push(table);
          subrequests.push(url.href);
          return Response.json({ upserted: 3, rowCount: 4 });
        })
      );
      try {
        const posted = await postReal("/api/v1/data-snapshot/sync");
        expect(posted.status).toBe(200);
        expect(attempted).toEqual(["customer", "address", "container"]);
        for (const href of subrequests) {
          expect(new URL(href).search).not.toContain("dryRun");
        }
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("GREEN: explicit ?dryRun=false runs real", () => {
    it.each(IMPORT_ROUTES.map((s) => [s.name, s.base, s.csv!] as const))(
      "%s ?dryRun=false writes for real",
      async (_name, base, csv) => {
        installThrowingFetch();
        try {
          await db().prepare(
            "INSERT OR REPLACE INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (9001, 1, '2026-09-27T00:00:00.000Z')"
          ).run();
          await db().prepare(
            "INSERT OR REPLACE INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (9001, 9001, 1, '2026-09-27T00:00:00.000Z')"
          ).run();
          const table =
            base === "/api/v1/customer-snapshot/import"
              ? "customer_snapshot"
              : base === "/api/v1/address-snapshot/import"
                ? "address_snapshot"
                : "container_snapshot";
          // The customer/address seeds above are FK parents, not the assertion
          // target: clear the target table so the write is observable.
          if (table === "customer_snapshot") {
            await db().prepare("DELETE FROM address_snapshot").run();
            await db().prepare("DELETE FROM customer_snapshot").run();
          } else if (table === "address_snapshot") {
            await db().prepare("DELETE FROM address_snapshot").run();
          } else {
            await db().prepare("DELETE FROM container_snapshot").run();
          }
          const posted = await postReal(`${base}?dryRun=false`, { body: csv });
          expect(posted.status).toBe(200);
          expect(JSON.parse(posted.raw)).toMatchObject({ upserted: 1, rowCount: 1 });
          expect(await rowCount(table)).toBe(1);
        } finally {
          vi.unstubAllGlobals();
        }
      }
    );
  });

  describe("GREEN: ?partialProgress=true envelope preserved", () => {
    it("keeps the sanitized failure envelope on a step failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          const table = ["customer", "address", "container"].find(
            (t) => url.pathname === `/api/v1/${t}-snapshot/sync`
          );
          if (url.origin !== BASE || !table || request.method !== "POST") {
            throw new Error(`Unexpected network request: ${request.url}`);
          }
          if (table === "address") return new Response("<html>refusal</html>", { status: 500 });
          return Response.json({ upserted: 3, rowCount: 4 });
        })
      );
      try {
        const posted = await postReal("/api/v1/data-snapshot/sync?partialProgress=true");
        expect(posted.status).toBe(500);
        expect(posted.contentType).toContain("application/json");
        expect(posted.contentType).not.toContain("problem+json");
        expect(JSON.parse(posted.raw)).toEqual({
          customer: { upserted: 3, rowCount: 4 },
          address: null,
          container: null,
          failure: { table: "address", code: "ChainedHttpError", status: 500 }
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("success with the opt-in stays byte-identical to default success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          const table = ["customer", "address", "container"].find(
            (t) => url.pathname === `/api/v1/${t}-snapshot/sync`
          );
          if (url.origin !== BASE || !table || request.method !== "POST") {
            throw new Error(`Unexpected network request: ${request.url}`);
          }
          return Response.json({ upserted: 3, rowCount: 4 });
        })
      );
      try {
        const opted = await postReal("/api/v1/data-snapshot/sync?partialProgress=true");
        const implicit = await postReal("/api/v1/data-snapshot/sync");
        expect(opted.status).toBe(200);
        expect(opted.raw).toBe(implicit.raw);
        expect(JSON.parse(opted.raw)).not.toHaveProperty("failure");
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("GREEN: auth precedence", () => {
    beforeEach(() => {
      installThrowingFetch();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each([
      ["customer sync", SYNC_ROUTES[0]!],
      ["customer import", IMPORT_ROUTES[0]!],
      ["combined sync", COMBINED]
    ] as const)("%s: missing bearer + bad query still 401s at the outer gate", async (_name, spec) => {
      const posted = await postRecording(spec, "?bogus_param=1", null);
      expect(posted.status).toBe(401);
      const body = JSON.parse(posted.raw) as Record<string, unknown>;
      expect(String(body.detail)).toContain("SHADOW_API_TOKEN");
      expectNoD1(posted.recording);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ["customer sync", SYNC_ROUTES[0]!],
      ["customer import", IMPORT_ROUTES[0]!],
      ["combined sync", COMBINED]
    ] as const)("%s: wrong bearer + bad query still 401s", async (_name, spec) => {
      const posted = await postRecording(spec, "?bogus_param=1", "wrong-secret");
      expect(posted.status).toBe(401);
      expectNoD1(posted.recording);
    });

    it.each([
      ["customer sync", SYNC_ROUTES[0]!],
      ["customer import", IMPORT_ROUTES[0]!],
      ["combined sync", COMBINED]
    ] as const)(
      "%s: API token (inner-invalid) + unknown key keeps the sync-secret 401",
      async (_name, spec) => {
        const posted = await postRecording(spec, "?bogus_param=1", API_TOKEN);
        expect(posted.status).toBe(401);
        expect(posted.contentType).toContain("application/problem+json");
        const body = JSON.parse(posted.raw) as Record<string, unknown>;
        expect(body.type).toBe(`${PROBLEM_TYPE_BASE}unauthorized`);
        expect(body.detail).toBe(INNER_DETAIL);
        expectNoD1(posted.recording);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      }
    );

    it("customer sync: API token + invalid VALUE keeps the validator-first 400", async () => {
      // Documents the existing split: invalid values 400 in the validator
      // before the handler's inner auth check runs. Unknown keys, in
      // contrast, are checked after auth (previous test). Neither changes.
      const posted = await postRecording(SYNC_ROUTES[0]!, "?dryRun=maybe", API_TOKEN);
      expect(posted.status).toBe(400);
      expectNoD1(posted.recording);
    });

    it("combined: missing bearer + invalid flag still 401s (outer gate first)", async () => {
      const posted = await postRecording(COMBINED, "?partialProgress=yes", null);
      expect(posted.status).toBe(401);
      expectNoD1(posted.recording);
    });
  });

  describe("GREEN: GET-list ignore behavior stays byte-identical", () => {
    const SYNTHETIC_ROW = {
      customer_id: 7,
      pickup_address_id: 11,
      container_id: 13,
      company_name: "Synthetic fixture",
      enabled: 1,
      synced_at: "2026-09-02T00:00:00.000Z"
    };
    const LIST_QUERIES: Record<string, string> = {
      "/api/v1/customer-snapshot": "customerId=7&q=Synthetic&enabled=true&limit=1&offset=2",
      "/api/v1/address-snapshot":
        "customerId=7&pickupAddressId=11&q=Synthetic&enabled=true&limit=1&offset=2",
      "/api/v1/container-snapshot":
        "customerId=7&pickupAddressId=11&containerId=13&q=Synthetic&enabled=true&limit=1&offset=2",
      "/api/v1/customer-snapshot/changes": "since=2026-09-01T00%3A00%3A00.000Z&since_id=3&limit=1"
    };

    async function getList(path: string, query: string) {
      const recording = recordingDb({ allResults: [SYNTHETIC_ROW], firstCounts: [1] });
      const response = await app.request(
        `${BASE}${path}${query ? `?${query}` : ""}`,
        { headers: { authorization: `Bearer ${SYNC_SECRET}` } },
        { ...env, CUSTOMER_DB: recording.db }
      );
      return { response, raw: await response.text(), recording };
    }

    beforeEach(() => {
      installThrowingFetch();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each(Object.keys(LIST_QUERIES))("%s ignores bogus_param byte-identically", async (path) => {
      const query = LIST_QUERIES[path]!;
      const baseline = await getList(path, query);
      const unknown = await getList(path, `${query}&bogus_param=1`);
      expect(baseline.response.status).toBe(200);
      expect(unknown.response.status).toBe(200);
      expect(unknown.raw).toBe(baseline.raw);
      expect(unknown.recording.selects).toEqual(baseline.recording.selects);
      expect(unknown.recording.runs).toEqual([]);
      expect(unknown.recording.batches).toEqual([]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each(Object.keys(LIST_QUERIES))(
      "%s still rejects an invalid known key before D1",
      async (path) => {
        const { response, recording } = await getList(path, "limit=501&bogus_param=1");
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        expectNoD1(recording);
      }
    );
  });

  describe("GREEN: OpenAPI query params pinned for all seven POSTs", () => {
    it("documents exactly the declared keys: dryRun everywhere, partialProgress only on combined", async () => {
      const res = await exports.default.fetch(`${BASE}/openapi.json`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        paths: Record<string, Record<string, { parameters?: Array<{ in?: string; name?: string; required?: boolean; schema?: Record<string, unknown> }> }>>;
      };
      const queryParams = (path: string): string[] =>
        (doc.paths[path]?.post?.parameters ?? [])
          .filter((p) => p.in === "query")
          .map((p) => p.name ?? "")
          .sort();
      for (const spec of DRYRUN_ONLY_SIX) {
        expect(queryParams(spec.base)).toEqual(["dryRun"]);
      }
      expect(queryParams(COMBINED.base)).toEqual(["dryRun", "partialProgress"]);

      // The dryRun enum stays the anchored true/false pair, optional everywhere.
      for (const spec of ALL_SEVEN) {
        const params = (doc.paths[spec.base]?.post?.parameters ?? []).filter(
          (p) => p.in === "query"
        );
        const dryRun = params.find((p) => p.name === "dryRun");
        expect(dryRun?.required ?? false).toBe(false);
        expect(dryRun?.schema).toMatchObject({ type: "string", enum: ["true", "false"] });
      }
      const partial = (doc.paths[COMBINED.base]?.post?.parameters ?? []).find(
        (p) => p.in === "query" && p.name === "partialProgress"
      );
      expect(partial?.required ?? false).toBe(false);
      expect(partial?.schema).toMatchObject({ type: "string", enum: ["true", "false"] });
    });
  });
});
