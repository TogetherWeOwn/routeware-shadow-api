import { createRoute, z } from "@hono/zod-openapi";
import {
  ORPHAN_SAMPLE_LIMIT_DEFAULT,
  ORPHAN_SAMPLE_LIMIT_MAX,
  getSnapshotOrphans,
  runDataSnapshotSyncChainedHttp
} from "../lib/d1SnapshotSync";
import {
  createRouteModule,
  dataSnapshotSyncResultExample,
  dryRunQuery,
  isDryRunRequested,
  requireSnapshotAuth,
  requireSnapshotSecret
} from "./shared";

/** Combined customer -> address -> container snapshot sync. */
export const dataSnapshotRoutes = createRouteModule();

const dataSnapshotResultSchema = z
  .object({
    customer: z
      .object({ upserted: z.number().int(), rowCount: z.number().int() })
      .nullable(),
    address: z
      .object({ upserted: z.number().int(), rowCount: z.number().int() })
      .nullable(),
    container: z
      .object({ upserted: z.number().int(), rowCount: z.number().int() })
      .nullable()
  })
  .openapi("DataSnapshotSyncResult");

const dataSnapshotSyncRoute = createRoute({
  method: "post",
  path: "/api/v1/data-snapshot/sync",
  tags: ["data-snapshot"],
  summary: "Fetch all configured Routeware CSV reports and upsert D1 (ordered)",
  description:
    "Runs **customer** → **address** → **container** when the corresponding `*_REPORT_EXPORT_PATH` or `*_REPORT_QUERY_ID` vars are set. Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. This route **chains three internal HTTP calls** to the per-table `...-snapshot/sync` routes (via the request origin) so each table runs in a **separate** Worker invocation (D1’s per-invocation operation limit applies per table, not to the whole job). The daily cron uses the same chained path only when `SHADOW_API_PUBLIC_BASE` is set (otherwise it falls back to one single-invocation run — see `src/scheduled.ts`). Each table is streamed; see `CUSTOMER_SNAPSHOT.md`. Pass `?dryRun=true` to dry-run every table (the flag is forwarded to each chained subrequest): full parse/validate, would-be counts, no D1 or R2 writes.\n\n" +
    "**Try it in `/docs`:** Authorize with the sync secret once, then Send with an empty body — this is the highest-friction flow made one click. Per-table 200s carry `{upserted, rowCount}` only (no `deleted` leak); a table with no export source comes back `null`, not zeros.",
  request: {
    query: dryRunQuery
  },
  responses: {
    200: {
      description: "Per-table Result (null if that export path is empty or was skipped for FKs)",
      content: {
        "application/json": {
          schema: dataSnapshotResultSchema,
          example: dataSnapshotSyncResultExample
        }
      }
    },
    401: { description: "Unauthorized" }
  }
});

/**
 * The combined shape is `{upserted, rowCount} | null` per table — the
 * per-table `deleted` reconcile counts stay on the per-table sync responses
 * and the cron line, and are stripped here (TOG-7391). Pinned by
 * `test/syncSummaryContract.test.ts` and `test/dataSnapshotRoutes.test.ts`.
 */
function withoutDeleted(
  t: { upserted: number; rowCount: number } | null
): { upserted: number; rowCount: number } | null {
  return t ? { upserted: t.upserted, rowCount: t.rowCount } : null;
}

dataSnapshotRoutes.openapi(dataSnapshotSyncRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const misconfigured = requireSnapshotSecret(c);
  if (misconfigured) return misconfigured;
  const origin = new URL(c.req.url).origin;
  // TOG-9203: forward `?dryRun=true` to every chained per-table subrequest.
  const r = await runDataSnapshotSyncChainedHttp(origin, c.env, {
    dryRun: isDryRunRequested(c.req.valid("query"))
  });
  return c.json(
    {
      customer: withoutDeleted(r.customer),
      address: withoutDeleted(r.address),
      container: withoutDeleted(r.container)
    },
    200
  );
});

const snapshotOrphanSampleSchema = z
  .object({
    count: z.number().int(),
    sampleIds: z.array(z.number().int())
  })
  .openapi("SnapshotOrphanSample");

const snapshotOrphanReportSchema = z
  .object({
    orphanAddresses: snapshotOrphanSampleSchema,
    orphanContainers: snapshotOrphanSampleSchema
  })
  .openapi("SnapshotOrphanReport");

const dataSnapshotOrphansRoute = createRoute({
  method: "get",
  path: "/api/v1/data-snapshot/orphans",
  tags: ["data-snapshot"],
  summary: "Report orphan rows on the snapshot FK chain (D1)",
  description:
    "D1 declares `address_snapshot.customer_id` → `customer_snapshot` and `container_snapshot.pickup_address_id` → `address_snapshot` but enforces neither, and a streamed sync spans many batches — so address rows can lack a customer and container rows can lack an address. Returns per-edge orphan counts plus deterministic id samples (ordered by primary key). Same bearer as other snapshot routes.",
  request: {
    query: z.object({
      sampleLimit: z.coerce
        .number()
        .int()
        .min(1)
        .max(ORPHAN_SAMPLE_LIMIT_MAX)
        .default(ORPHAN_SAMPLE_LIMIT_DEFAULT)
        .describe(
          "Max ids sampled per edge (counts are unaffected). Out-of-range values are rejected before D1 is touched."
        )
    })
  },
  responses: {
    200: {
      description: "Orphan counts and id samples per FK edge",
      content: { "application/json": { schema: snapshotOrphanReportSchema } }
    },
    401: { description: "Unauthorized" }
  }
});

dataSnapshotRoutes.openapi(dataSnapshotOrphansRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const q = c.req.valid("query");
  const report = await getSnapshotOrphans(c.env.CUSTOMER_DB, q.sampleLimit);
  return c.json(report, 200);
});
