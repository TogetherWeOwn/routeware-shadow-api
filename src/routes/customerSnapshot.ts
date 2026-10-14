import { createRoute, z } from "@hono/zod-openapi";
import { customerRowExample, customerExportExample } from "./payloadExamples";
import { snapshotSearchQuery } from "../lib/snapshotSearchQuery";
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
import {
  CUSTOMER_SNAPSHOT_EXPORT,
  readSnapshotExportPageSize,
  snapshotCsvResponse
} from "../lib/snapshot/export";
import { invalidateDataEntity } from "../lib/entityDataCache";
import { problemJsonResponse, problemType } from "../lib/problem";
import { isForeignKeyConstraintFailure } from "../lib/snapshot/upsert";
import {
  createRouteModule,
  dryRunQuery,
  isDryRunRequested,
  requireSnapshotAuth,
  requireSnapshotSecret,
  snapshotListResponse,
  snapshotWriteResultExample,
  parsePositiveIdParam
} from "./shared";
import {
  mapSnapshotImportError,
  rejectOversizedSnapshotImport,
  rejectUnsupportedSnapshotImportContentType
} from "./snapshotImport";

/** D1 customer snapshot: reads plus the CSV sync/import writers. */
export const customerSnapshotRoutes = createRouteModule();

const customerSnapshotListRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot",
  operationId: "listCustomerSnapshot",
  tags: ["customer-snapshot"],
  summary: "List customer snapshot rows (D1)",
  description:
    "Reads the cached Routeware customer CSV (see `CUSTOMER_SNAPSHOT.md`). Filter by `customerId`, company substring `q`, or `enabled`. Pass `cursor` (the previous page's `nextCursor`) instead of `offset` to page deep result sets by primary-key seek instead of a scanned OFFSET. **Try it:** authorize with `SHADOW_API_TOKEN` (or `SHADOW_API_READ_TOKEN` for GET-only access), select Test Request, and Send with `limit=10` and `enabled=true`. This only reads local D1; it does not import, sync, or contact Routeware.",
  request: {
    query: z.object({
      customerId: z.coerce.number().int().optional().openapi({ example: 345734 }),
      q: snapshotSearchQuery.optional().describe("Company name substring (case-insensitive; maximum 100 Unicode code points)").openapi({ example: "ExampleCo" }),
      enabled: z.enum(["true", "false", "any"]).optional().default("any").openapi({ example: "true" }),
      limit: z.coerce.number().int().min(1).max(500).default(50).openapi({ example: 10 }),
      offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
      cursor: z.coerce
        .number()
        .int()
        .optional()
        .describe("Last customer_id from the previous page's nextCursor; takes precedence over offset")
        .openapi({ example: 345733 })
    })
  },
  responses: {
    200: {
      description: "Rows and total count for pagination",
      content: {
        "application/json": {
          schema: snapshotListResponse,
          example: { rows: [customerRowExample], total: 1, nextCursor: null }
        }
      }
    },
    400: {
      description:
        "Invalid query (application/problem+json). The zod validator rejects `q` longer than 100 Unicode code points, an out-of-range `limit`/`offset`, or an unknown `enabled` value before any D1 query runs."
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
  if (p.cursor !== undefined) {
    where.push("customer_id > ?");
    binds.push(p.cursor);
  }
  const whereSql = where.join(" AND ");
  const totalRow = await db
    .prepare(`SELECT COUNT(*) as n FROM customer_snapshot WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  // A cursor seeks from `customer_id > ?` and never needs OFFSET; keeping the
  // OFFSET-less form off the cursor path is what avoids the scan-past-N-rows
  // cost this route exists to remove (TOG-5810).
  const pageSql =
    p.cursor !== undefined
      ? "ORDER BY customer_id LIMIT ?"
      : "ORDER BY customer_id LIMIT ? OFFSET ?";
  const pageBinds = p.cursor !== undefined ? [p.limit] : [p.limit, p.offset];
  const { results } = await db
    .prepare(
      `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
              name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
       FROM customer_snapshot WHERE ${whereSql} ${pageSql}`
    )
    .bind(...binds, ...pageBinds)
    .all();
  const rows = results ?? [];
  const nextCursor =
    rows.length === p.limit ? Number((rows[rows.length - 1] as Record<string, unknown>).customer_id) : null;
  return c.json({ rows, total, nextCursor });
});

/**
 * Changes feed: rows touched by the syncs after a client-held cursor (TOG-8877).
 *
 * A client keeps the largest `(synced_at, customer_id)` pair it has seen and
 * replays `GET /api/v1/customer-snapshot/changes?since=<ts>&since_id=<id>` to
 * fetch only later rows — the incremental-sync counterpart to the full table
 * list above. `synced_at` is stamped per sync run
 * (`src/lib/snapshot/streamSync.ts`), so every upserted row in run N shares
 * run N's timestamp: resuming a chunked delta with the bare timestamp would
 * skip the same-timestamp rows past the page boundary (strict `>`), which is
 * why the resume key is the composite pair, never the timestamp alone.
 */
// Own response schema, not `snapshotListResponse`: the changes cursor is the
// composite `(synced_at, customer_id)` pair (`since` + `since_id`), never a
// bare timestamp or a primary-key integer, so sharing the list schema would
// publish (and typecheck) the wrong `nextCursor` type.
const customerSnapshotChangesResponse = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())),
    total: z.number().int(),
    nextCursor: z
      .object({
        since: z.string().datetime(),
        since_id: z.number().int()
      })
      .nullable()
  })
  .openapi("CustomerSnapshotChanges");

const customerSnapshotChangesRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot/changes",
  tags: ["customer-snapshot"],
  summary: "List customer snapshot rows changed since a cursor (D1)",
  description:
    "Incremental-sync feed: returns rows with `synced_at > since` in `(synced_at, customer_id)` keyset order. Omit `since` for the first page (equivalent to the epoch — every row is newer). A bare `since` replays every later run whole. To page a chunked delta, pass the previous page's `nextCursor` back as `since` + `since_id`: the composite pair resumes at the boundary timestamp without skipping same-timestamp rows past the page boundary. `limit` caps the page at 1..500 (default 50). Rows carry only the stored snapshot columns — no fields beyond the row payload.",
  request: {
    query: z.object({
      since: z
        .preprocess(
          (v) => (v === "" || v === undefined ? undefined : v),
          z.string().datetime().optional()
        )
        .describe("ISO-8601 cursor; only rows with synced_at after it are returned (plus the since_id tiebreak when paging). Omit for the first page.")
        .openapi({ example: "2025-12-31T00:00:00.000Z" }),
      since_id: z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Tiebreak half of the composite cursor: the last row's customer_id from the previous page's nextCursor. Omit for the first page and for whole-run replays with a bare `since`.")
        .openapi({ example: 345733 }),
      limit: z.coerce.number().int().min(1).max(500).default(50).openapi({ example: 50 })
    })
  },
  responses: {
    200: {
      description: "Changed rows in (synced_at, customer_id) order with nextCursor",
      content: {
        "application/json": {
          schema: customerSnapshotChangesResponse,
          example: { rows: [customerRowExample], total: 1, nextCursor: null }
        }
      }
    }
  }
});

// Registered BEFORE the export and by-id routes below: Hono matches in
// registration order, so the `/{customerId}` param route would otherwise
// swallow `/changes` as an id (same reason `/export` registers early).
customerSnapshotRoutes.openapi(customerSnapshotChangesRoute, async (c) => {
  const p = c.req.valid("query");
  const db = c.env.CUSTOMER_DB;
  // Empty/absent `since` is the epoch: every row qualifies, so the first sync
  // sees the whole table and later replays see only newer runs. A bare `since`
  // (no `since_id`) stays strict-`>` — that is the whole-run-replay form. A
  // page resume passes the previous `nextCursor`'s pair and replays rows at
  // the boundary timestamp with a larger `customer_id`: without the tiebreak,
  // resuming mid-run with a strict `>` would skip same-timestamp rows past the
  // page boundary (every upserted row in run N shares run N's stamp).
  const since = p.since ?? "0000-01-01T00:00:00.000Z";
  const where =
    p.since_id === undefined
      ? "synced_at > ?"
      : "(synced_at > ? OR (synced_at = ? AND customer_id > ?))";
  const binds: unknown[] =
    p.since_id === undefined ? [since, p.limit] : [since, since, p.since_id, p.limit];
  const { results } = await db
    .prepare(
      `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
              name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
       FROM customer_snapshot WHERE ${where} ORDER BY synced_at, customer_id LIMIT ?`
    )
    .bind(...binds)
    .all();
  const rows = results ?? [];
  // Same convention as the list routes (TOG-5810): full page ⇒ maybe more.
  // The cursor is the last row's composite pair, so resuming keeps
  // `(synced_at, customer_id)` keyset order with no boundary skip.
  const last = rows.length === p.limit ? (rows[rows.length - 1] as Record<string, unknown>) : null;
  const nextCursor =
    last === null
      ? null
      : { since: String(last.synced_at), since_id: Number(last.customer_id) };
  return c.json({ rows, total: rows.length, nextCursor });
});

const customerSnapshotExportRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot/export",
  tags: ["customer-snapshot"],
  summary: "Download customer snapshot as CSV",
  description:
    "Streams every `customer_snapshot` row as CSV (`Content-Disposition: attachment`, filename `customer-snapshot.csv`) in `customer_id` order. Reads in keyset pages so a full-table export never buffers the table in memory. Emits a content-hash `ETag`; replay it as `If-None-Match` for a `304` with an empty body. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`.",
  responses: {
    200: {
      description: "CSV download (header line plus one line per row)",
      content: { "text/csv": { schema: z.string(), example: customerExportExample } }
    },
    304: { description: "Not modified (If-None-Match carries the current ETag)" },
    401: { description: "Unauthorized" }
  }
});

// Registered BEFORE the by-id route below: Hono matches in registration
// order, so a param route registered first would swallow `/export` as an id.
// (Pinned by `test/snapshotCsvExport.test.ts`.)
customerSnapshotRoutes.openapi(customerSnapshotExportRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  return snapshotCsvResponse(
    c.env.CUSTOMER_DB,
    CUSTOMER_SNAPSHOT_EXPORT,
    c.req.header("if-none-match"),
    readSnapshotExportPageSize(c.env)
  );
});

const customerSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot/{customerId}",
  tags: ["customer-snapshot"],
  summary: "Get one customer snapshot row",
  description:
    "Reads one row from the daily snapshot DB by `customerId`. Bearer-gated like every `/api/v1/*` route except `GET /api/v1/health`. Returns 404 when no row exists for that id.",
  request: {
    params: z.object({ customerId: z.coerce.number().int().openapi({ example: 345734 }) })
  },
  responses: {
    200: {
      description: "Row",
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()),
          example: customerRowExample
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
  const customerId = parsePositiveIdParam(c.req.param("customerId"));
  if (customerId === null) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "customerId must be a positive integer. See docs/PROBLEMS.md#bad-request.",
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
      type: problemType("not-found", c.env),
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
    "Same logic as the daily cron. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>` and either `CUSTOMER_REPORT_EXPORT_PATH` (static path) or `CUSTOMER_REPORT_QUERY_ID` (Routeware query id for the async report pipeline). Pass `?dryRun=true` to run the full parse/validate path, return the counts that WOULD apply, and write nothing (no D1, no R2).\n\n" +
    "**Try it in `/docs`:** paste the sync secret once into the `bearerAuth` Authorize dialog (it persists across calls), then Send with an empty body. A 200 looks like the example: `{upserted, rowCount, deleted}` (`skipped: true` instead when no export source is configured). Import customers before addresses/containers so foreign keys resolve.",
  request: {
    query: dryRunQuery
  },
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
          }),
          example: snapshotWriteResultExample
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
      type: problemType("misconfigured", c.env),
      title: "Service Unavailable",
      status: 503,
      detail:
        "Set CUSTOMER_REPORT_EXPORT_PATH (static report URL) or CUSTOMER_REPORT_QUERY_ID (Routeware query id). See CUSTOMER_SNAPSHOT.md. See docs/PROBLEMS.md#misconfigured.",
      instance: new URL(c.req.url).pathname
    });
  }
  // TOG-9203: `?dryRun=true` runs the full parse/validate path and returns
  // the would-be counts while writing nothing (no D1, no R2).
  const r = await runCustomerSnapshotSync(c.env, {
    dryRun: isDryRunRequested(c.req.valid("query"))
  });
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
    "Raw CSV bytes (same format as the Routeware export). `Content-Type: text/csv` or `application/octet-stream`. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Pass `?dryRun=true` to validate and return the would-be counts without writing D1.\n\n" +
    "**Try it in `/docs`:** Authorize with the sync secret once, paste the request example below as the raw body, then Send. A 200 looks like `{upserted: 2, rowCount: 2, deleted: 0}` — imports never delete, so `deleted` is always 0. Run this before the address/container imports so their foreign keys resolve.",
  request: {
    query: dryRunQuery,
    body: {
      description: "Routeware customer CSV (header + data rows — see example)",
      content: {
        "text/csv": {
          // Plain SchemaObject, not a zod schema: docs-only, no runtime
          // validator is installed (the handler streams the raw body).
          schema: { type: "string" },
          example:
            "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix,CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled\n123,,Co 123,Jane,,Doe,,,,,,,true"
        },
        "application/octet-stream": { schema: { type: "string" } }
      }
    }
  },
  responses: {
    200: {
      description: "Import result",
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
        "Empty body (application/problem+json). Returned when the POST has no request body; post the CSV file as the raw request body."
    }
  }
});

customerSnapshotRoutes.openapi(customerSnapshotImportRoute, async (c) => {
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
        "POST the CSV file as the raw request body. See docs/PROBLEMS.md#bad-request.",
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
    const r = await syncCustomerSnapshotFromStream(c.env.CUSTOMER_DB, body, undefined, {
      requireDataRows: true,
      rejectControlCharacters: true,
      maxBytes: SNAPSHOT_IMPORT_MAX_BYTES,
      // TOG-9203: `?dryRun=true` validates and counts without writing D1.
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
    throw e;
  }
});

/**
 * Customer-row erasure (TOG-8876): hard-deletes one `customer_snapshot` row.
 *
 * This erases the cached report extract only — it never touches upstream
 * Routeware (which exposes no customer hard delete; see
 * `docs/PROBLEMS.md#method-not-allowed`). Erasure removes the D1
 * `customer_snapshot` row and evicts the data-entity cache entry. It does not
 * remove R2 history CSVs, daily aliases, latest pointers, or the
 * archived-CSV readback, and it does not touch upstream Routeware. An id-only
 * D1 tombstone suppresses the customer on later sync, proxy-save refresh, and
 * CSV/archive import. Suppressed address writes for that customer are skipped
 * and recorded as id-only lineage so their container writes are skipped too.
 * This is local cache suppression, not upstream erasure;
 * tombstones persist until explicitly removed. A restore of a D1 backup from
 * before the erasure may restore both the customer row and an older schema
 * without the tombstone/triggers. D1 Time Travel can restore data for up to
 * 30 days (7 days on the Workers Free plan), so verify suppression after
 * database recovery. This route removes only the `customer_snapshot` row:
 * the customer's `address_snapshot` and `container_snapshot` rows are not
 * removed by this route. There is no address or container DELETE route —
 * address rows leave D1 only through upstream-driven reconciliation or
 * through direct privileged `wrangler d1 execute` deletes in container →
 * address → customer FK order before retrying the customer delete.
 * FK-safe by refusal, not by cascade:
 * D1 enforces the snapshot FK chain unconditionally, so deleting a customer
 * that still has address rows fails closed and is mapped to 400 naming the
 * blocking children — an orphan is never written. Exactly one row is ever
 * removed (`deleted` is always 1 on a 200).
 */
const customerSnapshotDeleteRoute = createRoute({
  method: "delete",
  path: "/api/v1/customer-snapshot/{customerId}",
  tags: ["customer-snapshot"],
  summary: "Delete one customer snapshot row",
  description:
    "Hard-deletes one `customer_snapshot` row by `customerId` (GDPR-style erasure for the cached report extract — upstream Routeware is untouched). Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Returns 404 when no row exists. Refuses with 400 `bad-request` when address rows still reference the customer — delete the addresses first; the D1 foreign key is never bypassed. A successful delete removes the D1 `customer_snapshot` row and evicts the cached data-entity customer bundle (other edge locations and clients may keep serving the erased PII until the 60 s cache TTL expires). It does not remove R2 history CSVs, daily aliases, latest pointers, or the archived-CSV readback, and it does not touch upstream Routeware. A D1 tombstone suppresses the customer on later sync, proxy-save refresh, and CSV/archive import while upstream still holds it. Suppressed address writes for that customer are skipped and recorded as id-only lineage so their container writes are skipped too. This is local cache suppression, not upstream erasure; tombstones persist until explicitly removed. A restore of a D1 backup from before the erasure may restore both the customer row and an older schema without the tombstone/triggers. D1 Time Travel can restore data for up to 30 days (7 days on the Workers Free plan), so verify suppression after database recovery. This route removes only the `customer_snapshot` row: the customer's `address_snapshot` and `container_snapshot` rows are not removed by this route. There is no address or container DELETE route — address rows leave D1 only through upstream-driven reconciliation or through direct privileged `wrangler d1 execute` deletes in container → address → customer FK order before retrying the customer delete.",
  request: {
    params: z.object({ customerId: z.coerce.number().int().openapi({ example: 345734 }) })
  },
  responses: {
    200: {
      description: "Deleted row id and count",
      content: {
        "application/json": {
          schema: z.object({ customerId: z.number().int(), deleted: z.number().int() }),
          example: { customerId: 345734, deleted: 1 }
        }
      }
    },
    400: {
      description: "Invalid customer id, or address rows still reference it (application/problem+json)"
    },
    404: {
      description: "Not found (application/problem+json)"
    }
  }
});

// Param route, but DELETE: Hono matches method first, so this can never shadow
// the literal GET `/export` or `/changes` routes above regardless of order.
// Kept last for readability next to the other writer routes.
customerSnapshotRoutes.openapi(customerSnapshotDeleteRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const customerId = parsePositiveIdParam(c.req.param("customerId"));
  if (customerId === null) {
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail:
        "customerId must be a positive integer. See docs/PROBLEMS.md#bad-request.",
      instance: `${new URL(c.req.url).pathname}#customerId=${c.req.param("customerId")}`
    });
  }
  const customerNotFound = () =>
    problemJsonResponse({
      type: problemType("not-found"),
      title: "Not Found",
      status: 404,
      detail: `No snapshot row for customer_id=${customerId}. See docs/PROBLEMS.md#not-found.`,
      instance: `${new URL(c.req.url).pathname}#customer_id=${customerId}`
    });
  const db = c.env.CUSTOMER_DB;
  const existing = await db
    .prepare("SELECT customer_id FROM customer_snapshot WHERE customer_id = ?")
    .bind(customerId)
    .first<{ customer_id: number }>();
  if (!existing) {
    return customerNotFound();
  }
  try {
    // Commit the marker and row deletion together: a failed FK delete must not
    // leave a tombstone that silently suppresses a still-present customer.
    // Re-check existence in the batch so a concurrent reconcile/delete cannot
    // create a new marker behind our 404 response.
    const [, res] = await db.batch([
      db
        .prepare(
          "INSERT INTO customer_snapshot_erasure (customer_id, erased_at) SELECT customer_id, ? FROM customer_snapshot WHERE customer_id = ? ON CONFLICT(customer_id) DO UPDATE SET erased_at = excluded.erased_at"
        )
        .bind(new Date().toISOString(), customerId),
      db
        .prepare("DELETE FROM customer_snapshot WHERE customer_id = ?")
        .bind(customerId)
    ]);
    if ((res?.meta.changes ?? 0) === 0) {
      // Lost a race with a concurrent delete: the row is gone, so answer absent.
      return customerNotFound();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isForeignKeyConstraintFailure(msg)) {
      throw e;
    }
    // The D1 FK refused: address rows still reference this customer. Name the
    // blocking children (integer keys only, never PII) so the fix is obvious.
    const [countRow, blockers] = await Promise.all([
      db
        .prepare("SELECT COUNT(*) as n FROM address_snapshot WHERE customer_id = ?")
        .bind(customerId)
        .first<{ n: number }>(),
      db
        .prepare(
          "SELECT pickup_address_id FROM address_snapshot WHERE customer_id = ? ORDER BY pickup_address_id LIMIT 20"
        )
        .bind(customerId)
        .all<{ pickup_address_id: number }>()
    ]);
    const n = countRow?.n ?? 0;
    const keys = (blockers.results ?? []).map((r) => r.pickup_address_id).join(", ");
    return problemJsonResponse({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail:
        `Cannot delete customer_id=${customerId}: ${n} address row(s) still reference it` +
        (keys ? ` (pickup_address_id=${keys})` : "") +
        ". Delete the addresses first. See docs/PROBLEMS.md#bad-request.",
      instance: `${new URL(c.req.url).pathname}#customer_id=${customerId}`
    });
  }
  // Erasure must be immediate: the data-entity GET cache would otherwise keep
  // serving the deleted row's PII until TTL expiry. Refuse-semantics plus the
  // D1 FK above guarantee no address/container bundle can reference this
  // customer (any remaining child 400s the delete), so the single customer key
  // is the whole stale set. Propagates on failure (TOG-6533): never report
  // success while erased PII may still serve.
  await invalidateDataEntity("customer", customerId);
  return c.json({ customerId, deleted: 1 }, 200);
});
