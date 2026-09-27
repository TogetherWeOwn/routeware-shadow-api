import { createRoute, z } from "@hono/zod-openapi";
import { checkReadiness } from "../lib/readiness";
import { createRouteModule } from "./shared";

/** Unauthenticated liveness probe — the one route the `/api/v1/*` gate allows. */
export const metaRoutes = createRouteModule();

const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/health",
  security: [],
  responses: {
    200: {
      description: "Worker is running",
      content: {
        "application/json": {
          schema: z
            .object({
              status: z.literal("ok"),
              service: z.string()
            })
            .openapi("HealthResponse")
        }
      }
    }
  }
});

metaRoutes.openapi(healthRoute, (c) =>
  c.json({ status: "ok" as const, service: "routeware-shadow-api" }, 200)
);

export const readinessResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    service: z.string(),
    checks: z.object({
      d1: z.object({ ok: z.boolean(), detail: z.string().optional() }),
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
      })
    })
  })
  .openapi("ReadinessResponse");

const readinessRoute = createRoute({
  method: "get",
  path: "/api/v1/readiness",
  tags: ["meta"],
  summary: "Deep readiness probe (D1, R2, report config)",
  description:
    "Authenticated deploy check: pings D1, reports whether the SNAPSHOTS R2 binding is present, and reports whether each snapshot report source is configured. Returns 200 when every check passes, 503 with per-dependency status otherwise. Requires the same bearer as other /api/v1/* routes.",
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
