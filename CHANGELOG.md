# Changelog

Per-release notes for consumer-visible changes. `package.json#version` is
the single source of truth — see `docs/VERSIONING.md` for the bump policy.

## [Unreleased]

- TOG-8374: The per-customer detail-full D1 refresh no longer skips a graph
  for having more than 5,000 addresses or 40,000 containers. It skips only
  when the graph needs more than 900 D1 operations in one request, checked
  before the first write so D1 is left untouched. The 8 MiB response cap
  still applies, and graphs within budget now refresh D1 in full.

- TOG-8375: Throttle 429s now include `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix seconds), and CORS
  exposes them to browser clients; `Retry-After` is unchanged.

- TOG-18135: Buffered upstream read/save, token-modal, and login bodies now
  have a separate `UPSTREAM_TIMEOUT_MS` deadline after headers arrive.
  Timeouts abort/cancel pending reads without replaying saves. Continuously
  ready body chunks yield to timer tasks so they cannot starve the deadline;
  successful passthrough bodies and long-running report CSV streams remain unchanged.

- TOG-8372: OpenAPI now includes synthetic request and response examples for
  snapshot, data-entity, and general Routeware operations. Proxy bodies remain
  unvalidated and existing runtime schemas are unchanged.

## [1.0.0] - 2026-09-27

Initial release of the Routeware Shadow API (Cloudflare Worker): shadow
health, Routeware account/customer/report proxies, customer/address/container
snapshots with sync and import, data-entity reads and writes, and the
versioned OpenAPI document at `GET /openapi.json`.

- TOG-5840: `openapi.json` `info.version` is now wired to
  `package.json#version` (via `src/lib/version.ts`) instead of a hardcoded
  `1.0.0`, so consumers can tell releases apart. Added
  `docs/VERSIONING.md` (bump policy) and this changelog.
