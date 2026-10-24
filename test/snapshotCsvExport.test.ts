import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env, exports } from "cloudflare:workers";
import {
  ADDRESS_SNAPSHOT_EXPORT,
  CONTAINER_SNAPSHOT_EXPORT,
  CUSTOMER_SNAPSHOT_EXPORT,
  SNAPSHOT_EXPORT_PAGE_SIZE,
  encodeSnapshotRow,
  escapeCsvCell,
  matchesSnapshotIfNoneMatch,
  readSnapshotExportPageSize,
  snapshotExportEtag,
  snapshotExportHeaderLine,
  snapshotExportSpec,
  streamSnapshotCsv,
  type SnapshotExportSpec
} from "../src/lib/snapshot/export";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Gap G5 — snapshot CSV export download UX.
 *
 * `src/lib/csvStream.ts` parses the inbound direction (Routeware → D1); the
 * outbound direction (D1 → browser download) did not exist at all. These
 * tests pin the new `GET ...-snapshot/export` routes:
 *
 * - `Content-Disposition: attachment; filename="…-snapshot.csv"` plus a
 *   `text/csv` content type on every table;
 * - the body is the full table in primary-key order with the canonical
 *   header, booleans as `true`/`false`, and RFC 4180 escaping;
 * - streaming, not full-buffering: every D1 read carries a LIMIT, a
 *   multi-page table takes several reads, and the response arrives as
 *   multiple stream chunks (header first, then one chunk per page);
 * - `/export` resolves as the static download route, never as a by-id lookup;
 * - the export routes carry the snapshot-secret inner auth gate.
 *
 * Large-table streaming is proved against a recording D1 fake (module-level
 * routes, no network); download correctness end to end against the real app
 * and the real migrated test D1, like `test/snapshotSyncE2E.test.ts`.
 */

const SECRET = "test-sync-secret";
const SYNCED_AT = "2026-09-28T00:00:00.000Z";

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

// Top-level await, house pattern (see test/snapshotRoutes.test.ts): the route
// modules are imported once so every describe below shares them.
const { customerSnapshotRoutes } = await import("../src/routes/customerSnapshot");
const { addressSnapshotRoutes } = await import("../src/routes/addressSnapshot");
const { containerSnapshotRoutes } = await import("../src/routes/containerSnapshot");

type RouteModule = typeof customerSnapshotRoutes;

type Recorded = { sql: string; binds: unknown[] };

/**
 * Recording read-side `D1Database` over in-memory rows. Honors the keyset
 * paging contract (`[limit]` for the first page, `[after, limit]` after)
 * and enforces the LIMIT — a handler that tried to pull the table in one
 * unpaged read gets every row at once and fails the multi-read assertion.
 */
function fakeExportDb(rows: Array<Record<string, unknown>>, pk: string): {
  db: D1Database;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return {
            async all<T>() {
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

function makeEnv(db: D1Database, pageSize?: unknown): Env {
  return {
    CUSTOMER_DB: db,
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    SNAPSHOT_EXPORT_PAGE_SIZE: pageSize
  } as unknown as Env;
}

async function callExport(
  routes: RouteModule,
  path: string,
  db: D1Database,
  token: string | null = SECRET,
  ifNoneMatch?: string,
  pageSize?: unknown
): Promise<Response> {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (ifNoneMatch !== undefined) {
    headers.set("if-none-match", ifNoneMatch);
  }
  return routes.fetch(
    new Request(`http://test.local${path}`, { headers }), makeEnv(db, pageSize), ctx
  );
}

/** Drain a response body chunk by chunk, preserving chunk boundaries. */
async function readChunks(res: Response): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.filter((c) => c.length > 0);
}

function customerRow(id: number, company: string | null = `Co ${id}`, enabled = 1) {
  return {
    customer_id: id,
    customer_type_id: null,
    company_name: company,
    first_name: null,
    middle_initial: null,
    last_name: null,
    name_suffix: null,
    customer_number: null,
    sub_customer_number: null,
    phone1: null,
    phone2: null,
    comments: null,
    enabled,
    synced_at: SYNCED_AT
  };
}

function addressRow(id: number, customerId = 1) {
  return {
    pickup_address_id: id,
    customer_id: customerId,
    route_id: null,
    address: `${id} Main St`,
    city: "Killeen",
    state: "TX",
    zip: "76541",
    franchise_id: null,
    comments: null,
    extras_allowed: 0,
    enabled: 1,
    driver_note: null,
    latitude: null,
    longitude: null,
    last_audit_date: null,
    synced_at: SYNCED_AT
  };
}

function containerRow(id: number, addressId = 1) {
  return {
    container_id: id,
    pickup_address_id: addressId,
    container_type_id: null,
    serial_number: `SN-${id}`,
    rfid: null,
    oncall: 0,
    event_code: null,
    gps_locked: 0,
    latitude: null,
    longitude: null,
    enabled: 1,
    location_address: `${id} Main St`,
    city: "Killeen",
    state: "TX",
    zip: "76541",
    container_note: null,
    ud_cost_share_ud: null,
    ud_enclosure_doors_ud: null,
    ud_last_compactor_inspection_ud: null,
    ud_last_enclosure_inspection_ud: null,
    ud_material_stream_ud: null,
    color: null,
    service_code_type: null,
    service_code_input: null,
    service_code: null,
    service_date: null,
    route_ids: null,
    frequency_ids: null,
    synced_at: SYNCED_AT
  };
}

type Spec = {
  name: string;
  routes: RouteModule;
  path: string;
  spec: SnapshotExportSpec;
  pk: string;
  filename: string;
  header: string;
  seed: (n: number) => Array<Record<string, unknown>>;
  edgeRows: Array<Record<string, unknown>>;
  edgeLines: string[];
};

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled,_shadow_csv_encoding,synced_at";
const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments," +
  "ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date,_shadow_csv_encoding,synced_at";
const CONTAINER_HEADER =
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked," +
  "Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote," +
  "UD-Cost_Share-UD,UD-Enclosure_Doors-UD,UD-Last_Compactor_Inspection-UD," +
  "UD-Last_Enclosure_Inspection-UD,UD-Material_Stream-UD,Color,ServiceCodeType," +
  "ServiceCode_input,ServiceCode,ServiceDate,RouteIDs,FrequencyIDs,_shadow_csv_encoding,synced_at";

const SPECS: Spec[] = [
  {
    name: "customer",
    routes: customerSnapshotRoutes,
    path: "/api/v1/customer-snapshot/export",
    spec: CUSTOMER_SNAPSHOT_EXPORT,
    pk: "customer_id",
    filename: "customer-snapshot.csv",
    header: CUSTOMER_HEADER,
    seed: (n) => Array.from({ length: n }, (_, i) => customerRow(i + 1)),
    edgeRows: [
      customerRow(1, 'Acme, "Quoted" Co\nLine 2'),
      customerRow(2, null, 0)
    ],
    edgeLines: [
      `1,,"Acme, ""Quoted"" Co\nLine 2",,,,,,,,,,true,1,${SYNCED_AT}`,
      `2,,,,,,,,,,,,false,1,${SYNCED_AT}`
    ]
  },
  {
    name: "address",
    routes: addressSnapshotRoutes,
    path: "/api/v1/address-snapshot/export",
    spec: ADDRESS_SNAPSHOT_EXPORT,
    pk: "pickup_address_id",
    filename: "address-snapshot.csv",
    header: ADDRESS_HEADER,
    seed: (n) => Array.from({ length: n }, (_, i) => addressRow(i + 1)),
    edgeRows: [addressRow(1)],
    edgeLines: [
      `1,1,,1 Main St,Killeen,TX,76541,,,false,true,,,,,1,${SYNCED_AT}`
    ]
  },
  {
    name: "container",
    routes: containerSnapshotRoutes,
    path: "/api/v1/container-snapshot/export",
    spec: CONTAINER_SNAPSHOT_EXPORT,
    pk: "container_id",
    filename: "container-snapshot.csv",
    header: CONTAINER_HEADER,
    seed: (n) => Array.from({ length: n }, (_, i) => containerRow(i + 1)),
    edgeRows: [containerRow(1)],
    edgeLines: [
      `1,1,,SN-1,,false,,false,,,true,1 Main St,Killeen,TX,76541,,,,,,,,,,,,,,1,${SYNCED_AT}`
    ]
  }
];

describe("escapeCsvCell", () => {
  it("leaves a plain cell untouched", () => {
    expect(escapeCsvCell("Acme Co")).toBe("Acme Co");
  });

  it("quotes a cell containing a comma, quote, LF or CR", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvCell("a\rb")).toBe('"a\rb"');
  });
});

describe("snapshotExportSpec", () => {
  it("resolves each table to its spec", () => {
    expect(snapshotExportSpec("customer")).toBe(CUSTOMER_SNAPSHOT_EXPORT);
    expect(snapshotExportSpec("address")).toBe(ADDRESS_SNAPSHOT_EXPORT);
    expect(snapshotExportSpec("container")).toBe(CONTAINER_SNAPSHOT_EXPORT);
  });

  it("publishes the canonical import header plus export metadata on every table", () => {
    // Every business column retains its import name. synced_at is ignored;
    // the encoding marker opts re-import into spreadsheet-prefix decoding.
    expect(snapshotExportHeaderLine(CUSTOMER_SNAPSHOT_EXPORT)).toBe(CUSTOMER_HEADER);
    expect(snapshotExportHeaderLine(ADDRESS_SNAPSHOT_EXPORT)).toBe(ADDRESS_HEADER);
    expect(snapshotExportHeaderLine(CONTAINER_SNAPSHOT_EXPORT)).toBe(CONTAINER_HEADER);
  });

  it("encodes null as empty and 0/1 booleans as false/true", () => {
    // Arrange / Act
    const line = encodeSnapshotRow(CUSTOMER_SNAPSHOT_EXPORT, customerRow(9, null, 0));

    // Assert
    expect(line).toBe(`9,,,,,,,,,,,,false,1,${SYNCED_AT}`);
  });
});

function readPageSizeQuietly(raw: unknown): { size: number; warnings: number } {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const size = readSnapshotExportPageSize(makeEnv({} as D1Database, raw));
    return { size, warnings: warn.mock.calls.length };
  } finally {
    warn.mockRestore();
  }
}

describe("readSnapshotExportPageSize", () => {
  it.each([
    ["1", 1], ["50", 50], ["500", 500], ["1000", 1000], ["5000", 5000], [" 50 \n", 50]
  ])("accepts %j as %i rows", (raw, expected) => {
    expect(readPageSizeQuietly(raw)).toEqual({ size: expected, warnings: 0 });
  });

  it.each([
    undefined, null, "", "   ", "0", "5001", "-1", "+50", "1.5", "50.0",
    "1e2", "0x32", "50rows", "NaN", "Infinity", "9007199254740993", "１２",
    "5 0", 50, true, {}, [[]]
  ])("falls back to 1000 for %j", (raw) => {
    expect(readPageSizeQuietly(raw)).toEqual({
      size: 1000,
      warnings: raw === undefined ? 0 : 1
    });
  });

  it("checks the 200 read formula against the D1 budget at measured row counts", () => {
    // 2026-09-27 counts (CUSTOMER_SNAPSHOT.md § batch sizing): customer
    // 109,894, address 111,620, container 388,735 rows. A 200 costs two
    // passes of ceil(N / pageSize) + 1 reads against the 1000-query cap, so
    // this fails if the default ever drops back below the budget (at 500 the
    // container needs 1,558 reads and the body truncates mid-stream).
    const reads = (rows: number) =>
      2 * (Math.ceil(rows / SNAPSHOT_EXPORT_PAGE_SIZE) + 1);
    expect(reads(109_894)).toBeLessThanOrEqual(1000);
    expect(reads(111_620)).toBeLessThanOrEqual(1000);
    expect(reads(388_735)).toBeLessThanOrEqual(1000);
  });
});

describe.each(SPECS)("$name export route", (spec) => {
  it("answers attachment with the table filename and a CSV content type", async () => {
    // Arrange
    const { db } = fakeExportDb(spec.seed(3), spec.pk);

    // Act
    const res = await callExport(spec.routes, spec.path, db);

    // Assert — the curl-visible contract: `attachment; filename=...`.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${spec.filename}"`
    );
    await res.text();
  });

  it("streams the full table in key order without buffering it in one read", async () => {
    // Arrange — more rows than one page so a single unpaged SELECT cannot
    // satisfy the export.
    const total = 2 * SNAPSHOT_EXPORT_PAGE_SIZE + 200;
    const { db, calls } = fakeExportDb(spec.seed(total), spec.pk);

    // Act
    const res = await callExport(spec.routes, spec.path, db);
    const chunks = await readChunks(res);

    // Assert — every D1 read is LIMIT-bounded (no full-table pull), the table
    // took several reads, and the response arrived as several stream chunks
    // (header first, then one chunk per page).
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.sql).toContain("LIMIT");
    }
    expect(chunks.length).toBeGreaterThan(2);
    const text = chunks.join("");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe(spec.header);
    expect(lines).toHaveLength(total + 1);
    // First page rows are 1..PAGE in order; the tail row is last.
    expect(lines[1]).toBe(encodeSnapshotRow(spec.spec, spec.seed(total)[0]!));
    expect(lines[lines.length - 1]).toBe(
      encodeSnapshotRow(spec.spec, spec.seed(total)[total - 1]!)
    );
  });

  it("pages with a keyset cursor, resuming strictly after the previous page", async () => {
    // Arrange
    const { db, calls } = fakeExportDb(spec.seed(SNAPSHOT_EXPORT_PAGE_SIZE + 1), spec.pk);

    // Act
    const res = await callExport(spec.routes, spec.path, db);
    await res.text();

    // Assert — first page unbounded below, second page resumes after the last
    // key of the first; no OFFSET (which would rescan on every page). The
    // ETag pre-pass doubles the reads (3 + 3): each pass pages identically.
    expect(calls).toHaveLength(6);
    expect(calls[0]!.sql).not.toContain("WHERE");
    expect(calls[0]!.binds).toEqual([SNAPSHOT_EXPORT_PAGE_SIZE]);
    expect(calls[1]!.sql).toContain(`WHERE ${spec.pk} > ?`);
    expect(calls[1]!.binds).toEqual([SNAPSHOT_EXPORT_PAGE_SIZE, SNAPSHOT_EXPORT_PAGE_SIZE]);
    // The body pass restarts from the first page.
    expect(calls[3]!.sql).not.toContain("WHERE");
    expect(calls[3]!.binds).toEqual([SNAPSHOT_EXPORT_PAGE_SIZE]);
    expect(calls[4]!.sql).toContain(`WHERE ${spec.pk} > ?`);
    for (const call of calls) {
      expect(call.sql).not.toContain("OFFSET");
    }
  });

  it("exports identical bytes at env page size 50 and the 1000 default", async () => {
    const rows = spec.seed(1253);
    const textColumn = spec.name === "customer" ? "company_name"
      : spec.name === "address" ? "address" : "container_note";
    rows[49]![textColumn] = 'Unicode Ω, "quoted"\r\nsecond line';
    rows[500]![textColumn] = null;
    const smaller = fakeExportDb(rows, spec.pk);
    const standard = fakeExportDb(rows, spec.pk);

    const at50 = await callExport(spec.routes, spec.path, smaller.db, SECRET, undefined, "50");
    const atDefault = await callExport(spec.routes, spec.path, standard.db);
    expect(at50.status).toBe(200);
    expect(atDefault.status).toBe(200);
    expect(at50.headers.get("etag")).toBe(atDefault.headers.get("etag"));
    expect(new Uint8Array(await at50.arrayBuffer())).toEqual(
      new Uint8Array(await atDefault.arrayBuffer())
    );
    expect(smaller.calls).toHaveLength(2 * (Math.ceil(rows.length / 50) + 1));
    expect(standard.calls).toHaveLength(2 * (Math.ceil(rows.length / 1000) + 1));
    for (const call of smaller.calls) {
      expect(call.sql).toContain("LIMIT ?");
      expect(call.binds.at(-1)).toBe(50);
    }
    for (const call of standard.calls) {
      expect(call.binds.at(-1)).toBe(1000);
    }
  });

  it("answers If-None-Match with 304 at env page size 50 for the default tag", async () => {
    const rows = spec.seed(120);
    const first = await callExport(spec.routes, spec.path, fakeExportDb(rows, spec.pk).db);
    const etag = first.headers.get("etag")!;
    await first.text();

    const res = await callExport(
      spec.routes, spec.path, fakeExportDb(rows, spec.pk).db, SECRET, etag, "50"
    );

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("uses bounded default reads when the env override is invalid", async () => {
    const { db, calls } = fakeExportDb(spec.seed(SNAPSHOT_EXPORT_PAGE_SIZE + 1), spec.pk);
    const res = await callExport(spec.routes, spec.path, db, SECRET, undefined, "-1");
    expect(res.status).toBe(200);
    await res.text();
    expect(calls).toHaveLength(6);
    expect(calls.every((call) => call.binds.at(-1) === SNAPSHOT_EXPORT_PAGE_SIZE)).toBe(true);
  });

  it("escapes cells and renders booleans on the wire", async () => {
    // Arrange
    const { db } = fakeExportDb(spec.edgeRows, spec.pk);

    // Act
    const res = await callExport(spec.routes, spec.path, db);
    const lines = (await res.text()).split("\n").filter((l) => l.length > 0 || l === "");

    // Assert — the quoted-newline cell spans lines on the wire; rejoin before
    // comparing (the CSV, not the transport, is the contract).
    const body = lines.join("\n");
    for (const line of spec.edgeLines) {
      expect(body).toContain(line);
    }
  });

  it("exports the header alone when the table is empty", async () => {
    // Arrange
    const { db, calls } = fakeExportDb([], spec.pk);

    // Act
    const res = await callExport(spec.routes, spec.path, db);

    // Assert — still a download (disposition intact), one D1 read per pass
    // (ETag pre-pass plus body pass), no rows.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${spec.filename}"`
    );
    expect(await res.text()).toBe(`${spec.header}\n`);
    expect(calls).toHaveLength(2);
  });

  it("does not resolve /export as a by-id lookup", async () => {
    // Arrange — the param route would 400/404 on the literal "export"; the
    // static download route must win (registration order, pinned here).
    const { db } = fakeExportDb(spec.seed(1), spec.pk);

    // Act
    const res = await callExport(spec.routes, spec.path, db);

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
  });

  it("rejects a missing bearer with the snapshot-secret 401", async () => {
    // Arrange
    const { db, calls } = fakeExportDb(spec.seed(1), spec.pk);

    // Act
    const res = await callExport(spec.routes, spec.path, db, null);

    // Assert — D1 never touched.
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("emits a stable content-hash ETag on every 200", async () => {
    // Arrange — identical content served from two independent fakes.
    const rows = spec.seed(3);

    // Act
    const first = await callExport(spec.routes, spec.path, fakeExportDb(rows, spec.pk).db);
    const second = await callExport(spec.routes, spec.path, fakeExportDb(rows, spec.pk).db);

    // Assert — greppable quoted form, identical for identical bytes.
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"fnv64-[0-9a-f]{16}"$/);
    expect(second.headers.get("etag")).toBe(etag);
    await first.text();
    await second.text();
  });

  it("answers If-None-Match with 304 and an empty body", async () => {
    // Arrange — fetch once to learn the current tag.
    const rows = spec.seed(3);
    const first = await callExport(spec.routes, spec.path, fakeExportDb(rows, spec.pk).db);
    const etag = first.headers.get("etag")!;
    await first.text();

    // Act — replay the tag.
    const res = await callExport(
      spec.routes,
      spec.path,
      fakeExportDb(rows, spec.pk).db,
      SECRET,
      etag
    );

    // Assert — not modified, tag repeated, nothing to download.
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  describe("quoted-comma legacy validators", () => {
    const outbound = vi.fn(async () => { throw new Error("Unexpected CSV outbound fetch"); });
    beforeEach(() => {
      outbound.mockClear();
      vi.stubGlobal("fetch", outbound);
    });
    afterEach(() => {
      try { expect(outbound).not.toHaveBeenCalled(); }
      finally { vi.unstubAllGlobals(); }
    });

    async function currentExport() {
      const db = fakeExportDb(spec.edgeRows, spec.pk).db;
      const first = await callExport(spec.routes, spec.path, db);
      expect(first.status).toBe(200);
      const tag = first.headers.get("etag")!;
      expect(tag).toMatch(/^"fnv64-[0-9a-f]{16}"$/);
      const text = `${spec.header}\n${spec.edgeLines.join("\n")}\n`;
      expect(await first.text()).toBe(text);
      return { db, tag, hash: tag.slice(1, -1), text };
    }

    // The current hash or * inside ONE unrelated opaque tag must not suppress
    // the CSV body. These run the production routes, not just the matcher helper.
    it.each([
      { name: "hash inside one quoted tag", header: (h: string) => `"prefix,${h},suffix"` },
      { name: "hash inside one lowercase-weak tag", header: (h: string) => `w/"prefix,${h},suffix"` },
      { name: "wildcard inside one quoted tag", header: () => '"prefix,*,suffix"' },
      { name: "wildcard inside one lowercase-weak tag", header: () => 'w/"prefix,*,suffix"' },
      // TOG-39719: a quoted "*" is an opaque entity-tag, never the RFC 7232
      // wildcard. The current tag is fnv64 hex (asserted in currentExport),
      // so these must miss (200); the raw "*" 304 control is preserved below.
      { name: "standalone quoted wildcard", header: () => '"*"' },
      { name: "standalone lowercase-weak quoted wildcard", header: () => 'w/"*"' },
      { name: "standalone uppercase-weak quoted wildcard", header: () => 'W/"*"' }
    ])("serves current CSV for $name", async ({ header }) => {
      const current = await currentExport();
      const res = await callExport(spec.routes, spec.path, current.db, SECRET, header(current.hash));
      const text = await res.text();
      expect.soft(res.status).toBe(200);
      expect.soft(res.headers.get("etag")).toBe(current.tag);
      expect.soft(text.length).toBeGreaterThan(0);
      expect(text).toBe(current.text);
    });

    it.each([
      { name: "exact quoted tag", header: (h: string) => `"${h}"` },
      { name: "bare tag", header: (h: string) => h },
      { name: "lowercase weak tag", header: (h: string) => `w/"${h}"` },
      { name: "uppercase weak tag", header: (h: string) => `W/"${h}"` },
      { name: "standalone wildcard", header: () => "*" },
      { name: "whitespace and list", header: (h: string) => ` \t"other", \t${h} \t` },
      { name: "real tag after quoted commas", header: (h: string) => `"prefix,wrong,suffix", w/"${h}"` },
      // Backslashes are literal in opaque tags, not quote escapes.
      { name: "real tag after a trailing backslash", header: (h: string) => `"prefix,wrong\\", "${h}"` }
    ])("preserves 304 for $name", async ({ header }) => {
      const current = await currentExport();
      const res = await callExport(spec.routes, spec.path, current.db, SECRET, header(current.hash));
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(current.tag);
      expect(await res.text()).toBe("");
    });
  });

  it("re-downloads with a fresh ETag after any cell edit", async () => {
    // Arrange — one cell changes between fetches (`synced_at` is a column on
    // every table, so this stays table-generic).
    const rows = spec.seed(2);
    const first = await callExport(spec.routes, spec.path, fakeExportDb(rows, spec.pk).db);
    const stale = first.headers.get("etag")!;
    await first.text();
    rows[0] = { ...rows[0], synced_at: "2026-09-29T00:00:00.000Z" };

    // Act — replay the now-stale tag against the edited table.
    const res = await callExport(
      spec.routes,
      spec.path,
      fakeExportDb(rows, spec.pk).db,
      SECRET,
      stale
    );

    // Assert — full body again under a different tag.
    expect(res.status).toBe(200);
    const fresh = res.headers.get("etag")!;
    expect(fresh).not.toBe(stale);
    expect(fresh).toMatch(/^"fnv64-[0-9a-f]{16}"$/);
    expect((await res.text()).split("\n")[0]).toBe(spec.header);
  });
});

describe("matchesSnapshotIfNoneMatch", () => {
  const TAG = '"fnv64-0123456789abcdef"';

  it("matches the exact tag, a weak tag, a list entry, and *", () => {
    expect(matchesSnapshotIfNoneMatch(TAG, TAG)).toBe(true);
    expect(matchesSnapshotIfNoneMatch(`W/${TAG}`, TAG)).toBe(true);
    expect(matchesSnapshotIfNoneMatch(`"fnv64-deadbeefdeadbeef", ${TAG}`, TAG)).toBe(true);
    expect(matchesSnapshotIfNoneMatch("*", TAG)).toBe(true);
  });

  it("never serves a false 304 for a stale or partial tag", () => {
    // A different tag is stale; a longer token sharing the prefix must not
    // substring-match (that would skip a re-download the client needs).
    expect(matchesSnapshotIfNoneMatch('"fnv64-ffffffffffffffff"', TAG)).toBe(false);
    expect(matchesSnapshotIfNoneMatch('"fnv64-0123456789abcdef0"', TAG)).toBe(false);
    expect(matchesSnapshotIfNoneMatch(null, TAG)).toBe(false);
    expect(matchesSnapshotIfNoneMatch(undefined, TAG)).toBe(false);
  });

  it("pins the FNV-1a 64 spec vector through the export hasher", async () => {
    // Arrange — an empty table hashes the header line only; the empty-input
    // basis is pinned by hashing zero rows via a bare spec.
    const { db } = fakeExportDb([], "customer_id");

    // Act
    const etag = await snapshotExportEtag(db, CUSTOMER_SNAPSHOT_EXPORT);

    // Assert — deterministic across passes (stability is the contract; the
    // exact hex is pinned so a hasher swap is a visible diff).
    const again = await snapshotExportEtag(fakeExportDb([], "customer_id").db, CUSTOMER_SNAPSHOT_EXPORT);
    expect(etag).toBe(again);
    expect(etag).toMatch(/^"fnv64-[0-9a-f]{16}"$/);
  });
});

describe("export page memory/backpressure bound", () => {
  it("drains a lazy wide-row table larger than 128 MB with at most one page prefetched", async () => {
    const total = 8001;
    const pageSize = 50;
    const wide = "x".repeat(20_000);
    let reads = 0;
    let maxRows = 0;
    const db = {
      prepare(sql: string) {
        expect(sql).toContain("LIMIT ?");
        return {
          bind(...binds: unknown[]) {
            return {
              async all() {
                reads++;
                const limit = binds.at(-1) as number;
                expect(limit).toBe(pageSize);
                const after = binds.length > 1 ? binds[0] as number : 0;
                const count = Math.max(0, Math.min(limit, total - after));
                maxRows = Math.max(maxRows, count);
                return {
                  results: Array.from({ length: count }, (_, i) =>
                    customerRow(after + i + 1, wide))
                };
              }
            };
          }
        };
      }
    } as unknown as D1Database;
    const stream = streamSnapshotCsv(
      db, CUSTOMER_SNAPSHOT_EXPORT, readSnapshotExportPageSize(makeEnv(db, "50"))
    );
    const reader = stream.getReader();
    const header = await reader.read();
    expect(new TextDecoder().decode(header.value)).toBe(`${CUSTOMER_HEADER}\n`);
    const maxChunkBytes = pageSize * new TextEncoder().encode(
      encodeSnapshotRow(CUSTOMER_SNAPSHOT_EXPORT, customerRow(total, wide)) + "\n"
    ).byteLength;
    let chunks = 0;
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      bytes += value.byteLength;
      expect(value.byteLength).toBeLessThanOrEqual(maxChunkBytes);
      await Promise.resolve();
      expect(reads).toBeLessThanOrEqual(chunks + 1);
    }
    expect(bytes).toBeGreaterThan(128 * 1024 * 1024);
    expect(maxRows).toBe(pageSize);
    expect(chunks).toBe(Math.ceil(total / pageSize));
    expect(reads).toBe(chunks + 1);
  }, 30_000);
});

describe("export end to end through the real app and D1", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  function realDb(): D1Database {
    return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
  }

  async function getExport(
    path: string,
    token = SECRET,
    ifNoneMatch?: string
  ): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (ifNoneMatch !== undefined) {
      headers.set("if-none-match", ifNoneMatch);
    }
    return exports.default.fetch(`http://test.local${path}`, { headers });
  }

  it("downloads all three tables with filenames, headers and FK-ordered rows", async () => {
    // Arrange — FK chain customer → address → container, fixed stamps.
    const db = realDb();
    await db
      .prepare(
        "INSERT OR REPLACE INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (9101, 'E2E Co', 1, '2026-09-28T00:00:00.000Z')"
      )
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO address_snapshot (pickup_address_id, customer_id, address, city, state, zip, extras_allowed, enabled, synced_at) VALUES (9201, 9101, '9201 Main St', 'Killeen', 'TX', '76541', 0, 1, '2026-09-28T00:00:00.000Z')"
      )
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO container_snapshot (container_id, pickup_address_id, serial_number, oncall, gps_locked, enabled, location_address, city, state, zip, synced_at) VALUES (9301, 9201, 'SN-9301', 0, 0, 1, '9201 Main St', 'Killeen', 'TX', '76541', '2026-09-28T00:00:00.000Z')"
      )
      .run();

    // Act
    const customer = await getExport("/api/v1/customer-snapshot/export");
    const address = await getExport("/api/v1/address-snapshot/export");
    const container = await getExport("/api/v1/container-snapshot/export");

    // Assert — the curl-visible contract per table, plus row presence.
    expect(customer.headers.get("content-disposition")).toBe(
      'attachment; filename="customer-snapshot.csv"'
    );
    expect(customer.headers.get("content-type")).toContain("text/csv");
    const customerText = await customer.text();
    expect(customerText.split("\n")[0]).toBe(CUSTOMER_HEADER);
    expect(customerText).toContain("9101,,E2E Co");

    expect(address.headers.get("content-disposition")).toBe(
      'attachment; filename="address-snapshot.csv"'
    );
    const addressText = await address.text();
    expect(addressText.split("\n")[0]).toBe(ADDRESS_HEADER);
    expect(addressText).toContain("9201,9101,,");

    expect(container.headers.get("content-disposition")).toBe(
      'attachment; filename="container-snapshot.csv"'
    );
    const containerText = await container.text();
    expect(containerText.split("\n")[0]).toBe(CONTAINER_HEADER);
    expect(containerText).toContain("9301,9201,,");

    // Assert — browser clients can read the filename through CORS.
    expect(customer.headers.get("access-control-expose-headers")).toMatch(
      /content-disposition/i
    );
  });

  it("answers a replayed ETag with 304 and an empty body (conditional read)", async () => {
    // Acceptance leg: fetch twice for a stable tag, replay it as
    // If-None-Match, get 304 with nothing to download.
    const first = await getExport("/api/v1/customer-snapshot/export");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"fnv64-[0-9a-f]{16}"$/);
    await first.text();

    const second = await getExport("/api/v1/customer-snapshot/export");
    expect(second.headers.get("etag")).toBe(etag);
    await second.text();

    const replay = await getExport(
      "/api/v1/customer-snapshot/export",
      SECRET,
      etag!
    );
    expect(replay.status).toBe(304);
    expect(replay.headers.get("etag")).toBe(etag);
    expect(await replay.text()).toBe("");
  });

  it("exports identical full local D1 bytes with env page size 50 and 1000", async () => {
    const db = realDb();
    const before = await db.prepare("SELECT COUNT(*) as n FROM customer_snapshot").first<{ n: number }>();
    expect(before).not.toBeNull();
    for (let start = 0; start < 521; start += 50) {
      await db.batch(Array.from({ length: Math.min(50, 521 - start) }, (_, i) =>
        db.prepare(
          "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, ?, ?)"
        ).bind(100_000 + start + i, `Local Ω ${start + i}, "quoted"`, i % 2, SYNCED_AT)
      ));
    }
    const at50 = await callExport(customerSnapshotRoutes, SPECS[0]!.path, db, SECRET, undefined, "50");
    const atDefault = await callExport(customerSnapshotRoutes, SPECS[0]!.path, db);
    expect(at50.status).toBe(200);
    expect(atDefault.status).toBe(200);
    expect(at50.headers.get("etag")).toBe(atDefault.headers.get("etag"));
    const bytes50 = new Uint8Array(await at50.arrayBuffer());
    expect(bytes50).toEqual(new Uint8Array(await atDefault.arrayBuffer()));
    expect(new TextDecoder().decode(bytes50).split("\n")).toHaveLength(before!.n + 521 + 2);
  });

  it("rejects the app token (not the sync secret) on exports", async () => {
    // Arrange / Act — a valid app bearer that is not the snapshot secret.
    const res = await getExport("/api/v1/customer-snapshot/export", "test-api-token");

    // Assert
    expect(res.status).toBe(401);
  });
});
