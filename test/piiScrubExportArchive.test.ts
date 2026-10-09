import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PII-scrub coverage for the CSV-export + R2-archive surface (TOG-8369, gap G13).
 *
 * Boundary with the two landed scrub pins — nothing here re-tests them:
 *
 * - `test/piiScrub.test.ts` (TOG-5821) pins the scrub where untrusted upstream
 *   text used to enter a thrown `Error` (detail-full + query-id report doors,
 *   anti-forgery modal prep, fixture hygiene).
 * - `test/piiScrubCronProblem.test.ts` (TOG-7378, PR #122) pins the cron log
 *   line, the chained-runner 1200-char slice, and every problem+json
 *   `detail`/`instance` constructor.
 *
 * This file pins what neither covers — the emission side-channels around the
 * CSV download (`GET ...-snapshot/export`, `src/lib/snapshot/export.ts`) and
 * the R2 archive leg (`src/lib/r2SnapshotArchive.ts`), plus the one report
 * door neither file reaches (the static-path fetcher):
 *
 * | # | Site | Emits | Contract pinned below |
 * |---|---|---|---|
 * | 1 | `fetchReportCsvForPath` throw | `status` + upstream `statusText` | **LEAK-1: `statusText` is upstream-controlled and PII-capable — the message must be status-only like the query-id door. Failing pin (`it.fails`) until the bug card lands.** |
 * | 2 | `R2 snapshot stored` info event | object key only | key shape + no PII |
 * | 3 | `R2 snapshot archive disabled` info event | table + fixed reason | exact reason strings, no PII |
 * | 4 | `R2 snapshot put failed` error event | object key only | key shape; the R2 client error text is NOT a log field (it reaches only the `onArchive` detail) |
 * | 5 | archive byte legs | full CSV bytes to D1-sync AND R2-put | byte-identical on both legs (a naive "scrub the archive" fix must not silently corrupt the backup) |
 * | 6 | export stream | CSV bytes only | zero console output while PII rows flow |
 * | 7 | export mid-stream D1 failure | stream error | zero console output; the error surfaces to the reader |
 * | 8 | export response | full row bytes (PII by design) | bytes verbatim — the bearer gate (pinned by `test/snapshotAuth.test.ts`) is the control, not payload scrubbing |
 * | 9 | export without bearer | 401 problem+json | fixed body, D1 never touched |
 *
 * Interpretation note: "no raw PII in export/archive outputs" cannot mean the
 * payloads — the export exists to serve snapshot rows (company names, phones)
 * to an authorized operator, and the R2 archive is byte-identical to the D1
 * sync by contract (TOG-6550; the TOG-8370 round-trip E2E depends on it).
 * Scrubbing either payload would destroy the feature. What must carry no PII
 * is every side-channel around them: logs, thrown messages, error bodies.
 * Test 8 pins the payload side of that boundary so a future scrub cannot
 * silently corrupt the download.
 *
 * No real secrets appear anywhere in this file: the PII stand-ins below are
 * `555-01xx` / `Example` values, and cookie stand-ins are `FAKE-…` literals.
 */

const PII_NAME = "Jane Example";
const PII_PHONE = "555-0199";
const PII_COMPANY = "Acme PII Probe Co";
const PII_COOKIE = "FAKE-SESSION-VALUE";

/** No byte of row data may survive in a side-channel emission. */
function expectNoPii(text: string): void {
  expect(text).not.toContain(PII_NAME);
  expect(text).not.toContain(PII_PHONE);
  expect(text).not.toContain(PII_COOKIE);
  expect(text).not.toContain(PII_COMPANY);
  expect(text).not.toContain("Set-Cookie");
}

const PII_CSV =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName," +
  "NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled\n" +
  `1,,${PII_COMPANY},Jane,,Example,,,,${PII_PHONE},,,true\n`;

const SYNCED_AT = "2026-09-28T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Site 1: static-path report-fetch throw.
// ---------------------------------------------------------------------------

const fetchBehavior: { responses: Array<() => Response> } = { responses: [] };

/*
 * Plain functions, not vi.fn(): the spy wrapper records each call's settled
 * result, which turns a deliberate rejection into an unhandled rejection under
 * @cloudflare/vitest-pool-workers (house pattern).
 */
vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => ({
    cookieHeader: "ASP.NET_SessionId=FAKE",
    expiresAtMs: null,
    refreshing: false
  })
}));

vi.mock("../src/lib/establishSession", () => ({
  establishSession: async () => undefined
}));

vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async () => {
    const next = fetchBehavior.responses.shift();
    return next ? next() : new Response("id,name\n", { status: 200 });
  }
}));

const { fetchReportCsvForPath } = await import("../src/lib/snapshot/reportFetch");
const { archiveReportCsvToR2AfterD1 } = await import("../src/lib/r2SnapshotArchive");
const {
  CUSTOMER_SNAPSHOT_EXPORT,
  snapshotCsvResponse,
  streamSnapshotCsv
} = await import("../src/lib/snapshot/export");

const { customerSnapshotRoutes } = await import("../src/routes/customerSnapshot");
const { addressSnapshotRoutes } = await import("../src/routes/addressSnapshot");
const { containerSnapshotRoutes } = await import("../src/routes/containerSnapshot");

const REPORT_ENV = {
  TARGET_ORIGIN: "https://killeen.example.test",
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: "https://killeen.example.test/WebRW/Account/Login",
  AUTH_SESSION: { idFromName: () => ({}), get: () => ({}) }
} as unknown as Env;

const REPORT_PATH = "/WebRW/Reports/QueryReport?reportID=42&format=csv";

beforeEach(() => {
  fetchBehavior.responses = [];
});

describe("static-path report-fetch throw carries status only (site 1 / LEAK-1)", () => {
  // Filed as its own bug card per the G13 acceptance (LEAK-1): the static-path
  // door interpolates upstream `statusText` into the thrown Error while the
  // query-id door (`QueryExecuteDownload failed: HTTP <status>`, pinned by
  // `test/piiScrub.test.ts`) is status-only. `statusText` is an
  // upstream-controlled free-text field — Routeware may echo request context
  // there — and this message propagates via the `[step]` wrap into the cron
  // `error` log field. `it.fails` keeps the suite green while documenting the
  // leak: the moment the fix lands, this test passes unexpectedly and fails
  // loudly, forcing its conversion to a plain pin.
  it.fails("excludes upstream statusText from the throw", async () => {
    // Arrange — both attempts fail with a PII-shaped body AND PII-shaped
    // status text. The body is already excluded (TOG-5821); the status text
    // is the unpinned channel.
    const piiStatus = `Service Unavailable for ${PII_NAME} ${PII_PHONE}`;
    fetchBehavior.responses = [
      () => new Response(PII_CSV, { status: 503, statusText: piiStatus }),
      () => new Response(PII_CSV, { status: 503, statusText: piiStatus })
    ];

    // Act
    const error = (await fetchReportCsvForPath(REPORT_ENV, REPORT_PATH).catch(
      (e: unknown) => e
    )) as Error;

    // Assert — the desired status-only contract, matching the query-id door.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Report fetch failed: 503");
    expectNoPii(error.message);
  });
});

// ---------------------------------------------------------------------------
// Sites 2–5: R2 archive emissions.
// ---------------------------------------------------------------------------

const r2Logs: Array<Record<string, unknown>> = [];
const r2Warnings: Array<Record<string, unknown>> = [];
const r2Errors: Array<Record<string, unknown>> = [];
const realConsole = { info: console.info, warn: console.warn, error: console.error };

function captureR2Console(): void {
  r2Logs.length = 0;
  r2Warnings.length = 0;
  r2Errors.length = 0;
  console.info = (...a: unknown[]) => {
    r2Logs.push(a[0] as Record<string, unknown>);
  };
  console.warn = (...a: unknown[]) => {
    r2Warnings.push(a[0] as Record<string, unknown>);
  };
  console.error = (...a: unknown[]) => {
    r2Errors.push(a[0] as Record<string, unknown>);
  };
}

afterEach(() => {
  console.info = realConsole.info;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
});

const enc = new TextEncoder();
const dec = new TextDecoder();

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    }
  });
}

async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (value?.byteLength) {
      parts.push(value);
    }
    if (done) {
      break;
    }
  }
  reader.releaseLock();
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return dec.decode(out);
}

/** Recording R2 bucket: captures the exact bytes of every `put`. */
function recordingBucket(): {
  bucket: R2Bucket;
  puts: Array<{ key: string; bytes: string }>;
} {
  const puts: Array<{ key: string; bytes: string }> = [];
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView | string) {
      const bytes =
        typeof value === "string"
          ? value
          : value instanceof ArrayBuffer
            ? dec.decode(value)
            : dec.decode(value as ArrayBufferView);
      puts.push({ key, bytes });
      return {} as R2Object;
    },
    async get() {
      // Fresh-bucket read: no pre-existing manifest sidecar, matching the
      // `null` the real binding returns for an absent key. The stored-manifest
      // merge path is pinned by `createMapBucket` in
      // `test/r2SnapshotManifest.test.ts`.
      return null;
    },
    async createMultipartUpload() {
      throw new Error("multipart not exercised in this file");
    }
  } as unknown as R2Bucket;
  return { bucket, puts };
}

function enabledEnv(bucket: R2Bucket): Env {
  return { SNAPSHOTS: bucket } as unknown as Env;
}

describe("R2 archive success log carries the key only (site 2)", () => {
  it("logs history keys with no row data while D1 and both R2 copies see identical PII bytes", async () => {
    // Arrange
    captureR2Console();
    const { bucket, puts } = recordingBucket();
    let d1Saw = "";

    // Act — PII-laden CSV through the real archive fan-out.
    const result = await archiveReportCsvToR2AfterD1(
      enabledEnv(bucket),
      "customer",
      streamOf(PII_CSV),
      async (s) => {
        d1Saw = await readAll(s);
        return { upserted: 1 };
      }
    );

    // Assert — passthrough result, byte-identical legs, and the log lines
    // name the key shapes with no row data anywhere near them. Write order:
    // history CSV, daily alias CSV, immutable history manifest, daily manifest
    // (fresh bucket, so `get` returned null and it was created), latest pointer.
    expect(result).toEqual({ upserted: 1 });
    expect(d1Saw).toBe(PII_CSV);
    expect(puts).toHaveLength(5);
    expect(puts[0]!.bytes).toBe(PII_CSV);
    expect(puts[0]!.key).toMatch(/^snapshot-history\/\d{4}-\d{2}-\d{2}\/[^/]+\/customer\.csv$/);
    expect(puts[1]!.bytes).toBe(PII_CSV);
    expect(puts[1]!.key).toMatch(/^snapshots\/\d{4}-\d{2}-\d{2}\/customer\.csv$/);
    expect(puts[2]!.key).toBe(`${puts[0]!.key}.manifest.json`);
    expect(puts[3]!.key).toMatch(/^snapshots\/\d{4}-\d{2}-\d{2}\.manifest\.json$/);
    expect(puts[4]!.key).toBe("snapshot-latest/customer.json");
    expect(puts[4]!.bytes).toBe(puts[2]!.bytes);
    expectNoPii(puts[3]!.bytes);
    expectNoPii(puts[4]!.bytes);
    const manifest = JSON.parse(puts[2]!.bytes) as {
      version: number;
      files: Record<string, { key: string }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.files["customer.csv"]?.key).toBe(puts[0]!.key);
    expect(r2Logs).toEqual([
      {
        level: "info",
        msg: "R2 snapshot stored",
        route: "snapshot.r2.archive",
        key: puts[0]!.key,
        ms: null
      },
      {
        level: "info",
        msg: "R2 snapshot manifest updated",
        route: "snapshot.r2.manifest",
        manifestKey: puts[3]!.key,
        ms: null
      }
    ]);
    expect(r2Warnings).toEqual([]);
    expect(r2Errors).toEqual([]);
    expectNoPii(JSON.stringify([...r2Logs, ...r2Warnings, ...r2Errors]));
    expectNoPii(puts[2]!.bytes);
  });
});

describe("R2 archive disabled log carries table plus fixed reason (site 3)", () => {
  it("names the unbound binding without touching the bucket", async () => {
    // Arrange
    captureR2Console();
    const { bucket, puts } = recordingBucket();
    let d1Ran = false;

    // Act — no SNAPSHOTS binding at all.
    const result = await archiveReportCsvToR2AfterD1(
      {} as unknown as Env,
      "address",
      streamOf(PII_CSV),
      async () => {
        d1Ran = true;
        return "ok";
      }
    );

    // Assert — D1 still runs, nothing archived, reason is a fixed string.
    expect(result).toBe("ok");
    expect(d1Ran).toBe(true);
    expect(puts).toEqual([]);
    expect(r2Logs).toEqual([
      {
        level: "info",
        msg: "R2 snapshot archive disabled",
        route: "snapshot.r2.archive",
        table: "address",
        reason: "SNAPSHOTS binding unbound",
        ms: null
      }
    ]);
    expect(r2Warnings).toEqual([]);
    expect(r2Errors).toEqual([]);
    expectNoPii(JSON.stringify([...r2Logs, ...r2Warnings, ...r2Errors]));
    void bucket;
  });

  it("names the kill-flag without touching the bucket", async () => {
    // Arrange
    captureR2Console();
    const { bucket, puts } = recordingBucket();

    // Act
    await archiveReportCsvToR2AfterD1(
      { SNAPSHOTS: bucket, SNAPSHOTS_R2_ENABLED: "false" } as unknown as Env,
      "container",
      streamOf(PII_CSV),
      async () => "ok"
    );

    // Assert
    expect(puts).toEqual([]);
    expect(r2Logs).toEqual([
      {
        level: "info",
        msg: "R2 snapshot archive disabled",
        route: "snapshot.r2.archive",
        table: "container",
        reason: "SNAPSHOTS_R2_ENABLED=false",
        ms: null
      }
    ]);
    expect(r2Warnings).toEqual([]);
    expect(r2Errors).toEqual([]);
    expectNoPii(JSON.stringify([...r2Logs, ...r2Warnings, ...r2Errors]));
  });
});

describe("R2 put-failure log carries the key only (site 4)", () => {
  it("keeps the D1 result and logs the key shape without the R2 error text", async () => {
    // Arrange — R2 throws a fixed transport error; the PII CSV already
    // succeeded on the D1 leg.
    captureR2Console();
    const boom = new Error("R2 boom");
    const failing = {
      async put() {
        throw boom;
      },
      async createMultipartUpload() {
        throw boom;
      }
    } as unknown as R2Bucket;

    // Act
    const result = await archiveReportCsvToR2AfterD1(
      enabledEnv(failing),
      "container",
      streamOf(PII_CSV),
      async () => ({ upserted: 2 })
    );

    // Assert — caller sees the D1 result. The error event carries the fixed
    // key and no transport text: the R2 client error reaches only the
    // `onArchive` detail, never a log field.
    expect(result).toEqual({ upserted: 2 });
    expect(r2Errors).toEqual([
      {
        level: "error",
        msg: "R2 snapshot put failed",
        route: "snapshot.r2.archive",
        key: expect.stringMatching(/^snapshot-history\/\d{4}-\d{2}-\d{2}\/[^/]+\/container\.csv$/),
        ms: null
      }
    ]);
    expect(r2Logs).toEqual([]);
    expect(r2Warnings).toEqual([]);
    expect(JSON.stringify(r2Errors)).not.toContain(boom.message);
  });
});

// ---------------------------------------------------------------------------
// Sites 6–8: CSV export emissions.
// ---------------------------------------------------------------------------

type RecordedCall = { sql: string; binds: unknown[] };

/** Read-side D1 fake over in-memory rows; rejects when `failAfter` pages served. */
function fakeExportDb(
  rows: Array<Record<string, unknown>>,
  pk: string,
  failAfter = Infinity
): { db: D1Database; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let pages = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return {
            async all<T>() {
              if (pages++ >= failAfter) {
                throw new Error("D1_ERROR: database is locked");
              }
              const limit = binds[binds.length - 1] as number;
              const after = binds.length > 1 ? (binds[0] as number) : null;
              const page = rows
                .filter((r) => after === null || (r[pk] as number) > after)
                .slice(0, limit);
              return { results: page } as unknown as T;
            }
          };
        }
      };
    }
  };
  return { db: db as unknown as D1Database, calls };
}

function piiCustomerRow(id: number): Record<string, unknown> {
  return {
    customer_id: id,
    customer_type_id: null,
    company_name: PII_COMPANY,
    first_name: "Jane",
    middle_initial: null,
    last_name: "Example",
    name_suffix: null,
    customer_number: null,
    sub_customer_number: null,
    phone1: PII_PHONE,
    phone2: null,
    comments: null,
    enabled: 1,
    synced_at: SYNCED_AT
  };
}

/** Every call on any console level during the export window (args as-is). */
const exportOutput: unknown[][] = [];
const realExportConsole = {
  log: console.log,
  info: console.info,
  error: console.error,
  warn: console.warn
};

function captureExportConsole(): void {
  exportOutput.length = 0;
  const sink = (...a: unknown[]) => {
    exportOutput.push(a);
  };
  console.log = sink;
  console.info = sink;
  console.error = sink;
  console.warn = sink;
}

function restoreExportConsole(): void {
  console.log = realExportConsole.log;
  console.info = realExportConsole.info;
  console.error = realExportConsole.error;
  console.warn = realExportConsole.warn;
}

describe("export stream emits bytes only, never log lines (sites 6–7)", () => {
  it("streams PII rows with zero console output", async () => {
    // Arrange
    captureExportConsole();
    try {
      const { db } = fakeExportDb([piiCustomerRow(1), piiCustomerRow(2)], "customer_id");

      // Act — small page size forces several D1 reads behind the stream.
      const text = await readAll(streamSnapshotCsv(db, CUSTOMER_SNAPSHOT_EXPORT, 1));

      // Assert — the rows flowed (capture window covered the emission) yet
      // nothing was logged at any level.
      expect(text).toContain(PII_COMPANY);
      expect(text).toContain(PII_PHONE);
      expect(exportOutput).toEqual([]);
    } finally {
      restoreExportConsole();
    }
  });

  it("a mid-stream D1 failure surfaces to the reader with zero console output", async () => {
    // Arrange — the second page rejects the way a locked D1 does.
    captureExportConsole();
    try {
      const { db } = fakeExportDb([piiCustomerRow(1), piiCustomerRow(2)], "customer_id", 1);

      // Act
      const error = (await readAll(streamSnapshotCsv(db, CUSTOMER_SNAPSHOT_EXPORT, 1)).catch(
        (e: unknown) => e
      )) as Error;

      // Assert — truncation contract (fail the download, don't buffer to
      // pre-validate) with no log line carrying row data.
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("D1_ERROR: database is locked");
      expect(exportOutput).toEqual([]);
    } finally {
      restoreExportConsole();
    }
  });
});

describe("export response carries row bytes verbatim (site 8)", () => {
  it("serves PII rows as an attachment — the bearer gate is the control", async () => {
    // Arrange
    const { db } = fakeExportDb([piiCustomerRow(7)], "customer_id");

    // Act
    const res = await snapshotCsvResponse(db, CUSTOMER_SNAPSHOT_EXPORT);

    // Assert — the download contract: attachment disposition, CSV type, and
    // the row bytes verbatim. Scrubbing here would corrupt the operator's
    // export (and break the import round-trip); unauthorized callers never
    // reach this constructor (site 9 + `test/snapshotAuth.test.ts`).
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="customer-snapshot.csv"'
    );
    const text = await res.text();
    expect(text).toContain(
      `7,,${PII_COMPANY},Jane,,Example,,,,${PII_PHONE},,,true,${SYNCED_AT}`
    );
  });
});

// ---------------------------------------------------------------------------
// Site 9: export without bearer.
// ---------------------------------------------------------------------------

const EXPORT_SECRET = "export-test-secret";
const INNER_401_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";

const exportCtx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

describe.each([
  {
    name: "customer",
    routes: customerSnapshotRoutes,
    path: "/api/v1/customer-snapshot/export"
  },
  {
    name: "address",
    routes: addressSnapshotRoutes,
    path: "/api/v1/address-snapshot/export"
  },
  {
    name: "container",
    routes: containerSnapshotRoutes,
    path: "/api/v1/container-snapshot/export"
  }
])("$name export without bearer (site 9)", ({ routes, path }) => {
  it("answers the fixed 401 without touching D1", async () => {
    // Arrange — a table holding PII rows behind the gate.
    const { db, calls } = fakeExportDb([piiCustomerRow(1)], "customer_id");
    const env = {
      CUSTOMER_DB: db,
      CUSTOMER_SNAPSHOT_SYNC_SECRET: EXPORT_SECRET
    } as unknown as Env;

    // Act — no Authorization header at all.
    const res = await routes.fetch(new Request(`http://test.local${path}`), env, exportCtx);

    // Assert — the canonical inner 401 (same body `test/snapshotAuth.test.ts`
    // pins with the API token), D1 never read, row data nowhere.
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
    const body = (await res.json()) as {
      detail?: string;
      instance?: string;
    };
    expect(body.detail).toBe(INNER_401_DETAIL);
    expect(body.instance).toBe(path);
    expectNoPii(JSON.stringify(body));
  });
});
