import { createRoute, z } from "@hono/zod-openapi";
import { problemJsonResponse, problemType } from "../lib/problem";
import {
  listSnapshotArchiveDatesForTable,
  SNAPSHOT_DATE_LIST_SCAN_BUDGET,
  type SnapshotArchiveDateListing
} from "../lib/r2SnapshotArchive";
import {
  measureSpreadsheetSafeCsv,
  spreadsheetSafeCsvStream
} from "../lib/snapshot/archiveReadback";
import { readReportStreamStallTimeoutMs } from "../lib/upstreamTimeout";
import { matchesSnapshotIfNoneMatch } from "../lib/snapshot/export";
import { createRouteModule, requireSnapshotAuth } from "./shared";

/**
 * Privileged R2 archive readback.
 *
 * The sync path archives the raw Routeware CSV to R2 after D1
 * (`src/lib/r2SnapshotArchive.ts`, keys
 * `snapshots/YYYY-MM-DD/{customer|address|container}.csv`) but nothing read
 * it back — recovery needed wrangler CLI tribal knowledge. This route streams
 * the archive back so an operator can compare it with a fresh export. The
 * body is re-encoded with the export's spreadsheet escaping, so opening it in a
 * spreadsheet cannot evaluate an upstream cell; the stored object is unchanged.
 * Gated on `CUSTOMER_SNAPSHOT_SYNC_SECRET` like the other snapshot-secret
 * routes; a missing key is 404 problem+json (an absent archive must stay
 * distinguishable from a failed one).
 */
export const snapshotArchiveRoutes = createRouteModule();

const snapshotArchiveRoute = createRoute({
  method: "get",
  path: "/api/v1/snapshots/{table}/{date}",
  operationId: "getSnapshotArchive",
  "x-access": "sync-secret",
  "x-effect": "local-read",
  tags: ["data-snapshot"],
  summary: "Download an archived snapshot CSV from R2",
  description:
    "Streams the Routeware CSV archived to R2 by a previous snapshot sync (`snapshots/YYYY-MM-DD/{customer|address|container}.csv`), re-encoded for spreadsheets: records are split as the importer splits them, blank data records are dropped as its row parsers drop them, and each cell is trimmed and escaped as the export escapes it (a formula-leading cell gets an apostrophe inside quotes; plain numbers are unchanged), and a `_shadow_csv_encoding` column with value `1` follows the archived columns on every row. Rows end in LF. The stored object is not modified. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Returns 404 when no archive exists for that table and date. The ETag is a content hash of the served bytes, and `If-None-Match` with the current tag returns 304. Operators compare the download with a fresh `...-snapshot/export` by business values, not bytes.",
  request: {
    params: z.object({
      table: z.enum(["customer", "address", "container"]).openapi({ example: "customer" }),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("UTC archive date (YYYY-MM-DD)")
        .openapi({ example: "2026-01-01" })
    })
  },
  responses: {
    200: {
      description: "Archive re-encoded for spreadsheets (synthetic customer-report excerpt)",
      content: {
        "text/csv": {
          schema: z.string(),
          example: "CustomerID,CompanyName,Enabled,_shadow_csv_encoding\n345734,ExampleCo,true,1\n"
        }
      }
    },
    304: {
      description: "`If-None-Match` matched the current content ETag; empty body"
    },
    400: {
      description:
        "Invalid table or date (application/problem+json). The zod validator rejects anything outside the `customer|address|container` enum or not shaped `YYYY-MM-DD` before any R2 read runs."
    },
    401: { description: "Unauthorized" },
    404: {
      description:
        "No archive for that table and date, including one deleted during the download (application/problem+json)"
    },
    409: {
      description:
        "The archive was replaced between the two reads of one download (application/problem+json). Retry the download."
    },
    503: {
      description:
        "R2 archive not configured (application/problem+json). The SNAPSHOTS binding is unbound."
    }
  }
});

function archiveNotFound(url: string, table: string, date: string) {
  return problemJsonResponse({
    type: problemType("not-found"),
    title: "Not Found",
    status: 404,
    detail: `No snapshot archive for table=${table} date=${date}. See docs/PROBLEMS.md#not-found.`,
    instance: new URL(url).pathname
  });
}

snapshotArchiveRoutes.openapi(snapshotArchiveRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const { table, date } = c.req.valid("param");
  const bucket = c.env.SNAPSHOTS;
  if (!bucket) {
    return problemJsonResponse({
      type: problemType("misconfigured"),
      title: "Service Unavailable",
      status: 503,
      detail:
        "R2 snapshot archive is not configured (SNAPSHOTS binding unbound). See docs/PROBLEMS.md#misconfigured.",
      instance: new URL(c.req.url).pathname
    });
  }
  // Interpolated from the validated enum + date shape, never raw path text:
  // identical to the writer's key in `src/lib/r2SnapshotArchive.ts`.
  const key = `snapshots/${date}/${table}.csv`;
  const obj = await bucket.get(key);
  if (!obj) {
    return archiveNotFound(c.req.url, table, date);
  }
  // Content-Length and the ETag describe the re-encoded bytes, so the first
  // pass measures them. The second read is conditional on the stored ETag, so
  // a replaced archive cannot be streamed against the first pass's length.
  // Both passes share the report-stream stall bound: a hung measurement fails
  // as a 502; a stall after the 200 headers aborts the download stream.
  const stallTimeoutMs = readReportStreamStallTimeoutMs(c.env);
  const { length, etag } = await measureSpreadsheetSafeCsv(obj.body, { stallTimeoutMs });
  if (matchesSnapshotIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const again = await bucket.get(key, { onlyIf: { etagMatches: obj.etag } });
  if (again === null) {
    return archiveNotFound(c.req.url, table, date);
  }
  if (!("body" in again)) {
    return problemJsonResponse({
      type: problemType("conflict"),
      title: "Conflict",
      status: 409,
      detail: `The snapshot archive for table=${table} date=${date} was replaced during the download. Retry the download. See docs/PROBLEMS.md#conflict.`,
      instance: new URL(c.req.url).pathname
    });
  }
  const headers = new Headers();
  headers.set(
    "content-type",
    obj.httpMetadata?.contentType ?? "text/csv; charset=utf-8"
  );
  headers.set("content-disposition", `attachment; filename="${table}-${date}.csv"`);
  // A plain stream body makes workerd drop a hand-set Content-Length and send
  // chunked, so the re-encoded bytes go through a FixedLengthStream: the header
  // below then reaches the wire, and the runtime rejects any byte-count drift
  // between the measure pass and this stream instead of serving it silently.
  headers.set("content-length", String(length));
  headers.set("etag", etag);
  const { readable, writable } = new FixedLengthStream(length);
  c.executionCtx.waitUntil(
    spreadsheetSafeCsvStream(again.body, { stallTimeoutMs })
      .pipeTo(writable)
      .catch(() => undefined)
  );
  return new Response(readable, { status: 200, headers });
});

/**
 * Archived-date listing: which dates hold an archive for a table, so an
 * authorized agent can browse instead of guessing dates one 404 at a time.
 * Reads the date-manifest sidecars only (hashes/sizes, never row data);
 * the explicit-date download above is unchanged.
 */
const snapshotArchiveDatesRoute = createRoute({
  method: "get",
  path: "/api/v1/snapshots/{table}",
  operationId: "listSnapshotArchiveDates",
  "x-access": "sync-secret",
  "x-effect": "local-read",
  tags: ["data-snapshot"],
  summary: "List archived snapshot dates for a table from R2",
  description:
    "Lists the UTC dates holding an R2 archive for one table, newest-first, from the date-manifest sidecars (`snapshots/YYYY-MM-DD.manifest.json`). Each entry carries the manifest's recorded byte length and sha256 (hashes/sizes only, never row data). `limit` caps the page at 1..366 (default 30); `truncated` is true when possibly more dates exist — the page filled, the 366-manifest scan budget exhausted, or the R2 list truncated. Zero archives is 200 with an empty list, never 404. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. The ETag is a content hash of the served JSON bytes, and `If-None-Match` with the current tag returns 304.",
  request: {
    params: z.object({
      table: z.enum(["customer", "address", "container"]).openapi({ example: "customer" })
    }),
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(SNAPSHOT_DATE_LIST_SCAN_BUDGET)
        .default(30)
        .openapi({ example: 30 })
    })
  },
  responses: {
    200: {
      description: "Archived dates newest-first with manifest hashes/sizes (synthetic excerpt)",
      content: {
        "application/json": {
          schema: z.object({
            table: z.enum(["customer", "address", "container"]),
            dates: z.array(
              z.object({
                date: z.string(),
                bytes: z.number(),
                sha256: z.string()
              })
            ),
            truncated: z.boolean()
          }),
          example: {
            table: "customer",
            dates: [
              {
                date: "2026-09-27",
                bytes: 1234,
                sha256: "9f2c4a7e1b5d83f09f2c4a7e1b5d83f09f2c4a7e1b5d83f09f2c4a7e1b5d83f0"
              }
            ],
            truncated: false
          }
        }
      }
    },
    304: {
      description: "`If-None-Match` matched the current content ETag; empty body"
    },
    400: {
      description:
        "Invalid table or limit (application/problem+json). The zod validator rejects anything outside the `customer|address|container` enum or a non-integer/out-of-range `limit` before any R2 read runs. Unknown query params are ignored."
    },
    401: { description: "Unauthorized" },
    500: {
      description:
        "The date listing is unreadable (application/problem+json): the R2 list or a manifest read failed, or a scanned manifest is not valid JSON or fails manifest validation. Fixed sanitized body — no R2 keys, manifest bytes, or driver text. Re-run the table sync to republish."
    },
    503: {
      description:
        "R2 archive not configured (application/problem+json). The SNAPSHOTS binding is unbound."
    }
  }
});

/**
 * FNV-1a 64 over bytes as a quoted `"fnv64-<hex>"` tag — the same hash family
 * as the date route's content ETag, over the exact served JSON bytes.
 */
const datesEtagEncoder = new TextEncoder();

function snapshotArchiveDatesEtag(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `"fnv64-${h.toString(16).padStart(16, "0")}"`;
}

// Single-segment path: it can never collide with `/{table}/{date}` or a
// future `/{table}/latest`, at any merge order — Hono matches segment counts.
snapshotArchiveRoutes.openapi(snapshotArchiveDatesRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const { table } = c.req.valid("param");
  const { limit } = c.req.valid("query");
  const bucket = c.env.SNAPSHOTS;
  if (!bucket) {
    return problemJsonResponse({
      type: problemType("misconfigured"),
      title: "Service Unavailable",
      status: 503,
      detail:
        "R2 snapshot archive is not configured (SNAPSHOTS binding unbound). See docs/PROBLEMS.md#misconfigured.",
      instance: new URL(c.req.url).pathname
    });
  }
  let listing: SnapshotArchiveDateListing;
  try {
    listing = await listSnapshotArchiveDatesForTable(bucket, table, limit);
  } catch {
    return problemJsonResponse({
      type: problemType("internal"),
      title: "Internal Server Error",
      status: 500,
      detail:
        `Snapshot archive date listing for table=${table} is unreadable. ` +
        "Re-run the table sync to republish it. See docs/PROBLEMS.md#internal.",
      instance: new URL(c.req.url).pathname
    });
  }
  const body = JSON.stringify({ table, dates: listing.dates, truncated: listing.truncated });
  const etag = snapshotArchiveDatesEtag(datesEtagEncoder.encode(body));
  if (matchesSnapshotIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", etag }
  });
});
