# Routeware CSV snapshots (D1)

Routeware **Customer / Address / Container** custom report exports are cached in a single D1 database (`CUSTOMER_DB`) so the Worker can query them without replaying the SPA.

## Data model (foreign keys)

- `customer_snapshot` — **primary key** `customer_id` (Routeware `CustomerID`)
- `address_snapshot` — **primary key** `pickup_address_id` (Routeware `PickupAddressID`); **FK** `customer_id` → `customer_snapshot`
- `container_snapshot` — **primary key** `container_id` (Routeware `ContainerID`); **FK** `pickup_address_id` → `address_snapshot`

**Import / sync order:** load customers, then addresses, then containers. The combined job (`POST /api/v1/data-snapshot/sync` or the daily cron) only runs the address step when the customer *export is configured* (static path or query id), and the container step only when both customer and address are configured.

## Environment

| Variable | Role |
|----------|------|
| `CUSTOMER_REPORT_EXPORT_PATH` | URL path to the Customer Details CSV (on `TARGET_ORIGIN`) — optional if you use `CUSTOMER_REPORT_QUERY_ID` |
| `ADDRESS_REPORT_EXPORT_PATH` | URL path to the Address Details CSV |
| `CONTAINER_REPORT_EXPORT_PATH` | URL path to the Container Details CSV |
| `CUSTOMER_REPORT_QUERY_ID` | Routeware **numeric** `queryID` for the Customer custom report (e.g. `23`). If set, it **takes precedence** over `CUSTOMER_REPORT_EXPORT_PATH` for that table. |
| `ADDRESS_REPORT_QUERY_ID` | Same (e.g. `24`) |
| `CONTAINER_REPORT_QUERY_ID` | Same (e.g. `25`) |
| `REPORT_QUERY_START_DATE` / `REPORT_QUERY_END_DATE` | Passed to `QueryExecuteDownload` as `startDate` / `endDate` (`yyyy-MM-dd`). Use `1900-01-01` when the modal has **no** date pickers (the WebRW script defaults to that). For reports with Kendo date pickers, set these to the same range you would choose in the UI. |
| `CUSTOMER_SNAPSHOT_SYNC_SECRET` | Bearer for `.../import`, `.../sync`, and `data-snapshot/sync` |

### Query-id mode (Killeen WebRW — client `requestID`)

The modal’s script does **`lastRequestID = crypto.randomUUID()`** and loads the iframe to  
`GET .../QueryExecuteDownload?requestID=<that-uuid>&queryID=<n>&startDate=...&endDate=...`.  
There is **no** separate `QueryExecute` POST: the one-time id is created in the browser. The Worker does the same with `crypto.randomUUID()` and a single download `GET` (same session cookies as other shadow calls). The UI also polls `QueryRequestIsComplete` every 2.5s for the loading indicator; the CSV is read from the **download** response body once the server finishes streaming.

### What to put in each `*_REPORT_EXPORT_PATH`

The Worker does `new URL(path, TARGET_ORIGIN)` and `GET`s that with your Routeware session cookies. You must store the **request that actually returns the CSV** (not the report UI page), usually:

- **Best:** path + query only, e.g. `/WebRW/Reports/SomeHandler?reportKey=...&export=1` (exact string depends on your recording).
- **Also valid:** a full `https://killeen.routeware.com/...` URL; if the host matches `TARGET_ORIGIN`, a path like `/WebRW/...?...` is enough.

**How to get the value after a recording**

1. **Chrome / Edge DevTools** → **Network** → run the export again (or use your last session) → find the request whose **Response** `Content-Type` is `text/csv` (or the file that downloads). Copy **Request URL** → for `wrangler.toml`, use only `pathname + ? + search` (or the full URL if you prefer). Assign that to the matching var (Customer, Address, or Container report).
2. **Harvest file** — if your run captured a `text/csv` response, use the `pathWithQuery` from that line. **Note:** Killeen’s UI often uses **query ids** and a **client** `requestID` (see [REPORT_CSV_HARVEST.md](tools/api-discovery/out/REPORT_CSV_HARVEST.md)). Map `queryID` values to report names in **Reports → Queries** (example: Customer `23`, Address `24`, Container `25`) and use `*_REPORT_QUERY_ID` when you are not using a stable static path.

**`npx wrangler types`:** Regenerates `worker-configuration.d.ts` from `wrangler.toml`. Run it once after you **add/rename** bindings or env keys in TOML (not strictly required if you only **paste new strings** into existing `*_REPORT_EXPORT_PATH` lines, but it is quick and safe).

## Recording the download flow (get real URLs for the path vars)

From the repository root:

```bash
npm run discovery:record
```

Optional: regenerate discovery artifacts (helps scan for new paths in docs):

```bash
npm run discovery:process
```

## Checklist: wire paths, database, and daily job

1. **Wire exports** — either paste the three `*_REPORT_EXPORT_PATH` values, **or** set the three `*_REPORT_QUERY_ID` values (and shared `REPORT_QUERY_*` keys) in `wrangler.toml` under `[vars]` (or in the Cloudflare dashboard under **Variables** for production).
2. **Set a sync secret** — in TOML `CUSTOMER_SNAPSHOT_SYNC_SECRET` for local dev, or for production `npx wrangler secret put CUSTOMER_SNAPSHOT_SYNC_SECRET` (and avoid committing real secrets in git).
3. **D1** — if you have not already: `npx wrangler d1 create routeware-customer-snapshot`, copy the printed **database_id** into `[[d1_databases]]` in `wrangler.toml` (replace the all-zero placeholder), then run `npx wrangler types`.
4. **Apply migrations** (after `database_id` is real):
   ```bash
   npx wrangler d1 migrations apply routeware-customer-snapshot --local
   npx wrangler d1 migrations apply routeware-customer-snapshot --remote
   ```
5. **Test locally** — `npx wrangler dev` (with `.dev.vars` containing `LOGIN_USERNAME` / `LOGIN_PASSWORD`), then call:
   `POST /api/v1/data-snapshot/sync` with header `Authorization: Bearer <your secret>`. The cron (`0 7 * * *` UTC) will run the same `runDataSnapshotSync` logic on the deployed worker.
6. **Deploy** — `npx wrangler deploy` after vars/secrets and D1 are set in the Cloudflare dashboard (or in TOML for non-secrets).

**API and documentation are already in this repo** — the address and container routes and OpenAPI entries live in `src/app.ts`. After `wrangler dev` or deploy, open **`/docs`** (Scalar) or **`/openapi.json`** on your worker URL; tags include `address-snapshot`, `container-snapshot`, and `data-snapshot`.

## Migrations (local and remote D1)

After creating a real D1 in your account and putting its `database_id` in `wrangler.toml` (replacing the placeholder), apply:

```bash
npx wrangler d1 migrations apply routeware-customer-snapshot --local
npx wrangler d1 migrations apply routeware-customer-snapshot --remote
```

## API quick reference (OpenAPI tags: `customer-snapshot`, `address-snapshot`, `container-snapshot`, `data-snapshot`)

All `.../import` and `.../sync` and `data-snapshot/sync` routes use **`Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>`**.

| Method | Path | Purpose |
|--------|------|--------|
| GET | `/api/v1/customer-snapshot` | List rows: query `customerId`, `q`, `enabled`, `limit`, `offset` |
| GET | `/api/v1/customer-snapshot/{customerId}` | One customer row |
| POST | `/api/v1/customer-snapshot/sync` | Fetch customer CSV (path or `CUSTOMER_REPORT_QUERY_ID` pipeline) and upsert |
| POST | `/api/v1/customer-snapshot/import` | Body = raw customer CSV |
| GET | `/api/v1/address-snapshot` | List rows: `customerId`, `pickupAddressId`, `q`, `enabled`, `limit`, `offset` |
| GET | `/api/v1/address-snapshot/{pickupAddressId}` | One address row |
| POST | `/api/v1/address-snapshot/sync` | Fetch address CSV (path or `ADDRESS_REPORT_QUERY_ID`) and upsert |
| POST | `/api/v1/address-snapshot/import` | Body = raw address CSV |
| GET | `/api/v1/container-snapshot` | List rows: `customerId` (join), `pickupAddressId`, `containerId`, `q`, `enabled`, `limit`, `offset` |
| GET | `/api/v1/container-snapshot/{containerId}` | One container row |
| POST | `/api/v1/container-snapshot/sync` | Fetch container CSV (path or `CONTAINER_REPORT_QUERY_ID`) and upsert |
| POST | `/api/v1/container-snapshot/import` | Body = raw container CSV |
| POST | `/api/v1/data-snapshot/sync` | Run customer → address → container in one call (per path vars and guards) |

### 503 / `exceededMemory` (combined sync)

Cloudflare Workers cap **memory** per request (~128 MB). The combined job loads all three report CSVs as full strings in one isolate; a large tenant can hit that cap and return **503** with `exceededMemory` in logs. **Workaround:** call the single-table syncs in order as **separate** requests: `POST /api/v1/customer-snapshot/sync`, then `.../address-snapshot/sync`, then `.../container-snapshot/sync` (same bearer). This keeps peak memory to one table per request.

**Aggregate reads and Routeware writes (OpenAPI tag `data-entity`):** same bearer. **GET** `/api/v1/data/customer?id=…` (or `customerId=…`), `/api/v1/data/address?id=…` (pickup address id), `/api/v1/data/container?id=…` — D1 cache with `ETag` / `If-None-Match` and Workers `Cache` API, invalidated on successful **POST** to the same path. **POST** forwards to Routeware `SaveCustomerLongForm`, `SaveAddressForm`, or `SaveContainerForm` and returns `upstream` + your `posted` form fields, then refreshes D1 from `GetCustomerDetailFull` for the affected customer. Create: customer with `CustomerID=0` (or omit); address with `PickupAddressID=0` + `CustomerID`; container with `ContainerID=0` + `PickupAddressID` (and `CustomerID` if you want local sync when D1 is empty).

Interactive docs: `GET /docs` (Scalar). Machine-readable: `GET /openapi.json`.

Regenerate types after `wrangler.toml` structural changes: `npx wrangler types`.
