import { createRoute, z } from "@hono/zod-openapi";
import {
  runAddressSnapshotSync,
  syncAddressSnapshotFromStream
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
  ADDRESS_SNAPSHOT_EXPORT,
  snapshotCsvResponse
} from "../lib/snapshot/export";
import { problemJsonResponse, problemType } from "../lib/problem";
import {
  createRouteModule,
  foreignKeyProblem,
  requireSnapshotAuth,
  requireSnapshotSecret,
  snapshotListResponse
} from "./shared";
import {
  mapSnapshotImportError,
  rejectOversizedSnapshotImport
} from "./snapshotImport";

/** D1 address snapshot: reads plus the CSV sync/import writers. */
export const addressSnapshotRoutes = createRouteModule();

const addressSnapshotListRoute = createRoute({
  method: "get",
  path: "/api/v1/address-snapshot",
  tags: ["address-snapshot"],
  summary: "List address snapshot rows (D1)",
  description:
    "Routeware addresses (`PickupAddressID` → `CustomerID`). Optional filters: `customerId`, `pickupAddressId`, free-text on street `q`, `enabled`.",
  request: {
    query: z.object({
      customerId: z.coerce.number().int().optional(),
      pickupAddressId: z.coerce.number().int().optional(),
      q: z.string().optional().describe("Address line substring (case-insensitive)"),
      enabled: z.enum(["true", "false", "any"]).optional().default("any"),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0)
    })
  },
  responses: {
    200: {
      description: "Rows and total",
      content: { "application/json": { schema: snapshotListResponse } }
    }
  }
});

addressSnapshotRoutes.openapi(addressSnapshotListRoute, async (c) => {
  const p = c.req.valid("query");
  const db = c.env.CUSTOMER_DB;
  const where: string[] = ["1 = 1"];
  const binds: unknown[] = [];
  if (p.customerId !== undefined) {
    where.push("customer_id = ?");
    binds.push(p.customerId);
  }
  if (p.pickupAddressId !== undefined) {
    where.push("pickup_address_id = ?");
    binds.push(p.pickupAddressId);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    where.push("instr(lower(coalesce(address, '')), lower(?)) > 0");
    binds.push(p.q.trim());
  }
  if (p.enabled === "true") {
    where.push("enabled = 1");
  }
  if (p.enabled === "false") {
    where.push("enabled = 0");
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare(`SELECT COUNT(*) as n FROM address_snapshot WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const { results } = await db
    .prepare(
      `SELECT pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
              extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at
       FROM address_snapshot WHERE ${whereSql} ORDER BY pickup_address_id LIMIT ? OFFSET ?`
    )
    .bind(...binds, p.limit, p.offset)
    .all();
  return c.json({ rows: results ?? [], total });
});

const addressSnapshotExportRoute = createRoute({
  method: "get",
  path: "/api/v1/address-snapshot/export",
  tags: ["address-snapshot"],
  summary: "Download address snapshot as CSV",
  description:
    "Streams every `address_snapshot` row as CSV (`Content-Disposition: attachment`, filename `address-snapshot.csv`) in `pickup_address_id` order. Reads in keyset pages so a full-table export never buffers the table in memory. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`.",
  responses: {
    200: {
      description: "CSV download (header line plus one line per row)",
      content: { "text/csv": { schema: z.string() } }
    },
    401: { description: "Unauthorized" }
  }
});

// Registered BEFORE the by-id route below: Hono matches in registration
// order, so a param route registered first would swallow `/export` as an id.
// (Pinned by `test/snapshotCsvExport.test.ts`.)
addressSnapshotRoutes.openapi(addressSnapshotExportRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  return snapshotCsvResponse(c.env.CUSTOMER_DB, ADDRESS_SNAPSHOT_EXPORT);
});

const addressSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/address-snapshot/{pickupAddressId}",
  tags: ["address-snapshot"],
  summary: "Get one address snapshot row",
  description:
    "Reads one row from the daily snapshot DB by `pickupAddressId`. Bearer-gated like every `/api/v1/*` route except `GET /api/v1/health`. Returns 404 when no row exists for that id.",
  request: {
    params: z.object({ pickupAddressId: z.coerce.number().int() })
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

addressSnapshotRoutes.openapi(addressSnapshotByIdRoute, async (c) => {
  const id = Number(c.req.param("pickupAddressId"));
  if (!Number.isFinite(id)) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "pickupAddressId must be an integer. See docs/PROBLEMS.md#bad-request.",
      instance: `${new URL(c.req.url).pathname}#pickupAddressId=${c.req.param("pickupAddressId")}`
    });
  }
  const row = await c.env.CUSTOMER_DB.prepare(
    `SELECT pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
            extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at
     FROM address_snapshot WHERE pickup_address_id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) {
    return problemJsonResponse({
      type: problemType("not-found", c.env),
      title: "Not Found",
      status: 404,
      detail: `No address row for pickup_address_id=${id}. See docs/PROBLEMS.md#not-found.`,
      instance: `${new URL(c.req.url).pathname}#pickup_address_id=${id}`
    });
  }
  return c.json(row, 200);
});

const addressSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/address-snapshot/sync",
  tags: ["address-snapshot"],
  summary: "Fetch address report CSV and upsert D1",
  description:
    "Same bearer as `customer-snapshot` sync. Requires `ADDRESS_REPORT_EXPORT_PATH` or `ADDRESS_REPORT_QUERY_ID`. Customers should exist in D1 (run customer import/sync first) so `customer_id` foreign keys are satisfied.",
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

addressSnapshotRoutes.openapi(addressSnapshotSyncRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const misconfigured = requireSnapshotSecret(c);
  if (misconfigured) return misconfigured;
  if (!c.env.ADDRESS_REPORT_EXPORT_PATH?.trim() && !c.env.ADDRESS_REPORT_QUERY_ID?.trim()) {
    return problemJsonResponse({
      type: problemType("misconfigured", c.env),
      title: "Service Unavailable",
      status: 503,
      detail:
        "Set ADDRESS_REPORT_EXPORT_PATH or ADDRESS_REPORT_QUERY_ID (see CUSTOMER_SNAPSHOT.md). See docs/PROBLEMS.md#misconfigured.",
      instance: new URL(c.req.url).pathname
    });
  }
  try {
    const r = await runAddressSnapshotSync(c.env);
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

const addressSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/address-snapshot/import",
  tags: ["address-snapshot"],
  summary: "Import address CSV body into D1",
  description: "Raw CSV (Routeware Address Details custom report). Bear same secret; import **customers** first to satisfy `customer_id` foreign keys.",
  request: {
    body: {
      description: "Routeware Address Details CSV (header + data rows — see example)",
      content: {
        "text/csv": {
          // Plain SchemaObject, not a zod schema: docs-only, no runtime
          // validator is installed (the handler streams the raw body).
          schema: { type: "string" },
          example:
            "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date\n10,5,,1 Main St,Killeen,TX,76541,,,false,true,,,,"
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
    401: { description: "Unauthorized" }
  }
});

addressSnapshotRoutes.openapi(addressSnapshotImportRoute, async (c) => {
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
  try {
    // No positional batch size: the per-table default in `streamSync` is the
    // right value, and the facade mock in `test/snapshotRoutes.test.ts` does
    // not forward extra args anyway.
    const r = await syncAddressSnapshotFromStream(c.env.CUSTOMER_DB, body, undefined, {
      requireDataRows: true,
      maxBytes: SNAPSHOT_IMPORT_MAX_BYTES
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
