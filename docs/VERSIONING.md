# Versioning and release policy

`package.json#version` is the single source of truth for the release
version. The OpenAPI document (`GET /openapi.json`, `info.version`) reads it
via `src/lib/version.ts` — bumping `package.json` updates the live spec version.
The checked-in [`openapi.json`](./openapi.json) must also be regenerated with
`npx vitest run test/openapiContract.test.ts -u`.

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

As of `1.0.0` (2026-10-22): no endpoint or field is deprecated. When the
first deprecation lands, it will appear here by name alongside its sunset
date.

## Release checklist

1. Bump `version` in `package.json` (`npm version patch|minor|major
   --no-git-tag-version` keeps the edit local without tagging).
2. Move the `CHANGELOG.md` `## [Unreleased]` consumer-visible bullets under
   a new `## [x.y.z]` heading (dated), leaving an empty `## [Unreleased]`
   section at the top.
3. The OpenAPI contract test (`test/openapiContract.test.ts`) asserts
   `info.version` equals `package.json#version`, and `docs/openapi.json` records
   the published contract. Run `npm test`; for a version-only release, run
   `npx vitest run test/openapiContract.test.ts -u`, then confirm the generated
   diff is limited to version values (including the `/api/v1/health` example).
   Review any other contract diff as an intentional API change.
4. Merge to `main` through the standard gates (CI green, review 5/5),
   then cut the release from green `main` per the tag convention below.

## Tag convention and release cut

- Tags are annotated and named `vX.Y.Z`, exactly matching
  `package.json#version` with a leading `v` (e.g. `v1.0.0`). No other
  prefixes, suffixes, or lightweight tags.
- Tag the exact green `main` head the version PR merged as — never an
  older commit, never a PR branch:
  1. `git tag -a vX.Y.Z -m "routeware-shadow-api vX.Y.Z" <main-sha>`
  2. `git push origin vX.Y.Z` (a normal push; never force-push `main`).
  3. Publish the GitHub Release from the tag
     (`gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes>`)
     with consumer-facing notes covering every consumer-visible change.
- The first release to be cut this way will be `v1.0.0`.
