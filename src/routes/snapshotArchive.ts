import { createRoute, z } from "@hono/zod-openapi";
import { problemJsonResponse, problemType } from "../lib/problem";
import { createRouteModule, requireSnapshotAuth } from "./shared";

/**
 * Privileged R2 archive readback (gap F1).
 *
 * The sync path archives the raw Routeware CSV to R2 after D1
 * (`src/lib/r2SnapshotArchive.ts`, keys
 * `snapshots/YYYY-MM-DD/{customer|address|container}.csv`) but nothing read
 * it back — recovery needed wrangler CLI tribal knowledge. This route streams
 * the archived bytes back out so an operator can diff them against a fresh
 * export. Gated on `CUSTOMER_SNAPSHOT_SYNC_SECRET` like the other
 * snapshot-secret routes; a missing key is 404 problem+json (an absent
 * archive must stay distinguishable from a failed one).
 */
export const snapshotArchiveRoutes = createRouteModule();

const snapshotArchiveRoute = createRoute({
  method: "get",
  path: "/api/v1/snapshots/{table}/{date}",
  tags: ["data-snapshot"],
  summary: "Download an archived snapshot CSV from R2",
  description:
    "Streams the raw Routeware CSV archived to R2 by a previous snapshot sync (`snapshots/YYYY-MM-DD/{customer|address|container}.csv`, same bytes as the D1 sync). Requires `Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`. Returns 404 when no archive exists for that table and date. Operators diff the download against a fresh `...-snapshot/export` to verify an archive before recovery.",
  request: {
    params: z.object({
      table: z.enum(["customer", "address", "container"]),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("UTC archive date (YYYY-MM-DD)")
    })
  },
  responses: {
    200: {
      description: "Archived CSV bytes (header line plus one line per row)",
      content: { "text/csv": { schema: z.string() } }
    },
    400: {
      description:
        "Invalid table or date (application/problem+json). The zod validator rejects anything outside the `customer|address|container` enum or not shaped `YYYY-MM-DD` before any R2 read runs."
    },
    401: { description: "Unauthorized" },
    404: {
      description: "No archive for that table and date (application/problem+json)"
    },
    503: {
      description:
        "R2 archive not configured (application/problem+json). The SNAPSHOTS binding is unbound."
    }
  }
});

snapshotArchiveRoutes.openapi(snapshotArchiveRoute, async (c) => {
  const denied = requireSnapshotAuth(c);
  if (denied) return denied;
  const { table, date } = c.req.valid("param");
  const bucket = c.env.SNAPSHOTS;
  if (!bucket) {
    return problemJsonResponse({
      type: problemType("misconfigured"),
      title: "Service Unavailable",
      status: 503,
      detail:
        "R2 snapshot archive is not configured (SNAPSHOTS binding unbound). See docs/PROBLEMS.md#misconfigured.",
      instance: new URL(c.req.url).pathname
    });
  }
  // Interpolated from the validated enum + date shape, never raw path text:
  // byte-identical to the writer's key in `src/lib/r2SnapshotArchive.ts`.
  const key = `snapshots/${date}/${table}.csv`;
  const obj = await bucket.get(key);
  if (!obj) {
    return problemJsonResponse({
      type: problemType("not-found"),
      title: "Not Found",
      status: 404,
      detail: `No snapshot archive for table=${table} date=${date}. See docs/PROBLEMS.md#not-found.`,
      instance: new URL(c.req.url).pathname
    });
  }
  // `size`/`etag` are required on R2Object (worker-configuration.d.ts), so no
  // presence guards: uncovered branches would sit against the coverage ratchet.
  const headers = new Headers();
  headers.set(
    "content-type",
    obj.httpMetadata?.contentType ?? "text/csv; charset=utf-8"
  );
  headers.set("content-disposition", `attachment; filename="${table}-${date}.csv"`);
  headers.set("content-length", String(obj.size));
  headers.set("etag", obj.etag);
  return new Response(obj.body, { status: 200, headers });
});
