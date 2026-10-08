import { createRoute, z } from "@hono/zod-openapi";
import {
  runAddressSnapshotSync,
  syncAddressSnapshotFromStream
} from "../lib/d1SnapshotSync";
import { problemJsonResponse, problemType } from "../lib/problem";
import {
  createRouteModule,
  nonEmptyImportStream,
  requireSnapshotAuth,
  requireSnapshotSecret,
  snapshotListResponse
} from "./shared";

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
      q: z.string().max(100).optional().describe("Address line substring (case-insensitive; maximum 100 characters)"),
      enabled: z.enum(["true", "false", "any"]).optional().default("any"),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0)
    })
  },
  responses: {
    200: {
      description: "Rows and total",
      content: { "application/json": { schema: snapshotListResponse } }
    },
    400: {
      description:
        "Invalid query (application/problem+json). The zod validator rejects `q` longer than 100 characters, an out-of-range `limit`/`offset`, or an unknown `enabled` value before any D1 query runs."
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

const addressSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/address-snapshot/{pickupAddressId}",
  tags: ["address-snapshot"],
  summary: "Get one address snapshot row",
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
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: "pickupAddressId must be an integer"
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
      type: problemType("not-found"),
      title: "Not Found",
      status: 404,
      detail: `No address row for pickup_address_id=${id}`
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
    503: { description: "Not configured" }
  }
});

addressSnapshotRoutes.openapi(addressSnapshotSyncRoute, async (c) => {
  const denied = requireSnapshotAuth(c, "Bearer token required.");
  if (denied) return denied;
  const misconfigured = requireSnapshotSecret(c.env, "Set CUSTOMER_SNAPSHOT_SYNC_SECRET in vars or secrets.");
  if (misconfigured) return misconfigured;
  if (!c.env.ADDRESS_REPORT_EXPORT_PATH?.trim() && !c.env.ADDRESS_REPORT_QUERY_ID?.trim()) {
    return problemJsonResponse({
      type: problemType("misconfigured"),
      title: "Not configured",
      status: 503,
      detail: "Set ADDRESS_REPORT_EXPORT_PATH or ADDRESS_REPORT_QUERY_ID (see CUSTOMER_SNAPSHOT.md)."
    });
  }
  const r = await runAddressSnapshotSync(c.env);
  if (!r) {
    return c.json({ upserted: 0, rowCount: 0, skipped: true }, 200);
  }
  return c.json(r, 200);
});

const addressSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/address-snapshot/import",
  tags: ["address-snapshot"],
  summary: "Import address CSV body into D1",
  description: "Raw CSV (Routeware Address Details custom report). Bear same secret; import **customers** first to satisfy `customer_id` foreign keys.",
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
        "Empty body (application/problem+json). Returned when the POST has no request body or the body is zero bytes; post the CSV as raw body."
    }
  }
});

addressSnapshotRoutes.openapi(addressSnapshotImportRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const body = await nonEmptyImportStream(c.req.raw);
  if (!body) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Empty body",
      status: 400,
      detail: "POST the CSV as raw body."
    });
  }
  const r = await syncAddressSnapshotFromStream(c.env.CUSTOMER_DB, body);
  return c.json(r, 200);
});
