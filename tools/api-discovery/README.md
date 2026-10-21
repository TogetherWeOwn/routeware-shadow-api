# Routeware API discovery (local)

Headed Playwright session that logs **every `/WebRW` request and response** to NDJSON, then tooling aggregates that into **documentation, inert local curl examples, route gaps, and suggested Worker routes**.

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

1. **`validate-harvest.mjs`** — every nonblank line satisfies the shared record contract below. Invalid input stops the process chain before any aggregate or downstream artifact is published.
2. **`aggregate.mjs`** — **`out/discovered-operations.json`** (counts, resource types, up to 3 diverse samples per operation with query keys, header names, body/response previews, JSON top-level keys).
3. **`generate-harvest-docs.mjs`** — **`out/HARVEST_API.md`** (human-readable tables + expandable samples).
4. **`route-gap.mjs`** — **`out/route-gaps.json`** / **`out/route-gaps.txt`** (harvested ops missing from `route-map.json`, and map entries not seen in this harvest). The report step never fails the chain; the gate (`route-gap.mjs --check`, last in `process`) exits 1 when harvested ops lack shadow routes. Stale map entries are warnings by default — re-run with `--strict` after an exhaustive session to fail on them. No aggregate yet, or an aggregate with zero operations, exits 0 (nothing to compare); a truncated aggregate fails loudly.
5. **`export-curl-examples.mjs`** — **`out/curl-examples.sh`** + complete documentation bodies under **`out/bodies/`**. No selection means no network; only explicitly selected GET examples can execute against a loopback `BASE`.
6. **`suggest-routes.mjs`** — **`out/suggested-routes.stub.ts`** (commented checklist for `src/app.ts`).

### Validate + test (CI / agent)

From repo root:

```bash
npm run discovery:verify
```

Runs **`discovery:process`** then **`npm test`** (includes **route-map contract tests** that hit the Worker with mocked upstream).

### Shared harvest record contract (v1)

`lib/harvestContract.mjs` is the pure validator used by validation and all sync,
stream-accumulator and CLI aggregation entry points. Each nonblank physical line
must be a nonarray JSON object with:

- `ts`: a real UTC ISO calendar timestamp (`YYYY-MM-DDTHH:mm:ss[.SSS]Z`,
  optional 1–3 fractional digits; impossible dates and normalized times fail).
- `method`: a nonempty uppercase HTTP token (standard methods and extension
  tokens are accepted; whitespace is not).
- `pathname`: an absolute path starting with one `/`, without whitespace,
  controls, backslashes, query/fragment or invalid percent escapes. A full URL
  is not a pathname. No route-map membership requirement is added.

Consumed optional fields are checked without adding captured fields or changing
redaction: previews, content types, `resourceType`, `pathWithQuery`, `queryString`
and `frameUrl` are strings when nonnull; absent/null string metadata remains
unavailable. Truncation flags, when present, must be booleans. `query` is an
object of strings or string arrays; request/response headers are objects of
strings. Null/absent query/header containers retain their empty defaults.
`responseStatus` is absent/null or an integer from 100 through 599. Unknown
fields are not copied into aggregate samples. Header values are never added to
aggregate output; existing sample (3) and preview (12,000 characters plus the
truncation notice) caps are unchanged. A valid partial capture remains valid;
this check does not require coverage of all routes.

```bash
# No recording, browser, credentials or live requests needed for these checks:
node tools/api-discovery/validate-harvest.mjs --help
node tools/api-discovery/validate-harvest.mjs --json
node tools/api-discovery/aggregate.mjs --json --dry-run
node --test tools/api-discovery/harvest-contract.acceptance.test.mjs tools/api-discovery/validate-harvest.test.mjs
npm run test:discovery
npm run test:probe
```

Both commands accept `--help` and `--json`; aggregation also accepts `--dry-run`.
Unknown arguments are rejected **before** input/output work, even with `--help`.
Dry-run validates everything and reports `output`, `lineCount`, `operationCount`
and `dryRun: true` without attempting mkdir/write/remove. Validation is always
read-only. Machine mode emits exactly one JSON document (no captured values or
raw parser/filesystem errors), with `schemaVersion: 1`, `ok`, `code`,
`next_action` and `findings`. Results contain at most 100 findings (under 64 KiB);
invalid-record results also give total `findingCount` and `findingsTruncated`.
Each finding has a fixed `code`, 1-based physical `line`, known top-level `field`
(or `$` for record/JSON shape), and a correction `next_action`.

| Code | Meaning / correction |
| --- | --- |
| `HARVEST_INVALID_JSON` | Correct the JSON object on the indicated line. |
| `HARVEST_RECORD_TYPE` | Replace a primitive/array/null with a record object. |
| `HARVEST_TIMESTAMP_INVALID` | Correct `ts` using the UTC syntax above. |
| `HARVEST_METHOD_INVALID` | Correct the uppercase method token. |
| `HARVEST_PATH_INVALID` | Supply an absolute pathname, not a URL/query. |
| `HARVEST_FIELD_INVALID` | Correct the optional field type above. |
| `HARVEST_INVALID_RECORDS` | Summary failure; fix the attached findings. |
| `HARVEST_UNKNOWN_FLAG` | Consult `--help`; no file work was attempted. |
| `HARVEST_READ_FAILED` | Check local input access/readability, then retry. |
| `HARVEST_WRITE_FAILED` | Check local output access/space, then retry. |
| `HARVEST_OK` | Valid input; continue local processing. |
| `HARVEST_MISSING` | Only stat `ENOENT`: validator skips; aggregate writes the existing fresh-checkout empty document. |
| `HARVEST_EMPTY` | Zero-byte file: explicit empty result/document, distinct from missing. |

Failures exit 1; successful/missing/empty results exit 0. Blank lines are ignored
for aggregate `lineCount` but still occupy diagnostic line positions; nonempty
blank-only input has no missing/empty note. Permission, I/O, non-directory and
asynchronous stream failures are not treated as missing. Any corrupt/mixed
input or read failure refuses the whole aggregate **before output publication**,
leaving previous aggregate and downstream files intact. The process command
stops on validation failure rather than regenerating documents from a valid
subset. Pure aggregation throws a `HarvestValidationError` with the same bounded
`findings` and total `findingCount`; a poisoned accumulator cannot finish even
if the caller catches a refusal. Deterministic valid content/operation identities
remain unchanged apart from the existing generated timestamp.

## Individual scripts

| Script | Output |
|--------|--------|
| `npm run setup` | Installs the Chromium browser (`playwright install chromium`) |
| `npm run record` | Headed recording → `out/harvest.ndjson` (redacted) |
| `npm run record:full` | Recording with all headers/values (`--full`) |
| `npm run codegen` | Playwright codegen — records UI actions to a script |
| `npm run validate:harvest` | Validates `harvest.ndjson` |
| `npm run aggregate` | `discovered-operations.json` only |
| `npm run docs:harvest` | `HARVEST_API.md` only |
| `npm run gap:routes` | `route-gaps.*` only (report; exits 1 on missing shadow routes, warns on stale entries unless `--strict`) |
| `npm run gap:check` | Re-checks `route-gaps.json` without recomputing (the `process` gate) |
| `npm run export:curls` | `curl-examples.sh` + `out/bodies/` |
| `npm run suggest:routes` | `suggested-routes.stub.ts` (after gaps exist) |

## Safe local curl examples

From the repo root (Node.js 24+, Bash and curl):

```bash
# Validate and inspect without network or changing any existing out/ artifacts:
node tools/api-discovery/export-curl-examples.mjs --dry-run
node tools/api-discovery/export-curl-examples.mjs --json

# Generate deterministically after validation. This does not execute requests.
node tools/api-discovery/export-curl-examples.mjs
bash tools/api-discovery/out/curl-examples.sh          # list only; zero curl calls
bash tools/api-discovery/out/curl-examples.sh --help
bash tools/api-discovery/out/curl-examples.sh --list
bash tools/api-discovery/out/curl-examples.sh --json

# Copy an exact METHOD + upstreamPath identity from --list (not a numeric index).
# Planning remains inert, even when a selection is supplied:
bash tools/api-discovery/out/curl-examples.sh \
  --operation 'GET /WebRW/Reports/QueryRequestIsComplete' --dry-run

# Execute exactly that GET, and only against your local service:
BASE=http://127.0.0.1:8787 bash tools/api-discovery/out/curl-examples.sh \
  --operation 'GET /WebRW/Reports/QueryRequestIsComplete'
```

`--json` implies a non-executing plan in both tools; generator `--dry-run`
validates every input it needs without creating, removing or rewriting artifacts.
Unknown/duplicate flags, missing/unknown selectors and duplicate method/path
identities fail before execution or generation writes. Validation failure leaves
existing artifacts intact. Normal generation replaces generated bodies and script,
never the source harvest or other discovery reports.

The generated shell file is self-contained and uses Node to validate and dispatch
an argv array, not shell evaluation. `BASE` defaults to `http://localhost:8787`;
only HTTP(S) origins with `localhost`, `127.0.0.1` or `[::1]` and an optional port
are accepted. Credentials, non-root paths, queries and fragments are refused.
Requests pin `localhost` resolution to loopback and disable curl configuration,
proxies, globbing and redirects; each GET
has a 5-second connect timeout, a 30-second total timeout and HTTP-error failure
behavior. Transport/HTTP failures exit nonzero with no retries. Harvested GET
query parameters (including repeated keys) intentionally override `exampleQuery`.
Treat that local service and its upstream configuration as your responsibility:
this guard is not a sandbox for a local service that itself forwards remotely.
No credentials are looked up or injected. No flag enables nonlocal requests or
POST/save/sync/write replay. Non-GET examples remain commented, non-executable
reference material, even when a complete body file exists.

Plans have `schemaVersion: 1` and `operations` (all entries, or the selected entry
for shell `--operation ... --json`). Each operation carries `id`, `method`,
`upstreamPath`, `shadowPath`, `executable`, `urlPath` (including intentional GET
query forwarding), and `body`. `executable` indicates GET eligibility, not an
authorization grant or a network request. `body.source` is:

- `none`: GET; no payload is ever sent or emitted.
- `harvest`: complete latest matching request preview (legacy captures may omit
  the truncation flag). Bytes are preserved, not trimmed.
- `synthetic`: complete repository `exampleFile`, using `exampleContentType`, not
  metadata from a discarded truncated preview. Bytes are preserved exactly.
- `unavailable`: no complete body; `code` is `BODY_TRUNCATED` or
  `BODY_UNAVAILABLE`, with a fixed `next_action` to add a complete repository
  example. An unavailable body has no artifact.

Available non-GET bodies name their relative artifact in `body.file` (under
`bodies/`). Plans and diagnostics never include body payload values. Truncated
previews are not copied to generated artifacts, and an older row is never used
to silently replace the latest truncated row. The source harvest is untouched.
Repository example files must resolve inside this tooling tree, outside `out/`.

Hermetic safety check (synthetic copied fixtures and fake curl only; no live origin):

```bash
node --test tools/api-discovery/curl-safety.acceptance.test.mjs \
  tools/api-discovery/downstream-scripts.test.mjs \
  tools/api-discovery/downstream-escapes.test.mjs
```

This also runs through `npm run test:probe` and `npm test`; no workflow changes.

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
