import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { parseAddressSnapshotRow } from "../src/lib/csvAddressSnapshot";
import { parseContainerSnapshotRow } from "../src/lib/csvContainerSnapshot";
import { parseCustomerSnapshotRow } from "../src/lib/csvCustomerSnapshot";
import { mapCsvHeaders, parseBool, parseBoolDefaultTrue } from "../src/lib/csvParse";
import { streamCsvLines, stringToUint8Stream } from "../src/lib/csvStream";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * TOG-8887 (R3-11) — export → reimport round-trip idempotence.
 *
 * Import-compatible data from each `*-snapshot/export` route (customer,
 * address, container — `data-snapshot` serves no export route) must paste back
 * into its matching import with no loss: export → import → export keeps every
 * business cell across booleans, RFC 4180 quoting and Unicode.
 * Report-origin controls and lone cell CR remain in exports but are rejected
 * by HTTP import. Lossless recovery of those rows uses the in-code archive
 * restore in docs/R2-RESTORE-RUNBOOK.md §6, pinned separately by
 * snapshotRestoreControlBoundary.test.ts; these assertions remain unchanged.
 *
 * Shape per table: POST import (edge-case seed) → GET export (A) → POST import
 * (A verbatim, `synced_at` column included — the row parsers ignore it by
 * design) → GET export (B), then assert row-count equality plus SHA-256
 * equality over the exports with the per-run `synced_at` trailer masked, plus
 * deep equality of the parsed business rows (a second lens, immune to any
 * masking overreach).
 *
 * `synced_at` is Worker metadata, not business data: every import restamps it
 * (`streamSync` always overwrites it; the upsert guard is `<=`), so raw
 * byte-equality across the reimport leg is impossible by design and is NOT
 * asserted — only the masked checksum is. If a future column stops
 * round-tripping, the masked checksum (and the parsed-row diff) names it.
 *
 * Driven through the real app + real test D1 (migrated via
 * `./d1TestMigrations`), like `test/snapshotImportEdges.test.ts`. FK order is
 * customer → address → container: each table's test seeds its own parents in
 * distinct id ranges first. No test here reaches the network.
 */

const SYNC_SECRET = "test-sync-secret";

type RowParser = (
  cols: Record<string, number>,
  line: string
) => Record<string, unknown> | null;

type TableSpec = {
  name: string;
  exportPath: string;
  importPath: string;
  parse: RowParser;
};

const SPECS: Record<"customer" | "address" | "container", TableSpec> = {
  customer: {
    name: "customer",
    exportPath: "/api/v1/customer-snapshot/export",
    importPath: "/api/v1/customer-snapshot/import",
    parse: parseCustomerSnapshotRow as RowParser
  },
  address: {
    name: "address",
    exportPath: "/api/v1/address-snapshot/export",
    importPath: "/api/v1/address-snapshot/import",
    parse: parseAddressSnapshotRow as RowParser
  },
  container: {
    name: "container",
    exportPath: "/api/v1/container-snapshot/export",
    importPath: "/api/v1/container-snapshot/import",
    parse: parseContainerSnapshotRow as RowParser
  }
};

type ImportResult = { upserted: number; rowCount: number; deleted?: number };

async function postImport(
  path: string,
  body: string
): Promise<{ status: number; body: ImportResult }> {
  const res = await exports.default.fetch(`http://test.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SYNC_SECRET}`,
      "content-type": "text/csv"
    },
    body
  });
  return { status: res.status, body: (await res.json()) as ImportResult };
}

async function getExport(path: string): Promise<Response> {
  return exports.default.fetch(`http://test.local${path}`, {
    headers: { authorization: `Bearer ${SYNC_SECRET}` }
  });
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
 * export always renders `synced_at` as the last column, so only a trailing ISO
 * timestamp is masked — a business timestamp mid-row never matches. Applied to
 * both exports before checksumming.
 */
function maskSyncedAtLine(line: string): string {
  return line.replace(
    /,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    ",<STAMP>"
  );
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseBusinessRows(
  spec: TableSpec,
  lines: string[]
): Array<Record<string, unknown>> {
  const cols = mapCsvHeaders(lines[0]!);
  return lines.slice(1).map((line) => {
    const row = spec.parse(cols, line);
    expect(row, `export line must parse: ${line.slice(0, 80)}`).not.toBeNull();
    return row!;
  });
}

/**
 * Full round-trip for one table: seed import → export A → reimport A →
 * export B, with row-count + checksum equality between A and B. Returns both
 * export texts for table-specific spot checks.
 */
async function roundTrip(
  spec: TableSpec,
  seedCsv: string,
  expectedRows: number
): Promise<{ textA: string; textB: string }> {
  // Arrange — seed carries the hostile cells (spellings, quoting, unicode).

  // Act — seed import.
  const seed = await postImport(spec.importPath, seedCsv);

  // Assert — the seed lands whole (a dropped row here would shrink both
  // exports identically and hide behind a passing checksum).
  expect(seed.status).toBe(200);
  expect(seed.body.rowCount).toBe(expectedRows);
  expect(seed.body.upserted).toBe(expectedRows);

  // Act — export A.
  const resA = await getExport(spec.exportPath);

  // Assert
  expect(resA.status).toBe(200);
  const textA = await resA.text();
  const linesA = await logicalLines(textA);
  expect(linesA.length - 1).toBe(expectedRows);

  // Act — reimport the export verbatim (synced_at column included).
  const re = await postImport(spec.importPath, textA);

  // Assert — the export re-imports cleanly: same row count, no 400, no drops.
  expect(re.status).toBe(200);
  expect(re.body).toMatchObject({
    upserted: expectedRows,
    rowCount: expectedRows
  });

  // Act — export B.
  const resB = await getExport(spec.exportPath);

  // Assert
  expect(resB.status).toBe(200);
  const textB = await resB.text();
  const linesB = await logicalLines(textB);
  expect(linesB.length - 1).toBe(expectedRows);

  // Assert — checksum equality over the synced_at-masked exports, plus parsed
  // business-row equality as the second lens.
  const maskedA = linesA.map(maskSyncedAtLine).join("\n");
  const maskedB = linesB.map(maskSyncedAtLine).join("\n");
  expect(maskedB).toBe(maskedA);
  expect(await sha256Hex(maskedB)).toBe(await sha256Hex(maskedA));
  expect(parseBusinessRows(spec, linesB)).toEqual(
    parseBusinessRows(spec, linesA)
  );

  return { textA, textB };
}

// ---------------------------------------------------------------------------
// Seeds. Distinct 88xxx ranges per table so the shared test D1 never collides.
// ---------------------------------------------------------------------------

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";

/** CRLF throughout (plus one quoted-CRLF cell): the export normalizes to LF. */
const CUSTOMER_SEED = [
  CUSTOMER_HEADER,
  '88101,,"Acme, Inc.",John,Q,Doe,Jr,CN-1,SC-1,555-0101,555-0102, normal comments ,true',
  '88102,,"say ""hi"", ok",Jane,,Smith,,,,,,,TRUE',
  '88103,,"line1\nline2",Bob,,Jones,,,,,,,1',
  '88104,,Café Münchën ☃ 日本語 🎉,Zoë,,Müller,,,,,,,yes',
  '88105,,5" widget,Max,,Payne,,,,,,,YES',
  '88106,,Bool Co 6,,,,,,,,,,false',
  '88107,,Bool Co 7,,,,,,,,,,FALSE',
  '88108,,Bool Co 8,,,,,,,,,,0',
  '88109,,Bool Co 9,,,,,,,,,,no',
  '88110,,Bool Co 10,,,,,,,,,,NO',
  '88111,,Bool Co 11,,,,,,,,,,',
  '88112,,Bool Co 12,,,,,,,,,,True'
].join("\r\n");

const ADDRESS_HEADER =
  "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments," +
  "ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date";

const ADDRESS_PARENTS = [
  CUSTOMER_HEADER,
  "88201,,Parent Co,,,,,,,,,,true",
  "88202,,Parent Co 2,,,,,,,,,,true"
].join("\n");

const ADDRESS_SEED = [
  ADDRESS_HEADER,
  '88211,88201,,"12 Main St, Apt ""4B""",Killeen,TX,76541,,"gate code, call ""front""",yes,1,Driver: Zoë ☃,30.1,-97.7,2024-05-01',
  '88212,88201,,"5"" alley",Killeen,TX,76541,,,TRUE,,30.2,-97.8,',
  '88213,88202,,"日本店 2号店\n二階",Austin,TX,78701,,,0,no,,30.3,-97.9,2024-06-01',
  "88214,88202,,Plain St,Killeen,TX,76541,,,,,,,,"
].join("\n");

const CONTAINER_HEADER =
  "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked," +
  "Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote";

/**
 * Short 16-column upstream shape on purpose: the export serves the full 29
 * columns (UD-*, service codes, ...), so this also pins short → full → short
 * stability (missing columns import as null, export as empty, reimport as
 * null).
 */
const CONTAINER_PARENTS_CUSTOMER = [
  CUSTOMER_HEADER,
  "88301,,Bin Parent,,,,,,,,,,true"
].join("\n");

const CONTAINER_PARENTS_ADDRESS = [
  ADDRESS_HEADER,
  "88311,88301,,99 Industrial,Killeen,TX,76541,,,true,true,,,,"
].join("\n");

const CONTAINER_SEED = [
  CONTAINER_HEADER,
  '88321,88311,,"SN-1, ""A""",RF-1,yes,E1,1,30.1,-97.7,TRUE,"99 Industrial, Bldg ""C""",Killeen,TX,76541,"Café ☃\nsecond line"',
  "88322,88311,,SN-2,,,,,30.2,-97.8,1,99 Industrial,Killeen,TX,76541,",
  '88323,88311,,"5"" bin",,no,,TRUE,,,,99 Industrial,Killeen,TX,76541,plain note'
].join("\n");

function db(): D1Database {
  return (env as unknown as { CUSTOMER_DB: D1Database }).CUSTOMER_DB;
}

describe("snapshot export → reimport round-trip (TOG-8887)", () => {
  beforeAll(async () => {
    await ensureD1TestTables();
  });

  it("pins the boolean spelling matrix at the parser level", () => {
    // Arrange / Act / Assert — every spelling the seed files use, plus the
    // empty-cell divergence: Enabled/ExtrasAllowed default true (TOG-6542),
    // OnCall/GPSLocked default false.
    for (const s of ["true", "TRUE", "True", "1", "yes", "YES", " Yes "]) {
      expect(parseBool(s)).toBe(true);
      expect(parseBoolDefaultTrue(s)).toBe(true);
    }
    for (const s of ["false", "FALSE", "0", "no", "NO", " No "]) {
      expect(parseBool(s)).toBe(false);
      expect(parseBoolDefaultTrue(s)).toBe(false);
    }
    expect(parseBool("")).toBe(false);
    expect(parseBoolDefaultTrue("")).toBe(true);
  });

  it("customer export re-imports cleanly: row count + checksum over spellings, quoting, unicode", async () => {
    // Act
    const { textA } = await roundTrip(SPECS.customer, CUSTOMER_SEED, 12);

    // Assert — spot checks on the canonicalized export A: CRLF converged to
    // LF, alternate spellings rendered true/false, empty Enabled defaulted
    // true, stray inch-mark quoted, unicode intact.
    expect(textA).not.toContain("\r");
    expect(textA).toContain('"Acme, Inc."');
    expect(textA).toContain('"say ""hi"", ok"');
    expect(textA).toContain('"line1\nline2"');
    expect(textA).toContain("Café Münchën ☃ 日本語 🎉");
    expect(textA).toContain('"5"" widget"');
    const lines = await logicalLines(textA);
    const rows = parseBusinessRows(SPECS.customer, lines);
    const byId = new Map(
      rows.map((r) => [r.customerId as number, r.enabled as boolean])
    );
    expect(byId.get(88101)).toBe(true);
    expect(byId.get(88103)).toBe(true); // seeded `1`
    expect(byId.get(88104)).toBe(true); // seeded `yes`
    expect(byId.get(88108)).toBe(false); // seeded `0`
    expect(byId.get(88110)).toBe(false); // seeded `NO`
    expect(byId.get(88111)).toBe(true); // seeded empty → default true
    // Assert — all seeded ids present (upsert keyed on customer_id).
    expect([...byId.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => 88101 + i)
    );
  });

  it("address export re-imports cleanly, with customer FK parents resolved", async () => {
    // Arrange — parents first (D1 enforces the FK chain unconditionally).
    const parents = await postImport(
      SPECS.customer.importPath,
      ADDRESS_PARENTS
    );
    expect(parents.status).toBe(200);

    // Act
    const { textB } = await roundTrip(SPECS.address, ADDRESS_SEED, 4);

    // Assert — spot checks: quoted comma + escaped quotes, stray inch-mark,
    // multiline unicode address, empty ExtrasAllowed defaulted true.
    expect(textB).toContain('"12 Main St, Apt ""4B"""');
    expect(textB).toContain('"5"" alley"');
    expect(textB).toContain("日本店 2号店\n二階");
    const lines = await logicalLines(textB);
    const rows = parseBusinessRows(SPECS.address, lines);
    const byId = new Map(rows.map((r) => [r.pickupAddressId as number, r]));
    expect(
      (byId.get(88212)!.extrasAllowed as boolean),
      "empty ExtrasAllowed defaults true"
    ).toBe(true);
    expect(byId.get(88213)!.extrasAllowed as boolean).toBe(false);
    expect(byId.get(88214)!.enabled as boolean).toBe(true);
    // Assert — FK parents still joined: every address points at a live customer.
    for (const id of [88211, 88212, 88213, 88214]) {
      const row = await db()
        .prepare(
          "SELECT c.customer_id FROM address_snapshot a JOIN customer_snapshot c " +
            "ON c.customer_id = a.customer_id WHERE a.pickup_address_id = ?"
        )
        .bind(id)
        .first<{ customer_id: number }>();
      expect(row?.customer_id).toBeGreaterThan(0);
    }
    expect(byId.get(88211)!.customerId).toBe(88201);
  });

  it("container export re-imports cleanly, short upstream shape survives the full-width export", async () => {
    // Arrange — customer → address parents in FK order.
    const pc = await postImport(
      SPECS.customer.importPath,
      CONTAINER_PARENTS_CUSTOMER
    );
    expect(pc.status).toBe(200);
    const pa = await postImport(
      SPECS.address.importPath,
      CONTAINER_PARENTS_ADDRESS
    );
    expect(pa.status).toBe(200);

    // Act
    const { textA, textB } = await roundTrip(
      SPECS.container,
      CONTAINER_SEED,
      3
    );

    // Assert — the 16-column seed came back as the full 29-column export
    // (UD-*/service-code columns present, empty), and survives the reimport.
    const header = (await logicalLines(textA))[0]!;
    expect(header.split(",")).toHaveLength(29);
    expect(header).toContain("UD-Material_Stream-UD");
    expect(textB).toContain('"SN-1, ""A"""');
    expect(textB).toContain('"99 Industrial, Bldg ""C"""');
    expect(textB).toContain('"Café ☃\nsecond line"');
    expect(textB).toContain('"5"" bin"');
    const rows = parseBusinessRows(SPECS.container, await logicalLines(textB));
    const byId = new Map(rows.map((r) => [r.containerId as number, r]));
    expect(byId.get(88321)!.onCall as boolean).toBe(true); // seeded `yes`
    expect(byId.get(88321)!.gpsLocked as boolean).toBe(true); // seeded `1`
    expect(byId.get(88322)!.onCall as boolean).toBe(false); // seeded empty
    expect(byId.get(88322)!.gpsLocked as boolean).toBe(false); // seeded empty
    expect(byId.get(88323)!.enabled as boolean).toBe(true); // seeded empty
    expect(byId.get(88321)!.udMaterialStreamUd as string | null).toBeNull();
  });
});
