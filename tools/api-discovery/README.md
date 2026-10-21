# Routeware API discovery (local)

Headed Playwright session that logs **every `/WebRW` request and response** to NDJSON, then tooling aggregates that into **documentation, curl replay files, route gaps, and suggested Worker routes**.

## Setup

One-liner from the **repo root** (installs deps + the Chromium browser):

```bash
npm run discovery:setup
```

Or manually:

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

To **truncate** the harvest before recording (new session only). Use the flag
(works in PowerShell / cmd / bash) or the env var:

```bash
npm run record -- --fresh      # cross-platform flag
HARVEST_FRESH=1 npm run record # env var (bash)
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

To log **every header** and **every value** (cookies, auth, anti-forgery tokens —
needed for full replay / session debugging), use the flag or env var:

```bash
npm run record:full                 # = record -- --full (cross-platform)
npm run record -- --full --fresh    # full capture into a fresh file
export HARVEST_FULL_HEADERS=1       # env var equivalent (bash)
```

`--full` also disables the credential/PII value masking, so treat `harvest.ndjson`
as **secret** when it is on. `out/` is gitignored.

## Record UI actions (codegen)

`record.ts` captures the **requests** your actions fire. To also capture **the actions
themselves** (clicks, typing, navigation) as a replayable script, run Playwright codegen:

```bash
npm run codegen                 # opens Routeware; script appears in the Inspector
npm run codegen -- -o flow.ts   # also save the generated script to flow.ts
```

Run `npm run record` (or `record:full`) in a second terminal at the same time to get
both the action script **and** the underlying request/arg harvest for one workflow —
everything needed to replicate it as a shadow API route.

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

1. **`route-map-validation.mjs`** — validates `route-map.json` before any artifact is built (see below).
2. **`validate-harvest.mjs`** — every line is valid JSON with `ts`, `method`, `pathname`.
3. **`aggregate.mjs`** — **`out/discovered-operations.json`** (counts, resource types, up to 3 diverse samples per operation with query keys, header names, body/response previews, JSON top-level keys).
4. **`generate-harvest-docs.mjs`** — **`out/HARVEST_API.md`** (human-readable tables + expandable samples).
5. **`route-gap.mjs`** — **`out/route-gaps.json`** / **`out/route-gaps.txt`** (harvested ops missing from `route-map.json`, and map entries not seen in this harvest). The report step never fails the chain; the gate (`route-gap.mjs --check`, last in `process`) exits 1 when harvested ops lack shadow routes. Stale map entries are warnings by default — re-run with `--strict` after an exhaustive session to fail on them. No aggregate yet, or an aggregate with zero operations, exits 0 (nothing to compare); a truncated aggregate fails loudly.
6. **`export-curl-examples.mjs`** — **`out/curl-examples.sh`** + **`out/bodies/*.json`** (replay against `BASE`, e.g. `wrangler dev`).
7. **`suggest-routes.mjs`** — **`out/suggested-routes.stub.ts`** (commented checklist for `src/app.ts`).

## Validate the route map

`route-map.json` is the contract between the harvest and the shadow Worker:
every entry maps one upstream operation (`method` + `upstreamPath`) to one
shadow operation (`method` + `shadowPath`). `route-map-validation.mjs`
checks that contract with the shared library `lib/routeMapValidation.mjs` —
the same implementation `route-gap.mjs`, `export-curl-examples.mjs` and
`suggest-routes.mjs` run before producing output, and the workerd contract
tests run against the live `/openapi.json`.

From the repo root:

```bash
npm run discovery:validate
```

Or inside `tools/api-discovery`:

```bash
npm run validate:routes              # text verdict, exit 0/1
node route-map-validation.mjs --json # exactly one JSON object on stdout, stderr empty
```

Flags: `--json`, and `--mounted-operations=<file>` (a JSON array of
`"METHOD /path"` strings; default: derive from the `createRoute`
definitions in `src/routes/*.ts`). Any other flag or positional argument is
rejected with `UNKNOWN_FLAG` (exit 2). Exit 0 = valid, 1 = findings.
Validation is read-only: it never writes, and never prints harvest payloads,
credentials, raw exceptions or recorded customer values.

`--json` result shape (`schemaVersion` 1):

```json
{
  "schemaVersion": 1,
  "ok": false,
  "checks": [{ "id": "route-map.shape", "status": "pass" }],
  "findings": [{
    "id": "DUPLICATE_UPSTREAM_IDENTITY-9f2c4a1b7e30",
    "checkId": "route-map.duplicate-upstream",
    "code": "DUPLICATE_UPSTREAM_IDENTITY",
    "severity": "error",
    "entryIndexes": [0, 1],
    "method": "POST",
    "upstreamPath": "/WebRW/Customer/CustomersRead",
    "nextAction": "Merge route-map entries 0, 1 into a single mapping for the duplicated upstream operation, or delete the stale one."
  }],
  "summary": { "entries": 5, "errors": 1 }
}
```

Check statuses are `pass`, `fail`, or `skipped` (the mounted-operation
check is `skipped` when no mounted-operations list is supplied). Finding ids
are content-derived, stable, and independent of entry order.

Checks and finding codes:

| Check id | Code | Meaning |
|----------|------|---------|
| `route-map.shape` | `ROUTE_MAP_NOT_ARRAY` | the map is not an array |
| `route-map.shape` | `ENTRY_FIELD_INVALID` | an entry is not an object, or a field is missing, empty or not a string |
| `route-map.method` | `METHOD_UNSUPPORTED` | method is not GET, POST, PUT, PATCH or DELETE (exact, uppercase) |
| `route-map.upstream-path` | `UPSTREAM_PATH_INVALID` | upstream path is not an absolute clean path (no query, fragment, whitespace, dot segments or trailing slash) |
| `route-map.shadow-path` | `SHADOW_PATH_INVALID` | same shape rules for the shadow path |
| `route-map.duplicate-upstream` | `DUPLICATE_UPSTREAM_IDENTITY` | two entries claim the same upstream method + (case-folded) path |
| `route-map.conflicting-shadow` | `CONFLICTING_SHADOW_MAPPING` | two upstream operations map onto one shadow method + path |
| `route-map.mounted-operation` | `SHADOW_OPERATION_NOT_MOUNTED` | the shadow method + path is not a mounted/documented operation (`{param}` matches exactly one segment) |
| `route-map.shape` | `ROUTE_MAP_UNREADABLE` | CLI-only: `route-map.json` is missing or unparsable |
| `route-map.mounted-operation` | `MOUNTED_OPERATIONS_UNAVAILABLE` | CLI-only: no `--mounted-operations` file and no repo source to derive from |
| `cli.arguments` | `UNKNOWN_FLAG` | CLI-only: unknown flag or positional argument |

`export-curl-examples.mjs` and `suggest-routes.mjs` accept `--dry-run`:
validate the map, print the verdict, write nothing (exit 1 on findings).

### Validate + test (CI / agent)

From repo root:

```bash
npm run discovery:verify
```

Runs **`discovery:process`** then **`npm test`** (includes **route-map contract tests** that hit the Worker with mocked upstream).

## Individual scripts

| Script | Output |
|--------|--------|
| `npm run setup` | Installs the Chromium browser (`playwright install chromium`) |
| `npm run record` | Headed recording → `out/harvest.ndjson` (redacted) |
| `npm run record:full` | Recording with all headers/values (`--full`) |
| `npm run codegen` | Playwright codegen — records UI actions to a script |
| `npm run validate:harvest` | Validates `harvest.ndjson` |
| `npm run validate:routes` | Validates `route-map.json` (read-only; `--json` for one JSON object) |
| `npm run aggregate` | `discovered-operations.json` only |
| `npm run docs:harvest` | `HARVEST_API.md` only |
| `npm run gap:routes` | `route-gaps.*` only (report; exits 1 on missing shadow routes, warns on stale entries unless `--strict`) |
| `npm run gap:check` | Re-checks `route-gaps.json` without recomputing (the `process` gate) |
| `npm run export:curls` | `curl-examples.sh` + `out/bodies/` (supports `--dry-run`) |
| `npm run suggest:routes` | `suggested-routes.stub.ts` (after gaps exist; supports `--dry-run`) |

## Building new shadow routes after a recording

1. Open **`out/route-gaps.txt`** (or **`route-gaps.json`**) — high-count paths first.
2. Add entries to **`route-map.json`** (`upstreamPath`, `shadowPath`, optional `exampleFile` / `exampleQuery`).
3. Use **`out/suggested-routes.stub.ts`** as a naming hint; implement `createRoute` + handler in **`src/app.ts`** (same pattern as existing Routeware forwards).
4. Add example JSON under **`examples/`** if the exporter needs a body when the harvest has no preview for that path.
5. Run **`npm run discovery:verify`** from the repo root.

`discovery:process` always builds every artifact (curl examples, route stubs)
before the trailing gap gate, so the stub exists exactly when gaps exist; the
gate fails only on missing shadow routes, and `discovery:verify` reaches the
contract tests once it is green. After an exhaustive recording (every mapped
route exercised), run `node route-gap.mjs --strict` from `tools/api-discovery`
to also fail on stale map entries.

## Example request bodies

See **`examples/README.md`**.
