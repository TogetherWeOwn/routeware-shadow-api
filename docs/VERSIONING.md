# Versioning and release policy

`package.json#version` is the single source of truth for the release
version. The OpenAPI document (`GET /openapi.json`, `info.version`) reads it
via `src/lib/version.ts` — bumping `package.json` moves the spec version with
no other edit.

## Bump policy (semver)

- **Patch** (`x.y.z+1`): bug fixes, doc fixes, internal refactors, test-only
  changes. No consumer-visible contract change.
- **Minor** (`x.y+1.0`): new endpoints, new optional fields, new query
  parameters. Backwards compatible — existing consumers keep working.
- **Major** (`x+1.0.0`): removed or renamed endpoints, changed required
  fields, changed response shapes, changed auth requirements.

## Consumer deprecation and removal policy

VERSIONING.md above covers how releases are numbered. This section is the
promise to API consumers about how endpoints and fields are retired.

### Notice period

- A deprecated endpoint or field keeps serving normally for a minimum of
  **30 days** after the deprecation is announced.
- The announcement is a `CHANGELOG.md` entry naming the endpoint/field, its
  replacement, and the earliest removal date — deprecation is therefore always
  tied to a released version consumers can see in `GET /openapi.json`
  (`info.version`).
- Removal happens only in a **major** version bump (`x+1.0.0`), never in a
  minor or patch. The major release's changelog entry lists every removal.

### Sunset headers

While deprecated, every response from the affected endpoint carries:

- `Deprecation: true`
- `Sunset: <http-date>` — the earliest removal date (never sooner than
  announcement + 30 days).
- `Link: <successor-path>; rel="successor-version"` — when a replacement
  endpoint exists.

Consumers should treat the presence of `Deprecation` as the signal to
migrate; the absence of these headers means the endpoint is fully supported.

### Path-version coexistence

Breaking changes ship under a new path version (e.g. `/api/v2`) while the old
path keeps serving through its sunset date, so consumers migrate by changing
the path prefix, not by racing a removal. Additive changes (new optional
fields, new endpoints) need no new path version and arrive as minor releases.

### Removal policy

- On or after the `Sunset` date, the next major release may remove the
  deprecated surface. Until that major ships, the deprecated surface keeps
  working unchanged.
- Removals are listed verbatim in the major release's `CHANGELOG.md` entry.
- Emergency early removal (security, upstream withdrawal, PII exposure) is
  announced out-of-band in the changelog with the reason stated; the headers
  above are updated to the earliest feasible date.

### Current status

As of `1.0.0` (2026-09-27): no endpoint or field is deprecated. When the
first deprecation lands, it will appear here by name alongside its sunset
date.

## Release checklist

1. Bump `version` in `package.json` (`npm version patch|minor|major
   --no-git-tag-version` keeps the edit local without tagging).
2. Add a `CHANGELOG.md` entry under a new `## [x.y.z]` heading describing
   consumer-visible changes.
3. The OpenAPI contract test (`test/openapiContract.test.ts`) asserts
   `info.version` equals `package.json#version`, and the full-document
   snapshot records the new version — run `npm test` and update the snapshot
   with `vitest run test/openapiContract.test.ts -u` only after confirming
   the version change is the sole diff.
