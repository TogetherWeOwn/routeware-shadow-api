import { z } from "@hono/zod-openapi";

/** Fixed public codes only; never exception text or upstream HTML. */
export const localSyncCodeSchema = z.enum([
  "not_attempted",
  "unknown_customer_id",
  "sync_failed"
]).openapi("LocalSyncCode", {
  description:
    "not_attempted: upstream save was rejected or this was validation-only (dryRun=true), so no refresh ran. unknown_customer_id: upstream save succeeded but the owning customer could not be resolved. sync_failed: upstream save succeeded but local graph refresh or cache invalidation failed."
});

export const localSyncSummarySchema = z.discriminatedUnion("done", [
  z.strictObject({ done: z.literal(false), code: localSyncCodeSchema }),
  z.strictObject({
    done: z.literal(true),
    customerId: z.number(),
    addressIds: z.array(z.number()),
    containerIds: z.array(z.number())
  })
]).openapi("LocalSyncSummary", {
  description:
    "Best-effort local D1 graph refresh and cache invalidation, separate from upstream write acceptance. done=true identifies the refreshed graph; done=false carries a fixed recovery code, not exception details."
});

export type LocalSyncCode = z.infer<typeof localSyncCodeSchema>;
export type LocalSyncSummary = z.infer<typeof localSyncSummarySchema>;

const saveOutcomeFields = {
  ok: z.boolean().openapi({
    description: "Whether the upstream save was accepted; not a local-refresh guarantee. Inspect this even on HTTP 200."
  }),
  routewareStatus: z.number().int().openapi({
    description: "Original upstream HTTP status, which may differ from the wrapper status."
  }),
  customerId: z.number().nullable().openapi({
    description: "Resolved owning customer ID, or null when unresolved; not proof of local refresh."
  }),
  upstreamBytes: z.number().int().nonnegative().openapi({
    description: "UTF-8 byte count of the upstream body. Its contents and submitted fields are never echoed."
  }),
  localSync: localSyncSummarySchema
};
const pickupAddressId = z.number().nullable().openapi({
  description: "Usable posted PickupAddressID, or null. On a live address create (HTTP 201) this carries the resolved new ID; null when neither posted nor resolvable. Container outcomes and validation-only (dryRun) responses echo the posted value only."
});

// Documentation/type contracts only: do not parse or transform live responses.
export const customerSaveOutcomeSchema = z.strictObject(saveOutcomeFields)
  .openapi("CustomerSaveOutcome");
export const addressSaveOutcomeSchema = z.strictObject({ ...saveOutcomeFields, pickupAddressId })
  .openapi("AddressSaveOutcome");
export const containerSaveOutcomeSchema = z.strictObject({
  ...saveOutcomeFields,
  pickupAddressId,
  containerId: z.number().nullable().openapi({
    description: "Usable posted ContainerID, or null. On a live container create (HTTP 201) this carries the resolved new ID; null when neither posted nor resolvable. Validation-only (dryRun) responses echo the posted value only."
  })
}).openapi("ContainerSaveOutcome");

const dryRunOutcomeFields = {
  ...saveOutcomeFields,
  ok: z.literal(true).openapi({ description: "Validation passed only; no upstream write was attempted." }),
  dryRun: z.literal(true),
  routewareStatus: z.null().openapi({ description: "No upstream write was attempted, so no save status exists." }),
  customerId: z.number().nullable().openapi({ description: "Posted customer ID, or null; not resolved from upstream or D1." }),
  upstreamBytes: z.literal(0),
  localSync: z.strictObject({
    done: z.literal(false),
    code: z.literal(localSyncCodeSchema.enum.not_attempted)
  })
};

export const customerSaveDryRunSchema = z.strictObject(dryRunOutcomeFields)
  .openapi("CustomerSaveDryRun");
export const addressSaveDryRunSchema = z.strictObject({ ...dryRunOutcomeFields, pickupAddressId })
  .openapi("AddressSaveDryRun");
export const containerSaveDryRunSchema = z.strictObject({
  ...dryRunOutcomeFields,
  pickupAddressId,
  containerId: containerSaveOutcomeSchema.shape.containerId
}).openapi("ContainerSaveDryRun");

export type EntitySaveOutcome = z.infer<typeof customerSaveOutcomeSchema>
  | z.infer<typeof addressSaveOutcomeSchema>
  | z.infer<typeof containerSaveOutcomeSchema>;
