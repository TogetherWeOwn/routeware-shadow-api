import { createRoute, z } from "@hono/zod-openapi";
import { createRouteModule } from "./shared";

/**
 * Staging slice of the versioned Shadow API (`/api/v1/shadow/*`).
 *
 * TOG-3495: OpenAPI stub + zod validator only. No prod route is changed —
 * this module adds one new authenticated liveness probe behind the existing
 * `/api/v1/*` bearer gate (only `GET /api/v1/health` is public, see
 * `src/app.ts`). The contract test (`test/shadowContract.test.ts`,
 * `npm run test:contracts`) pins the 200 schema.
 */
export const shadowHealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.string(),
    version: z.literal("v1")
  })
  .openapi("ShadowHealthResponse");

export const shadowRoutes = createRouteModule();

const shadowHealthRoute = createRoute({
  method: "get",
  path: "/api/v1/shadow/health",
  tags: ["shadow"],
  summary: "Shadow API liveness probe (versioned, staging slice)",
  responses: {
    200: {
      description: "Shadow API is running",
      content: {
        "application/json": {
          schema: shadowHealthResponseSchema
        }
      }
    },
    401: {
      description: "Unauthorized"
    }
  }
});

shadowRoutes.openapi(shadowHealthRoute, (c) =>
  c.json(
    { status: "ok" as const, service: "routeware-shadow-api", version: "v1" as const },
    200
  )
);
