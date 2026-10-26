import { createRoute, z } from "@hono/zod-openapi";
import { rejectUnknownSnapshotListQuery } from "../lib/snapshotStrictQuery";
import { customerRowExample, customerExportExample } from "./payloadExamples";
import { customerSnapshotListResponse, customerSnapshotRowSchema } from "./snapshotRowSchemas";
import { snapshotOrderSql } from "../lib/snapshotListOrder";
import { snapshotNextLink, snapshotNextLinkHeader } from "../lib/snapshotNextLink";
import { customerChangesNextLink, customerChangesNextLinkHeader } from "../lib/customerChangesNextLink";
import { customerChangesSinceQuery, customerChangesUntilQuery } from "../lib/customerChangesTimestamp";
import { customerSnapshotChangesRow } from "../lib/customerChangesRow";
import { projectSnapshotRow, snapshotFieldsQuery } from "../lib/sparseFieldsets";
import { snapshotIdSelectionPredicate } from "../lib/snapshotIdSelection";
import { customerSnapshotListQuery } from "../lib/customerSnapshotListQuery";
import { customerAddressCohortPredicate, customerAddressPresencePredicate, customerContainerPresencePredicate, customerPhoneFragmentPredicate, customerPhonePresencePredicate } from "../lib/snapshotCustomerSelectors";
import { snapshotListModeExamples } from "../lib/snapshotCountOnly";
import {
  snapshotListConditionalHeaders,
  snapshotListEtagHeaders,
  snapshotListNotModifiedResponse,
  snapshotListJsonResponse
} from "../lib/snapshotListConditional";
import { snapshotByIdConditional } from "../lib/snapshotByIdConditional";
import {
  runCustomerSnapshotSync,
  syncCustomerSnapshotFromStream
} from "../lib/d1SnapshotSync";
import { parseRunIdHeader } from "../lib/snapshot/orchestration";
// Guard values come from the deep module, not the facade: `test/snapshotRoutes.test.ts`
// mocks `../lib/d1SnapshotSync` with only the six sync functions, so any other
// facade import throws at module scope there. The deep module is never mocked.
import { InvalidSnapshotCsvError, SNAPSHOT_IMPORT_MAX_BYTES, isSnapshotTooLarge } from "../lib/snapshot/streamSync";
import {
  CUSTOMER_SNAPSHOT_EXPORT,
  readSnapshotExportPageSize,
  snapshotCsvResponse
} from "../lib/snapshot/export";
import { invalidateDataEntity } from "../lib/entityDataCache";
import { problemJsonResponse, problemType } from "../lib/problem";
import { isForeignKeyConstraintFailure } from "../lib/snapshot/upsert";
import {
  SNAPSHOT_POST_QUERY_KEYS,
  createRouteModule,
  dryRunQuery,
  isDryRunRequested,
  rejectUnknownSnapshotPostQuery,
  requireSnapshotAuth,
  requireSnapshotSecret,
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
  "x-access": "read",
  "x-effect": "local-read",
  tags: ["customer-snapshot"],
  summary: "List customer snapshot rows (D1)",
  description:
    "Reads the cached Routeware customer CSV (see `CUSTOMER_SNAPSHOT.md`). Filter by `customerId`, stored-classification `customerTypeId`, exact `customerNumber` and/or `subCustomerNumber`, customer-name substring `q` (a match in any one of `company_name`, `first_name` or `last_name`), stored-phone substring `phone`, `enabled`, or mirrored-child `hasAddresses`; all supplied filters are AND-composed. Business numbers are case-sensitive opaque strings, not unique keys: return every matching customer_id, including duplicate business references. Null stored numbers do not match strings. `phone` is an ASCII case-insensitive substring over the stored `phone1`/`phone2` text (SQLite lower() folds A-Z only, so non-ASCII case variants match only on exact case; no normalization or digit-stripping), so a last-seven-digits fragment resolves its owner without downloading every customer. Substring-only selections (`q` or `phone` without a selective predicate) scan the table: no phone index exists and none is added. Pass `cursor` (the previous page's `nextCursor`) instead of `offset` to page deep result sets by primary-key seek instead of a scanned OFFSET. **Try it:** authorize with `SHADOW_API_TOKEN` (or `SHADOW_API_READ_TOKEN` for GET-only access), select Test Request, and Send with `limit=10` and `enabled=true`. This only reads local D1; it does not import, sync, or contact Routeware.",
  request: {
    headers: snapshotListConditionalHeaders,
    // Query contract lives in `src/lib/customerSnapshotListQuery.ts` so this
    // file stays under the 800-line source guard; the object is referenced,
    // not copied, so validation and OpenAPI stay identical.
    query: customerSnapshotListQuery
  },
  responses: {
    200: {
      description: "Rows and total count for pagination",
      headers: { ...snapshotListEtagHeaders, Link: snapshotNextLinkHeader },
      content: {
        "application/json": {
          schema: customerSnapshotListResponse,
          examples: snapshotListModeExamples(customerRowExample)
        }
      }
    },
    304: snapshotListNotModifiedResponse,
    400: {
      description:
        "Invalid query (application/problem+json). strictQuery=true rejects unknown decoded names with fixed value-free guidance before D1/304; use supported names from this mounted OpenAPI operation, remove unknown keys, or set strictQuery=false. Send strictQuery once as exact true or false (default false); invalid/empty/repeated values fail before D1. The zod validator rejects empty, whitespace-only, repeated or over-100-Unicode-code-point `customerNumber`/`subCustomerNumber`, a non-canonical `customerTypeId` (anything but one unpadded ASCII nonnegative safe integer), blank, repeated or over-100-Unicode-code-point `phone` (1..100 Unicode code points, never whitespace-only), `q` longer than 100 Unicode code points, repeated or overlength `comments` (send one comments fragment of at most 100 Unicode code points before trimming, or omit comments and retry; blank is omitted), an out-of-range `limit`/`offset`, an unknown `enabled` value, invalid/empty/repeated `hasAddresses` (send one hasAddresses=true, false or any, or omit the selector and retry), invalid/empty/repeated `hasContainers` (send one hasContainers=true, false or any, or omit the selector and retry), invalid/empty/repeated `addressRouteId` (send one canonical unpadded nonnegative ASCII safe integer, or omit it and retry), invalid/blank/overlength/repeated `addressFranchiseId` (send one nonblank opaque string of 1..100 Unicode code points, or omit it and retry), invalid/empty/repeated `addressEnabled` (send one addressEnabled=true, false or any, or omit the selector and retry), invalid/empty/repeated `addressExtrasAllowed` (send one addressExtrasAllowed=true, false or any, or omit the selector and retry), invalid/blank/overlength/repeated `addressLastAuditDate` (send one nonblank addressLastAuditDate of 1..100 Unicode code points, or omit it and retry), invalid/empty/repeated `hasPhone1`/`hasPhone2` (send one hasPhone1=true, false or any and one hasPhone2=true, false or any, or omit the selectors and retry), an unknown/empty/duplicate `fields` selector, invalid/repeated `order`, or an invalid `ids` primary-ID selector (empty, over-50, duplicate, repeated-key, or non-canonical member) before any D1 query runs. Supply each account-number key once with 1..100 Unicode code points including a non-whitespace character, or omit it, then retry. Send customerTypeId once as unpadded ASCII digits from 0 to 9007199254740991, or omit it. Send a single nonblank `phone` of 1..100 Unicode code points, or omit it. Send order=asc or order=desc exactly (case-sensitive), or omit it for asc. Invalid/repeated exactNext is rejected; send one exactNext=true or false, or omit it and retry. Errors name fields, never submitted values; see docs/PROBLEMS.md#bad-request."
    }
  }
});

customerSnapshotRoutes.openapi(customerSnapshotListRoute, async (c) => {
  const p = c.req.valid("query");
  const unknownQuery = rejectUnknownSnapshotListQuery(c, p.strictQuery, customerSnapshotListRoute.request.query);
  if (unknownQuery) return unknownQuery;
  const order = snapshotOrderSql(p.order);
  const db = c.env.CUSTOMER_DB;
  const where: string[] = ["1 = 1"];
  const binds: unknown[] = [];
  if (p.customerId !== undefined) {
    where.push("customer_id = ?");
    binds.push(p.customerId);
  }
  if (p.ids !== undefined) {
    where.push(snapshotIdSelectionPredicate("customer", p.ids.length));
    binds.push(...p.ids);
  }
  // Stored classification equality: one bound predicate shared with the
  // COUNT below. SQL NULL never equals the literal, so null rows simply do
  // not match; omission adds no predicate and preserves previous matches.
  if (p.customerTypeId !== undefined) {
    where.push("customer_type_id = ?");
    binds.push(p.customerTypeId);
  }
  if (p.customerNumber !== undefined) {
    where.push("customer_number = ?");
    binds.push(p.customerNumber);
  }
  if (p.subCustomerNumber !== undefined) {
    where.push("sub_customer_number = ?");
    binds.push(p.subCustomerNumber);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    where.push("(instr(lower(coalesce(company_name, '')), lower(?)) > 0 OR instr(lower(coalesce(first_name, '')), lower(?)) > 0 OR instr(lower(coalesce(last_name, '')), lower(?)) > 0)");
    const qv = p.q.trim();
    binds.push(qv, qv, qv);
  }
  if (p.phone !== undefined) {
    where.push(customerPhoneFragmentPredicate());
    binds.push(p.phone, p.phone);
  }
  if (p.comments !== undefined) {
    where.push("instr(lower(coalesce(comments, '')), lower(?)) > 0");
    binds.push(p.comments);
  }
  if (p.enabled === "true") {
    where.push("enabled = 1");
  }
  if (p.enabled === "false") {
    where.push("enabled = 0");
  }
  if (p.hasAddresses !== "any") where.push(customerAddressPresencePredicate(p.hasAddresses));
  if (p.hasContainers !== "any") where.push(customerContainerPresencePredicate(p.hasContainers));
  const cohort = customerAddressCohortPredicate(p); // One correlated EXISTS, or no predicate.
  if (cohort !== null) { where.push(cohort.sql); binds.push(...cohort.binds); }
  if (p.hasPhone1 !== "any") where.push(customerPhonePresencePredicate("phone1", p.hasPhone1));
  if (p.hasPhone2 !== "any") where.push(customerPhonePresencePredicate("phone2", p.hasPhone2));
  if (p.cursor !== undefined) {
    where.push(`customer_id ${order.seek} ?`);
    binds.push(p.cursor);
  }
  // Inclusive caller-held window shared by COUNT and page in either direction.
  if (p.lowerId !== undefined) { where.push("customer_id >= ?"); binds.push(p.lowerId); }
  if (p.upperId !== undefined) { where.push("customer_id <= ?"); binds.push(p.upperId); }
  const whereSql = where.join(" AND ");
  // Count-free: total null means deliberately not computed, not an empty page.
  let total: number | null;
  if (p.includeTotal === "false") {
    total = null;
  } else {
    const totalRow = await db
      .prepare(`SELECT COUNT(*) as n FROM customer_snapshot WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>();
    total = totalRow?.n ?? 0;
  }
  if (p.countOnly === "true") {
    return snapshotListJsonResponse(c, { rows: [], total, nextCursor: null });
  }
  // Cursor seeks follow the selected direction and never scan an OFFSET.
  const pageSql =
    p.cursor !== undefined
      ? `ORDER BY customer_id${order.suffix} LIMIT ?`
      : `ORDER BY customer_id${order.suffix} LIMIT ? OFFSET ?`;
  const pageLimit = p.limit + (p.exactNext === "true" ? 1 : 0);
  const pageBinds = p.cursor !== undefined ? [pageLimit] : [pageLimit, p.offset];
  const { results } = await db
    .prepare(
      `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
              name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
       FROM customer_snapshot WHERE ${whereSql} ${pageSql}`
    )
    .bind(...binds, ...pageBinds)
    .all();
  const rows = p.exactNext === "true" ? (results ?? []).slice(0, p.limit) : results ?? [];
  const nextCursor =
    (p.exactNext === "true" ? (results?.length ?? 0) > p.limit : rows.length === p.limit) ? Number((rows[rows.length - 1] as Record<string, unknown>).customer_id) : null;
  // Project only after paging; retain the canonical id on every sparse row.
  const fields = p.fields;
  const out =
    fields === undefined
      ? rows
      : rows.map((row) =>
          projectSnapshotRow("customer", row as Record<string, unknown>, fields)
        );
  // Echo an explicitly requested direction/count-mode into the follow-next
  // target. Raw presence is safe here: validation already rejected
  // repeated/invalid values, while the zod defaults erase explicitness.
  const nextLink = snapshotNextLink(
    "customer",
    {
      ...p,
      order: c.req.query("order") === undefined ? undefined : p.order,
      includeTotal: c.req.query("includeTotal") === undefined ? undefined : p.includeTotal
    },
    nextCursor
  );
  if (nextLink !== null) c.header("Link", nextLink);
  return snapshotListJsonResponse(c, { rows: out, total, nextCursor });
});

/**
 * Changes feed: rows touched by the syncs after a client-held cursor.
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
// Own response schema, not `customerSnapshotListResponse`: the changes cursor is the
// composite `(synced_at, customer_id)` pair (`since` + `since_id`), never a
// bare timestamp or a primary-key integer, so sharing the list schema would
// publish (and typecheck) the wrong `nextCursor` type.
const customerSnapshotChangesResponse = z
  .object({
    rows: z.array(customerSnapshotChangesRow).describe("Full customer rows. With fields=, each row contains customer_id plus the selected columns; synced_at is absent unless selected, so sparse rows follow the projection rather than this full-row schema's required set."),
    total: z.number().int().describe("Returned page length: rows.length for this page, never a COUNT query; 0 on an empty tail page."),
    nextCursor: z
      .object({
        since: z.string().datetime(),
        since_id: z.number().int()
      })
      .nullable().describe("Composite resume cursor: pass the whole {since, since_id} pair back as the next request's since + since_id to continue the (synced_at, customer_id) traversal without skipping same-timestamp rows; null at the tail.")
  })
  .openapi("CustomerSnapshotChanges");

const customerSnapshotChangesRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot/changes",
  operationId: "listCustomerSnapshotChanges",
  "x-access": "read",
  "x-effect": "local-read",
  tags: ["customer-snapshot"],
  summary: "List customer snapshot rows changed since a cursor (D1)",
  description:
    "Incremental-sync feed: returns rows with `synced_at > since` in `(synced_at, customer_id)` keyset order. Omit `since` for the first page (equivalent to the epoch — every row is newer). A bare `since` replays every later run whole. To page a chunked delta, pass the previous page's `nextCursor` back as `since` + `since_id`: the composite pair resumes at the boundary timestamp without skipping same-timestamp rows past the page boundary. `limit` caps the page at 1..500 (default 50). Optional `until` adds an inclusive upper bound (`synced_at <= until`, same UTC Z millisecond contract as `since`; normalized `since` must not exceed it) so callers read a finite caller-chosen window instead of chasing newly synced rows; omit it for the unbounded tail. When nextCursor is non-null, follow the relative Link rel=next target instead of rebuilding the cursor: it replaces since and since_id together and retains the effective limit, the normalized until and the validated fields selector. Omission means stop; a full terminal page can link to an empty page, with no lookahead or snapshot-isolation guarantee. Unknown query keys are ignored and never copied into Link. Optional `fields` selects stored customer columns, always retaining `customer_id`; omit it for full rows. Page membership, total (returned page length), order and composite `nextCursor` are computed from full rows before projection, even when `synced_at` is not selected. This is an upserts-only feed over current rows, not historical isolation or a deletion log: concurrent overwrites can move rows outside the window, bulk imports advance timestamps, and bounded traversal does not guarantee completeness.",
  request: {
    query: z.object({
      // Shared lossless chain (`../lib/customerChangesTimestamp`): identical
      // validation/normalization for both endpoints.
      since: customerChangesSinceQuery,
      since_id: z.string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .refine((v) => Number.isSafeInteger(Number(v)))
        .transform(Number)
        .optional()
        .describe("Tiebreak half of the composite cursor; requires a nonempty valid since. Exact unpadded ASCII decimal integer from 0 through 9007199254740991 (0 is the boundary sentinel); no signs, whitespace, exponent, fractions or prefixes. Omit for first pages and bare-since whole-run replays.")
        .openapi({ example: "345733" }),
      // Inclusive upper bound on the same shared chain (empty is a 400 here).
      until: customerChangesUntilQuery,
      limit: z.coerce.number().int().min(1).max(500).default(50).openapi({ example: 50 }),
      fields: snapshotFieldsQuery("customer")
    }).refine((p) => p.since_id === undefined || p.since !== undefined, { path: ["since_id"] })
      // Normalized toISOString by now, so lexical is chronological. Equality
      // stays valid: bare since yields an empty page, composite resumes ties.
      .refine((p) => p.since === undefined || p.until === undefined || p.since <= p.until, { path: ["until"] })
  },
  responses: {
    200: {
      description: "Changed rows in (synced_at, customer_id) order with nextCursor",
      headers: { Link: customerChangesNextLinkHeader },
      content: {
        "application/json": {
          schema: customerSnapshotChangesResponse,
          example: { rows: [customerRowExample], total: 1, nextCursor: null }
        }
      }
    },
    400: {
      description:
        "Invalid query (application/problem+json), rejected before D1. Send a UTC Z datetime with at most millisecond precision and pair since_id only with a nonempty valid since. since_id must be an exact unpadded nonnegative safe-integer decimal; repeated cursor keys are invalid. Optional until is an inclusive synced_at upper bound with the same UTC Z millisecond contract: empty, offset, overprecise and repeated values are invalid, and normalized since must not exceed until. Omit both cursor fields for the first page. For the fields selector, use exact stored customer column names once each: no empty names, spaces, duplicates or repeated keys. Omit fields for full rows. Errors name fields, never submitted values. See docs/PROBLEMS.md#bad-request."
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
  // Caller-held inclusive ceiling, conjoined as a bound `<= ?` with the limit
  // bind last. Omitted `until` keeps the previous SQL/binds untouched.
  const predicates = p.until === undefined ? [where] : [where, "synced_at <= ?"];
  const whereSql = predicates.join(" AND ");
  const binds: unknown[] =
    p.since_id === undefined ? [since] : [since, since, p.since_id];
  if (p.until !== undefined) binds.push(p.until);
  binds.push(p.limit);
  const { results } = await db
    .prepare(
      `SELECT customer_id, customer_type_id, company_name, first_name, middle_initial, last_name,
              name_suffix, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at
       FROM customer_snapshot WHERE ${whereSql} ORDER BY synced_at, customer_id LIMIT ?`
    )
    .bind(...binds)
    .all();
  const rows = results ?? [];
  // Same convention as the list routes: full page ⇒ maybe more.
  // The cursor is the last row's composite pair, so resuming keeps
  // `(synced_at, customer_id)` keyset order with no boundary skip.
  const last = rows.length === p.limit ? (rows[rows.length - 1] as Record<string, unknown>) : null;
  const nextCursor =
    last === null
      ? null
      : { since: String(last.synced_at), since_id: Number(last.customer_id) };
  // Project only after deriving the cursor from full rows: synced_at may be omitted.
  const fields = p.fields;
  const out =
    fields === undefined
      ? rows
      : rows.map((row) =>
          projectSnapshotRow("customer", row as Record<string, unknown>, fields)
        );
  // The next link retains the validated projection and normalized `until` so
  // sparse bounded traversal stays sparse and bounded; absent selectors keep
  // the pre-existing target bytes.
  const nextLink = customerChangesNextLink(nextCursor, p.limit, fields, p.until);
  if (nextLink !== null) c.header("Link", nextLink);
  return c.json({ rows: out, total: rows.length, nextCursor });
});

const customerSnapshotExportRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot/export",
  operationId: "exportCustomerSnapshot",
  "x-access": "sync-secret",
  "x-effect": "local-read",
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
    401: { description: "Unauthorized" },
    503: {
      description: "Snapshot export query budget exceeded before CSV starts (application/problem+json, snapshot-export-query-budget). Review SNAPSHOT_EXPORT_PAGE_SIZE using CUSTOMER_SNAPSHOT.md#csv-export-page-sizing."
    }
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
    readSnapshotExportPageSize(c.env),
    c.env
  );
});

const customerSnapshotByIdRoute = createRoute({
  method: "get",
  path: "/api/v1/customer-snapshot/{customerId}",
  operationId: "getCustomerSnapshot",
  "x-access": "read",
  "x-effect": "local-read",
  tags: ["customer-snapshot"],
  summary: "Get one customer snapshot row",
  description:
    "Reads one row from the daily snapshot DB by `customerId`. Bearer-gated like every `/api/v1/*` route except `GET /api/v1/health`. Returns 404 when no row exists for that id.",
  request: {
    params: z.object({ customerId: z.coerce.number().int().openapi({ example: 345734 }) }),
    headers: snapshotByIdConditional.headers,
    query: z.object({ fields: snapshotFieldsQuery("customer") })
  },
  responses: {
    200: {
      description: "Row",
      headers: { ...snapshotByIdConditional.etagHeaders },
      content: {
        "application/json": {
          schema: customerSnapshotRowSchema,
          example: customerRowExample
        }
      }
    },
    304: snapshotByIdConditional.notModified,
    400: {
      description:
        "Invalid customer id or fields selector (application/problem+json). An unknown/empty/duplicate `fields` name is rejected before any D1 query runs."
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
  const fields = c.req.valid("query").fields;
  return snapshotByIdConditional.jsonResponse(c, fields === undefined ? row : projectSnapshotRow("customer", row, fields));
});

const customerSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/customer-snapshot/sync",
  operationId: "syncCustomerSnapshot",
  "x-access": "sync-secret",
  "x-effect": "upstream-read-local-sync",
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
  const unknownQuery = rejectUnknownSnapshotPostQuery(c, SNAPSHOT_POST_QUERY_KEYS);
  if (unknownQuery) return unknownQuery;
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
  // `?dryRun=true` runs the full parse/validate path and returns
  // the would-be counts while writing nothing (no D1, no R2).
  // Forward a valid inbound `x-run-id` so this invocation's
  // lines share the originating run's correlation id. Invalid values are
  // dropped — correlation must never fail a sync.
  const runId = parseRunIdHeader(c.req.header("x-run-id"));
  const r = await runCustomerSnapshotSync(c.env, {
    dryRun: isDryRunRequested(c.req.valid("query")),
    ...(runId ? { runId } : {})
  });
  if (!r) {
    return c.json({ upserted: 0, rowCount: 0, skipped: true }, 200);
  }
  return c.json(r, 200);
});

const customerSnapshotImportRoute = createRoute({
  method: "post",
  path: "/api/v1/customer-snapshot/import",
  operationId: "importCustomerSnapshot",
  "x-access": "sync-secret",
  "x-effect": "local-write",
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
        "Invalid CSV or empty body (application/problem+json). Required identity headers must be unambiguous and primary/relationship cells must be positive safe whole-decimal integers, including dryRun. Identity errors identify table, logical row and field without submitted values; correct the CSV and retry. Earlier valid flushed batches may remain committed."
    }
  }
});

customerSnapshotRoutes.openapi(customerSnapshotImportRoute, async (c) => {
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
    throw e;
  }
});

/**
 * Customer-row erasure: hard-deletes one `customer_snapshot` row.
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
 * database recovery. Customers erased before the suppression migration have
 * no tombstone; backfill them with privileged `wrangler d1 execute` inserts
 * (see `docs/R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched`).
 * List and remove markers only with privileged `wrangler d1 execute`
 * SELECT/DELETE; there is no marker list or delete route. This route removes
 * only the `customer_snapshot` row:
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
  operationId: "eraseCustomerSnapshot",
  "x-access": "sync-secret",
  "x-effect": "local-write",
  tags: ["customer-snapshot"],
  summary: "Delete one customer snapshot row",
  description:
    "Hard-deletes one `customer_snapshot` row by `customerId` (GDPR-style erasure for the cached report extract — upstream Routeware is untouched). Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Returns 404 when no row exists. Refuses with 400 `bad-request` when address rows still reference the customer — delete the addresses first; the D1 foreign key is never bypassed. A successful delete removes the D1 `customer_snapshot` row and evicts the cached data-entity customer bundle (other edge locations and clients may keep serving the erased PII until the 60 s cache TTL expires). It does not remove R2 history CSVs, daily aliases, latest pointers, or the archived-CSV readback, and it does not touch upstream Routeware. A D1 tombstone suppresses the customer on later sync, proxy-save refresh, and CSV/archive import while upstream still holds it. Suppressed address writes for that customer are skipped and recorded as id-only lineage so their container writes are skipped too. This is local cache suppression, not upstream erasure; tombstones persist until explicitly removed. A restore of a D1 backup from before the erasure may restore both the customer row and an older schema without the tombstone/triggers. D1 Time Travel can restore data for up to 30 days (7 days on the Workers Free plan), so verify suppression after database recovery. Customers erased before the suppression migration have no tombstone; backfill them with privileged `wrangler d1 execute` inserts (see docs/R2-RETENTION.md#customer-row-erasure-leaves-r2-untouched). List and remove markers only with privileged `wrangler d1 execute` SELECT/DELETE; there is no marker list or delete route. This route removes only the `customer_snapshot` row: the customer's `address_snapshot` and `container_snapshot` rows are not removed by this route. There is no address or container DELETE route — address rows leave D1 only through upstream-driven reconciliation or through direct privileged `wrangler d1 execute` deletes in container → address → customer FK order before retrying the customer delete.",
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
  // is the whole stale set. Propagates on failure: never report
  // success while erased PII may still serve.
  await invalidateDataEntity("customer", customerId);
  return c.json({ customerId, deleted: 1 }, 200);
});
