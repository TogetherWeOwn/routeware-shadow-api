# Routeware shadow API

Cloudflare Worker that exposes an explicit, versioned HTTP API (`/api/v1/...`) in front of Routeware **WebRW**, with OpenAPI 3.1 at [`/openapi.json`](./src/app.ts) and optional Scalar UI at [`/docs`](./src/app.ts). Upstream session cookies are stored in a **Durable Object** (`AuthSession`); clients do not send Routeware cookies.

## Prerequisites

- Node 20+
- Cloudflare account (for `wrangler deploy`)

## Configure secrets

For local dev, copy [`.dev.vars.example`](./.dev.vars.example) to **`.dev.vars` in the repo root** (same directory as [`wrangler.toml`](./wrangler.toml)), one `KEY=value` per line, **no spaces around `=`**. Then run `npm run check:devvars` to verify keys exist (values are not printed).

**Important:** `wrangler secret put` configures **deployed** Workers only. It does **not** populate `wrangler dev`. Local browser login always needs `.dev.vars` (or the Vitest `test` environment in [`wrangler.toml`](./wrangler.toml) for `npm test` only).

For deployed Workers, use **this repo’s Wrangler** (from `node_modules`) so the correct `workerd` binary for your OS is used — especially under **WSL**, where a global Windows npm Wrangler (`workerd-windows-64`) will fail on Linux.

```bash
cd /path/to/routeware-shadow-api
npm install
npx wrangler secret put LOGIN_USERNAME
npx wrangler secret put LOGIN_PASSWORD
```

Or:

```bash
npm run secret:login-username
npm run secret:login-password
```

**WSL note:** If `wrangler` resolves to `C:\\Users\\...\\AppData\\Roaming\\npm\\`, uninstall or ignore that global install in Linux shells; rely on `npx wrangler` / `npm run` from the project after `npm install` here.

Non-sensitive defaults live in [`wrangler.toml`](./wrangler.toml) under `[vars]`. The
`SHADOW_API_TOKEN` / `CUSTOMER_SNAPSHOT_SYNC_SECRET` values in `[vars]` are **local-dev
placeholders only** — set real values with `wrangler secret put` for deployed Workers.

## Client authentication

Every `/api/v1/*` endpoint requires `Authorization: Bearer <token>` **except**
`GET /api/v1/health`. The token is `SHADOW_API_TOKEN` (falling back to
`CUSTOMER_SNAPSHOT_SYNC_SECRET` when unset). Privileged snapshot/data routes
(`.../sync`, `.../import`, `/api/v1/data/*`, `/api/v1/data-snapshot/sync`) additionally
require `CUSTOMER_SNAPSHOT_SYNC_SECRET`. See [`docs/PROBLEMS.md`](./docs/PROBLEMS.md#unauthorized).

```bash
npx wrangler secret put SHADOW_API_TOKEN
```

Vitest uses the Wrangler **`test`** environment ([`env.test`](./wrangler.toml)), which includes dummy `LOGIN_*` vars so the suite never needs real credentials. Deployed/default environments should use **secrets** for those keys instead.

## Commands

| Command | Purpose |
|--------|---------|
| `npm run dev` | `wrangler dev` — local Worker + Miniflare |
| `npm run dev:remote` | `wrangler dev --remote` — use if Browser Rendering / Puppeteer differs locally |
| `npm run types` | Regenerate [`worker-configuration.d.ts`](./worker-configuration.d.ts) from Wrangler |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest with [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) (`environment: "test"` in [`wrangler.toml`](./wrangler.toml)) |
| `npm run deploy` | Deploy default environment |

## OpenAPI and docs

- **`GET /openapi.json`** — OpenAPI 3.1 document (disabled when `OPENAPI_DOCS_ENABLED` is not `"true"`).
- **`GET /docs`** — Scalar UI when enabled.

## API discovery (traffic harvest)

See [`tools/api-discovery/README.md`](./tools/api-discovery/README.md). Output stays under `tools/api-discovery/out/` (gitignored).

| Command | Purpose |
|--------|--------|
| `npm run discovery:record` | Playwright recorder → `tools/api-discovery/out/harvest.ndjson` |
| `npm run discovery:process` | Validate harvest → aggregate → **HARVEST_API.md** → route gaps → curl examples → suggested route stubs |
| `npm run discovery:verify` | Runs **`discovery:process`** then **`npm test`** (route-map + Worker contract tests) |

After a recording, use **`out/route-gaps.txt`** and **`out/suggested-routes.stub.ts`** to add **`route-map.json`** entries and matching routes in [`src/app.ts`](./src/app.ts).

Example mappings from a typical harvest (SPA + ExtJS):

| Shadow API | Upstream `WebRW` |
|------------|------------------|
| `POST /api/v1/routeware/customer/customers-read` | `POST /Customer/CustomersRead` |
| `POST /api/v1/routeware/customer/detail-full` | `POST /Customer/GetCustomerDetailFull` |
| `POST /api/v1/routeware/data/app-settings-get` | `POST /Data/appSettingsGet` |
| `GET /api/v1/routeware/reports/query-request-is-complete` | `GET /Reports/QueryRequestIsComplete` (client query string forwarded) |

## Cursor rules and MCP

- Project rules: [`.cursor/rules/`](./.cursor/rules/).
- Optional Cloudflare remote MCP entries: [`.cursor/mcp.json`](./.cursor/mcp.json) (OAuth per developer; no tokens in git).
- Agent-oriented summary: [`AGENTS.md`](./AGENTS.md).

## Layout

- [`src/worker.ts`](./src/worker.ts) — Worker entry (re-exports `AuthSession` + Hono `app`).
- [`src/app.ts`](./src/app.ts) — Routes and OpenAPI.
- [`src/lib/`](./src/lib/) — Upstream helpers, problem+json, session retry, browser auth.
