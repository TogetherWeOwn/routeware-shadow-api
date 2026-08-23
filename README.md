# Routeware shadow API

Cloudflare Worker that exposes an explicit, versioned HTTP API (`/api/v1/...`) in front of Routeware **WebRW**, with OpenAPI 3.1 at [`/openapi.json`](./src/app.ts) and optional Scalar UI at [`/docs`](./src/app.ts). Upstream session cookies are stored in a **Durable Object** (`AuthSession`); clients do not send Routeware cookies.

> ### ⚠️ New owner? CI is switched off — read this before you push
>
> GitHub **Actions is administratively disabled** on this repository, and it has **no secrets and no
> environments**. Push a branch or open a PR and *nothing will run*; merge to `main` and it will
> **not** deploy. That is deliberate, not a broken workflow — this repo was created as a clean
> replacement and a new repo starts with no `CLOUDFLARE_API_TOKEN`, so the deploy job would otherwise
> run against production tooling with an empty credential.
>
> **[`docs/HANDOVER.md` § 0](./docs/HANDOVER.md#0-do-this-first--ci-is-switched-off-in-this-repository)
> has the ordered fix** — create the token, create the `production` environment, add the secret,
> re-enable Actions, then verify with a throwaway PR. The order matters.
>
> That file is also the handover document generally: what lives outside this repo (Cloudflare
> account, resource ids, the Routeware tenant), the transfer runbook, and the open tasks.

## Prerequisites

- Node 20+ (see [`.nvmrc`](./.nvmrc); `nvm use` picks it up)
- Cloudflare account (for `wrangler deploy`)

## Quick start (local)

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in LOGIN_* and a client token
npm run db:migrate:local          # create the local D1 tables
npm run dev                       # http://localhost:8787
```

`npm run dev` runs `check:devvars` first and fails fast if `.dev.vars` is missing a
required key. Local dev uses the browser-free HTTP login, so **no `--remote` is needed**;
use `npm run dev:remote` only to exercise the Browser Rendering fallback.

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

Non-sensitive defaults live in [`wrangler.toml`](./wrangler.toml) under `[vars]`. Bearer
secrets (`SHADOW_API_TOKEN`, `CUSTOMER_SNAPSHOT_SYNC_SECRET`) are **not** defined in
`[vars]` — set them in `.dev.vars` for local dev and via `wrangler secret put` for deployed
Workers. A deployed Worker with no token set **fails closed** (see [Deploy](#deploy)).

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
| `npm run dev` | `wrangler dev` — local Worker + Miniflare (runs `check:devvars` first). With `AUTH_MODE=auto`/`http`, HTTP login needs no Browser Rendering, so this works **without** `--remote` |
| `npm run dev:remote` | `wrangler dev --remote` — use to exercise the Browser Rendering / Puppeteer login fallback |
| `npm run db:migrate:local` | Apply `migrations/d1/*.sql` to the **local** Miniflare D1 (run once after cloning) |
| `npm run db:migrate:remote` | Apply migrations to the **deployed** D1 (CD does this automatically before deploy) |
| `npm run types` | Regenerate [`worker-configuration.d.ts`](./worker-configuration.d.ts) from Wrangler |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest with [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) (`environment: "test"` in [`wrangler.toml`](./wrangler.toml)) |
| `npm run deploy` | Manual deploy (CI/CD deploys automatically on merge to `main` — see [Deploy](#deploy)) |

## Deploy

Merges to `main` deploy automatically via [`.github/workflows/ci.yml`](./.github/workflows/ci.yml):
the `build` job (typecheck + test + `wrangler deploy --dry-run`) and `hygiene` job must
pass, then the `deploy` job applies remote D1 migrations and runs `wrangler deploy`.
`account_id` lives in [`wrangler.toml`](./wrangler.toml), so CI needs only an API token.

**One-time setup:**

1. **Scoped API token** — Cloudflare dashboard → My Profile → API Tokens → *Edit
   Cloudflare Workers* template; confirm **D1 : Edit** is included (for migrations).
   Do **not** use the Global API Key.
2. **GitHub secret** — add the token as `CLOUDFLARE_API_TOKEN` (repo → Settings → Secrets
   and variables → Actions), ideally under a `production` Environment.
3. **Worker secrets** — set real values once; they persist across deploys and are never in
   git or `[vars]`:

   ```bash
   npx wrangler secret put SHADOW_API_TOKEN
   npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET
   npx wrangler secret put LOGIN_USERNAME
   npx wrangler secret put LOGIN_PASSWORD
   ```

   The bearer tokens are **not** defined in `[vars]`, so a Worker with no secret set
   **fails closed** (every `/api/v1/*` route except `GET /api/v1/health` returns 401)
   rather than trusting a committed placeholder.

To deploy by hand instead, run `npm run db:migrate:remote && npm run deploy` locally.

## OpenAPI and docs

- **`GET /openapi.json`** — OpenAPI 3.1 document (disabled when `OPENAPI_DOCS_ENABLED` is not `"true"`).
- **`GET /docs`** — Scalar UI when enabled.

## API discovery (traffic harvest)

Record what you do on the Routeware site — every request, its args/params, and the
response — then turn the gaps into new shadow API routes. See
[`tools/api-discovery/README.md`](./tools/api-discovery/README.md). Output stays under
`tools/api-discovery/out/` (gitignored). Sensitive values (credentials, tokens, PII) are
masked by default; field names, body structure, and query params are preserved.

| Command | Purpose |
|--------|--------|
| `npm run discovery:setup` | One-time: install Playwright + the Chromium browser |
| `npm run discovery:record` | Headed recorder → `tools/api-discovery/out/harvest.ndjson` (redacted). Log in, do your workflow, press Enter to stop |
| `npm run discovery:record:full` | Same, but captures **all** headers/values (cookies, tokens) for full replay — keep the harvest private |
| `npm run discovery:codegen` | Record your **UI actions** (clicks/typing) into a replayable Playwright script |
| `npm run discovery:process` | Validate harvest → aggregate → **HARVEST_API.md** → route gaps → curl examples → suggested route stubs |
| `npm run discovery:verify` | Runs **`discovery:process`** then **`npm test`** (route-map + Worker contract tests) |

Typical loop: `discovery:setup` (once) → `discovery:record` while you use the site →
`discovery:process` → open **`out/route-gaps.txt`** and **`out/suggested-routes.stub.ts`**
to add **`route-map.json`** entries and matching routes in [`src/app.ts`](./src/app.ts).

Example mappings from a typical harvest (SPA + ExtJS):

| Shadow API | Upstream `WebRW` |
|------------|------------------|
| `POST /api/v1/routeware/customer/customers-read` | `POST /Customer/CustomersRead` |
| `POST /api/v1/routeware/customer/detail-full` | `POST /Customer/GetCustomerDetailFull` |
| `POST /api/v1/routeware/data/app-settings-get` | `POST /Data/appSettingsGet` |
| `GET /api/v1/routeware/reports/query-request-is-complete` | `GET /Reports/QueryRequestIsComplete` (client query string forwarded) |

## Project rules

- Conventions, invariants and the verification loop: [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) — read before any change.
- Optional Cloudflare remote MCP entries: [`.cursor/mcp.json`](./.cursor/mcp.json) (OAuth per developer; no tokens in git).

## Layout

- [`src/worker.ts`](./src/worker.ts) — Worker entry (re-exports `AuthSession` + Hono `app`).
- [`src/app.ts`](./src/app.ts) — Routes and OpenAPI.
- [`src/lib/`](./src/lib/) — Upstream helpers, problem+json, session retry, browser auth.
