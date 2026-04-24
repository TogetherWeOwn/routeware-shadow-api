# Routeware API discovery (local)

Headed Playwright session that logs **every `/WebRW` request and response** to NDJSON, then tooling aggregates that into **documentation, curl replay files, route gaps, and suggested Worker routes**.

## Setup

```bash
cd tools/api-discovery
npm install
npx playwright install chromium
```

### Linux / WSL (missing `libnspr4.so` and similar)

Playwright’s Chromium needs system libraries. Install them once (requires `sudo`):

```bash
cd tools/api-discovery
sudo ./node_modules/.bin/playwright install-deps chromium
```

`sudo npx …` often fails with **`npx: command not found`** because root’s `PATH` does not include your Node install (nvm, fnm, etc.). Using **`./node_modules/.bin/playwright`** avoids that. Alternatively: `sudo env "PATH=$PATH" npx playwright install-deps chromium`.

### Use system Chrome instead (optional)

```bash
export CHROME_CHANNEL=chrome
npm run record
```

## Record

```bash
npm run record
```

- Opens Chromium (set `HEADLESS=1` for headless).
- Default start URL: `https://killeen.routeware.com/WebRW/` — override with `START_URL`, `TARGET_ORIGIN`, or `TARGET_BASE_PATH`.
- Appends one JSON object per finished request to **`out/harvest.ndjson`** (gitignored). Press **Enter** to stop, or **Ctrl+C**.

### Fresh recording file

To **truncate** the harvest before recording (new session only):

```bash
HARVEST_FRESH=1 npm run record
```

### Body / response size caps

Defaults are **256 KiB** each for request and response bodies (stored as UTF-8 text previews). Increase if needed:

```bash
export HARVEST_MAX_REQUEST_BYTES=524288
export HARVEST_MAX_RESPONSE_BYTES=524288
npm run record
```

### NDJSON fields (per line)

| Field | Purpose |
|--------|--------|
| `ts` | ISO timestamp |
| `method` | HTTP method |
| `resourceType` | Playwright type (`xhr`, `fetch`, `document`, …) |
| `pathname` | URL path (e.g. `/WebRW/Customer/CustomersRead`) |
| `pathWithQuery` | Path + query string |
| `fullUrl` | Full URL (same origin as target) |
| `query` | Query as plain object |
| `queryString` | Raw query string (no `?`) |
| `frameUrl` | Page URL that issued the request |
| `requestHeaders` | Redacted header map |
| `requestContentType` | `Content-Type` request header |
| `requestBodySize` | Byte length of POST body |
| `requestBodyPreview` | Body text up to cap |
| `requestBodyTruncated` | `true` if body exceeded cap |
| `responseStatus` | HTTP status |
| `responseHeaders` | Redacted response headers |
| `responseContentType` | Response `Content-Type` |
| `responseBodyPreview` | Response body text up to cap |
| `responseBodyTruncated` | `true` if response exceeded cap |

### Header capture

By default, **`Cookie`**, **`Authorization`**, **`Set-Cookie`**, **`X-Api-Key`**, and **`Proxy-Authorization`** are omitted from `requestHeaders` / `responseHeaders`.

To log **every header** (needed for full replay / session debugging):

```bash
export HARVEST_FULL_HEADERS=1
# or: HARVEST_REDACT_HEADERS=0
```

Treat `harvest.ndjson` as **secret** when full headers are on.

## After recording — one command

From the **repo root**:

```bash
npm run discovery:process
```

Or inside `tools/api-discovery`:

```bash
npm run process
```

This runs, in order:

1. **`validate-harvest.mjs`** — every line is valid JSON with `ts`, `method`, `pathname`.
2. **`aggregate.mjs`** — **`out/discovered-operations.json`** (counts, resource types, up to 3 diverse samples per operation with query keys, header names, body/response previews, JSON top-level keys).
3. **`generate-harvest-docs.mjs`** — **`out/HARVEST_API.md`** (human-readable tables + expandable samples).
4. **`route-gap.mjs`** — **`out/route-gaps.json`** / **`out/route-gaps.txt`** (harvested ops missing from `route-map.json`, and map entries not seen in this harvest).
5. **`export-curl-examples.mjs`** — **`out/curl-examples.sh`** + **`out/bodies/*.json`** (replay against `BASE`, e.g. `wrangler dev`).
6. **`suggest-routes.mjs`** — **`out/suggested-routes.stub.ts`** (commented checklist for `src/app.ts`).

### Validate + test (CI / agent)

From repo root:

```bash
npm run discovery:verify
```

Runs **`discovery:process`** then **`npm test`** (includes **route-map contract tests** that hit the Worker with mocked upstream).

## Individual scripts

| Script | Output |
|--------|--------|
| `npm run validate:harvest` | Validates `harvest.ndjson` |
| `npm run aggregate` | `discovered-operations.json` only |
| `npm run docs:harvest` | `HARVEST_API.md` only |
| `npm run gap:routes` | `route-gaps.*` only |
| `npm run export:curls` | `curl-examples.sh` + `out/bodies/` |
| `npm run suggest:routes` | `suggested-routes.stub.ts` (after gaps exist) |

## Building new shadow routes after a recording

1. Open **`out/route-gaps.txt`** (or **`route-gaps.json`**) — high-count paths first.
2. Add entries to **`route-map.json`** (`upstreamPath`, `shadowPath`, optional `exampleFile` / `exampleQuery`).
3. Use **`out/suggested-routes.stub.ts`** as a naming hint; implement `createRoute` + handler in **`src/app.ts`** (same pattern as existing Routeware forwards).
4. Add example JSON under **`examples/`** if the exporter needs a body when the harvest has no preview for that path.
5. Run **`npm run discovery:verify`** from the repo root.

## Example request bodies

See **`examples/README.md`**.
