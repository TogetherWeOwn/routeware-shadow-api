import { createRoute, z } from "@hono/zod-openapi";
import { rejectUnknownSnapshotListQuery, snapshotStrictQuery } from "../lib/snapshotStrictQuery";
import { containerRowExample, containerExportExample } from "./payloadExamples";
import { containerSnapshotListResponse, containerSnapshotRowSchema } from "./snapshotRowSchemas";
import { containerNoteQuery, snapshotSearchQuery } from "../lib/snapshotSearchQuery";
import { snapshotCountOnlyQuery, snapshotCountModeCompatible, snapshotListModeExamples } from "../lib/snapshotCountOnly";
import { containerIdentifierQuery } from "../lib/containerIdentifierQuery";
import { changesTimestamp } from "../lib/customerChangesTimestamp";
import { snapshotOrderQuery, snapshotOrderSql } from "../lib/snapshotListOrder";
import { snapshotExactNextQuery, snapshotNextLink, snapshotNextLinkHeader } from "../lib/snapshotNextLink";
import { snapshotLowerIdQuery } from "../lib/snapshotLowerId";
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
    "Routeware containers link to an address via `pickup_address_id` (and thus to a customer). Filter by `customerId` (joins through address), `pickupAddressId`, `containerId`, or the stored snapshot `containerTypeId`, exact stored container `zip`, `locationAddress` (`c.location_address`), `city` (`c.city`) and `state` (`c.state`), text `q` on `location_address`, `serial_number`, `city` or `zip` (a match in any one column), and `enabled`, plus NULL-only stored-pair `hasCoordinates` (not geographic validity). Unprefixed locality comes only from the container, never the parent address. Optional `parentCity`, `parentState` and `parentZip` instead select the mirrored service site's stored `a.city`, `a.state` and `a.zip`, via container.pickup_address_id to address_snapshot.pickup_address_id through the same shared address join as customerId and parent scopes. Each is case-sensitive opaque exact text of 1..100 Unicode code points containing a non-whitespace character, with leading zeros and nonblank whitespace preserved; no trimming, normalization, abbreviation conversion or enum. Parent and own locality AND-compose independently, including contradictions returning empty 200; missing parents and null parent locality do not match supplied selectors. Omission adds no join. This is stored site locality, not equipment GPS, live geolocation, postal verification or service territory eligibility; equality may scan with no index or performance promise. `locationAddress` is case-sensitive opaque text (1..200 Unicode code points); `city`, `state` and `zip` allow 1..100. Each exact selector requires a non-whitespace character, preserves leading zeros and nonblank whitespace, and never normalizes data. `q` stays a substring search and excludes state. Unscoped exact-location/locality filters scan stored rows; no dedicated location/state/zip index or production performance claim. This GET is idempotent and local-read. Optional `serialNumber`, `rfid` and `serviceCode` are case-sensitive opaque exact strings (1..100 Unicode code points); leading zeros and nonblank whitespace are preserved. Optional `materialStream` matches `c.ud_material_stream_ud` and `color` matches `c.color`: case-sensitive opaque stored labels with the same nonblank 1..100 Unicode code-point bounds, no trimming, normalization or inferred taxonomy. Optional `serviceCodeType` matches `c.service_code_type` and `serviceCodeInput` matches `c.service_code_input`: case-sensitive opaque stored service-code entry text with the same nonblank 1..100 Unicode code-point bounds, no trimming, normalization, service-history inference or controlled taxonomy; mirrored report data only. Optional `onCall` and `gpsLocked` select stored `oncall`/`gps_locked` states (`true` is stored 1, `false` is stored 0, `any` adds no predicate). Optional `parentRouteId`, `parentFranchiseId` and `parentEnabled` scope only the parent address's scalar route_id, franchise_id and enabled state through one shared address join (also used by customerId). Parent state is independent of equipment `enabled` and customer state; never parse equipment route_ids/frequency_ids as parent assignments. Effective parent selectors exclude missing/null parents; omission or parentEnabled=any alone preserves unjoined orphan visibility. Optional `note` matches a literal substring of stored `c.container_note` only; it never widens `q` to instructions or parent notes. Boundaries are trimmed before the maximum 100 Unicode code points; blank means omitted. SQLite lower() folds ASCII only, without Unicode normalization or full-text relevance; null notes act as empty. Note substring reads scan with no dedicated index, though existing ID/enabled scopes can narrow candidates. Stored notes imply no work orders, schedules or instruction execution. All supplied filters, including `q`, `note`, `ids` and `upperId`, compose with AND; null identifiers/labels do not match and duplicate matches are paginated, not collapsed. Valid unknown labels return an empty 200. Equality filters may scan; no index or performance guarantee is implied. Pass `cursor` (the previous page's `nextCursor`) instead of `offset` to page deep result sets by primary-key seek instead of a scanned OFFSET. Optional `hasSerialNumber` and `hasRfid` select by stored identity-text presence: exact `true|false|any` (default `any`) where present means the stored column `IS NOT NULL AND <> ''` and nonempty whitespace-only text counts as present. The two controls AND-compose with each other and with exact `serialNumber`/`rfid`; an exact value plus its presence=`false` yields an empty 200, while omission/`any` adds no predicate. Stored identity text is mirrored report data, never a live tag scan, deployment proof or uniqueness guarantee; missing text includes report gaps, not only untagged equipment. Presence filters may scan; no index or performance promise.",
  request: {
    headers: snapshotListConditionalHeaders,
    query: z.object({
      customerId: z.coerce.number().int().optional().openapi({ example: 345734 }),
      parentRouteId: z.string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .refine((value) => Number.isSafeInteger(Number(value)) && String(Number(value)) === value)
        .transform(Number)
        .optional()
        .describe("Exact parent address route_id equality: one unpadded ASCII decimal safe integer, 0..9007199254740991. Zero matches literal stored 0. No signs, whitespace, fractions, exponents or repeated keys; correct the format and retry. Never matches equipment route_ids/frequency_ids.")
        .openapi({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, example: 7 }),
      parentFranchiseId: containerIdentifierQuery.optional()
        .describe("Opaque case-sensitive exact parent address franchise_id equality: 1..100 Unicode code points containing a non-whitespace character. Leading zeros and significant nonblank whitespace are preserved, not trimmed or normalized. URL-encode one supported-length nonblank value and retry; repeated keys are invalid.")
        .openapi({ example: "001" }),
      parentEnabled: z.enum(["true", "false", "any"]).optional().default("any")
        .describe("Parent address enabled state, independent of equipment enabled and customer state. true/false requires a matching parent; any or omission adds no parent predicate or join. Send one exact true, false or any, or omit it and retry.")
        .openapi({ example: "true" }),
      parentCity: z.string()
        .refine((value) => value.trim().length > 0 && [...value].length <= 100)
        .optional()
        .describe("Opaque case-sensitive exact parent address stored city equality on a.city: 1..100 Unicode code points containing a non-whitespace character. Preserve leading zeros and nonblank whitespace without trimming or normalization. Missing parents and null locality never match. URL-encode one nonblank supported-length value, or omit the key and retry; repeated keys are invalid. Mirrored service-site locality, not equipment GPS, live geolocation, postal verification or service territory eligibility.")
        .openapi({ type: "string", minLength: 1, maxLength: 100, example: "Riverton" }),
      parentState: z.string()
        .refine((value) => value.trim().length > 0 && [...value].length <= 100)
        .optional()
        .describe("Opaque case-sensitive exact parent address stored state equality on a.state: 1..100 Unicode code points containing a non-whitespace character. Preserve leading zeros and nonblank whitespace without trimming, normalization, abbreviation conversion or an enum. Missing parents and null locality never match. URL-encode one nonblank supported-length value, or omit the key and retry; repeated keys are invalid. Independent of the container's own state.")
        .openapi({ type: "string", minLength: 1, maxLength: 100, example: "TX" }),
      parentZip: z.string()
        .refine((value) => value.trim().length > 0 && [...value].length <= 100)
        .optional()
        .describe("Opaque case-sensitive exact parent address stored zip equality on a.zip: 1..100 Unicode code points containing a non-whitespace character. Preserve leading zeros and nonblank whitespace without trimming or normalization. Missing parents and null locality never match. URL-encode one nonblank supported-length value, or omit the key and retry; repeated keys are invalid. Independent of the container's own zip; no postal verification.")
        .openapi({ type: "string", minLength: 1, maxLength: 100, example: "02139" }),
      pickupAddressId: z.coerce.number().int().optional().openapi({ example: 10 }),
      containerId: z.coerce.number().int().optional().openapi({ example: 100 }),
      containerTypeId: z.string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .refine((value) => Number.isSafeInteger(Number(value)))
        .transform(Number)
        .optional()
        .describe("Exact stored container-type equality on the snapshot column: one unpadded ASCII decimal safe integer, 0..9007199254740991. Zero matches literal stored 0, never nulls or all rows. No signs, whitespace, fractions, exponents or repeated keys. Correct the format and retry.")
        .openapi({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, example: 5 }),
      ids: snapshotIdSelectionQuery(),
      serialNumber: containerIdentifierQuery.optional().openapi({ example: "00123" }),
      rfid: containerIdentifierQuery.optional().openapi({ example: "RF-0007" }),
      serviceCode: containerIdentifierQuery.optional().openapi({ example: "SVC-001" }),
      hasSerialNumber: z.enum(["true", "false", "any"]).optional().default("any")
        .describe("Stored serial_number presence over mirrored report text: \"true\" keeps only containers whose stored serial_number reads present (IS NOT NULL AND <> empty string; nonempty whitespace-only text counts as present), \"false\" keeps only null-or-empty stored text. Stored identity text is mirrored report data, never a live tag scan, deployment proof or uniqueness guarantee; missing text includes report gaps, not only untagged equipment. AND-composes with hasRfid and exact serialNumber; an exact value plus false yields an empty 200. Presence may scan; no index or performance promise. Send one exact true, false or any, or omit the selector and retry.")
        .openapi({ example: "true" }),
      hasRfid: z.enum(["true", "false", "any"]).optional().default("any")
        .describe("Stored rfid presence over mirrored report text: \"true\" keeps only containers whose stored rfid reads present (IS NOT NULL AND <> empty string; nonempty whitespace-only text counts as present), \"false\" keeps only null-or-empty stored text. Stored identity text is mirrored report data, never a live tag scan, deployment proof or uniqueness guarantee; missing text includes report gaps, not only untagged equipment. AND-composes with hasSerialNumber and exact rfid; an exact value plus false yields an empty 200. Presence may scan; no index or performance promise. Send one exact true, false or any, or omit the selector and retry.")
        .openapi({ example: "true" }),
      materialStream: containerIdentifierQuery.optional().describe(
        "Case-sensitive opaque exact stored label in c.ud_material_stream_ud, 1..100 Unicode code points containing a non-whitespace character. Preserve leading zeros and significant whitespace without trimming or Unicode normalization; no inferred material taxonomy. URL-encode a single supported-length nonblank label, or omit it and retry; repeated keys are rejected before D1."
      ).openapi({ example: "001" }),
      color: containerIdentifierQuery.optional().describe(
        "Case-sensitive opaque exact stored label in c.color, 1..100 Unicode code points containing a non-whitespace character. Preserve leading zeros and significant whitespace without trimming or Unicode normalization; no defined vocabulary. URL-encode a single supported-length nonblank label, or omit it and retry; repeated keys are rejected before D1."
      ).openapi({ example: "Blue" }),
      serviceCodeType: containerIdentifierQuery.optional().describe(
        "Case-sensitive opaque exact stored service-code entry text in c.service_code_type, 1..100 Unicode code points containing a non-whitespace character. Preserve leading zeros and significant whitespace without trimming or Unicode normalization; mirrored report data, not service history, dispatch state, proof of service or a controlled taxonomy. URL-encode a single supported-length nonblank value, or omit it and retry; repeated keys are rejected before D1."
      ).openapi({ example: "T-1" }),
      serviceCodeInput: containerIdentifierQuery.optional().describe(
        "Case-sensitive opaque exact stored service-code entry text in c.service_code_input, 1..100 Unicode code points containing a non-whitespace character. Preserve leading zeros and significant whitespace without trimming or Unicode normalization; mirrored report data, not service history, dispatch state, proof of service or a controlled taxonomy. URL-encode a single supported-length nonblank value, or omit it and retry; repeated keys are rejected before D1."
      ).openapi({ example: "IN-1" }),
      zip: containerIdentifierQuery.optional()
        .describe("Opaque case-sensitive exact stored container zip equality: 1..100 Unicode code points. Leading zeros and nonblank whitespace are preserved, not trimmed. Empty/whitespace-only, overlength and repeated keys are invalid before D1. URL-encode one value and retry; no parent-address fallback or live geolocation.")
        .openapi({ example: "02139" }),
      locationAddress: z.string()
        .refine((value) => value.length <= 400 && [...value].length <= 200 && value.trim() !== "")
        .optional()
        .describe("Opaque case-sensitive exact stored container location_address equality: 1..200 Unicode code points, including a non-whitespace character. Nonblank whitespace, punctuation and leading zeros are preserved, not trimmed or normalized. Empty/whitespace-only, overlength and repeated keys are invalid before D1. URL-encode one nonblank stored value within the limit or omit the key. No parent-address fallback or live geolocation.")
        .openapi({ type: "string", minLength: 1, maxLength: 200, example: "00123 Depot" }),
      city: containerIdentifierQuery.optional()
        .describe("Opaque case-sensitive exact stored container city equality: 1..100 Unicode code points, including a non-whitespace character. Binds c.city on the container's own row only, never the parent address city. Stored city is mirrored text, not geolocation, current assignment or a normalized taxonomy. Nonblank whitespace, punctuation and leading zeros are preserved, not trimmed or normalized. Empty/whitespace-only, overlength and repeated keys are invalid before D1. URL-encode one nonblank stored value within the limit or omit the key. No parent-address fallback or live geolocation.")
        .openapi({ example: "Killeen" }),
      state: containerIdentifierQuery.optional()
        .describe("Opaque case-sensitive exact stored container state equality: 1..100 Unicode code points, including a non-whitespace character. Nonblank whitespace, punctuation and leading zeros are preserved, not trimmed or normalized; no abbreviation conversion or state enum. Empty/whitespace-only, overlength and repeated keys are invalid before D1. URL-encode one nonblank stored value within the limit or omit the key. No parent-address fallback or live geolocation.")
        .openapi({ example: "St-01" }),
      q: snapshotSearchQuery.optional().describe("Literal substring on stored container location_address, serial_number, city or zip — a match in any one column (ASCII case-insensitive; SQLite lower() preserves non-ASCII case distinctions; maximum 100 Unicode code points before trimming). Trimmed; blank means omitted. No LIKE wildcards or live geolocation.").openapi({ example: "Killeen" }),
      note: containerNoteQuery.optional().describe("Literal substring on stored c.container_note only, separate from q. Trim boundaries before the maximum 100 Unicode code points; blank means omitted. Single value only; repeated keys are invalid before D1. SQLite lower() folds ASCII only; no Unicode normalization, LIKE wildcards or full-text relevance. Null notes act as empty.").openapi({ example: "gate" }),
      enabled: z.enum(["true", "false", "any"]).optional().default("any").openapi({ example: "true" }),
      hasCoordinates: z.enum(["true", "false", "any"]).optional().default("any")
        .describe('Stored-pair NULL-only presence on the container itself, never inherited from its parent address: "true" requires both latitude and longitude non-null; "false" requires either SQL NULL; "any" or omission adds no filter. TEXT including zero, negative-looking, empty, whitespace and non-numeric strings counts as present when non-null. Not valid/complete geographic coordinates, accuracy, GPS lock or live position. Disabled rows remain eligible. May scan; no dedicated index or performance claim. Send one hasCoordinates=true, false or any, or omit the selector and retry.')
        .openapi({ example: "false" }),
      syncedSince: changesTimestamp.optional()
        .describe("Stored c.synced_at strictly greater than this UTC Z instant, normalized to milliseconds using the customer-changes timestamp parser (seconds required, optional 1–3 fractional digits). Empty, offsets, calendar-invalid and repeated values are invalid; send one valid instant or omit syncedSince and retry. Mirror freshness only, not upstream event/service time or proof of changed content. A filter, not a changes feed: container_id ordering/cursors stay unchanged, with no deletion history, isolation or completeness guarantee; concurrent sync can move rows across the window. May scan; no index or performance promise.")
        .openapi({ example: "2026-09-01T00:00:00.500Z" }),
      onCall: z
        .enum(["true", "false", "any"])
        .optional()
        .default("any")
        .describe("Stored on-call flag equality on `c.oncall`: `true` matches stored 1, `false` matches stored 0, `any` (default) adds no predicate. A stored snapshot value, not a service-demand assertion.")
        .openapi({ example: "true" }),
      gpsLocked: z
        .enum(["true", "false", "any"])
        .optional()
        .default("any")
        .describe("Stored GPS-lock flag equality on `c.gps_locked`: `true` matches stored 1, `false` matches stored 0, `any` (default) adds no predicate. A stored snapshot value, not proof of fresh GPS.")
        .openapi({ example: "true" }),
      limit: z.coerce.number().int().min(1).max(500).default(50).openapi({ example: 50 }),
      offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
      cursor: z.coerce
        .number()
        .int()
        .optional()
        .describe("Last container_id from the previous page's nextCursor in the same order; takes precedence over offset. Changing direction starts a new traversal.")
        .openapi({ example: 99 }),
      lowerId: snapshotLowerIdQuery,
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
      fields: snapshotFieldsQuery("container"), countOnly: snapshotCountOnlyQuery, strictQuery: snapshotStrictQuery
    }).refine(snapshotCountModeCompatible, { path: ["countOnly"] })
  },
  responses: {
    200: {
      description: "Rows and total",
      headers: { ...snapshotListEtagHeaders, Link: snapshotNextLinkHeader },
      content: {
        "application/json": {
          schema: containerSnapshotListResponse,
          examples: snapshotListModeExamples(containerRowExample)
        }
      }
    },
    304: snapshotListNotModifiedResponse,
    400: {
      description:
        "Invalid query (application/problem+json). strictQuery=true rejects unknown decoded names with fixed value-free guidance before D1/304; use supported names from this mounted OpenAPI operation, remove unknown keys, or set strictQuery=false. Send strictQuery once as exact true or false (default false); invalid/empty/repeated values fail before D1. Send parentRouteId as one canonical unpadded ASCII decimal safe integer 0..9007199254740991; parentFranchiseId as one URL-encoded nonblank opaque string of 1..100 Unicode code points without trimming significant whitespace; parentEnabled as one exact true, false or any. Send parentCity, parentState and parentZip each as one URL-encoded nonblank opaque exact stored parent-locality string of 1..100 Unicode code points, preserving leading zeros and nonblank whitespace without trimming or normalization. Blank, invalid, overlength and repeated parent keys (including encoded duplicate names) fail before D1/304, after authentication; correct the named format and retry, or omit only if no parent scope is intended. The zod validator rejects a non-canonical `containerTypeId` (anything but one unpadded ASCII nonnegative safe integer; `0` is literal stored zero), empty/whitespace-only/repeated `serialNumber`, `rfid`, `serviceCode`, `materialStream`, `color`, `serviceCodeType`, `serviceCodeInput`, `zip`, `locationAddress`, `city` or `state`, `locationAddress` longer than 200 Unicode code points, any other exact string selector or `q` longer than 100 Unicode code points, an out-of-range `limit`/`offset`, an unknown `enabled`/`onCall`/`gpsLocked` value, an invalid/empty/repeated `hasCoordinates` value (send one hasCoordinates=true, false or any, or omit it), an invalid/blank/repeated `hasSerialNumber` or `hasRfid` (send one exact true, false or any for each, or omit it and retry), an unknown/empty/duplicate `fields` selector, invalid/repeated `order`, or an invalid `ids` primary-ID selector (empty, over-50, duplicate, repeated-key, or non-canonical member) before any D1 query runs. Repeated `note` or a trimmed note over 100 Unicode code points also rejects before D1. Send one `note` fragment of at most 100 Unicode code points after trimming, or omit note, then retry. Send order=asc or order=desc exactly (case-sensitive), or omit it for asc. Invalid/repeated exactNext is rejected; send one exactNext=true or false, or omit it and retry. Errors name fields, never submitted values. For locationAddress, city or state, URL-encode one nonblank stored value within the named limit or omit the key, then retry. For materialStream/color, URL-encode one supported-length nonblank stored label or omit it and retry. For serviceCodeType/serviceCodeInput, URL-encode one supported-length nonblank stored entry or omit it and retry. Send syncedSince once as a calendar-valid UTC Z datetime with seconds and at most 3 fractional digits (normalized to milliseconds); empty, offsets, excess precision and repeated values fail before D1/304 after auth. Correct other named query keys and see docs/PROBLEMS.md#bad-request."
    }
  }
});

containerSnapshotRoutes.openapi(containerSnapshotListRoute, async (c) => {
  const p = c.req.valid("query");
  const unknownQuery = rejectUnknownSnapshotListQuery(c, p.strictQuery, containerSnapshotListRoute.request.query);
  if (unknownQuery) return unknownQuery;
  const order = snapshotOrderSql(p.order);
  const db = c.env.CUSTOMER_DB;
  const fromJoin =
    p.customerId !== undefined || p.parentRouteId !== undefined || p.parentFranchiseId !== undefined || p.parentEnabled !== "any" ||
    p.parentCity !== undefined || p.parentState !== undefined || p.parentZip !== undefined
      ? "FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id"
      : "FROM container_snapshot c";
  const where: string[] = ["1 = 1"];
  const binds: unknown[] = [];
  if (p.customerId !== undefined) {
    where.push("a.customer_id = ?");
    binds.push(p.customerId);
  }
  // Parent assignment/state is separate from equipment route-list text and
  // c.enabled. Reuse the customer join; its unique parent key never fans out.
  if (p.parentRouteId !== undefined) {
    where.push("a.route_id = ?");
    binds.push(p.parentRouteId);
  }
  if (p.parentFranchiseId !== undefined) {
    where.push("a.franchise_id = ?");
    binds.push(p.parentFranchiseId);
  }
  if (p.parentEnabled === "true") {
    where.push("a.enabled = 1");
  }
  if (p.parentEnabled === "false") {
    where.push("a.enabled = 0");
  }
  // Exact mirrored service-site locality, independent of c.city/state/zip.
  // Reuse the unique parent join and COUNT/page predicates without fan-out.
  if (p.parentCity !== undefined) {
    where.push("a.city = ?");
    binds.push(p.parentCity);
  }
  if (p.parentState !== undefined) {
    where.push("a.state = ?");
    binds.push(p.parentState);
  }
  if (p.parentZip !== undefined) {
    where.push("a.zip = ?");
    binds.push(p.parentZip);
  }
  if (p.pickupAddressId !== undefined) {
    where.push("c.pickup_address_id = ?");
    binds.push(p.pickupAddressId);
  }
  if (p.containerId !== undefined) {
    where.push("c.container_id = ?");
    binds.push(p.containerId);
  }
  // Stored-type equality on the container alias (both fromJoin paths select
  // from `c`): null stored types never match, omission adds no predicate.
  if (p.containerTypeId !== undefined) {
    where.push("c.container_type_id = ?");
    binds.push(p.containerTypeId);
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
  if (p.serviceCode !== undefined) {
    where.push("c.service_code = ?");
    binds.push(p.serviceCode);
  }
  // Stored identity-text presence: present means IS NOT NULL AND <> '';
  // false is the exact null-or-empty complement. Nonempty whitespace-only
  // text counts as present (no trim). No value binds; omission/any adds no
  // predicate. Shared with COUNT through the same where/binds below.
  if (p.hasSerialNumber === "true") {
    where.push("c.serial_number IS NOT NULL AND c.serial_number <> ''");
  }
  if (p.hasSerialNumber === "false") {
    where.push("(c.serial_number IS NULL OR c.serial_number = '')");
  }
  if (p.hasRfid === "true") {
    where.push("c.rfid IS NOT NULL AND c.rfid <> ''");
  }
  if (p.hasRfid === "false") {
    where.push("(c.rfid IS NULL OR c.rfid = '')");
  }
  if (p.materialStream !== undefined) {
    where.push("c.ud_material_stream_ud = ?");
    binds.push(p.materialStream);
  }
  if (p.color !== undefined) {
    where.push("c.color = ?");
    binds.push(p.color);
  }
  // Stored service-code entry-part equality on the container alias (both
  // fromJoin paths select from `c`): opaque mirrored report text, never
  // parsed as schedule, status or proof of service. Null never matches `=`;
  // a nonblank needle cannot equal empty stored text either.
  if (p.serviceCodeType !== undefined) {
    where.push("c.service_code_type = ?");
    binds.push(p.serviceCodeType);
  }
  if (p.serviceCodeInput !== undefined) {
    where.push("c.service_code_input = ?");
    binds.push(p.serviceCodeInput);
  }
  if (p.zip !== undefined) {
    where.push("c.zip = ?");
    binds.push(p.zip);
  }
  if (p.locationAddress !== undefined) {
    where.push("c.location_address = ?");
    binds.push(p.locationAddress);
  }
  if (p.city !== undefined) {
    where.push("c.city = ?");
    binds.push(p.city);
  }
  if (p.state !== undefined) {
    where.push("c.state = ?");
    binds.push(p.state);
  }
  if (p.q !== undefined && p.q.trim() !== "") {
    // One grouped OR over container columns only; all other scopes stay ANDed.
    where.push(
      "(instr(lower(coalesce(c.location_address, '')), lower(?)) > 0 OR instr(lower(coalesce(c.serial_number, '')), lower(?)) > 0 OR instr(lower(coalesce(c.city, '')), lower(?)) > 0 OR instr(lower(coalesce(c.zip, '')), lower(?)) > 0)"
    );
    const qv = p.q.trim();
    binds.push(qv, qv, qv, qv);
  }
  if (p.note !== undefined && p.note !== "") {
    where.push("instr(lower(coalesce(c.container_note, '')), lower(?)) > 0");
    binds.push(p.note);
  }
  if (p.enabled === "true") {
    where.push("c.enabled = 1");
  }
  if (p.enabled === "false") {
    where.push("c.enabled = 0");
  }
  if (p.hasCoordinates === "true") {
    where.push("(c.latitude IS NOT NULL AND c.longitude IS NOT NULL)");
  }
  if (p.hasCoordinates === "false") {
    where.push("(c.latitude IS NULL OR c.longitude IS NULL)");
  }
  // Stored operational flags: integer-literal equality on the container alias
  // so filtered and bare pages share the same binds. `any` adds no predicate.
  if (p.onCall === "true") {
    where.push("c.oncall = 1");
  }
  if (p.onCall === "false") {
    where.push("c.oncall = 0");
  }
  if (p.gpsLocked === "true") {
    where.push("c.gps_locked = 1");
  }
  if (p.gpsLocked === "false") {
    where.push("c.gps_locked = 0");
  }
  if (p.syncedSince !== undefined) {
    where.push("c.synced_at > ?");
    binds.push(p.syncedSince);
  }
  if (p.cursor !== undefined) {
    where.push(`c.container_id ${order.seek} ?`);
    binds.push(p.cursor);
  }
  // Caller-held inclusive floor on the container primary key (never the
  // joined address key): a fixed bound shared with the COUNT below through
  // the same where/binds. A descending cursor at or below the floor matches
  // nothing; ascending seeks retain this same inclusive floor.
  if (p.lowerId !== undefined) {
    where.push("c.container_id >= ?");
    binds.push(p.lowerId);
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
  if (p.countOnly === "true") {
    return snapshotListJsonResponse(c, { rows: [], total, nextCursor: null });
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
      note: p.note === "" ? undefined : p.note,
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
