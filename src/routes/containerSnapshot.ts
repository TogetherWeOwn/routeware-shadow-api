import { createRoute, z } from "@hono/zod-openapi";
import {
  runContainerSnapshotSync,
  syncContainerSnapshotFromStream
} from "../lib/d1SnapshotSync";
import { problemJsonResponse, problemType } from "../lib/problem";
import {
  createRouteModule,
  requireSnapshotAuth,
  requireSnapshotSecret,
  snapshotListResponse
} from "./shared";

/** D1 container snapshot: reads plus the CSV sync/import writers. */
export const containerSnapshotRoutes = createRouteModule();

const containerSnapshotListRoute = createRoute({
  method: "get",
  path: "/api/v1/container-snapshot",
  tags: ["container-snapshot"],
  summary: "List container snapshot rows (D1)",
  description:
    "Routeware containers link to an address via `pickup_address_id` (and thus to a customer). Filter by `customerId` (joins through address), `pickupAddressId`, or `containerId`, text `q` on `location_address` or `serial_number`, and `enabled`.",
  request: {
    query: z.object({
      customerId: z.coerce.number().int().optional(),
      pickupAddressId: z.coerce.number().int().optional(),
      containerId: z.coerce.number().int().optional(),
      q: z.string().optional().describe("Substring on location or serial (case-insensitive)"),
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
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) as n ${fromJoin} WHERE ${whereSql}`
    )
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const { results } = await db
    .prepare(
      `SELECT c.container_id, c.pickup_address_id, c.container_type_id, c.serial_number, c.rfid, c.oncall, c.event_code,
              c.gps_locked, c.latitude, c.longitude, c.enabled, c.location_address, c.city, c.state, c.zip, c.container_note,
              c.ud_cost_share_ud, c.ud_enclosure_doors_ud, c.ud_last_compactor_inspection_ud, c.ud_last_enclosure_inspection_ud,
              c.ud_material_stream_ud, c.color, c.service_code_type, c.service_code_input, c.service_code, c.service_date, c.route_ids, c.frequency_ids, c.synced_at
       ${fromJoin} WHERE ${whereSql} ORDER BY c.container_id LIMIT ? OFFSET ?`
    )
    .bind(...binds, p.limit, p.offset)
    .all();
  return c.json({ rows: results ?? [], total });
});

const containerSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/container-snapshot/{containerId}",
  tags: ["container-snapshot"],
  summary: "Get one container snapshot row",
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
  const id = Number(c.req.param("containerId"));
  if (!Number.isFinite(id)) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: "containerId must be an integer"
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
      type: problemType("not-found"),
      title: "Not Found",
      status: 404,
      detail: `No container row for container_id=${id}`
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
    "Same bearer. Requires `CONTAINER_REPORT_EXPORT_PATH` or `CONTAINER_REPORT_QUERY_ID`. Address rows for each `pickup_address_id` should exist in D1 first.",
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

containerSnapshotRoutes.openapi(containerSnapshotSyncRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const misconfigured = requireSnapshotSecret(c.env);
  if (misconfigured) return misconfigured;
  if (!c.env.CONTAINER_REPORT_EXPORT_PATH?.trim() && !c.env.CONTAINER_REPORT_QUERY_ID?.trim()) {
    return problemJsonResponse({
      type: problemType("misconfigured"),
      title: "Not configured",
      status: 503,
      detail: "Set CONTAINER_REPORT_EXPORT_PATH or CONTAINER_REPORT_QUERY_ID (see CUSTOMER_SNAPSHOT.md)."
    });
  }
  const r = await runContainerSnapshotSync(c.env);
  if (!r) {
    return c.json({ upserted: 0, rowCount: 0, skipped: true }, 200);
  }
  return c.json(r, 200);
});

const containerSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/container-snapshot/import",
  tags: ["container-snapshot"],
  summary: "Import container CSV into D1",
  description: "Raw CSV. Bear same secret. Import or sync **addresses** (and **customers**) first for `pickup_address_id` foreign keys.",
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

containerSnapshotRoutes.openapi(containerSnapshotImportRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const body = c.req.raw.body;
  if (!body) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Empty body",
      status: 400
    });
  }
  const r = await syncContainerSnapshotFromStream(c.env.CUSTOMER_DB, body);
  return c.json(r, 200);
});
