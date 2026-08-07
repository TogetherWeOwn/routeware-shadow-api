import { createRoute, z } from "@hono/zod-openapi";
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
