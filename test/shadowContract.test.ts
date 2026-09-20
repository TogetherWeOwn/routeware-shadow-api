import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { shadowHealthResponseSchema } from "../src/routes/shadow";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

/**
 * TOG-3495 staging slice: contract test for the versioned Shadow API
 * `GET /api/v1/shadow/health` -> 200 with schema.
 *
 * Staging-only, behind the existing Cloudflare creds / bearer gate: the route
 * is authenticated (only `GET /api/v1/health` is public — see `src/app.ts`),
 * and no prod route is changed. Run in isolation with `npm run test:contracts`.
 */
async function callShadowHealth(token: string | null): Promise<Response> {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return exports.default.fetch("http://test.local/api/v1/shadow/health", { headers });
}

describe("shadow API contract: GET /api/v1/shadow/health", () => {
  it("returns 200 with a schema-valid body when authorized (positive)", async () => {
    // Arrange / Act
    const res = await callShadowHealth(API_TOKEN);

    // Assert — status first, then shape via the shared zod validator.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body: unknown = await res.json();
    const parsed = shadowHealthResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body).toEqual({ status: "ok", service: "routeware-shadow-api", version: "v1" });
  });

  it("requires the bearer token (staging gate, no creds in repo)", async () => {
    // Arrange / Act
    const res = await callShadowHealth(null);

    // Assert — behind the gate, not public like GET /api/v1/health.
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("rejects a wrong token", async () => {
    const res = await callShadowHealth("nope");
    expect(res.status).toBe(401);
  });

  it("validator rejects a body with a schema field removed (negative)", () => {
    // Arrange — what the handler would return if `version` were dropped.
    const withoutVersion = { status: "ok", service: "routeware-shadow-api" };

    // Act
    const parsed = shadowHealthResponseSchema.safeParse(withoutVersion);

    // Assert — the contract fails when a field is removed.
    expect(parsed.success).toBe(false);
  });

  it("is advertised in the OpenAPI document with the versioned schema", async () => {
    // Arrange / Act
    const res = await exports.default.fetch("http://test.local/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      tags?: Array<{ name: string }>;
      components?: { schemas?: Record<string, unknown> };
    };

    // Assert — route published, 200 declared, shared schema registered.
    expect(doc.paths["/api/v1/shadow/health"]).toBeDefined();
    expect(doc.paths["/api/v1/shadow/health"].get.responses?.["200"]).toBeDefined();
    expect(doc.components?.schemas?.["ShadowHealthResponse"]).toBeDefined();
    expect(doc.tags?.map((t) => t.name)).toContain("shadow");
  });
});
