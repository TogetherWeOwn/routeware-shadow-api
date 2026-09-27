/**
 * Pure helpers for the OpenAPI contract-drift check (TOG-6282).
 *
 * Catches the plain-Hono mount regression (CONVENTIONS.md §3): mounting a
 * plain `Hono` sub-app still serves traffic while silently dropping every one
 * of its routes from `/openapi.json`, because `OpenAPIHono.route()` merges a
 * sub-app's `openAPIRegistry` only for `OpenAPIHono` instances. The runtime
 * contract test (`test/openapiContract.test.ts`) pins this under workerd; this
 * check pins it statically and credential-free so it can run in CI hygiene and
 * on a nightly schedule without a Worker runtime, secrets, or network access.
 *
 * Two sides, both read from source text:
 * - Side A (intent): every `createRoute({ method, path })` op declared in a
 *   mounted `*Routes` module.
 * - Side B (published): the ops that survive into `/openapi.json` — the ones
 *   registered via `<module>.openapi(<route>, …)` inside a module built with
 *   `createRouteModule()` (an `OpenAPIHono`).
 *
 * Drift (A minus B) is reported per op with its cause:
 * - module mounted in `app.ts` but its file cannot be resolved from imports,
 * - module built on plain `Hono` (`from "hono"`, `new Hono(`, or
 *   `<mod>.get(…)`/`.post(…)` plain handlers) instead of `createRouteModule()`,
 * - route declared with `createRoute(` but never registered via `.openapi(`,
 * - a `*Routes` export that exists in `src/routes/` but is never mounted with
 *   `app.route(…)` (unreachable and undocumented).
 *
 * `.openapi("Name")` schema-naming calls (e.g. `"HealthResponse"`) are never
 * counted as registrations: only `.openapi(<routeIdent>, …)` with an
 * identifier first argument registers a route.
 *
 * Every function here is pure (strings in, data out). See
 * `scripts/check-openapi-drift.mjs` for the CLI and
 * `docs/OPENAPI-DRIFT-CHECK.md` for the schedule.
 */

export const CHECK_NAME = "openapi-drift";

const ROUTE_VERBS = ["get", "post", "put", "delete", "patch", "options", "all"];

/**
 * Parse `app.ts` source into its `app.route(…)` mounts resolved to files.
 *
 * Returns `[{ module, file }]` where `file` is the repo-relative `src/routes/…`
 * path resolved through the `import { … } from "…"` map, or `null` when the
 * mounted name has no matching import (itself a drift finding).
 */
export function parseAppMounts(appText) {
  const text = String(appText);
  const importSources = new Map();
  const importRe = /import\s*\{\s*([^}]+?)\s*\}\s*from\s*["']([^"']+)["']/g;
  let match;
  while ((match = importRe.exec(text)) !== null) {
    const [, names, source] = match;
    for (const name of names.split(",")) {
      const ident = name.trim().split(/\s+as\s+/).pop().trim();
      if (ident) importSources.set(ident, source);
    }
  }
  const mounts = [];
  const mountRe = /app\.route\(\s*["'][^"']*["']\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  while ((match = mountRe.exec(text)) !== null) {
    const module = match[1];
    const source = importSources.get(module);
    mounts.push({
      module,
      file: source ? `${source.replace(/^\.\//, "src/")}.ts` : null,
    });
  }
  return mounts;
}

/** All `export const <…Routes>` names in a route file. */
export function parseModuleExports(fileText) {
  const names = [];
  const re = /export\s+const\s+([A-Za-z_$][\w$]*Routes)\s*=/g;
  let match;
  while ((match = re.exec(fileText)) !== null) names.push(match[1]);
  return names;
}

/**
 * Parse one route-module file.
 *
 * Returns `{ ops, declared, registered, usesCreateRouteModule, usesPlainHono,
 * plainHandlers }` where `ops` is `[{ name, method, path }]` (one per
 * `createRoute({ method, path })` block), `declared`/`registered` are the
 * route-const names on each side of the `.openapi(<route>, …)` call, and
 * `plainHandlers` is `["GET /path", …]` for direct `<mod>.get("…")`-style
 * calls whose first argument starts with `/` (served but undocumented).
 */
export function parseRouteModule(fileText) {
  const text = String(fileText);
  const declared = [];
  const declareRe = /(?:^|[\s;])(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*createRoute\(\s*\{/gm;
  let match;
  while ((match = declareRe.exec(text)) !== null) declared.push(match[1]);

  // `method` is always the first key of the `createRoute({ … })` literal in
  // this repo (verified across all 11 modules); `path` follows it directly.
  const ops = [];
  const opRe = /createRoute\(\s*\{\s*method:\s*"([a-z]+)"\s*,\s*path:\s*"([^"]+)"/gi;
  while ((match = opRe.exec(text)) !== null) {
    ops.push({ method: match[1].toUpperCase(), path: match[2] });
  }

  const registered = [];
  const registerRe = /\.openapi\(\s*([A-Za-z_$][\w$]*)\s*,/g;
  while ((match = registerRe.exec(text)) !== null) registered.push(match[1]);

  const usesCreateRouteModule = /createRouteModule\(\s*\)/.test(text);
  const plainHandlers = [];
  for (const line of text.split("\n")) {
    const found = line.match(
      new RegExp(`^\\s*[A-Za-z_$][\\w$]*\\.(${ROUTE_VERBS.join("|")})\\(\\s*["'\`](\\/[^"'\\\`]*?)["'\`]`)
    );
    if (found) plainHandlers.push(`${found[1].toUpperCase()} ${found[2]}`);
  }
  const usesPlainHono =
    /from\s*["']hono["']/.test(text) || /new\s+Hono\s*[<(]/.test(text) || plainHandlers.length > 0;

  return { ops, declared, registered, usesCreateRouteModule, usesPlainHono, plainHandlers };
}

/**
 * Run the drift compare.
 *
 * `appText` is `src/app.ts` source; `modules` is `[{ module, file, text }]`
 * with `text: null` when the file could not be read. `allExports` is
 * `[{ module, file }]` for every `*Routes` export found anywhere under the
 * routes dir (used for the not-mounted class).
 *
 * Returns `{ ok, drops, stats }`. `drops` is `[{ op, module, file, reason }]`
 * with `op` null for module-level causes.
 *
 * @param {{ appText: string, modules: Array<{ module: string, file: string | null, text: string | null }>, allExports?: Array<{ module: string, file: string | null }> }} args
 */
export function runDriftCheck({ appText, modules, allExports = [] }) {
  const mounts = parseAppMounts(appText);
  const mountedNames = new Set(mounts.map((m) => m.module));
  const drops = [];
  let published = 0;
  let declared = 0;

  for (const mount of mounts) {
    const entry = modules.find((m) => m.module === mount.module);
    if (!entry || entry.text == null) {
      drops.push({
        op: null,
        module: mount.module,
        file: mount.file,
        reason: `mounted via app.route() but module file ${mount.file ?? "(unresolvable import)"} could not be read`,
      });
      continue;
    }
    const parsed = parseRouteModule(entry.text);
    declared += parsed.ops.length;
    if (parsed.usesPlainHono || !parsed.usesCreateRouteModule) {
      const why = parsed.plainHandlers.length > 0
        ? `plain-Hono handlers (${parsed.plainHandlers.join(", ")})`
        : !parsed.usesCreateRouteModule
          ? "not built with createRouteModule() (plain Hono drops out of /openapi.json)"
          : 'bare "hono" import/instantiation';
      for (const op of parsed.ops) {
        drops.push({
          op: `${op.method} ${op.path}`,
          module: mount.module,
          file: mount.file,
          reason: `${mount.module} mounts a plain-Hono module: ${why}. Rebuild it with createRouteModule() so OpenAPIHono.route() merges its registry.`,
        });
      }
      continue;
    }
    const registeredSet = new Set(parsed.registered);
    const opByName = new Map();
    // Pair ops to declared names positionally: every declaration in this repo
    // is `const <name> = createRoute({ method, path … })`, so the nth
    // `createRoute({` block belongs to the nth declared name.
    parsed.declared.forEach((name, i) => {
      if (parsed.ops[i]) opByName.set(name, `${parsed.ops[i].method} ${parsed.ops[i].path}`);
    });
    for (const name of parsed.declared) {
      if (!registeredSet.has(name)) {
        drops.push({
          op: opByName.get(name) ?? name,
          module: mount.module,
          file: mount.file,
          reason: `${name} is declared with createRoute() but never registered via ${mount.module}.openapi(${name}, …) — it serves no traffic and is absent from /openapi.json.`,
        });
      } else {
        published += 1;
      }
    }
  }

  for (const exp of allExports) {
    if (!mountedNames.has(exp.module)) {
      drops.push({
        op: null,
        module: exp.module,
        file: exp.file,
        reason: `${exp.module} is exported from ${exp.file} but never mounted with app.route() — unreachable and absent from /openapi.json.`,
      });
    }
  }

  return { ok: drops.length === 0, drops, stats: { mounts: mounts.length, declared, published } };
}

/** Human-readable drift report lines for CI/schedule logs. */
export function formatDriftReport(drops) {
  return drops.map((d) => (d.op ? `${d.op} (${d.module}, ${d.file}): ${d.reason}` : `${d.module} (${d.file}): ${d.reason}`));
}
