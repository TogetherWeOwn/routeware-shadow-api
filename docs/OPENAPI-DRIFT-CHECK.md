# OpenAPI contract-drift check

**Status:** script, unit tests and CI wiring merged. The check runs in the
`hygiene` job on every pull request, push to `main` and the nightly schedule
(no new services, no paid tiers, no new secrets — same constraint as the cron
alarm runbook).

**Why:** a route module built on plain `Hono` instead of `createRouteModule()`
still serves traffic while silently dropping every one of its routes from
`/openapi.json` (`OpenAPIHono.route()` merges a sub-app's registry only for
`OpenAPIHono` instances). The runtime contract test
(`test/openapiContract.test.ts`) pins this under workerd; this check pins it
statically and credential-free so it can run in CI hygiene and on a nightly
schedule with no Worker runtime, no secrets, and no network access
(CONVENTIONS.md §3).

## 0. The command

```bash
node scripts/check-openapi-drift.mjs
# openapi-drift: OK — 35/35 declared op(s) published across 11 mounted module(s)
```

Reads `src/app.ts` (mounts) and `src/routes/*.ts` (declared
`createRoute({ method, path })` vs registered `<module>.openapi(<route>, …)`).
Exit 0 when every declared op is published; exit 1 naming each dropped op (or
module) with its cause; exit 2 when an input is missing/unreadable — never a
missing file reported as a pass. Flags (for fixture-driven proofs without
touching `src/`):

```bash
node scripts/check-openapi-drift.mjs --app=<path> --routes-dir=<path>
```

Pure rule lives in `scripts/lib/openapiDriftCheck.mjs`, unit-tested by
`test/openapiDriftCheck.test.ts` without Wrangler, credentials, or network.

## 1. What it flags (cause → fix)

| Cause | Meaning | Fix |
|---|---|---|
| plain-Hono module | Module not built with `createRouteModule()` (bare `hono` import, `new Hono(`). One drop per declared op. | Rebuild with `createRouteModule()`; register each route via `<mod>.openapi(…)`. |
| unmatched plain handler | Direct `.get(…)`/`.post(…)` handler with no `createRoute()` declaration. Served, undocumented. | Rebuild with `createRouteModule()`; declare via `createRoute()` and register via `<mod>.openapi(…)`. |
| declared, never registered | `createRoute()` const with no matching `<mod>.openapi(<name>, …)`. Serves nothing, documents nothing. | Register it, or delete the dead declaration. |
| exported, never mounted | `*Routes` export with no `app.route(…)` mount. Unreachable and undocumented. | Mount it in `src/app.ts` (before the doc endpoints, after the two `/api/v1/*` gates), or delete it. |
| mounted, unreadable | `app.route()` name with no resolvable import. | Fix the import, or remove the mount. |

`.openapi("Name")` schema-naming calls never count as registrations — only
`.openapi(<routeIdent>, …)` does.

## 2. Acceptance proof: dummy plain-Hono route fails the gate

The unit tests cover both halves of the regression: a mixed module (declared
`createRoute()` ops on plain `Hono`) drops every declared op with the
plain-Hono cause named, and a pure direct-handler module (zero declarations,
only `.get(…)`/`.post(…)`) drops one op per unmatched handler — served but
undocumented. To replay the pure-handler half against fixtures by hand:

```bash
mkdir -p /tmp/drift-proof/routes
cat > /tmp/drift-proof/app.ts <<'EOF'
import { dummyRoutes } from "./routes/dummy";
app.route("/", dummyRoutes);
EOF
cat > /tmp/drift-proof/routes/dummy.ts <<'EOF'
import { Hono } from "hono";
export const dummyRoutes = new Hono();
dummyRoutes.get("/api/v1/dummy", (c) => c.json({}));
EOF
node scripts/check-openapi-drift.mjs --app=/tmp/drift-proof/app.ts --routes-dir=/tmp/drift-proof/routes
# openapi-drift: GET /api/v1/dummy (dummyRoutes, src/routes/dummy.ts): dummyRoutes serves GET /api/v1/dummy via a direct plain-Hono handler with no createRoute() declaration — served but absent from /openapi.json. Rebuild it with createRouteModule() and register each route via dummyRoutes.openapi(…).
# exit 1
```

(The CLI looks the mounted module up under `src/routes/` relative to the
repo root, so the fixture resolves only when `--routes-dir` points at a real
`src/routes` overlay containing `dummy.ts`. A reviewer can also verify live:
temporarily rebuild any one module on plain `Hono` in a scratch worktree and
watch the check name every dropped op.)

## 3. Schedule (wired)

Credential-free, alongside the other static gates in the `hygiene` job of
`.github/workflows/ci.yml`:

- **Cadence:** every pull request, every push to `main`, and the nightly
  `schedule` trigger (`cron: "23 4 * * *"`, `ci.yml:8-11`). The `hygiene` job has
  no `if:`, so it is never skipped, including on docs-only PRs. Detection
  latency for a regression that slips past PR gating is ≤ 24h, same bound as
  the cron alarm loop.
- **Where:** the OpenAPI drift check step in `ci.yml` runs
  `npm run check:openapi-drift` (`package.json:18`). The check reads source
  text only, so it needs no token. `scripts/check-ci-workflow.mjs:117` pins the
  step so it cannot be dropped silently.
- **Alerting:** the step's non-zero exit fails the run — the finding IS the
  alert (name, op, cause in the log). No paging tier, same posture as the
  coverage ratchet and per-file gate. Record the disposition where the team
  looks.

## 4. What this check does not cover

- Runtime-only divergence (a handler that throws, an auth gate mis-order):
  that is `test/openapiContract.test.ts` territory under workerd.
- Whether the documented schemas match upstream Routeware shapes: the
  discovery recorder (`tools/api-discovery/`) owns that.
