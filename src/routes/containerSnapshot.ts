import { createRoute, z } from "@hono/zod-openapi";
import { containerRowExample, containerExportExample } from "./payloadExamples";
import { containerSnapshotListResponse, containerSnapshotRowSchema } from "./snapshotRowSchemas";
import { snapshotSearchQuery } from "../lib/snapshotSearchQuery";
import { containerIdentifierQuery } from "../lib/containerIdentifierQuery";
import { snapshotOrderQuery, snapshotOrderSql } from "../lib/snapshotListOrder";
import { snapshotExactNextQuery, snapshotNextLink, snapshotNextLinkHeader } from "../lib/snapshotNextLink";
import { snapshotUpperIdQuery } from "../lib/snapshotUpperId";
import { projectSnapshotRow, snapshotFieldsQuery } from "../lib/sparseFieldsets";
import { snapshotIdSelectionPredicate, snapshotIdSelectionQuery } from "../lib/snapshotIdSelection";
import {
  snapshotListConditionalHeaders,
  snapshotListEtagHeaders,
  snapshotListNotModifiedResponse,
  snapshotListJsonResponse
} from "../lib/snapshotListConditional";
import { snapshotByIdConditional } from "../lib/snapshotByIdConditional";
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
  SNAPSHOT_POST_QUERY_KEYS,
  createRouteModule,
  dryRunQuery,
  foreignKeyProblem,
  isDryRunRequested,
  rejectUnknownSnapshotPostQuery,
  requireSnapshotAuth,
  requireSnapshotSecret,
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
  operationId: "listContainerSnapshot",
  "x-access": "read",
  "x-effect": "local-read",
  tags: ["container-snapshot"],
  summary: "List container snapshot rows (D1)",
  description:
    "Routeware containers link to an address via `pickup_address_id` (and thus to a customer). Filter by `customerId` (joins through address), `pickupAddressId`, or `containerId`, exact stored `zip`, text `q` on `location_address`, `serial_number`, `city` or `zip` (a match in any one column), and `enabled`. Locality comes only from the container, never the parent address; neither selector is live geolocation. `zip` is case-sensitive opaque text (1..100 Unicode code points), preserving leading zeros and nonblank whitespace. Unscoped locality filters scan stored rows; no dedicated zip index or production performance claim. Optional `serialNumber` and `rfid` are case-sensitive opaque exact strings (1..100 Unicode code points); leading zeros and nonblank whitespace are preserved. Optional `materialStream` matches `c.ud_material_stream_ud` and `color` matches `c.color`: case-sensitive opaque stored labels with the same nonblank 1..100 Unicode code-point bounds, no trimming, normalization or inferred taxonomy. All supplied filters compose with AND; null identifiers/labels do not match and duplicate matches are paginated, not collapsed. Valid unknown labels return an empty 200. Equality filters may scan; no index or performance guarantee is implied. Pass `cursor` (the previous page's `nextCursor`) instead of `offset` to page deep result sets by primary-key seek instead of a scanned OFFSET.",
  request: {
    headers: snapshotListConditionalHeaders,
    query: z.object({
      customerId: z.coerce.number().int().optional().openapi({ example: 345734 }),
      pickupAddressId: z.coerce.number().int().optional().openapi({ example: 10 }),
      containerId: z.coerce.number().int().optional().openapi({ example: 100 }),
      ids: snapshotIdSelectionQuery(),
      serialNumber: containerIdentifierQuery.optional().openapi({ example: "00123" }),
      rfid: containerIdentifierQuery.optional().openapi({ example: "RF-0007" }),
      materialStream: containerIdentifierQuery.optional().describe(
        "Case-sensitive opaque exact stored label in c.ud_material_stream_ud, 1..100 Unicode code points containing a non-whitespace character. Preserve leading zeros and significant whitespace without trimming or Unicode normalization; no inferred material taxonomy. URL-encode a single supported-length nonblank label, or omit it and retry; repeated keys are rejected before D1."
      ).openapi({ example: "001" }),
      color: containerIdentifierQuery.optional().describe(
        "Case-sensitive opaque exact stored label in c.color, 1..100 Unicode code points containing a non-whitespace character. Preserve leading zeros and significant whitespace without trimming or Unicode normalization; no defined vocabulary. URL-encode a single supported-length nonblank label, or omit it and retry; repeated keys are rejected before D1."
      ).openapi({ example: "Blue" }),
      zip: containerIdentifierQuery.optional()
        .describe("Opaque case-sensitive exact stored container zip equality: 1..100 Unicode code points. Leading zeros and nonblank whitespace are preserved, not trimmed. Empty/whitespace-only, overlength and repeated keys are invalid before D1. URL-encode one value and retry; no parent-address fallback or live geolocation.")
        .openapi({ example: "02139" }),
      q: snapshotSearchQuery.optional().describe("Literal substring on stored container location_address, serial_number, city or zip — a match in any one column (ASCII case-insensitive; SQLite lower() preserves non-ASCII case distinctions; maximum 100 Unicode code points before trimming). Trimmed; blank means omitted. No LIKE wildcards or live geolocation.").openapi({ example: "Killeen" }),
      enabled: z.enum(["true", "false", "any"]).optional().default("any").openapi({ example: "true" }),
      limit: z.coerce.number().int().min(1).max(500).default(50).openapi({ example: 50 }),
      offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
      cursor: z.coerce
        .number()
        .int()
        .optional()
        .describe("Last container_id from the previous page's nextCursor in the same order; takes precedence over offset. Changing direction starts a new traversal.")
        .openapi({ example: 99 }),
      upperId: snapshotUpperIdQuery,
      includeTotal: z
        .enum(["true", "false"])
        .optional()
        .default("true")
        .describe(
          "Count opt-out: \"false\" skips the COUNT query and returns total null (deliberately not computed) with the same rows and nextCursor"
        )
        .openapi({ example: "false" }),
      exactNext: snapshotExactNextQuery,
      order: snapshotOrderQuery,
      fields: snapshotFieldsQuery("container")
    })
  },
  responses: {
    200: {
      description: "Rows and total",
      headers: { ...snapshotListEtagHeaders, Link: snapshotNextLinkHeader },
      content: {
        "application/json": {
          schema: containerSnapshotListResponse,
          example: { rows: [containerRowExample], total: 1, nextCursor: null }
        }
      }
    },
    304: snapshotListNotModifiedResponse,
    400: {
      description:
        "Invalid query (application/problem+json). The zod validator rejects empty/whitespace-only/repeated `serialNumber`, `rfid`, `materialStream`, `color` or `zip`, any exact string selector or `q` longer than 100 Unicode code points, an out-of-range `limit`/`offset`, an unknown `enabled` value, an unknown/empty/duplicate `fields` selector, invalid/repeated `order`, or an invalid `ids` primary-ID selector (empty, over-50, duplicate, repeated-key, or non-canonical member) before any D1 query runs. Send order=asc or order=desc exactly (case-sensitive), or omit it for asc. For materialStream/color, URL-encode one supported-length nonblank stored label or omit it and retry. Invalid/repeated exactNext is rejected; send one exactNext=true or false, or omit it and retry. Errors name fields, never submitted values; correct the named query key and see docs/PROBLEMS.md#bad-request."
    }
  }
});

containerSnapshotRoutes.openapi(containerSnapshotListRoute, async (c) => {
  const p = c.req.valid("query");
  const order = snapshotOrderSql(p.order);
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
  if (p.ids !== undefined) {
    where.push(snapshotIdSelectionPredicate("container", p.ids.length));
    binds.push(...p.ids);
  }
  if (p.serialNumber !== undefined) {
    where.push("c.serial_number = ?");
    binds.push(p.serialNumber);
  }
  if (p.rfid !== undefined) {
    where.push("c.rfid = ?");
    binds.push(p.rfid);
  }
  if (p.materialStream !== undefined) {
    where.push("c.ud_material_stream_ud = ?");
    binds.push(p.materialStream);
  }
  if (p.color !== undefined) {
    where.push("c.color = ?");
    binds.push(p.color);
  }
  if (p.zip !== undefined) {
    where.push("c.zip = ?");
    binds.push(p.zip);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    // One grouped OR over container columns only; all other scopes stay ANDed.
    where.push(
      "(instr(lower(coalesce(c.location_address, '')), lower(?)) > 0 OR instr(lower(coalesce(c.serial_number, '')), lower(?)) > 0 OR instr(lower(coalesce(c.city, '')), lower(?)) > 0 OR instr(lower(coalesce(c.zip, '')), lower(?)) > 0)"
    );
    const qv = p.q.trim();
    binds.push(qv, qv, qv, qv);
  }
  if (p.enabled === "true") {
    where.push("c.enabled = 1");
  }
  if (p.enabled === "false") {
    where.push("c.enabled = 0");
  }
  if (p.cursor !== undefined) {
    where.push(`c.container_id ${order.seek} ?`);
    binds.push(p.cursor);
  }
  // Caller-held inclusive ceiling on the container primary key (never the
  // joined address key): a fixed bound shared with the COUNT below through
  // the same where/binds. An ascending cursor at or above the cap matches
  // nothing; descending seeks retain this same inclusive cap.
  if (p.upperId !== undefined) {
    where.push("c.container_id <= ?");
    binds.push(p.upperId);
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
      ? `ORDER BY c.container_id${order.suffix} LIMIT ?`
      : `ORDER BY c.container_id${order.suffix} LIMIT ? OFFSET ?`;
  const pageLimit = p.limit + (p.exactNext === "true" ? 1 : 0);
  const pageBinds = p.cursor !== undefined ? [pageLimit] : [pageLimit, p.offset];
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
  const rows = p.exactNext === "true" ? (results ?? []).slice(0, p.limit) : results ?? [];
  const nextCursor =
    (p.exactNext === "true" ? (results?.length ?? 0) > p.limit : rows.length === p.limit) ? Number((rows[rows.length - 1] as Record<string, unknown>).container_id) : null;
  // Sparse fieldset: same page, same envelope — only each row's keys shrink.
  // The id stays on every row even when the selector omits it.
  const fields = p.fields;
  const out =
    fields === undefined
      ? rows
      : rows.map((row) =>
          projectSnapshotRow("container", row as Record<string, unknown>, fields)
        );
  // Echo an explicitly requested direction/count-mode into the follow-next
  // target. Raw presence is safe here: validation already rejected
  // repeated/invalid values, while the zod defaults erase explicitness.
  const nextLink = snapshotNextLink(
    "container",
    {
      ...p,
      // Carry the effective needle; blank q adds no predicate or next-link key.
      q: p.q === undefined || p.q.trim() === "" ? undefined : p.q.trim(),
      order: c.req.query("order") === undefined ? undefined : p.order,
      includeTotal: c.req.query("includeTotal") === undefined ? undefined : p.includeTotal
    },
    nextCursor
  );
  if (nextLink !== null) c.header("Link", nextLink);
  return snapshotListJsonResponse(c, { rows: out, total, nextCursor });
});

const containerSnapshotExportRoute = createRoute({
  method: "get",
  path: "/api/v1/container-snapshot/export",
  operationId: "exportContainerSnapshot",
  "x-access": "sync-secret",
  "x-effect": "local-read",
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
    401: { description: "Unauthorized" },
    503: {
      description: "Snapshot export query budget exceeded before CSV starts (application/problem+json, snapshot-export-query-budget). Review SNAPSHOT_EXPORT_PAGE_SIZE using CUSTOMER_SNAPSHOT.md#csv-export-page-sizing."
    }
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
    readSnapshotExportPageSize(c.env),
    c.env
  );
});

const containerSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/container-snapshot/{containerId}",
  operationId: "getContainerSnapshot",
  "x-access": "read",
  "x-effect": "local-read",
  tags: ["container-snapshot"],
  summary: "Get one container snapshot row",
  description:
    "Reads one row from the daily snapshot DB by `containerId`. Bearer-gated like every `/api/v1/*` route except `GET /api/v1/health`. Returns 404 when no row exists for that id.",
  request: {
    params: z.object({ containerId: z.coerce.number().int().openapi({ example: 100 }) }),
    headers: snapshotByIdConditional.headers,
    query: z.object({ fields: snapshotFieldsQuery("container") })
  },
  responses: {
    200: {
      description: "Row",
      headers: { ...snapshotByIdConditional.etagHeaders },
      content: {
        "application/json": {
          schema: containerSnapshotRowSchema,
          example: containerRowExample
        }
      }
    },
    304: snapshotByIdConditional.notModified,
    400: {
      description:
        "Invalid id or fields selector (application/problem+json). An unknown/empty/duplicate `fields` name is rejected before any D1 query runs."
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
  const fields = c.req.valid("query").fields;
  return snapshotByIdConditional.jsonResponse(c, fields === undefined ? row : projectSnapshotRow("container", row, fields));
});

const containerSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/container-snapshot/sync",
  operationId: "syncContainerSnapshot",
  "x-access": "sync-secret",
  "x-effect": "upstream-read-local-sync",
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
  const unknownQuery = rejectUnknownSnapshotPostQuery(c, SNAPSHOT_POST_QUERY_KEYS);
  if (unknownQuery) return unknownQuery;
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
  operationId: "importContainerSnapshot",
  "x-access": "sync-secret",
  "x-effect": "local-write",
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
        "Invalid CSV or empty body (application/problem+json). Required identity headers must be unambiguous and primary/relationship cells must be positive safe whole-decimal integers, including dryRun. Identity errors identify table, logical row and field without submitted values; correct the CSV and retry. Earlier valid flushed batches may remain committed."
    }
  }
});

containerSnapshotRoutes.openapi(containerSnapshotImportRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const unknownQuery = rejectUnknownSnapshotPostQuery(c, SNAPSHOT_POST_QUERY_KEYS);
  if (unknownQuery) return unknownQuery;
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
      strictImportIdentities: true,
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
