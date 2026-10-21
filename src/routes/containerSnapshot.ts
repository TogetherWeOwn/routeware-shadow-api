import { createRoute, z } from "@hono/zod-openapi";
import { containerRowExample, containerExportExample } from "./payloadExamples";
import { snapshotSearchQuery } from "../lib/snapshotSearchQuery";
import {
  runContainerSnapshotSync,
  syncContainerSnapshotFromStream
} from "../lib/d1SnapshotSync";
import { parseRunIdHeader } from "../lib/snapshot/orchestration";
// Guard values come from the deep module, not the facade: `test/snapshotRoutes.test.ts`
// mocks `../lib/d1SnapshotSync` with only the six sync functions, so any other
// facade import throws at module scope there. The deep module is never mocked.
import {
  InvalidSnapshotCsvError,
  SNAPSHOT_IMPORT_MAX_BYTES,
  isSnapshotTooLarge
} from "../lib/snapshot/streamSync";
import {
  CONTAINER_SNAPSHOT_EXPORT,
  readSnapshotExportPageSize,
  snapshotCsvResponse
} from "../lib/snapshot/export";
import { problemJsonResponse, problemType } from "../lib/problem";
import {
  createRouteModule,
  dryRunQuery,
  foreignKeyProblem,
  isDryRunRequested,
  requireSnapshotAuth,
  requireSnapshotSecret,
  rejectRepeatedIncludeTotal,
  snapshotListResponse,
  parsePositiveIdParam,
  snapshotWriteResultExample
} from "./shared";
import {
  mapSnapshotImportError,
  rejectOversizedSnapshotImport,
  rejectUnsupportedSnapshotImportContentType
} from "./snapshotImport";

/** D1 container snapshot: reads plus the CSV sync/import writers. */
export const containerSnapshotRoutes = createRouteModule();

const containerSnapshotListRoute = createRoute({
  method: "get",
  path: "/api/v1/container-snapshot",
  tags: ["container-snapshot"],
  summary: "List container snapshot rows (D1)",
  description:
    "Routeware containers link to an address via `pickup_address_id` (and thus to a customer). Filter by `customerId` (joins through address), `pickupAddressId`, or `containerId`, text `q` on `location_address` or `serial_number`, and `enabled`. Pass `cursor` (the previous page's `nextCursor`) instead of `offset` to page deep result sets by primary-key seek instead of a scanned OFFSET.",
  request: {
    query: z.object({
      customerId: z.coerce.number().int().optional().openapi({ example: 345734 }),
      pickupAddressId: z.coerce.number().int().optional().openapi({ example: 10 }),
      containerId: z.coerce.number().int().optional().openapi({ example: 100 }),
      q: snapshotSearchQuery.optional().describe("Substring on location or serial (case-insensitive; maximum 100 Unicode code points)").openapi({ example: "C-100" }),
      enabled: z.enum(["true", "false", "any"]).optional().default("any").openapi({ example: "true" }),
      limit: z.coerce.number().int().min(1).max(500).default(50).openapi({ example: 50 }),
      offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
      cursor: z.coerce
        .number()
        .int()
        .optional()
        .describe("Last container_id from the previous page's nextCursor; takes precedence over offset")
        .openapi({ example: 99 }),
      includeTotal: z
        .enum(["true", "false"])
        .optional()
        .default("true")
        .describe(
          "Count opt-out: \"false\" skips the COUNT query and returns total null (deliberately not computed) with the same rows and nextCursor"
        )
        .openapi({ example: "false" })
    })
  },
  responses: {
    200: {
      description: "Rows and total",
      content: {
        "application/json": {
          schema: snapshotListResponse,
          example: { rows: [containerRowExample], total: 1, nextCursor: null }
        }
      }
    },
    400: {
      description:
        "Invalid query (application/problem+json). The zod validator rejects `q` longer than 100 Unicode code points, an out-of-range `limit`/`offset`, or an unknown `enabled` value before any D1 query runs."
    }
  }
});

containerSnapshotRoutes.openapi(containerSnapshotListRoute, async (c) => {
  const repeated = rejectRepeatedIncludeTotal(c);
  if (repeated) return repeated;
  const p = c.req.valid("query");
  const db = c.env.CUSTOMER_DB;
  const fromJoin =
    p.customerId !== undefined
      ? "FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id"
      : "FROM container_snapshot c";
  const where: string[] = ["1 = 1"];
  const binds: unknown[] = [];
  if (p.customerId !== undefined) {
    where.push("a.customer_id = ?");
    binds.push(p.customerId);
  }
  if (p.pickupAddressId !== undefined) {
    where.push("c.pickup_address_id = ?");
    binds.push(p.pickupAddressId);
  }
  if (p.containerId !== undefined) {
    where.push("c.container_id = ?");
    binds.push(p.containerId);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    where.push(
      "(instr(lower(coalesce(c.location_address, '')), lower(?)) > 0 OR instr(lower(coalesce(c.serial_number, '')), lower(?)) > 0)"
    );
    const qv = p.q.trim();
    binds.push(qv, qv);
  }
  if (p.enabled === "true") {
    where.push("c.enabled = 1");
  }
  if (p.enabled === "false") {
    where.push("c.enabled = 0");
  }
  if (p.cursor !== undefined) {
    where.push("c.container_id > ?");
    binds.push(p.cursor);
  }
  const whereSql = where.join(" AND ");
  // Count-free page: zero COUNT statements. `total: null` means the count was
  // deliberately not computed, not that the page is empty.
  let total: number | null;
  if (p.includeTotal === "false") {
    total = null;
  } else {
    const totalRow = await db
      .prepare(
        `SELECT COUNT(*) as n ${fromJoin} WHERE ${whereSql}`
      )
      .bind(...binds)
      .first<{ n: number }>();
    total = totalRow?.n ?? 0;
  }
  const pageSql =
    p.cursor !== undefined
      ? "ORDER BY c.container_id LIMIT ?"
      : "ORDER BY c.container_id LIMIT ? OFFSET ?";
  const pageBinds = p.cursor !== undefined ? [p.limit] : [p.limit, p.offset];
  const { results } = await db
    .prepare(
      `SELECT c.container_id, c.pickup_address_id, c.container_type_id, c.serial_number, c.rfid, c.oncall, c.event_code,
              c.gps_locked, c.latitude, c.longitude, c.enabled, c.location_address, c.city, c.state, c.zip, c.container_note,
              c.ud_cost_share_ud, c.ud_enclosure_doors_ud, c.ud_last_compactor_inspection_ud, c.ud_last_enclosure_inspection_ud,
              c.ud_material_stream_ud, c.color, c.service_code_type, c.service_code_input, c.service_code, c.service_date, c.route_ids, c.frequency_ids, c.synced_at
       ${fromJoin} WHERE ${whereSql} ${pageSql}`
    )
    .bind(...binds, ...pageBinds)
    .all();
  const rows = results ?? [];
  const nextCursor =
    rows.length === p.limit ? Number((rows[rows.length - 1] as Record<string, unknown>).container_id) : null;
  return c.json({ rows, total, nextCursor });
});

const containerSnapshotExportRoute = createRoute({
  method: "get",
  path: "/api/v1/container-snapshot/export",
  tags: ["container-snapshot"],
  summary: "Download container snapshot as CSV",
  description:
    "Streams every `container_snapshot` row as CSV (`Content-Disposition: attachment`, filename `container-snapshot.csv`) in `container_id` order. Reads in keyset pages so a full-table export never buffers the table in memory. Emits a content-hash `ETag`; replay it as `If-None-Match` for a `304` with an empty body. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`.",
  responses: {
    200: {
      description: "CSV download (header line plus one line per row)",
      content: { "text/csv": { schema: z.string(), example: containerExportExample } }
    },
    304: { description: "Not modified (If-None-Match carries the current ETag)" },
    401: { description: "Unauthorized" }
  }
});

// Registered BEFORE the by-id route below: Hono matches in registration
// order, so a param route registered first would swallow `/export` as an id.
// (Pinned by `test/snapshotCsvExport.test.ts`.)
containerSnapshotRoutes.openapi(containerSnapshotExportRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  return snapshotCsvResponse(
    c.env.CUSTOMER_DB,
    CONTAINER_SNAPSHOT_EXPORT,
    c.req.header("if-none-match"),
    readSnapshotExportPageSize(c.env)
  );
});

const containerSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/container-snapshot/{containerId}",
  tags: ["container-snapshot"],
  summary: "Get one container snapshot row",
  description:
    "Reads one row from the daily snapshot DB by `containerId`. Bearer-gated like every `/api/v1/*` route except `GET /api/v1/health`. Returns 404 when no row exists for that id.",
  request: {
    params: z.object({ containerId: z.coerce.number().int().openapi({ example: 100 }) })
  },
  responses: {
    200: {
      description: "Row",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
          example: containerRowExample
        }
      }
    },
    400: {
      description: "Invalid id (application/problem+json)"
    },
    404: {
      description: "Not found (application/problem+json)"
    }
  }
});

containerSnapshotRoutes.openapi(containerSnapshotByIdRoute, async (c) => {
  const id = parsePositiveIdParam(c.req.param("containerId"));
  if (id === null) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "containerId must be a positive integer. See docs/PROBLEMS.md#bad-request.",
      instance: `${new URL(c.req.url).pathname}#containerId=${c.req.param("containerId")}`
    });
  }
  const row = await c.env.CUSTOMER_DB.prepare(
    `SELECT container_id, pickup_address_id, container_type_id, serial_number, rfid, oncall, event_code, gps_locked,
            latitude, longitude, enabled, location_address, city, state, zip, container_note, ud_cost_share_ud,
            ud_enclosure_doors_ud, ud_last_compactor_inspection_ud, ud_last_enclosure_inspection_ud, ud_material_stream_ud,
            color, service_code_type, service_code_input, service_code, service_date, route_ids, frequency_ids, synced_at
     FROM container_snapshot WHERE container_id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) {
    return problemJsonResponse({
      type: problemType("not-found", c.env),
      title: "Not Found",
      status: 404,
      detail: `No container row for container_id=${id}. See docs/PROBLEMS.md#not-found.`,
      instance: `${new URL(c.req.url).pathname}#container_id=${id}`
    });
  }
  return c.json(row, 200);
});

const containerSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/container-snapshot/sync",
  tags: ["container-snapshot"],
  summary: "Fetch container report CSV and upsert D1",
  description:
    "Same bearer. Requires `CONTAINER_REPORT_EXPORT_PATH` or `CONTAINER_REPORT_QUERY_ID`. Address rows for each `pickup_address_id` should exist in D1 first. Pass `?dryRun=true` to run the full parse/validate path, return the counts that WOULD apply, and write nothing (no D1, no R2).",
  request: {
    query: dryRunQuery
  },
  responses: {
    200: {
      description: "Result",
      content: {
        "application/json": {
          schema: z.object({
            upserted: z.number().int(),
            rowCount: z.number().int(),
            deleted: z.number().int().optional(),
            skipped: z.boolean().optional()
          }),
          example: snapshotWriteResultExample
        }
      }
    },
    401: { description: "Unauthorized" },
    503: { description: "Service Unavailable" }
  }
});

containerSnapshotRoutes.openapi(containerSnapshotSyncRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const misconfigured = requireSnapshotSecret(c);
  if (misconfigured) return misconfigured;
  if (!c.env.CONTAINER_REPORT_EXPORT_PATH?.trim() && !c.env.CONTAINER_REPORT_QUERY_ID?.trim()) {
    return problemJsonResponse({
      type: problemType("misconfigured", c.env),
      title: "Service Unavailable",
      status: 503,
      detail:
        "Set CONTAINER_REPORT_EXPORT_PATH or CONTAINER_REPORT_QUERY_ID (see CUSTOMER_SNAPSHOT.md). See docs/PROBLEMS.md#misconfigured.",
      instance: new URL(c.req.url).pathname
    });
  }
  try {
    // `?dryRun=true` runs the full parse/validate path and returns
    // the would-be counts while writing nothing (no D1, no R2).
    // Forward a valid inbound `x-run-id` so this invocation's
    // lines share the originating run's correlation id. Invalid values are
    // dropped — correlation must never fail a sync.
    const runId = parseRunIdHeader(c.req.header("x-run-id"));
    const r = await runContainerSnapshotSync(c.env, {
      dryRun: isDryRunRequested(c.req.valid("query")),
      ...(runId ? { runId } : {})
    });
    if (!r) {
      return c.json({ upserted: 0, rowCount: 0, skipped: true }, 200);
    }
    return c.json(r, 200);
  } catch (e) {
    const fk = foreignKeyProblem(e, c.env);
    if (fk) return fk;
    throw e;
  }
});

const containerSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/container-snapshot/import",
  tags: ["container-snapshot"],
  summary: "Import container CSV into D1",
  description: "Raw CSV; `Content-Type: text/csv` or `application/octet-stream`. Bear the same secret. Import or sync **addresses** (and **customers**) first for `pickup_address_id` foreign keys. Pass `?dryRun=true` to validate and return the would-be counts without writing D1.",
  request: {
    query: dryRunQuery,
    body: {
      description: "Routeware Container Details CSV (header + data rows — see example)",
      content: {
        "text/csv": {
          // Plain SchemaObject, not a zod schema: docs-only, no runtime
          // validator is installed (the handler streams the raw body).
          schema: { type: "string" },
          example:
            "ContainerID,PickupAddressID,ContainerTypeID,SerialNumber,RFID,OnCall,EventCode,GPSLocked,Latitude,Longitude,Enabled,Address,City,State,Zip,ContainerNote\n100,10,,SN-100,,false,,false,,,true,1 Main St,Killeen,TX,76541,"
        },
        "application/octet-stream": { schema: { type: "string" } }
      }
    }
  },
  responses: {
    200: {
      description: "Result",
      content: {
        "application/json": {
          schema: z.object({ upserted: z.number().int(), rowCount: z.number().int(), deleted: z.number().int().optional() }),
          example: snapshotWriteResultExample
        }
      }
    },
    401: { description: "Unauthorized" },
    415: { description: "Unsupported Content-Type (application/problem+json)" },
    400: {
      description:
        "Empty body (application/problem+json). Returned when the POST has no request body; post the CSV as the raw request body."
    }
  }
});

containerSnapshotRoutes.openapi(containerSnapshotImportRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const oversized = rejectOversizedSnapshotImport(
    { url: c.req.url, contentLength: c.req.raw.headers.get("content-length") },
    SNAPSHOT_IMPORT_MAX_BYTES,
    c.env
  );
  if (oversized) return oversized;
  const body = c.req.raw.body;
  if (!body) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "POST the CSV as raw body. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.url).pathname
    });
  }
  const unsupportedMediaType = rejectUnsupportedSnapshotImportContentType(
    { url: c.req.url, contentType: c.req.raw.headers.get("content-type") },
    c.env
  );
  if (unsupportedMediaType) return unsupportedMediaType;
  try {
    // No positional batch size: the per-table default in `streamSync` is the
    // right value, and the facade mock in `test/snapshotRoutes.test.ts` does
    // not forward extra args anyway.
    const r = await syncContainerSnapshotFromStream(c.env.CUSTOMER_DB, body, undefined, {
      requireDataRows: true,
      rejectControlCharacters: true,
      maxBytes: SNAPSHOT_IMPORT_MAX_BYTES,
      // `?dryRun=true` validates and counts without writing D1.
      dryRun: isDryRunRequested(c.req.valid("query"))
    });
    return c.json(r, 200);
  } catch (e) {
    const mapped = mapSnapshotImportError(
      c.req.url,
      e,
      isSnapshotTooLarge,
      (err) => err instanceof InvalidSnapshotCsvError,
      c.env
    );
    if (mapped) return mapped;
    const fk = foreignKeyProblem(e, c.env);
    if (fk) return fk;
    throw e;
  }
});
