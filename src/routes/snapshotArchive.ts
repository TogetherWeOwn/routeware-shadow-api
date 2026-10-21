import { createRoute, z } from "@hono/zod-openapi";
import { problemJsonResponse, problemType } from "../lib/problem";
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
  // Both passes share the report-stream stall bound: a hung R2 read fails as
  // a 502 timeout instead of holding the Worker.
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
