import { createRoute, z } from "@hono/zod-openapi";
import { createRouteModule } from "./shared";

/**
 * Staging slice of the versioned Shadow API (`/api/v1/shadow/*`).
 *
 * OpenAPI stub + zod validator only. No prod route is changed —
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
  operationId: "getShadowHealth",
  "x-access": "read",
  "x-effect": "none",
  tags: ["shadow"],
  summary: "Shadow API liveness probe (versioned, staging slice)",
  description:
    "Bearer-gated like every `/api/v1/*` route except `GET /api/v1/health`. Returns `{status, service, version}` when the Worker is running; it does not check D1, R2, or report config.",
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
