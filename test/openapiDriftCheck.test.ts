import { describe, expect, it } from "vitest";
import {
  formatDriftReport,
  parseAppMounts,
  parseModuleExports,
  parseRouteModule,
  runDriftCheck,
} from "../scripts/lib/openapiDriftCheck.mjs";

const GOOD_MODULE = `import { createRoute } from "@hono/zod-openapi";
import { createRouteModule } from "./shared";

export const widgetRoutes = createRouteModule();

const widgetListRoute = createRoute({
  method: "get",
  path: "/api/v1/widget",
});

const widgetCreateRoute = createRoute({
  method: "post",
  path: "/api/v1/widget",
});

widgetRoutes.openapi(widgetListRoute, (c) => c.json([]));
widgetRoutes.openapi(widgetCreateRoute, (c) => c.json({}));
`;

const APP_TEXT = `import { widgetRoutes } from "./routes/widget";

app.route("/", widgetRoutes);
`;

function run(
  appText: string,
  module: string,
  text: string | null,
  allExports: Array<{ module: string; file: string }> = [{ module, file: "src/routes/widget.ts" }]
) {
  const mounts = parseAppMounts(appText).map((m) => ({
    ...m,
    text: m.module === module ? text : null,
  }));
  return runDriftCheck({ appText, modules: mounts, allExports });
}

describe("openapi drift check", () => {
  it("passes a healthy module: every declared op is published", () => {
    const outcome = run(APP_TEXT, "widgetRoutes", GOOD_MODULE);
    expect(outcome.ok).toBe(true);
    expect(outcome.drops).toEqual([]);
    expect(outcome.stats).toMatchObject({ mounts: 1, declared: 2, published: 2 });
  });

  it("flags the plain-Hono mount regression the acceptance case targets", () => {
    // Arrange — the exact regression CONVENTIONS.md §3 warns about: a module
    // built on plain Hono instead of createRouteModule(). Traffic is served;
    // /openapi.json sees nothing.
    const plain = GOOD_MODULE
      .replace('import { createRouteModule } from "./shared";', 'import { Hono } from "hono";')
      .replace("export const widgetRoutes = createRouteModule();", "export const widgetRoutes = new Hono();");
    const withHandlers = `${plain}\nwidgetRoutes.get("/api/v1/widget", (c) => c.json([]));\n`;

    // Act
    const outcome = run(APP_TEXT, "widgetRoutes", withHandlers);

    // Assert — both declared ops drop with the plain-Hono cause named, and the
    // report line a reviewer greps for contains the op, the module, and the fix.
    expect(outcome.ok).toBe(false);
    expect(outcome.drops).toHaveLength(2);
    expect(outcome.drops[0].op).toBe("GET /api/v1/widget");
    expect(outcome.drops[0].reason).toMatch(/plain-Hono/);
    expect(outcome.drops[0].reason).toMatch(/createRouteModule/);
    const lines = formatDriftReport(outcome.drops);
    expect(lines[0]).toContain("GET /api/v1/widget");
    expect(lines.join("\n")).toContain("plain-Hono handlers (GET /api/v1/widget)");
  });

  it("flags a declared-but-never-registered route", () => {
    const orphan = `${GOOD_MODULE}\nconst widgetDeleteRoute = createRoute({\n  method: "delete",\n  path: "/api/v1/widget",\n});\n`;
    const outcome = run(APP_TEXT, "widgetRoutes", orphan);
    expect(outcome.ok).toBe(false);
    expect(outcome.drops).toHaveLength(1);
    expect(outcome.drops[0]).toMatchObject({
      op: "DELETE /api/v1/widget",
      module: "widgetRoutes",
    });
    expect(outcome.drops[0].reason).toMatch(/never registered/);
  });

  it("flags an exported-but-never-mounted module and an unreadable mount", () => {
    const mounted = run(APP_TEXT, "widgetRoutes", GOOD_MODULE, [
      { module: "widgetRoutes", file: "src/routes/widget.ts" },
      { module: "ghostRoutes", file: "src/routes/ghost.ts" },
    ]);
    expect(mounted.ok).toBe(false);
    expect(mounted.drops[0]).toMatchObject({ op: null, module: "ghostRoutes" });
    expect(mounted.drops[0].reason).toMatch(/never mounted/);

    const unreadable = run(APP_TEXT, "widgetRoutes", null);
    expect(unreadable.ok).toBe(false);
    expect(unreadable.drops[0].reason).toMatch(/could not be read/);
  });

  it("never mistakes schema naming for route registration", () => {
    // `.openapi("HealthResponse")` (schema naming) must not satisfy the
    // `.openapi(<routeIdent>, …)` registration side.
    const schemaOnly = `import { createRoute, z } from "@hono/zod-openapi";
import { createRouteModule } from "./shared";
export const metaRoutes = createRouteModule();
const healthRoute = createRoute({ method: "get", path: "/api/v1/health" });
const named = z.object({ ok: z.boolean() }).openapi("HealthResponse");
`;
    const parsed = parseRouteModule(schemaOnly);
    expect(parsed.declared).toEqual(["healthRoute"]);
    expect(parsed.registered).toEqual([]);
    expect(parseModuleExports(schemaOnly)).toEqual(["metaRoutes"]);
    expect(parseAppMounts('import { metaRoutes } from "./routes/meta";\napp.route("/", metaRoutes);')).toEqual([
      { module: "metaRoutes", file: "src/routes/meta.ts" },
    ]);
  });
});
