import { createRoute, z } from "@hono/zod-openapi";
import {
  runCustomerSnapshotSync,
  syncCustomerSnapshotFromStream
} from "../lib/d1SnapshotSync";
// Guard values come from the deep module, not the facade: `test/snapshotRoutes.test.ts`
// mocks `../lib/d1SnapshotSync` with only the six sync functions, so any other
// facade import throws at module scope there. The deep module is never mocked.
import {
  InvalidSnapshotCsvError,
  SNAPSHOT_IMPORT_MAX_BYTES,
  isSnapshotTooLarge
} from "../lib/snapshot/streamSync";
import { problemJsonResponse, problemType } from "../lib/problem";
import {
  createRouteModule,
  requireSnapshotAuth,
  requireSnapshotSecret,
  snapshotListResponse
} from "./shared";
import {
  mapSnapshotImportError,
  rejectOversizedSnapshotImport
} from "./snapshotImport";

/** D1 customer snapshot: reads plus the CSV sync/import writers. */
export const customerSnapshotRoutes = createRouteModule();

const customerSnapshotListRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot",
  tags: ["customer-snapshot"],
  summary: "List customer snapshot rows (D1)",
  description:
    "Reads the cached Routeware customer CSV (see `CUSTOMER_SNAPSHOT.md`). Filter by `customerId`, company substring `q`, or `enabled`.",
  request: {
    query: z.object({
      customerId: z.coerce.number().int().optional(),
      q: z.string().optional().describe("Company name substring (case-insensitive)"),
      enabled: z.enum(["true", "false", "any"]).optional().default("any"),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0)
    })
  },
  responses: {
    200: {
      description: "Rows and total count for pagination",
      content: { "application/json": { schema: snapshotListResponse } }
    }
  }
});

customerSnapshotRoutes.openapi(customerSnapshotListRoute, async (c) => {
  const p = c.req.valid("query");
  const db = c.env.CUSTOMER_DB;
  const where: string[] = ["1 = 1"];
  const binds: unknown[] = [];
  if (p.customerId !== undefined) {
    where.push("customer_id = ?");
    binds.push(p.customerId);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    where.push("instr(lower(coalesce(company_name, '')), lower(?)) > 0");
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
    .prepare(`SELECT COUNT(*) as n FROM customer_snapshot WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const { results } = await db
    .prepare(
      `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
              name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
       FROM customer_snapshot WHERE ${whereSql} ORDER BY customer_id LIMIT ? OFFSET ?`
    )
    .bind(...binds, p.limit, p.offset)
    .all();
  return c.json({ rows: results ?? [], total });
});

const customerSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot/{customerId}",
  tags: ["customer-snapshot"],
  summary: "Get one customer snapshot row",
  request: {
    params: z.object({ customerId: z.coerce.number().int() })
  },
  responses: {
    200: {
      description: "Row",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown())
        }
      }
    },
    400: {
      description: "Invalid customer id (application/problem+json)"
    },
    404: {
      description: "Not found (application/problem+json)"
    }
  }
});

customerSnapshotRoutes.openapi(customerSnapshotByIdRoute, async (c) => {
  const customerId = Number(c.req.param("customerId"));
  if (!Number.isFinite(customerId)) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail:
        "customerId must be an integer. See docs/PROBLEMS.md#bad-request.",
      instance: `${new URL(c.req.url).pathname}#customerId=${c.req.param("customerId")}`
    });
  }
  const row = await c.env.CUSTOMER_DB.prepare(
    `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
            name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
     FROM customer_snapshot WHERE customer_id = ?`
  )
    .bind(customerId)
    .first<Record<string, unknown>>();
  if (!row) {
    return problemJsonResponse({
      type: problemType("not-found"),
      title: "Not Found",
      status: 404,
      detail: `No snapshot row for customer_id=${customerId}. See docs/PROBLEMS.md#not-found.`,
      instance: `${new URL(c.req.url).pathname}#customer_id=${customerId}`
    });
  }
  return c.json(row, 200);
});

const customerSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/customer-snapshot/sync",
  tags: ["customer-snapshot"],
  summary: "Fetch Routeware report CSV and upsert D1",
  description:
    "Same logic as the daily cron. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>` and either `CUSTOMER_REPORT_EXPORT_PATH` (static path) or `CUSTOMER_REPORT_QUERY_ID` (Routeware query id for the async report pipeline).",
  responses: {
    200: {
      description: "Sync result",
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
    401: { description: "Missing or invalid bearer token" },
    503: { description: "Service Unavailable" }
  }
});

customerSnapshotRoutes.openapi(customerSnapshotSyncRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const misconfigured = requireSnapshotSecret(c);
  if (misconfigured) return misconfigured;
  if (!c.env.CUSTOMER_REPORT_EXPORT_PATH?.trim() && !c.env.CUSTOMER_REPORT_QUERY_ID?.trim()) {
    return problemJsonResponse({
      type: problemType("misconfigured"),
      title: "Service Unavailable",
      status: 503,
      detail:
        "Set CUSTOMER_REPORT_EXPORT_PATH (static report URL) or CUSTOMER_REPORT_QUERY_ID (Routeware query id). See CUSTOMER_SNAPSHOT.md. See docs/PROBLEMS.md#misconfigured.",
      instance: new URL(c.req.url).pathname
    });
  }
  const r = await runCustomerSnapshotSync(c.env);
  if (!r) {
    return c.json({ upserted: 0, rowCount: 0, skipped: true }, 200);
  }
  return c.json(r, 200);
});

const customerSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/customer-snapshot/import",
  tags: ["customer-snapshot"],
  summary: "Import CSV body into D1",
  description:
    "Raw CSV bytes (same format as the Routeware export). `Content-Type: text/csv` or `application/octet-stream`. Requires bearer secret.",
  responses: {
    200: {
      description: "Import result",
      content: {
        "application/json": {
          schema: z.object({ upserted: z.number().int(), rowCount: z.number().int(), deleted: z.number().int().optional() })
        }
      }
    },
    401: { description: "Unauthorized" }
  }
});

customerSnapshotRoutes.openapi(customerSnapshotImportRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const oversized = rejectOversizedSnapshotImport(
    { url: c.req.url, contentLength: c.req.raw.headers.get("content-length") },
    SNAPSHOT_IMPORT_MAX_BYTES
  );
  if (oversized) return oversized;
  const body = c.req.raw.body;
  if (!body) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail:
        "POST the CSV file as the raw request body. See docs/PROBLEMS.md#bad-request.",
      instance: new URL(c.req.url).pathname
    });
  }
  try {
    // No positional batch size: the per-table default in `streamSync` is the
    // right value, and the facade mock in `test/snapshotRoutes.test.ts` does
    // not forward extra args anyway.
    const r = await syncCustomerSnapshotFromStream(c.env.CUSTOMER_DB, body, undefined, {
      requireDataRows: true,
      maxBytes: SNAPSHOT_IMPORT_MAX_BYTES
    });
    return c.json(r, 200);
  } catch (e) {
    const mapped = mapSnapshotImportError(
      c.req.url,
      e,
      isSnapshotTooLarge,
      (err) => err instanceof InvalidSnapshotCsvError
    );
    if (mapped) return mapped;
    throw e;
  }
});
