import { createRoute, z } from "@hono/zod-openapi";
import { rejectUnknownSnapshotListQuery, snapshotStrictQuery } from "../lib/snapshotStrictQuery";
import { addressRowExample, addressExportExample } from "./payloadExamples";
import { addressSnapshotListResponse, addressSnapshotRowSchema } from "./snapshotRowSchemas";
import { snapshotSearchQuery } from "../lib/snapshotSearchQuery";
import { snapshotCountOnlyQuery, snapshotCountModeCompatible, snapshotListModeExamples } from "../lib/snapshotCountOnly";
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
  runAddressSnapshotSync,
  syncAddressSnapshotFromStream
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
  ADDRESS_SNAPSHOT_EXPORT,
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

/** D1 address snapshot: reads plus the CSV sync/import writers. */
export const addressSnapshotRoutes = createRouteModule();

const addressSnapshotListRoute = createRoute({
  method: "get",
  path: "/api/v1/address-snapshot",
  operationId: "listAddressSnapshot",
  "x-access": "read",
  "x-effect": "local-read",
  tags: ["address-snapshot"],
  summary: "List address snapshot rows (D1)",
  description:
    "Routeware addresses (`PickupAddressID` → `CustomerID`). Optional filters: `customerId`, `pickupAddressId`, `ids`, exact `routeId`, `franchiseId`, stored `zip`, `city` and `state`, and case-sensitive `streetAddress` (all exact stored street matches, not city/ZIP or partial-street matches), free-text `q` over street, city or zip (a match in any one column), literal stored `driverNote` substring on `driver_note` only (not comments/locality), `enabled`, stored `extrasAllowed`, mirrored-child `hasContainers`, exact stored `lastAuditDate` equality and stored `hasLastAuditDate` presence on `last_audit_date`, and NULL-only stored-pair `hasCoordinates` (not geographic validity). Supplied filters intersect by AND; null scope columns do not match supplied values. City/state/street-only equality, driverNote-only substring and audit-date-only reads may scan without a dedicated index; none is added. No geography inference, normalization, note interpretation, audit-compliance/scheduling/overdue meaning or operational scheduling/accuracy claim. Stored text is mirrored data, not permission to act. This GET is idempotent and local-read. Pass `cursor` (the previous page's `nextCursor`) instead of `offset` to page deep result sets by primary-key seek instead of a scanned OFFSET; `upperId` caps either traversal.",
  request: {
    headers: snapshotListConditionalHeaders,
    query: z.object({
      customerId: z.coerce.number().int().optional().openapi({ example: 345734 }),
      pickupAddressId: z.coerce.number().int().optional().openapi({ example: 10 }),
      ids: snapshotIdSelectionQuery(),
      routeId: z.string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .refine((value) => Number.isSafeInteger(Number(value)) && String(Number(value)) === value)
        .transform(Number)
        .optional()
        .describe("Exact route equality: one unpadded ASCII decimal safe integer, 0..9007199254740991. Zero matches literal stored 0, not all routes. No signs, whitespace, fractions, exponents or repeated keys. Correct the format and retry.")
        .openapi({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, example: 7 }),
      franchiseId: z.string()
        .refine((value) => value.trim().length > 0 && [...value].length <= 100)
        .optional()
        .describe("Opaque case-sensitive exact franchise equality: 1..100 Unicode code points. Leading zeros and nonblank whitespace are preserved, not trimmed. Blank/whitespace-only values and repeated keys are invalid. URL-encode the value, send one key and retry.")
        .openapi({ type: "string", minLength: 1, maxLength: 100, example: "001" }),
      zip: z.string()
        .refine((value) => value.trim().length > 0 && [...value].length <= 100)
        .optional()
        .describe("Opaque case-sensitive exact stored-zip equality: 1..100 Unicode code points. Leading zeros and nonblank whitespace are preserved, not trimmed. Blank/whitespace-only values and repeated keys are invalid. URL-encode the value, send one key and retry.")
        .openapi({ type: "string", minLength: 1, maxLength: 100, example: "02139" }),
      streetAddress: z.string()
        .refine((value) => value.trim().length > 0 && [...value].length <= 200)
        .optional()
        .describe("Opaque case-sensitive exact stored-street equality: 1..200 Unicode code points containing a non-whitespace character. Preserve nonblank whitespace, punctuation and leading zeros; no normalization, postal verification, geocoding or uniqueness guarantee. Null never matches; all matching sites are returned. Empty, whitespace-only, overlength and repeated values are invalid. URL-encode one nonblank stored street value or omit streetAddress and retry. Equality may scan without a dedicated index.")
        .openapi({ type: "string", minLength: 1, maxLength: 200, example: "001 Cedar St" }),
      city: z.string()
        .refine((value) => value.trim().length > 0 && [...value].length <= 100)
        .optional()
        .describe("Opaque case-sensitive exact stored-city equality: 1..100 Unicode code points, including a non-whitespace character. Nonblank whitespace and punctuation are preserved, not trimmed or normalized. Blank/whitespace-only values and repeated keys are invalid. URL-encode the value, send one key and retry.")
        .openapi({ type: "string", minLength: 1, maxLength: 100, example: "Killeen" }),
      state: z.string()
        .refine((value) => value.trim().length > 0 && [...value].length <= 100)
        .optional()
        .describe("Opaque case-sensitive exact stored-state equality: 1..100 Unicode code points, including a non-whitespace character. Nonblank whitespace and punctuation are preserved, not trimmed or normalized; no abbreviation conversion or state enum. Blank/whitespace-only values and repeated keys are invalid. URL-encode the value, send one key and retry.")
        .openapi({ type: "string", minLength: 1, maxLength: 100, example: "TX" }),
      driverNote: snapshotSearchQuery.optional()
        .describe("Literal substring on stored driver_note only, not comments or locality. Maximum 100 Unicode code points before trimming; trim boundaries, blank means omitted, null acts as empty. ASCII case-insensitive only (SQLite lower preserves non-ASCII case distinctions); no LIKE wildcards. Send one driverNote key or omit it and retry.")
        .openapi({ example: "Use side gate" }),
      q: snapshotSearchQuery.optional().describe("Substring on street, city or zip — a match in any one column (ASCII case-insensitive; SQLite lower() preserves non-ASCII case distinctions; maximum 100 Unicode code points)").openapi({ example: "Main" }),
      enabled: z.enum(["true", "false", "any"]).optional().default("any").openapi({ example: "true" }),
      hasCoordinates: z.enum(["true", "false", "any"]).optional().default("any")
        .describe('Stored-pair NULL-only presence: "true" requires both latitude and longitude non-null; "false" requires either SQL NULL; "any" or omission adds no filter. TEXT including zero, negative-looking, empty, whitespace and non-numeric strings counts as present when non-null. Not valid/complete geographic coordinates, accuracy, GPS lock or live position. Disabled rows remain eligible. May scan; no dedicated index or performance claim. Send one hasCoordinates=true, false or any, or omit the selector and retry.')
        .openapi({ example: "false" }),
      extrasAllowed: z.enum(["true", "false", "any"]).optional().default("any")
        .describe("Stored extras-allowed equality: true matches stored extras_allowed = 1, false matches stored 0, any (default) adds no predicate. The flag is stored snapshot state from the last sync, not permission to mutate service terms or proof of current upstream policy. Exact case-sensitive spelling, sent once; malformed, blank or repeated keys are invalid. Correct the value and retry.")
        .openapi({ example: "true" }),
      hasContainers: z.enum(["true", "false", "any"]).optional().default("any")
        .describe("Mirrored container presence: \"true\" keeps only addresses with at least one stored container row, \"false\" keeps only addresses with none. Counts every stored child including disabled containers; address enabled stays independent. Absence means no currently mirrored child, not proof the upstream site is empty and not authorization to delete or reconcile.")
        .openapi({ example: "true" }),
      lastAuditDate: z.string()
        .refine((value) => value.trim().length > 0 && [...value].length <= 100)
        .optional()
        .describe("Opaque case-sensitive exact stored audit-date equality on `last_audit_date`: 1..100 Unicode code points, including a non-whitespace character. Supplied text is preserved verbatim and bound with `=`; it is never parsed as a date, range or schedule. Null never matches a supplied value; an unknown value returns 200 empty. AND-composes with `hasLastAuditDate` and every other filter; stored mirror text only, not audit compliance or permission to act. Blank/whitespace-only, overlength and repeated keys are invalid. URL-encode the value, send one key and retry.")
        .openapi({ type: "string", minLength: 1, maxLength: 100, example: "2026-01-15" }),
      hasLastAuditDate: z.enum(["true", "false", "any"]).optional().default("any")
        .describe("Stored audit-date presence on `last_audit_date`: \"true\" keeps only rows whose stored text is present (not null and not empty; whitespace-only counts as present), \"false\" keeps only null-or-empty rows, \"any\" (default) adds no predicate. Exact value and presence AND-compose; an exact value plus false matches nothing. Mirror text only, not audit compliance, schedule, overdue status or permission to act. Exact case-sensitive spelling, sent once; malformed, blank or repeated keys are invalid. Correct the value and retry.")
        .openapi({ example: "true" }),
      limit: z.coerce.number().int().min(1).max(500).default(50).openapi({ example: 50 }),
      offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
      cursor: z.coerce
        .number()
        .int()
        .optional()
        .describe("Last pickup_address_id from the previous page's nextCursor in the same order; takes precedence over offset. Changing direction starts a new traversal.")
        .openapi({ example: 9 }),
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
      fields: snapshotFieldsQuery("address"), countOnly: snapshotCountOnlyQuery, strictQuery: snapshotStrictQuery
    }).refine(snapshotCountModeCompatible, { path: ["countOnly"] })
  },
  responses: {
    200: {
      description: "Rows and total",
      headers: { ...snapshotListEtagHeaders, Link: snapshotNextLinkHeader },
      content: {
        "application/json": {
          schema: addressSnapshotListResponse,
          examples: snapshotListModeExamples(addressRowExample)
        }
      }
    },
    304: snapshotListNotModifiedResponse,
    400: {
      description:
        "Invalid query (application/problem+json), rejected before any D1 query. streetAddress must be one nonblank stored street value of 1..200 Unicode code points; empty, whitespace-only, overlength and repeated values are invalid. URL-encode one nonblank stored street value or omit streetAddress and retry. strictQuery=true rejects unknown decoded names with fixed value-free guidance before D1/304; use supported names from this mounted OpenAPI operation, remove unknown keys, or set strictQuery=false. Send strictQuery once as exact true or false (default false); invalid/empty/repeated values fail before D1. Send `routeId` as one exact unpadded ASCII nonnegative safe integer, `franchiseId` as one nonblank opaque string of 1..100 Unicode code points, and `zip`, `city` and `state` each as one nonblank exact stored string of 1..100 Unicode code points; empty/whitespace-only, overlength and repeated scope keys are invalid. URL-encode one nonblank value for each named string field and retry without trimming significant whitespace. Repeated or overlength `driverNote` is invalid: send one driverNote of at most 100 Unicode code points before trimming, or omit it and retry; blank is omitted. Send `lastAuditDate` as one nonblank exact stored string of 1..100 Unicode code points; empty/whitespace-only, overlength and repeated keys are invalid. Send `hasLastAuditDate` once as exact true, false or any (default any); invalid/blank/repeated values fail before D1. The validator also rejects `q` longer than 100 Unicode code points, an out-of-range `limit`/`offset`, an unknown `enabled` or `extrasAllowed` value, an unknown `hasContainers` value, an invalid/empty/repeated `hasCoordinates` value (send one hasCoordinates=true, false or any, or omit it), an unknown/empty/duplicate `fields` selector, invalid/repeated `order`, or an invalid `ids` primary-ID selector (empty, over-50, duplicate, repeated-key, or non-canonical member). Send order=asc or order=desc exactly (case-sensitive), or omit it for asc. Invalid/repeated exactNext is rejected; send one exactNext=true or false, or omit it and retry. Errors name fields, never submitted values. Correct the named field and retry. See docs/PROBLEMS.md#bad-request."
    }
  }
});

addressSnapshotRoutes.openapi(addressSnapshotListRoute, async (c) => {
  const p = c.req.valid("query");
  const unknownQuery = rejectUnknownSnapshotListQuery(c, p.strictQuery, addressSnapshotListRoute.request.query);
  if (unknownQuery) return unknownQuery;
  const order = snapshotOrderSql(p.order);
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
  if (p.ids !== undefined) {
    where.push(snapshotIdSelectionPredicate("address", p.ids.length));
    binds.push(...p.ids);
  }
  if (p.routeId !== undefined) {
    where.push("route_id = ?");
    binds.push(p.routeId);
  }
  if (p.franchiseId !== undefined) {
    where.push("franchise_id = ?");
    binds.push(p.franchiseId);
  }
  if (p.zip !== undefined) {
    where.push("zip = ?");
    binds.push(p.zip);
  }
  if (p.streetAddress !== undefined) {
    where.push("address = ?");
    binds.push(p.streetAddress);
  }
  if (p.city !== undefined) {
    where.push("city = ?");
    binds.push(p.city);
  }
  if (p.state !== undefined) {
    where.push("state = ?");
    binds.push(p.state);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    // Locality search: one parenthesized OR across street, city and zip,
    // AND-composed with every other filter by the shared where/binds join.
    // Postcodes stay opaque text (leading zeros significant); no LIKE, no
    // numeric conversion, no state or geographic expansion.
    where.push(
      "(instr(lower(coalesce(address, '')), lower(?)) > 0 OR instr(lower(coalesce(city, '')), lower(?)) > 0 OR instr(lower(coalesce(zip, '')), lower(?)) > 0)"
    );
    const needle = p.q.trim();
    binds.push(needle, needle, needle);
  }
  if (p.driverNote !== undefined && p.driverNote.trim() !== "") {
    where.push("instr(lower(coalesce(driver_note, '')), lower(?)) > 0");
    binds.push(p.driverNote.trim());
  }
  if (p.enabled === "true") {
    where.push("enabled = 1");
  }
  if (p.enabled === "false") {
    where.push("enabled = 0");
  }
  // Stored-state equality, not a live policy assertion: literal predicates,
  // no binds, shared with COUNT through the same where/binds below.
  if (p.extrasAllowed === "true") {
    where.push("extras_allowed = 1");
  }
  if (p.extrasAllowed === "false") {
    where.push("extras_allowed = 0");
  }
  // Mirrored-child presence: a correlated EXISTS over the child's existing
  // pickup_address_id index. No join (parent rows never multiply), no binds
  // (the enum becomes a predicate, not a value), no child payload expansion.
  // Disabled children count as present; any/omission adds no predicate.
  if (p.hasContainers === "true") {
    where.push("EXISTS (SELECT 1 FROM container_snapshot WHERE container_snapshot.pickup_address_id = address_snapshot.pickup_address_id)");
  }
  if (p.hasContainers === "false") {
    where.push("NOT EXISTS (SELECT 1 FROM container_snapshot WHERE container_snapshot.pickup_address_id = address_snapshot.pickup_address_id)");
  }
  if (p.hasCoordinates === "true") {
    where.push("(latitude IS NOT NULL AND longitude IS NOT NULL)");
  }
  if (p.hasCoordinates === "false") {
    where.push("(latitude IS NULL OR longitude IS NULL)");
  }
  // Stored audit-date selection: opaque text equality and null-or-empty
  // presence, shared with COUNT through the same where/binds. The exact value
  // binds verbatim (never trimmed, parsed or pattern-matched); null stored
  // text never matches a supplied value. Presence complements are exact:
  // whitespace-only stored text counts as present.
  if (p.lastAuditDate !== undefined) {
    where.push("last_audit_date = ?");
    binds.push(p.lastAuditDate);
  }
  if (p.hasLastAuditDate === "true") {
    where.push("last_audit_date IS NOT NULL AND last_audit_date <> ''");
  }
  if (p.hasLastAuditDate === "false") {
    where.push("(last_audit_date IS NULL OR last_audit_date = '')");
  }
  if (p.cursor !== undefined) {
    where.push(`pickup_address_id ${order.seek} ?`);
    binds.push(p.cursor);
  }
  // Caller-held inclusive ceiling: a fixed primary-key bound shared with the
  // COUNT below through the same where/binds. An ascending cursor at or above
  // the cap matches nothing; descending seeks retain this same inclusive cap.
  if (p.upperId !== undefined) {
    where.push("pickup_address_id <= ?");
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
      .prepare(`SELECT COUNT(*) as n FROM address_snapshot WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>();
    total = totalRow?.n ?? 0;
  }
  if (p.countOnly === "true") {
    return snapshotListJsonResponse(c, { rows: [], total, nextCursor: null });
  }
  const pageSql =
    p.cursor !== undefined
      ? `ORDER BY pickup_address_id${order.suffix} LIMIT ?`
      : `ORDER BY pickup_address_id${order.suffix} LIMIT ? OFFSET ?`;
  const pageLimit = p.limit + (p.exactNext === "true" ? 1 : 0);
  const pageBinds = p.cursor !== undefined ? [pageLimit] : [pageLimit, p.offset];
  const { results } = await db
    .prepare(
      `SELECT pickup_address_id, customer_id, route_id, address, city, state, zip, franchise_id, comments,
              extras_allowed, enabled, driver_note, latitude, longitude, last_audit_date, synced_at
       FROM address_snapshot WHERE ${whereSql} ${pageSql}`
    )
    .bind(...binds, ...pageBinds)
    .all();
  const rows = p.exactNext === "true" ? (results ?? []).slice(0, p.limit) : results ?? [];
  const nextCursor =
    (p.exactNext === "true" ? (results?.length ?? 0) > p.limit : rows.length === p.limit)
      ? Number((rows[rows.length - 1] as Record<string, unknown>).pickup_address_id)
      : null;
  // Sparse fieldset: same page, same envelope — only each row's keys shrink.
  // The id stays on every row even when the selector omits it.
  const fields = p.fields;
  const out =
    fields === undefined
      ? rows
      : rows.map((row) =>
          projectSnapshotRow("address", row as Record<string, unknown>, fields)
        );
  // Echo an explicitly requested direction/count-mode into the follow-next
  // target. Raw presence is safe here: validation already rejected
  // repeated/invalid values, while the zod defaults erase explicitness.
  const nextLink = snapshotNextLink(
    "address",
    {
      ...p,
      // The continuation spells the effective trimmed needle: matching trims
      // q, so the Link carries the value that actually filtered this page. A
      // blank q filtered nothing and stays out of the target.
      q: p.q === undefined || p.q.trim() === "" ? undefined : p.q.trim(),
      driverNote: p.driverNote === undefined || p.driverNote.trim() === "" ? undefined : p.driverNote.trim(),
      order: c.req.query("order") === undefined ? undefined : p.order,
      includeTotal: c.req.query("includeTotal") === undefined ? undefined : p.includeTotal
    },
    nextCursor
  );
  if (nextLink !== null) c.header("Link", nextLink);
  return snapshotListJsonResponse(c, { rows: out, total, nextCursor });
});

const addressSnapshotExportRoute = createRoute({
  method: "get",
  path: "/api/v1/address-snapshot/export",
  operationId: "exportAddressSnapshot",
  "x-access": "sync-secret",
  "x-effect": "local-read",
  tags: ["address-snapshot"],
  summary: "Download address snapshot as CSV",
  description:
    "Streams every `address_snapshot` row as CSV (`Content-Disposition: attachment`, filename `address-snapshot.csv`) in `pickup_address_id` order. Reads in keyset pages so a full-table export never buffers the table in memory. Emits a content-hash `ETag`; replay it as `If-None-Match` for a `304` with an empty body. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`.",
  responses: {
    200: {
      description: "CSV download (header line plus one line per row)",
      content: { "text/csv": { schema: z.string(), example: addressExportExample } }
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
addressSnapshotRoutes.openapi(addressSnapshotExportRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  return snapshotCsvResponse(
    c.env.CUSTOMER_DB,
    ADDRESS_SNAPSHOT_EXPORT,
    c.req.header("if-none-match"),
    readSnapshotExportPageSize(c.env),
    c.env
  );
});

const addressSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/address-snapshot/{pickupAddressId}",
  operationId: "getAddressSnapshot",
  "x-access": "read",
  "x-effect": "local-read",
  tags: ["address-snapshot"],
  summary: "Get one address snapshot row",
  description:
    "Reads one row from the daily snapshot DB by `pickupAddressId`. Bearer-gated like every `/api/v1/*` route except `GET /api/v1/health`. Returns 404 when no row exists for that id.",
  request: {
    params: z.object({ pickupAddressId: z.coerce.number().int().openapi({ example: 10 }) }),
    headers: snapshotByIdConditional.headers,
    query: z.object({ fields: snapshotFieldsQuery("address") })
  },
  responses: {
    200: {
      description: "Row",
      headers: { ...snapshotByIdConditional.etagHeaders },
      content: {
        "application/json": {
          schema: addressSnapshotRowSchema,
          example: addressRowExample
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

addressSnapshotRoutes.openapi(addressSnapshotByIdRoute, async (c) => {
  const id = parsePositiveIdParam(c.req.param("pickupAddressId"));
  if (id === null) {
    return problemJsonResponse({
      type: problemType("bad-request", c.env),
      title: "Bad Request",
      status: 400,
      detail:
        "pickupAddressId must be a positive integer. See docs/PROBLEMS.md#bad-request.",
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
  const fields = c.req.valid("query").fields;
  return snapshotByIdConditional.jsonResponse(c, fields === undefined ? row : projectSnapshotRow("address", row, fields));
});

const addressSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/address-snapshot/sync",
  operationId: "syncAddressSnapshot",
  "x-access": "sync-secret",
  "x-effect": "upstream-read-local-sync",
  tags: ["address-snapshot"],
  summary: "Fetch address report CSV and upsert D1",
  description:
    "Same bearer as `customer-snapshot` sync. Requires `ADDRESS_REPORT_EXPORT_PATH` or `ADDRESS_REPORT_QUERY_ID`. Customers should exist in D1 (run customer import/sync first) so `customer_id` foreign keys are satisfied. Pass `?dryRun=true` to run the full parse/validate path, return the counts that WOULD apply, and write nothing (no D1, no R2).",
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

addressSnapshotRoutes.openapi(addressSnapshotSyncRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const misconfigured = requireSnapshotSecret(c);
  if (misconfigured) return misconfigured;
  const unknownQuery = rejectUnknownSnapshotPostQuery(c, SNAPSHOT_POST_QUERY_KEYS);
  if (unknownQuery) return unknownQuery;
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
    // `?dryRun=true` runs the full parse/validate path and returns
    // the would-be counts while writing nothing (no D1, no R2).
    // Forward a valid inbound `x-run-id` so this invocation's
    // lines share the originating run's correlation id. Invalid values are
    // dropped — correlation must never fail a sync.
    const runId = parseRunIdHeader(c.req.header("x-run-id"));
    const r = await runAddressSnapshotSync(c.env, {
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

const addressSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/address-snapshot/import",
  operationId: "importAddressSnapshot",
  "x-access": "sync-secret",
  "x-effect": "local-write",
  tags: ["address-snapshot"],
  summary: "Import address CSV body into D1",
  description: "Raw CSV (Routeware Address Details custom report); `Content-Type: text/csv` or `application/octet-stream`. Bear the same secret; import **customers** first to satisfy `customer_id` foreign keys. Pass `?dryRun=true` to validate and return the would-be counts without writing D1.",
  request: {
    query: dryRunQuery,
    body: {
      description: "Routeware Address Details CSV (header + data rows — see example)",
      content: {
        "text/csv": {
          // Plain SchemaObject, not a zod schema: docs-only, no runtime
          // validator is installed (the handler streams the raw body).
          schema: { type: "string" },
          example:
            "PickupAddressID,CustomerID,RouteID,Address,City,State,Zip,FranchiseID,Comments,ExtrasAllowed,Enabled,DriverNote,Latitude,Longitude,Last_Audit_Date\n10,5,,1 Main St,Killeen,TX,76541,,,false,true,,,,"
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

addressSnapshotRoutes.openapi(addressSnapshotImportRoute, async (c) => {
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
    const r = await syncAddressSnapshotFromStream(c.env.CUSTOMER_DB, body, undefined, {
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
