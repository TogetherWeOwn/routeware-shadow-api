import { z } from "@hono/zod-openapi";

/**
 * Ordinary address-list same-container equipment cohort:
 * `equipmentMaterialStream`, `equipmentTypeId` and `equipmentEnabled`.
 *
 * Single source of truth for the lexical contracts, so the shape cannot
 * drift between the route schema, the served OpenAPI and the SQL below.
 * The stream policy mirrors the container opaque-label contract
 * (`containerIdentifierQuery`: trim only detects blank input, never
 * transforms it; the UTF-16 guard bounds allocation before counting code
 * points); the type policy mirrors the container `containerTypeId`
 * contract (canonical unpadded ASCII safe integer, literal zero).
 * Validation lives in the query zod schema so the module `defaultHook`
 * (`validationFailureHook`) answers rejections with the existing anchored
 * 400 before the handler — and therefore before any D1 work — runs. A
 * repeated key reaches zod as an array and fails the schema.
 */
export const addressEquipmentMaterialStreamQuery = z.string()
  .refine((value) => value.length <= 200 && [...value].length <= 100 && value.trim() !== "")
  .optional()
  .describe("Opaque case-sensitive exact stored material-stream equality on the SAME stored child container as the other equipment scopes: 1..100 Unicode code points containing a non-whitespace character, bound verbatim as `ud_material_stream_ud = ?` with no trimming, case folding or Unicode normalization. Null stored streams never match a supplied value; an unknown stream returns 200 empty. Any single supplied equipment scope creates the correlated same-container EXISTS; omission adds no predicate. Independent of `hasContainers` and the prospective `hasEnabledContainers`: each any-child scope may be satisfied by a different stored child than the equipment cohort. Mirrored equipment attributes are not live inventory, material acceptance, service eligibility or recycling-outcome truth. URL-encode one value or omit it and retry; blank, overlength and repeated keys are invalid.")
  .openapi({ type: "string", minLength: 1, maxLength: 100, example: "X" });

export const addressEquipmentTypeIdQuery = z.string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)) && String(Number(value)) === value)
  .transform(Number)
  .optional()
  .describe("Exact stored container-type equality on the SAME stored child container as the other equipment scopes: one unpadded ASCII decimal safe integer, 0..9007199254740991, bound as `container_type_id = ?`. Zero matches literal stored 0, never nulls. No signs, whitespace, fractions, exponents or repeated keys. Any single supplied equipment scope creates the correlated same-container EXISTS; omission adds no predicate. Correct the format and retry.")
  .openapi({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, example: 5 });

export const addressEquipmentEnabledQuery = z.enum(["true", "false", "any"]).optional().default("any")
  .describe("Stored container enabled state on the SAME stored child container as the other equipment scopes: \"true\" requires stored `enabled = 1`, \"false\" requires stored `enabled = 0`; \"any\" (default) or omission adds no state scope. A noncanonical stored value never matches true or false. Site `enabled` stays independent. Send one equipmentEnabled=true, false or any, or omit the selector and retry.")
  .openapi({ example: "true" });

export type AddressEquipmentCohortScope = {
  equipmentMaterialStream?: string;
  equipmentTypeId?: number;
  equipmentEnabled: "true" | "false" | "any";
};

/**
 * One address-correlated EXISTS over the stored child containers: stream,
 * type and enabled-state scopes AND inside the same child, so split
 * scopes across different children never match and duplicate matching
 * containers never duplicate the site. Plain equality can never match a
 * null stored attribute or a noncanonical enabled value. Returns null
 * when no scope is effective (omitted scalars, or `equipmentEnabled=any`
 * alone), leaving the caller's SQL/binds untouched. The caller appends
 * `binds` in order; COUNT and page share both.
 */
export function addressEquipmentCohortPredicate(scope: AddressEquipmentCohortScope): { sql: string; binds: unknown[] } | null {
  const predicates: string[] = [];
  const binds: unknown[] = [];
  if (scope.equipmentMaterialStream !== undefined) {
    predicates.push("ud_material_stream_ud = ?");
    binds.push(scope.equipmentMaterialStream);
  }
  if (scope.equipmentTypeId !== undefined) {
    predicates.push("container_type_id = ?");
    binds.push(scope.equipmentTypeId);
  }
  if (scope.equipmentEnabled !== "any") {
    predicates.push("enabled = ?");
    binds.push(scope.equipmentEnabled === "true" ? 1 : 0);
  }
  if (predicates.length === 0) return null;
  return {
    sql: `EXISTS (SELECT 1 FROM container_snapshot WHERE container_snapshot.pickup_address_id = address_snapshot.pickup_address_id AND ${predicates.join(" AND ")})`,
    binds
  };
}
