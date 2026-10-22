import { createRoute, z } from "@hono/zod-openapi";
import { APP_VERSION } from "../lib/version";
import { checkReadiness } from "../lib/readiness";
import { createRouteModule } from "./shared";

/** Unauthenticated liveness probe — the one route the `/api/v1/*` gate allows. */
export const metaRoutes = createRouteModule();

/**
 * Health response schema.
 *
 * `version` is the release version single-sourced from `package.json#version`
 * via `src/lib/version.ts` (same pattern) — the handler below sends
 * `APP_VERSION`, so bumping `package.json` moves the health version with no
 * other edit.
 */
export const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.string(),
    version: z.string()
  })
  .openapi("HealthResponse");

const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/health",
  operationId: "health",
  "x-access": "public",
  "x-effect": "none",
  tags: ["meta"],
  summary: "Liveness probe (public, no bearer)",
  description:
    "The one route the `/api/v1/*` bearer gate allows without a token. Returns 200 when the Worker is running; it does not check D1, R2, or report config — that is `GET /api/v1/readiness`. **Try it:** select Test Request and Send; no Authorization header or request body is needed.",
  security: [],
  responses: {
    200: {
      description: "Worker is running",
      content: {
        "application/json": {
          schema: healthResponseSchema,
          example: { status: "ok", service: "routeware-shadow-api", version: APP_VERSION }
        }
      }
    }
  }
});

metaRoutes.openapi(healthRoute, (c) =>
  c.json(
    { status: "ok" as const, service: "routeware-shadow-api", version: APP_VERSION },
    200
  )
);

export const readinessResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    service: z.string(),
    checks: z.object({
      d1: z.object({
        ok: z.boolean(),
        detail: z.string().optional(),
        code: z.enum(["d1_ping_timeout", "d1_ping_failed"]).optional(),
        next_action: z.literal("retry_after_cache_ttl").optional()
      }),
      r2: z.object({
        ok: z.boolean(),
        bound: z.boolean(),
        enabled: z.boolean(),
        detail: z.string().optional()
      }),
      config: z.object({
        ok: z.boolean(),
        customer: z.boolean(),
        address: z.boolean(),
        container: z.boolean(),
        detail: z.string().optional()
      }),
      cron: z.object({
        ok: z.boolean(),
        stale: z.boolean(),
        lastRunAt: z.string().nullable(),
        tables: z.object({
          customer: z
            .object({
              outcome: z.enum(["success", "skipped", "failed"]),
              upserted: z.number().nullable(),
              rowCount: z.number().nullable(),
              deleted: z.number().nullable(),
              ranAt: z.string()
            })
            .nullable(),
          address: z
            .object({
              outcome: z.enum(["success", "skipped", "failed"]),
              upserted: z.number().nullable(),
              rowCount: z.number().nullable(),
              deleted: z.number().nullable(),
              ranAt: z.string()
            })
            .nullable(),
          container: z
            .object({
              outcome: z.enum(["success", "skipped", "failed"]),
              upserted: z.number().nullable(),
              rowCount: z.number().nullable(),
              deleted: z.number().nullable(),
              ranAt: z.string()
            })
            .nullable()
        }),
        detail: z.string().optional(),
        code: z.enum(["cron_state_timeout", "cron_state_failed"]).optional(),
        next_action: z.literal("retry_after_cache_ttl").optional()
      })
    })
  })
  .openapi("ReadinessResponse");

const readinessRoute = createRoute({
  method: "get",
  path: "/api/v1/readiness",
  operationId: "getReadiness",
  "x-access": "read",
  "x-effect": "local-read",
  tags: ["meta"],
  summary: "Deep readiness probe (D1, R2, report config)",
  description:
    "Authenticated deploy check: pings D1, reports whether the SNAPSHOTS R2 binding is present, reports whether each snapshot report source is configured, and reports cron staleness (last persisted cron run per table from cron_sync_state; advisory — never flips the overall status). D1, R2, and cron observations are cached in memory for 20 seconds from refresh start per Worker isolate; concurrent hits share a refresh, and binding changes invalidate the cache. Ping and cron response waits run concurrently with a 15-second budget (not cancellation of underlying D1 work). Failed or timed-out observations return fixed code and next_action fields and remain cached until expiry. Config and bearer checks are never cached. Returns 200 when every required check passes, 503 with per-dependency status otherwise. Requires the same bearer as other /api/v1/* routes.",
  responses: {
    200: {
      description: "All dependencies ready",
      content: {
        "application/json": {
          schema: readinessResponseSchema
        }
      }
    },
    401: {
      description: "Unauthorized"
    },
    503: {
      description: "One or more dependencies not ready (per-dependency status in body)",
      content: {
        "application/json": {
          schema: readinessResponseSchema
        }
      }
    }
  }
});

metaRoutes.openapi(readinessRoute, async (c) => {
  const { report, httpStatus } = await checkReadiness(c.env);
  return c.json(report, httpStatus);
});
