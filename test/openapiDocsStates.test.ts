/**
 * Vite client types for the bundled `wrangler.toml?raw` import below. The
 * suite runs inside the workers pool (workerd: no `node:fs`), so repo text is
 * read through bundled `?raw` imports instead of filesystem reads.
 */
/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import app from "../src/app";
import wranglerToml from "../wrangler.toml?raw";

/**
 * Pin the Scalar UI gated-404 vs enabled-render states end to end (TOG-6283).
 *
 * `test/openapiDocsGate.test.ts` (TOG-5828) already proves the app gate logic
 * with fabricated envs. This file pins what that file cannot: the actual
 * `wrangler.toml` wiring — default env OFF (`404 problem+json` on both
 * endpoints) and `[env.test]` ON (spec renders, Scalar HTML renders) — so a
 * config flip fails CI instead of silently exposing or hiding the docs.
 *
 * Both endpoints × both states × both wrangler envs: 8 pins.
 */

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function tomlSection(toml: string, header: string): string {
  const match = toml.match(
    new RegExp(`(?:^|\\n)\\[${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\n([\\s\\S]*?)(?=\\n\\[[^\\n]*\\]|\\n\\[\\[[^\\n]*\\]\\]|$)`)
  );
  return match ? match[1] : "";
}

function sectionVar(section: string, key: string): string | null {
  const match = section.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : null;
}

function docsFlagFor(envName: "default" | "test"): string | null {
  if (envName === "test") {
    // `[env.test.vars]` — dotted header, not nested table syntax.
    const match = wranglerToml.match(
      /(?:^|\n)\[env\.test\.vars\]\n([\s\S]*?)(?=\n\[[^\n]*\]|\n\[\[[^\n]*\]\]|$)/
    );
    return match ? sectionVar(match[1], "OPENAPI_DOCS_ENABLED") : null;
  }
  return sectionVar(tomlSection(wranglerToml, "vars"), "OPENAPI_DOCS_ENABLED");
}

function docsEnv(value: unknown): Env {
  return { OPENAPI_DOCS_ENABLED: value } as unknown as Env;
}

async function get(path: string, env: Env): Promise<Response> {
  return app.fetch(new Request(`http://test.local${path}`), env, ctx);
}

describe("docs gate wiring per wrangler env (TOG-6283)", () => {
  it('default [vars] keeps OPENAPI_DOCS_ENABLED="false"', () => {
    expect(docsFlagFor("default")).toBe("false");
  });

  it('keeps OPENAPI_DOCS_ENABLED="true" in [env.test.vars]', () => {
    expect(docsFlagFor("test")).toBe("true");
  });

  it.each(["/openapi.json", "/docs"] as const)(
    "default env: GET %s returns 404 problem+json",
    async (path) => {
      const res = await get(path, docsEnv(docsFlagFor("default")));
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as {
        type: string;
        title: string;
        status: number;
        detail: string;
        instance: string;
      };
      expect(body.status).toBe(404);
      expect(body.instance).toBe(path);
    }
  );

  it("test env: GET /openapi.json renders the 3.1 spec", async () => {
    const res = await get("/openapi.json", docsEnv(docsFlagFor("test")));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; info: { title: string } };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.info.title).toBe("Routeware Shadow API");
  });

  it("test env: GET /docs renders the Scalar UI wired to /openapi.json", async () => {
    const res = await get("/docs", docsEnv(docsFlagFor("test")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>Routeware Shadow API</title>");
    expect(html.toLowerCase()).toContain("scalar");
    expect(html).toContain("/openapi.json");
  });
});
