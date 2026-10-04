import { createRoute, z } from "@hono/zod-openapi";
import {
  runContainerSnapshotSync,
  syncContainerSnapshotFromStream
} from "../lib/d1SnapshotSync";
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
  snapshotListResponse,
  parsePositiveIdParam,
  type SnapshotAuthContext
} from "./shared";
import {
  mapSnapshotImportError,
  rejectOversizedSnapshotImport
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
      customerId: z.coerce.number().int().optional(),
      pickupAddressId: z.coerce.number().int().optional(),
      containerId: z.coerce.number().int().optional(),
      q: z.string().optional().describe("Substring on location or serial (case-insensitive)"),
      enabled: z.enum(["true", "false", "any"]).optional().default("any"),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      cursor: z.coerce
        .number()
        .int()
        .optional()
        .describe("Last container_id from the previous page's nextCursor; takes precedence over offset")
    })
  },
  responses: {
    200: {
      description: "Rows and total",
      content: { "application/json": { schema: snapshotListResponse } }
    },
    400: {
      description:
        "Invalid query (application/problem+json). The zod validator rejects an out-of-range `limit`/`offset` or an unknown `enabled` value before any D1 query runs."
    }
  }
});

containerSnapshotRoutes.openapi(containerSnapshotListRoute, async (c) => {
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
  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) as n ${fromJoin} WHERE ${whereSql}`
    )
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
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
      content: { "text/csv": { schema: z.string() } }
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
    c.req.header("if-none-match")
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
    params: z.object({ containerId: z.coerce.number().int() })
  },
  responses: {
    200: {
      description: "Row",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }
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
          })
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
    // TOG-9203: `?dryRun=true` runs the full parse/validate path and returns
    // the would-be counts while writing nothing (no D1, no R2).
    const r = await runContainerSnapshotSync(c.env, {
      dryRun: isDryRunRequested(c.req.valid("query"))
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
  description: "Raw CSV. Bear same secret. Import or sync **addresses** (and **customers**) first for `pickup_address_id` foreign keys. Pass `?dryRun=true` to validate and return the would-be counts without writing D1.",
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
        }
      }
    }
  },
  responses: {
    200: {
      description: "Result",
      content: {
        "application/json": {
          schema: z.object({ upserted: z.number().int(), rowCount: z.number().int(), deleted: z.number().int().optional() })
        }
      }
    },
    401: { description: "Unauthorized" },
    400: {
      description:
        "Empty body (application/problem+json). Returned when the POST has no request body; post the CSV as the raw request body."
    }
  }
});

/**
 * Shared container-import core: the canonical `/import` route and its
 * trailing-slash alias run the same streaming implementation. Plain-data
 * arguments (never the framework context type) so both `createRoute`
 * registrations — which infer different context types — can share it. Returns
 * a `Response` for rejections, or the sync result for the caller to `c.json`.
 */
async function runContainerSnapshotImport(args: {
  auth: SnapshotAuthContext;
  raw: Request;
  url: string;
  dryRun: boolean;
  env: Env;
}): Promise<Response | Awaited<ReturnType<typeof syncContainerSnapshotFromStream>>> {
  const denied = requireSnapshotAuth(args.auth);
  if (denied) return denied;
  const oversized = rejectOversizedSnapshotImport(
    { url: args.url, contentLength: args.raw.headers.get("content-length") },
    SNAPSHOT_IMPORT_MAX_BYTES,
    args.env
  );
  if (oversized) return oversized;
  const body = args.raw.body;
  if (!body) {
    return problemJsonResponse({
      type: problemType("bad-request", args.env),
      title: "Bad Request",
      status: 400,
      detail:
        "POST the CSV as raw body. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(args.url).pathname
    });
  }
  try {
    // No positional batch size: the per-table default in `streamSync` is the
    // right value, and the facade mock in `test/snapshotRoutes.test.ts` does
    // not forward extra args anyway.
    return await syncContainerSnapshotFromStream(args.env.CUSTOMER_DB, body, undefined, {
      requireDataRows: true,
      maxBytes: SNAPSHOT_IMPORT_MAX_BYTES,
      // TOG-9203: `?dryRun=true` validates and counts without writing D1.
      dryRun: args.dryRun
    });
  } catch (e) {
    const mapped = mapSnapshotImportError(
      args.url,
      e,
      isSnapshotTooLarge,
      (err) => err instanceof InvalidSnapshotCsvError,
      args.env
    );
    if (mapped) return mapped;
    const fk = foreignKeyProblem(e, args.env);
    if (fk) return fk;
    throw e;
  }
}

async function handleContainerSnapshotImport(
  c: SnapshotAuthContext & {
    req: { raw: Request; url: string; valid: (scope: "query") => { dryRun?: string } };
    env: Env;
    json: (value: unknown, status: 200) => Response;
  }
): Promise<Response> {
  const out = await runContainerSnapshotImport({
    auth: c,
    raw: c.req.raw,
    url: c.req.url,
    dryRun: isDryRunRequested(c.req.valid("query")),
    env: c.env
  });
  return out instanceof Response ? out : c.json(out, 200);
}

containerSnapshotRoutes.openapi(containerSnapshotImportRoute, (c) =>
  handleContainerSnapshotImport(c)
);

// Trailing-slash alias: same streaming handler and limits. Hono matches paths
// exactly, so without this `/import/` 404s — and, before the body cap, the
// middleware buffered the full export first. Pinned by `test/bodySizeCap.test.ts`.
const containerSnapshotImportSlashRoute = createRoute({
  method: "post",
  path: "/api/v1/container-snapshot/import/",
  tags: ["container-snapshot"],
  summary: "Import container CSV into D1 (trailing-slash alias)",
  description:
    "Trailing-slash alias of `POST /api/v1/container-snapshot/import`: same raw-CSV streaming handler, same bearer secret, same size limits.",
  request: {
    query: dryRunQuery
  },
  responses: {
    200: {
      description: "Result",
      content: {
        "application/json": {
          schema: z.object({ upserted: z.number().int(), rowCount: z.number().int(), deleted: z.number().int().optional() })
        }
      }
    },
    401: { description: "Unauthorized" },
    400: {
      description:
        "Empty body (application/problem+json). Returned when the POST has no request body; post the CSV as raw body."
    }
  }
});

containerSnapshotRoutes.openapi(containerSnapshotImportSlashRoute, (c) =>
  handleContainerSnapshotImport(c)
);
