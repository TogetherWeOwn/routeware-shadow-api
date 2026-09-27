import { createRoute, z } from "@hono/zod-openapi";
import { runDataSnapshotSyncChainedHttp } from "../lib/d1SnapshotSync";
import {
  createRouteModule,
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
    "Runs **customer** → **address** → **container** when the corresponding `*_REPORT_EXPORT_PATH` or `*_REPORT_QUERY_ID` vars are set. Same bearer as other snapshot sync routes. This route **chains three internal HTTP calls** to the per-table `...-snapshot/sync` routes so each table runs in a **separate** Worker invocation (D1’s per-invocation operation limit applies per table, not to the whole job). The daily cron should set `SHADOW_API_PUBLIC_BASE` to this Worker’s public URL. Each table is streamed; see `CUSTOMER_SNAPSHOT.md`.",
  responses: {
    200: {
      description: "Per-table Result (null if that export path is empty or was skipped for FKs)",
      content: { "application/json": { schema: dataSnapshotResultSchema } }
    },
    401: { description: "Unauthorized" }
  }
});

dataSnapshotRoutes.openapi(dataSnapshotSyncRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const misconfigured = requireSnapshotSecret(c);
  if (misconfigured) return misconfigured;
  const origin = new URL(c.req.url).origin;
  const r = await runDataSnapshotSyncChainedHttp(origin, c.env);
  return c.json(r, 200);
});
