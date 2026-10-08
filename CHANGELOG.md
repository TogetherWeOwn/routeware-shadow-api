# Changelog

Per-release notes for consumer-visible changes. `package.json#version` is
the single source of truth — see `docs/VERSIONING.md` for the bump policy.

## [Unreleased]

- TOG-8894: Snapshot CSV exports reversibly escape formula-leading values with
  `apostrophe-v1` and add `_shadow_csv_encoding` before the final `synced_at`
  column (15 customer / 17 address / 30 container columns). First-open spreadsheet
  safety requires comma separators and double-quote text delimiters. Decoding
  requires the original encoded cells and marker; existing normalization and the
  HTTP import 50 MiB cap still apply. Batch preparation needs separate control
  preflight (see CUSTOMER_SNAPSHOT.md).
- TOG-8895: Snapshot CSV imports reject NUL/control characters and lone CR
  cell content before D1 binding, with a PII-free row-numbered 400. Upstream
  report sync parsing stays permissive; earlier valid import batches may remain.
- TOG-8877: `GET /api/v1/customer-snapshot/changes` incremental-sync feed —
  rows with `synced_at > since` in `(synced_at, customer_id)` keyset order. A
  bare `since` replays every later run whole; chunked deltas page with the
  composite `since` + `since_id` cursor pair (served by the
  `idx_customer_snapshot_synced_at` index), so same-timestamp rows past a page
  boundary are never skipped.

## [1.0.0] - 2026-09-27

Initial release of the Routeware Shadow API (Cloudflare Worker): shadow
health, Routeware account/customer/report proxies, customer/address/container
snapshots with sync and import, data-entity reads and writes, and the
versioned OpenAPI document at `GET /openapi.json`.

- TOG-5840: `openapi.json` `info.version` is now wired to
  `package.json#version` (via `src/lib/version.ts`) instead of a hardcoded
  `1.0.0`, so consumers can tell releases apart. Added
  `docs/VERSIONING.md` (bump policy) and this changelog.
