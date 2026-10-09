/**
 * Streaming D1 → CSV download for the three snapshot tables
 * (`GET ...-snapshot/export`, TOG-8361 / gap G5).
 *
 * The snapshot list routes return paginated JSON; nothing served the raw CSV
 * back out, so `Content-Disposition` filename and download-streaming behaviour
 * were never pinned anywhere. These helpers close that gap: each export reads
 * its table in keyset pages (`WHERE pk > ? ORDER BY pk LIMIT ?`) and yields
 * one CSV chunk per page, so peak memory is a single page no matter how large
 * the table is. D1 `all()` paginates server-side; at no point is the full
 * table (or the full CSV) buffered.
 *
 * Table/column names are interpolated into SQL from the internal spec
 * constants below — never from client input (same rule as `tableSql.ts`).
 * The export is unfiltered by design: the list routes already serve filtered
 * reads, and rebuilding their WHERE/bind correspondence here would duplicate
 * the exact logic `test/snapshotRoutes.test.ts` exists to pin in one place.
 *
 * A D1 failure mid-stream errors the stream after the 200 headers are sent,
 * so the client sees a truncated download. That matches the existing sync
 * path (which streams the upstream body the same way) — fail the run loudly
 * in logs rather than buffering the table to pre-validate it.
 */

/**
 * Conditional reads (TOG-8879): every export also answers `If-None-Match`
 * with `304 Not Modified` and an empty body. The ETag is a content hash over
 * the exact response bytes (header line plus every row line), so it is stable
 * for identical content and changes on any cell edit.
 *
 * `crypto.subtle.digest` is one-shot — hashing with it would buffer the whole
 * table, defeating the streaming guarantee above. The tag is therefore an
 * incremental FNV-1a 64 over the UTF-8 bytes, computed in a first keyset-paged
 * pass (one page in memory at a time); the body then streams in a second
 * pass. An export costs twice the D1 reads of an unconditioned one; every
 * read still carries a LIMIT and no OFFSET. A 64-bit collision would serve a
 * stale 304, at ~2^-64 per comparison — a re-download is the only cost, not
 * a correctness boundary worth a vendored incremental SHA-256.
 */

import {
  CSV_SPREADSHEET_ENCODING,
  CSV_SPREADSHEET_ENCODING_HEADER,
  escapeCsvCell
} from "../csvSpreadsheet";

export { escapeCsvCell } from "../csvSpreadsheet";

/** One CSV column: the D1 column, its header label, and boolean rendering. */
export type SnapshotExportColumn = {
  /** D1 column, selected verbatim into the CSV, in order. */
  db: string;
  /**
   * Header label. Routeware PascalCase matches import's `cell()` lookups;
   * `synced_at` stays lowercase because import ignores this Worker metadata.
   * Compatible headers do not bypass HTTP import's control-character policy:
   * report-origin control content needs the in-code archive restore path.
   */
  header: string;
  /** Render 0/1 as `false`/`true`, the canonical export spelling. */
  boolean?: boolean;
};

export type SnapshotExportTable = "customer" | "address" | "container";

export type SnapshotExportSpec = {
  /** D1 table. Internal constant only — never client input. */
  table: "customer_snapshot" | "address_snapshot" | "container_snapshot";
  /** Keyset cursor column (the table's integer primary key). */
  pk: string;
  /** `Content-Disposition` filename for the download. */
  filename: string;
  columns: SnapshotExportColumn[];
};

/**
 * Rows per D1 page. 500 keeps every page far under D1's 100-bind /
 * 100 KB-per-statement ceilings (the widest table here is 29 columns) while
 * a full-table export stays inside the ~1000-op per-invocation budget for
 * today's row counts (see CUSTOMER_SNAPSHOT.md § batch sizing).
 */
export const SNAPSHOT_EXPORT_PAGE_SIZE = 500;

export const CUSTOMER_SNAPSHOT_EXPORT: SnapshotExportSpec = {
  table: "customer_snapshot",
  pk: "customer_id",
  filename: "customer-snapshot.csv",
  columns: [
    { db: "customer_id", header: "CustomerID" },
    { db: "customer_type_id", header: "CustomerTypeID" },
    { db: "company_name", header: "CompanyName" },
    { db: "first_name", header: "FirstName" },
    { db: "middle_initial", header: "MiddleInitial" },
    { db: "last_name", header: "LastName" },
    { db: "name_suffix", header: "NameSuffix" },
    { db: "customer_number", header: "CustomerNumber" },
    { db: "sub_customer_number", header: "SubCustomerNumber" },
    { db: "phone1", header: "Phone1" },
    { db: "phone2", header: "Phone2" },
    { db: "comments", header: "Comments" },
    { db: "enabled", header: "Enabled", boolean: true },
    { db: "synced_at", header: "synced_at" }
  ]
};

export const ADDRESS_SNAPSHOT_EXPORT: SnapshotExportSpec = {
  table: "address_snapshot",
  pk: "pickup_address_id",
  filename: "address-snapshot.csv",
  columns: [
    { db: "pickup_address_id", header: "PickupAddressID" },
    { db: "customer_id", header: "CustomerID" },
    { db: "route_id", header: "RouteID" },
    { db: "address", header: "Address" },
    { db: "city", header: "City" },
    { db: "state", header: "State" },
    { db: "zip", header: "Zip" },
    { db: "franchise_id", header: "FranchiseID" },
    { db: "comments", header: "Comments" },
    { db: "extras_allowed", header: "ExtrasAllowed", boolean: true },
    { db: "enabled", header: "Enabled", boolean: true },
    { db: "driver_note", header: "DriverNote" },
    { db: "latitude", header: "Latitude" },
    { db: "longitude", header: "Longitude" },
    { db: "last_audit_date", header: "Last_Audit_Date" },
    { db: "synced_at", header: "synced_at" }
  ]
};

export const CONTAINER_SNAPSHOT_EXPORT: SnapshotExportSpec = {
  table: "container_snapshot",
  pk: "container_id",
  filename: "container-snapshot.csv",
  columns: [
    { db: "container_id", header: "ContainerID" },
    { db: "pickup_address_id", header: "PickupAddressID" },
    { db: "container_type_id", header: "ContainerTypeID" },
    { db: "serial_number", header: "SerialNumber" },
    { db: "rfid", header: "RFID" },
    { db: "oncall", header: "OnCall", boolean: true },
    { db: "event_code", header: "EventCode" },
    { db: "gps_locked", header: "GPSLocked", boolean: true },
    { db: "latitude", header: "Latitude" },
    { db: "longitude", header: "Longitude" },
    { db: "enabled", header: "Enabled", boolean: true },
    { db: "location_address", header: "Address" },
    { db: "city", header: "City" },
    { db: "state", header: "State" },
    { db: "zip", header: "Zip" },
    { db: "container_note", header: "ContainerNote" },
    { db: "ud_cost_share_ud", header: "UD-Cost_Share-UD" },
    { db: "ud_enclosure_doors_ud", header: "UD-Enclosure_Doors-UD" },
    {
      db: "ud_last_compactor_inspection_ud",
      header: "UD-Last_Compactor_Inspection-UD"
    },
    {
      db: "ud_last_enclosure_inspection_ud",
      header: "UD-Last_Enclosure_Inspection-UD"
    },
    { db: "ud_material_stream_ud", header: "UD-Material_Stream-UD" },
    { db: "color", header: "Color" },
    { db: "service_code_type", header: "ServiceCodeType" },
    { db: "service_code_input", header: "ServiceCode_input" },
    { db: "service_code", header: "ServiceCode" },
    { db: "service_date", header: "ServiceDate" },
    { db: "route_ids", header: "RouteIDs" },
    { db: "frequency_ids", header: "FrequencyIDs" },
    { db: "synced_at", header: "synced_at" }
  ]
};

export function snapshotExportSpec(table: SnapshotExportTable): SnapshotExportSpec {
  switch (table) {
    case "customer":
      return CUSTOMER_SNAPSHOT_EXPORT;
    case "address":
      return ADDRESS_SNAPSHOT_EXPORT;
    case "container":
      return CONTAINER_SNAPSHOT_EXPORT;
  }
}

function formatCell(col: SnapshotExportColumn, value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (col.boolean) {
    // D1 stores 0/1 integers; accept the string/boolean spellings too so a
    // re-imported export renders identically to the canonical one.
    return value === 1 || value === true || value === "1" || value === "true"
      ? "true"
      : "false";
  }
  return String(value);
}

/** One D1 row → one CSV line (no trailing newline). */
export function encodeSnapshotRow(
  spec: SnapshotExportSpec,
  row: Record<string, unknown>
): string {
  const cells = spec.columns.map((c) => escapeCsvCell(formatCell(c, row[c.db])));
  // Every snapshot spec ends in synced_at; the marker goes just before it.
  cells.splice(cells.length - 1, 0, CSV_SPREADSHEET_ENCODING);
  return cells.join(",");
}

export function snapshotExportHeaderLine(spec: SnapshotExportSpec): string {
  const headers = spec.columns.map((c) => c.header);
  headers.splice(headers.length - 1, 0, CSV_SPREADSHEET_ENCODING_HEADER);
  return headers.join(",");
}

export type SnapshotExportPage = {
  rows: Record<string, unknown>[];
  /** Cursor for the next page (`after`), or the input cursor when empty. */
  last: number | null;
};

/**
 * One keyset page. `after === null` is the first page (no WHERE — a
 * `pk > -1` predicate would silently drop a zero/negative key); later pages
 * resume strictly after the previous page's last key, so concurrent inserts
 * with higher keys are picked up and no row is read twice.
 */
export async function readSnapshotExportPage(
  db: D1Database,
  spec: SnapshotExportSpec,
  after: number | null,
  limit: number = SNAPSHOT_EXPORT_PAGE_SIZE
): Promise<SnapshotExportPage> {
  const cols = spec.columns.map((c) => c.db).join(", ");
  const { results } =
    after === null
      ? await db
          .prepare(`SELECT ${cols} FROM ${spec.table} ORDER BY ${spec.pk} LIMIT ?`)
          .bind(limit)
          .all<Record<string, unknown>>()
      : await db
          .prepare(
            `SELECT ${cols} FROM ${spec.table} WHERE ${spec.pk} > ? ORDER BY ${spec.pk} LIMIT ?`
          )
          .bind(after, limit)
          .all<Record<string, unknown>>();
  const rows = results ?? [];
  return {
    rows,
    last: rows.length > 0 ? (rows[rows.length - 1]?.[spec.pk] as number) : after
  };
}

/**
 * The table as a byte stream: header line first, then one chunk per D1 page.
 * Exactly one page is held in memory at a time; an empty table yields the
 * header alone. Errors reject the stream (see the module note on truncation).
 */
export function streamSnapshotCsv(
  db: D1Database,
  spec: SnapshotExportSpec,
  pageSize: number = SNAPSHOT_EXPORT_PAGE_SIZE
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let pending = `${snapshotExportHeaderLine(spec)}\n`;
  let after: number | null = null;
  let exhausted = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (pending === "" && !exhausted) {
        const page = await readSnapshotExportPage(db, spec, after, pageSize);
        if (page.rows.length === 0) {
          exhausted = true;
          break;
        }
        after = page.last;
        pending = page.rows.map((r) => encodeSnapshotRow(spec, r)).join("\n") + "\n";
      }
      if (pending === "") {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(pending));
      pending = "";
    }
  });
}

/**
 * Incremental FNV-1a 64 hasher: `crypto.subtle.digest` is one-shot and would
 * force buffering the table, so the ETag pass feeds it line by line instead.
 * Constants are the FNV-1a 64 offset basis + prime (unit-tested against the
 * spec vectors: `""` → `cbf29ce484222325`).
 */
function createFnv1a64() {
  let h = 0xcbf29ce484222325n;
  return {
    feed(bytes: Uint8Array) {
      for (const b of bytes) {
        h ^= BigInt(b);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
      }
    },
    hex(): string {
      return h.toString(16).padStart(16, "0");
    }
  };
}

const snapshotEtagEncoder = new TextEncoder();

/**
 * Content-hash ETag for an export (TOG-8879): FNV-1a 64 over the exact
 * response bytes (header line plus one line per row), Tag'd so the form is
 * greppable (`"fnv64-<hex>"`, quoted — same quoting as the data-entity
 * ETags in `src/lib/dataEntityHandlers.ts`).
 *
 * One keyset-paged pass (one page in memory at a time); row encoding is the
 * same `encodeSnapshotRow` the streaming body uses, so the hash is over
 * byte-identical lines.
 */
export async function snapshotExportEtag(
  db: D1Database,
  spec: SnapshotExportSpec,
  pageSize: number = SNAPSHOT_EXPORT_PAGE_SIZE
): Promise<string> {
  const hasher = createFnv1a64();
  const feed = (s: string) => hasher.feed(snapshotEtagEncoder.encode(s));
  feed(`${snapshotExportHeaderLine(spec)}\n`);
  let after: number | null = null;
  for (;;) {
    const page = await readSnapshotExportPage(db, spec, after, pageSize);
    if (page.rows.length === 0) break;
    after = page.last;
    for (const row of page.rows) {
      feed(`${encodeSnapshotRow(spec, row)}\n`);
    }
  }
  return `"fnv64-${hasher.hex()}"`;
}

/**
 * RFC 7232 `If-None-Match` against one opaque ETag token: a comma-separated
 * token list or `*`. Tokens compare exactly after stripping the weak prefix
 * and surrounding quotes (same normalisation as `dataEntityHandlers.ts` —
 * a substring match here could serve a false 304 for a stale copy).
 */
export function matchesSnapshotIfNoneMatch(
  header: string | null | undefined,
  etag: string
): boolean {
  if (!header) return false;
  const norm = (t: string) =>
    t.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
  const want = norm(etag);
  return header
    .split(",")
    .map(norm)
    .some((t) => t === "*" || t === want);
}

/**
 * `200 text/csv` with the download disposition and a content-hash `ETag`;
 * `304` with an empty body when `ifNoneMatch` carries the current tag.
 * The filename is a fixed per-table constant (never client input), so no
 * sanitisation is needed. The ETag pass doubles D1 reads (still LIMIT-paged,
 * never OFFSET) — acceptable so that conditional re-downloads can skip the
 * body entirely.
 */
export async function snapshotCsvResponse(
  db: D1Database,
  spec: SnapshotExportSpec,
  ifNoneMatch?: string | null
): Promise<Response> {
  const etag = await snapshotExportEtag(db, spec);
  const headers = {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${spec.filename}"`,
    ETag: etag
  };
  if (matchesSnapshotIfNoneMatch(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(streamSnapshotCsv(db, spec), { status: 200, headers });
}
