# Routeware shadow API — agent context

## Layout

- `src/worker.ts` — Cloudflare Worker default export (`ExportedHandler<Env>`).
- `src/app.ts` — Hono application, OpenAPI registry, `/api/v1` routes.
- `src/lib/` — Pure helpers (upstream headers, login redirect detection, problem+json, URL builders).
- `src/authSession.do.ts` — Durable Object for upstream session cookies.
- `test/` — Vitest + `@cloudflare/vitest-pool-workers` (integration + unit).
- `tools/api-discovery/` — Headed Playwright recorder for Routeware traffic (NDJSON + aggregation).
- `.cursor/rules/` — Cursor project rules (Workers, tests, OpenAPI, discovery).

## Commands

- `npm run dev` — `wrangler dev` (local Miniflare; runs `check:devvars` first; no `--remote` needed since HTTP login skips Browser Rendering).
- `npm run dev:remote` — `wrangler dev --remote` (exercises the Browser Rendering login fallback).
- `npm run db:migrate:local` / `npm run db:migrate:remote` — apply `migrations/d1/*.sql` to the local / deployed D1.
- `npm run types` — `wrangler types` → `src/worker-configuration.d.ts`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` / `npm run test:watch` — Vitest.
- `npm run deploy` — `wrangler deploy` (CI/CD auto-deploys on merge to `main` via `.github/workflows/ci.yml`).
- `npm run discovery:record` — Playwright harvester (`tools/api-discovery`).
- `npm run discovery:process` — Harvest → docs, gaps, curls, suggested stubs (see `tools/api-discovery/README.md`).
- `npm run discovery:verify` — `discovery:process` + `npm test` (full agent loop after a new recording).

## Secrets

Set `LOGIN_USERNAME`, `LOGIN_PASSWORD`, and a client token (`SHADOW_API_TOKEN`, falling back to `CUSTOMER_SNAPSHOT_SYNC_SECRET`) via `wrangler secret put` (deployed) or `.dev.vars` (local). These are **not** in `wrangler.toml [vars]`; a deployed Worker with no token set fails closed (401 on all `/api/v1/*` except health).

## OpenAPI

- Spec URL: `GET /openapi.json` (when the Worker serves the app).
- UI: `GET /docs` if `OPENAPI_DOCS_ENABLED` is `true` in `[vars]` / `.dev.vars`.

## MCP (optional)

See README: project `.cursor/mcp.json` lists Cloudflare remote MCP servers (OAuth per developer). No tokens belong in git.
