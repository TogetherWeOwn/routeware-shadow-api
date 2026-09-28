# Routeware shadow API

Cloudflare Worker that exposes an explicit, versioned HTTP API (`/api/v1/...`) in front of Routeware **WebRW**, with OpenAPI 3.1 at [`/openapi.json`](./src/app.ts) and optional Scalar UI at [`/docs`](./src/app.ts). Upstream session cookies are stored in a **Durable Object** (`AuthSession`); clients do not send Routeware cookies.

> ### ⚠️ New owner? Verify PR checks first, production deploys separately
>
> GitHub Actions runs on self-hosted runners labeled `two-selfhosted`. PR `build` and `hygiene`
> jobs are credential-free; the optional `shadow-api-v1` probe reports a gated result when
> `CF_TOKEN` is absent. Production deploys remain skipped unless `PRODUCTION_DEPLOY_ENABLED`
> is exactly `true`. Repository settings and credentials must be verified separately at handover.
>
> **[`docs/HANDOVER.md` § 0](./docs/HANDOVER.md#0-do-this-first--enable-pr-ci-before-enabling-production-deploys)
> has the phased procedure** — enable Actions and verify a throwaway PR first; configure the
> `production` environment and token later; set the repository variable last.
>
> That file is also the handover document generally: what lives outside this repo (Cloudflare
> account, resource ids, the Routeware tenant), the transfer runbook, and the open tasks.

## Prerequisites

- Node 20+ (see [`.nvmrc`](./.nvmrc); `nvm use` picks it up)
- Cloudflare account (for `wrangler deploy`)

## Quick start (local)

```bash
nvm use                             # Node 20+, per .nvmrc (engines: >=20)
npm install                         # includes devDependencies (wrangler, vitest); add --include=dev if your shell omits them
cp .dev.vars.example .dev.vars      # then fill in values (see below)
npm run db:migrate:local            # create the local D1 tables (once per clone)
npm run dev                         # http://localhost:8787 (runs check:devvars first)
```

**Filling in `.dev.vars`** (one `KEY=value` per line, no spaces around `=`): `SHADOW_API_TOKEN`
can be any local-only string you invent — it is *your* bearer for `/api/v1/*`, so dummy
values work for local dev. `LOGIN_USERNAME` / `LOGIN_PASSWORD` must be real Routeware tenant
credentials for any upstream-backed route; dummy values are fine up to and including the
verify step below, which never touches upstream. Run `npm run check:devvars` to verify keys
exist (values are never printed); `npm run dev` runs it automatically and fails fast.

**Verify with your first calls** — public health needs no token, the shadow probe needs yours:

```bash
curl http://localhost:8787/api/v1/health
curl -H "Authorization: Bearer <SHADOW_API_TOKEN>" http://localhost:8787/api/v1/shadow/health
# or both at once (token is read from .dev.vars, never printed):
npm run probe:post-deploy -- http://localhost:8787
```

Expect `{"status":"ok",...}` and HTTP 200 from each. A 401 on the second call means
`.dev.vars` has no non-empty `SHADOW_API_TOKEN` (falling back to
`CUSTOMER_SNAPSHOT_SYNC_SECRET`); re-check it with `npm run check:devvars` and restart
`wrangler dev` after editing.

For the full five-rung ladder with copy-paste commands and exact expected
bodies — health → bearer-gate 401 → token load from `.dev.vars` →
shadow/health → readiness — see
[`docs/CONSUMER-QUICKSTART.md`](./docs/CONSUMER-QUICKSTART.md#smoke-ladder-five-copy-paste-commands-fresh-clone--green)
(it runs verbatim on a fresh clone).

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
Failed bearer checks are throttled per IP (20 failures / 60 s → `429` for 60 s);
see [`docs/PROBLEMS.md`](./docs/PROBLEMS.md#rate-limited). A valid token always
passes and resets the counter.

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
| `npm run check:ci-workflow` | Verify credential-free build/hygiene, the optional staging credential boundary, and fail-closed production deploy gates |
| `npm run deploy` | Manual deploy (CI deploys pushes to `main` only when explicitly enabled — see [Deploy](#deploy)) |

## Deploy

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) always keeps PR verification separate from
production authorization: the credential-free `build` job (workflow invariant check + typecheck +
test + `wrangler deploy --dry-run`) and `hygiene` job run on PRs, while the `deploy` job runs only on
a push to `main` when `PRODUCTION_DEPLOY_ENABLED` is exactly `true`. Deploy then applies remote D1
migrations and runs `wrangler deploy` using the `production` environment. All jobs use self-hosted
runners labeled `two-selfhosted`; the additional `shadow-api-v1` probe skips contract execution when
its optional `CF_TOKEN` is absent.

**Enable production only after the full setup is ready:**

1. **Scoped API token** — Cloudflare dashboard → My Profile → API Tokens → *Edit
   Cloudflare Workers* template; confirm **D1 : Edit** is included (for migrations).
   Do **not** use the Global API Key.
2. **GitHub `production` environment** — add the token there as the environment secret
   `CLOUDFLARE_API_TOKEN`.
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
4. **Repository variable last** — set `PRODUCTION_DEPLOY_ENABLED` to `true` only after the
   environment, API token, resources and Worker secrets are ready. Delete or change the variable to
   stop deploys without disabling PR checks. See [`docs/HANDOVER.md` § 0](./docs/HANDOVER.md#0-do-this-first--enable-pr-ci-before-enabling-production-deploys).

Manual production deploy commands are intentionally outside the ordinary development loop; follow
the handover runbook rather than running them opportunistically.

## OpenAPI and docs

- **`GET /openapi.json`** — OpenAPI 3.1 document. Served only when `OPENAPI_DOCS_ENABLED`
  is `"true"`; deployed envs default it to `"false"` (fail-closed, 404), while local dev
  enables it via [`.dev.vars.example`](./.dev.vars.example) and the Vitest `test` env keeps it
  on for contract tests.
- **`GET /docs`** — Scalar UI, same gate as above.

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
| `GET /api/v1/routeware/reports/query-request-is-complete` | `GET /Reports/QueryRequestIsComplete` (`requestID` + `_` forwarded; other query params dropped — see `docs/PROBLEMS.md` § query-param allowlist) |

## Project rules

- Conventions, invariants and the verification loop: [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) — read before any change.
- How to contribute: [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, PR checks, conventional commits.
- Security policy: [`SECURITY.md`](./SECURITY.md) — how to report a vulnerability privately (report channel, scope, response SLA, safe harbor).
- Code of conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).

## License

[MIT](./LICENSE) — proposed for the TOG-4025 open-sourcing track; owner to confirm before the repo goes public.

## Layout

- [`src/worker.ts`](./src/worker.ts) — Worker entry (re-exports `AuthSession` + Hono `app`).
- [`src/app.ts`](./src/app.ts) — Routes and OpenAPI.
- [`src/lib/`](./src/lib/) — Upstream helpers, problem+json, session retry, browser auth.
