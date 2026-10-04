import { describe, expect, it } from "vitest";
import app from "../src/app";

/**
 * Fail-closed gate on the public docs surface (TOG-5828).
 *
 * `wrangler.toml` defaults `OPENAPI_DOCS_ENABLED` to `"false"` in deployed
 * envs, so `/openapi.json` and `/docs` must return 404 unless the var is
 * explicitly `"true"`. Local dev opts back in via `.dev.vars`; the Vitest
 * `test` env keeps it `"true"` so contract tests can read the spec.
 *
 * These tests call `app.fetch` directly with a minimal env because the
 * `cloudflare:workers` self-fetch path always runs under `[env.test.vars]`
 * (docs ON) and cannot exercise the disabled branch.
 */

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function docsEnv(value: unknown): Env {
  return { OPENAPI_DOCS_ENABLED: value } as unknown as Env;
}

async function get(path: string, env: Env): Promise<Response> {
  return app.fetch(new Request(`http://test.local${path}`), env, ctx);
}

describe("OpenAPI docs gate (TOG-5828)", () => {
  it("GET /openapi.json returns 404 problem+json when docs are disabled", async () => {
    const res = await get("/openapi.json", docsEnv("false"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as { status: number; detail?: string };
    expect(body.status).toBe(404);
    expect(body.detail).toMatch(/OPENAPI_DOCS_ENABLED/);
  });

  it("GET /docs returns 404 problem+json when docs are disabled", async () => {
    const res = await get("/docs", docsEnv("false"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("problem+json");
  });

  it("fails closed when the var is missing or empty (not just \"false\")", async () => {
    for (const value of [undefined, "", "0", "TRUE"]) {
      const res = await get("/openapi.json", docsEnv(value));
      expect(res.status).toBe(404);
    }
    const docs = await get("/docs", docsEnv(undefined));
    expect(docs.status).toBe(404);
  });

  it("stamps hardening headers on the disabled-branch 404s (TOG-8368)", async () => {
    for (const path of ["/openapi.json", "/docs"]) {
      const res = await get(path, docsEnv("false"));
      expect(res.status).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("stamps hardening headers on the served spec and UI (TOG-8368)", async () => {
    const spec = await get("/openapi.json", docsEnv("true"));
    expect(spec.status).toBe(200);
    expect(spec.headers.get("x-content-type-options")).toBe("nosniff");
    expect(spec.headers.get("x-frame-options")).toBe("DENY");
    expect(spec.headers.get("referrer-policy")).toBe("no-referrer");

    const ui = await get("/docs", docsEnv("true"));
    expect(ui.status).toBe(200);
    expect(ui.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ui.headers.get("x-frame-options")).toBe("DENY");
    expect(ui.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("serves the spec and UI when explicitly enabled", async () => {
    const spec = await get("/openapi.json", docsEnv("true"));
    expect(spec.status).toBe(200);
    const doc = (await spec.json()) as { openapi: string };
    expect(doc.openapi).toMatch(/^3\.1/);

    const ui = await get("/docs", docsEnv("true"));
    expect(ui.status).toBe(200);
    expect(ui.headers.get("content-type")).toContain("text/html");
  });
});
